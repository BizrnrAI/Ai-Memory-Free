-- Preserve Vault authenticated encryption and the existing public signatures.
-- No values are rewritten by this migration. Existing rows keep their Vault UUID;
-- a later rotation changes the internal Vault name to an unambiguous JSON pair.
-- Row locks keep a retrieved secret, version, audit entry and retirement coherent.

create or replace function public.store_encrypted_secret(
  p_namespace text,
  p_name text,
  p_description text,
  p_secret text,
  p_metadata jsonb,
  p_client_id uuid,
  p_request_id uuid
)
returns table (
  id uuid,
  namespace text,
  name text,
  description text,
  version integer,
  metadata jsonb,
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  existing public.memory_secrets%rowtype;
  new_vault_id uuid;
  vault_name text := 'ai-memory-free:' || jsonb_build_array(p_namespace, p_name)::text;
begin
  if coalesce(caller_role, session_user) not in ('service_role', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_namespace is null or p_name is null or p_secret is null
     or p_namespace !~ '^[a-zA-Z0-9_.:-]{1,128}$'
     or p_name !~ '^[a-zA-Z0-9_.:-]{1,128}$'
     or char_length(p_secret) not between 1 and 16384
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_encrypted_secret';
  end if;

  -- Serialize first creation as well as rotation for this logical credential.
  -- JSON framing prevents ambiguity when either identifier contains a colon.
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_namespace, p_name)::text, 0));

  select * into existing
  from public.memory_secrets s
  where s.namespace = p_namespace and s.name = p_name
  for update;

  if existing.id is null then
    select vault.create_secret(p_secret, vault_name, coalesce(btrim(p_description), ''))
    into new_vault_id;

    return query
    insert into public.memory_secrets (
      namespace, name, description, vault_secret_id, metadata, created_by
    ) values (
      p_namespace, p_name, nullif(btrim(p_description), ''), new_vault_id,
      coalesce(p_metadata, '{}'::jsonb), p_client_id
    )
    returning
      memory_secrets.id,
      memory_secrets.namespace,
      memory_secrets.name,
      memory_secrets.description,
      memory_secrets.version,
      memory_secrets.metadata,
      memory_secrets.is_active,
      memory_secrets.created_at,
      memory_secrets.updated_at;
  else
    perform vault.update_secret(
      existing.vault_secret_id,
      p_secret,
      vault_name,
      coalesce(btrim(p_description), '')
    );

    return query
    update public.memory_secrets s
    set description = nullif(btrim(p_description), ''),
        metadata = coalesce(p_metadata, '{}'::jsonb),
        version = s.version + 1,
        is_active = true,
        retired_at = null
    where s.id = existing.id
    returning
      s.id, s.namespace, s.name, s.description, s.version, s.metadata,
      s.is_active, s.created_at, s.updated_at;
  end if;

  insert into public.memory_audit_log (
    request_id, client_id, action, namespace, resource_type, resource_id, success, details
  )
  select
    p_request_id, p_client_id, 'secret_store', p_namespace, 'encrypted_secret', s.id::text,
    true, jsonb_build_object('name', p_name, 'version', s.version)
  from public.memory_secrets s
  where s.namespace = p_namespace and s.name = p_name;
end;
$$;

create or replace function public.get_encrypted_secret(
  p_namespace text,
  p_name text,
  p_client_id uuid,
  p_request_id uuid
)
returns table (
  id uuid,
  namespace text,
  name text,
  description text,
  version integer,
  metadata jsonb,
  secret text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  target public.memory_secrets%rowtype;
  plaintext text;
begin
  if coalesce(caller_role, session_user) not in ('service_role', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into target
  from public.memory_secrets s
  where s.namespace = p_namespace and s.name = p_name and s.is_active
  for update;
  if target.id is null then raise exception 'secret_not_found'; end if;

  select d.decrypted_secret into plaintext
  from vault.decrypted_secrets d
  where d.id = target.vault_secret_id;
  if plaintext is null then raise exception 'vault_secret_unavailable'; end if;

  update public.memory_secrets s
  set access_count = s.access_count + 1,
      last_accessed_at = now(),
      last_accessed_by = p_client_id
  where s.id = target.id;

  insert into public.memory_audit_log (
    request_id, client_id, action, namespace, resource_type, resource_id, success, details
  ) values (
    p_request_id, p_client_id, 'secret_get', p_namespace, 'encrypted_secret', target.id::text,
    true, jsonb_build_object('name', p_name, 'version', target.version)
  );

  return query select
    target.id, target.namespace, target.name, target.description, target.version,
    target.metadata, plaintext, target.created_at, target.updated_at;
end;
$$;

revoke all on function public.store_encrypted_secret(text, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_encrypted_secret(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.store_encrypted_secret(text, text, text, text, jsonb, uuid, uuid) to service_role;
grant execute on function public.get_encrypted_secret(text, text, uuid, uuid) to service_role;

-- Index every credential's safe identity/description, including legacy names and
-- retired entries. Never index Vault plaintext/ciphertext or arbitrary metadata.
alter table public.memory_secrets add column if not exists discovery_fts tsvector
  generated always as (
    to_tsvector('simple',
      replace(replace(name, '.', ' '), '_', ' ') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(metadata ->> 'service', '') || ' ' ||
      coalesce(metadata ->> 'environment', '') || ' ' ||
      replace(coalesce(metadata ->> 'credential_type', ''), '_', ' ')
    )
  ) stored;
create index if not exists memory_secrets_discovery_fts
  on public.memory_secrets using gin(discovery_fts);
create index if not exists memory_secrets_name_prefix
  on public.memory_secrets(namespace, name text_pattern_ops);
