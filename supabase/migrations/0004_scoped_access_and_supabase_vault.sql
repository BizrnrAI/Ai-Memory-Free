-- 0004_scoped_access_and_supabase_vault.sql
--
-- Additive security hardening for multi-client deployments:
--   * hashed, revocable, expiring API credentials
--   * namespace and permission grants per caller
--   * encrypted, recoverable secrets backed by Supabase Vault
--   * append-only security audit events
--   * fixed-window per-client abuse controls
--
-- Raw access tokens are NEVER stored. Recoverable platform secrets exist only in
-- vault.secrets, where Supabase Vault applies authenticated encryption and keeps
-- its encryption key outside the database. public.memory_secrets stores metadata
-- and the Vault UUID, never ciphertext or plaintext.

create extension if not exists supabase_vault cascade;

create table if not exists public.memory_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  allowed_namespaces text[] not null default array['default']::text[],
  permissions text[] not null default array['memory:read']::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memory_clients_name_check check (char_length(name) between 1 and 128),
  constraint memory_clients_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint memory_clients_token_prefix_check check (char_length(token_prefix) between 4 and 24),
  constraint memory_clients_namespaces_check check (cardinality(allowed_namespaces) between 1 and 128),
  constraint memory_clients_permissions_check check (cardinality(permissions) between 1 and 32)
);

create index if not exists memory_clients_active_lookup
  on public.memory_clients(token_hash)
  where revoked_at is null;

create table if not exists public.memory_secrets (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  name text not null,
  description text,
  vault_secret_id uuid not null unique,
  version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  access_count bigint not null default 0,
  last_accessed_at timestamptz,
  created_by uuid references public.memory_clients(id) on delete set null,
  last_accessed_by uuid references public.memory_clients(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (namespace, name),
  constraint memory_secrets_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_secrets_name_check check (name ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_secrets_version_check check (version > 0),
  constraint memory_secrets_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists memory_secrets_namespace_active
  on public.memory_secrets(namespace, name)
  where is_active;

create index if not exists memory_secrets_created_by
  on public.memory_secrets(created_by)
  where created_by is not null;

create index if not exists memory_secrets_last_accessed_by
  on public.memory_secrets(last_accessed_by)
  where last_accessed_by is not null;

create table if not exists public.memory_audit_log (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  client_id uuid references public.memory_clients(id) on delete set null,
  action text not null,
  namespace text,
  resource_type text,
  resource_id text,
  success boolean not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint memory_audit_action_check check (char_length(action) between 1 and 64),
  constraint memory_audit_details_object_check check (jsonb_typeof(details) = 'object')
);

create index if not exists memory_audit_log_created_at
  on public.memory_audit_log(created_at desc);

create index if not exists memory_audit_log_client_created
  on public.memory_audit_log(client_id, created_at desc)
  where client_id is not null;

create index if not exists memory_audit_log_namespace_created
  on public.memory_audit_log(namespace, created_at desc)
  where namespace is not null;

create table if not exists public.memory_rate_limit_buckets (
  client_key text not null,
  action text not null,
  window_start timestamptz not null,
  request_count integer not null default 1,
  primary key (client_key, action, window_start),
  constraint memory_rate_limit_client_check check (char_length(client_key) between 1 and 128),
  constraint memory_rate_limit_action_check check (char_length(action) between 1 and 64),
  constraint memory_rate_limit_count_check check (request_count > 0)
);

create index if not exists memory_rate_limit_window
  on public.memory_rate_limit_buckets(window_start);

alter table public.memory_clients enable row level security;
alter table public.memory_secrets enable row level security;
alter table public.memory_audit_log enable row level security;
alter table public.memory_rate_limit_buckets enable row level security;

revoke all on table public.memory_clients from public, anon, authenticated;
revoke all on table public.memory_secrets from public, anon, authenticated;
revoke all on table public.memory_audit_log from public, anon, authenticated;
revoke all on table public.memory_rate_limit_buckets from public, anon, authenticated;
revoke all on sequence public.memory_audit_log_id_seq from public, anon, authenticated;

-- Supabase Vault grants its backend service role Vault access by design. External
-- Ai-Memory-Free clients never receive that key. Keep public/user roles out; the
-- Edge implementation uses only the guarded functions below.
revoke all on table vault.secrets from public, anon, authenticated;
revoke all on table vault.decrypted_secrets from public, anon, authenticated;

grant all on table public.memory_clients to service_role;
grant all on table public.memory_secrets to service_role;
revoke all on table public.memory_audit_log from service_role;
grant select, insert on table public.memory_audit_log to service_role;
grant all on table public.memory_rate_limit_buckets to service_role;
grant usage, select on sequence public.memory_audit_log_id_seq to service_role;

drop trigger if exists memory_clients_touch_updated_at on public.memory_clients;
create trigger memory_clients_touch_updated_at
before update on public.memory_clients
for each row execute function public.touch_updated_at();

drop trigger if exists memory_secrets_touch_updated_at on public.memory_secrets;
create trigger memory_secrets_touch_updated_at
before update on public.memory_secrets
for each row execute function public.touch_updated_at();

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
  vault_name text := 'ai-memory-free:' || p_namespace || ':' || p_name;
begin
  if coalesce(caller_role, session_user) not in ('service_role', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_namespace !~ '^[a-zA-Z0-9_.:-]{1,128}$'
     or p_name !~ '^[a-zA-Z0-9_.:-]{1,128}$'
     or char_length(p_secret) not between 1 and 16384
     or jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_encrypted_secret';
  end if;

  select * into existing
  from public.memory_secrets s
  where s.namespace = p_namespace and s.name = p_name
  for update;

  if existing.id is null then
    select vault.create_secret(p_secret, vault_name, nullif(btrim(p_description), ''))
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
      nullif(btrim(p_description), '')
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
  where s.namespace = p_namespace and s.name = p_name and s.is_active;
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

create or replace function public.retire_encrypted_secret(
  p_namespace text,
  p_name text,
  p_client_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  target_id uuid;
begin
  if coalesce(caller_role, session_user) not in ('service_role', 'postgres') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.memory_secrets
  set is_active = false, retired_at = now()
  where namespace = p_namespace and name = p_name and is_active
  returning id into target_id;
  if target_id is null then raise exception 'secret_not_found'; end if;

  insert into public.memory_audit_log (
    request_id, client_id, action, namespace, resource_type, resource_id, success, details
  ) values (
    p_request_id, p_client_id, 'secret_retire', p_namespace, 'encrypted_secret', target_id::text,
    true, jsonb_build_object('name', p_name)
  );
end;
$$;

create or replace function public.check_memory_rate_limit(
  p_client_key text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language sql
set search_path = public, pg_temp
as $$
  with args as (
    select
      left(p_client_key, 128) as client_key,
      left(p_action, 64) as action,
      greatest(1, least(p_limit, 10000)) as request_limit,
      greatest(1, least(p_window_seconds, 86400)) as window_seconds
  ), bucket as (
    select
      client_key,
      action,
      request_limit,
      to_timestamp(
        floor(extract(epoch from clock_timestamp()) / window_seconds) * window_seconds
      ) as window_start
    from args
  ), pruned as (
    delete from public.memory_rate_limit_buckets
    where window_start < clock_timestamp() - interval '2 days'
    returning 1
  ), counted as (
    insert into public.memory_rate_limit_buckets(client_key, action, window_start, request_count)
    select client_key, action, window_start, 1 from bucket
    on conflict (client_key, action, window_start)
    do update set request_count = public.memory_rate_limit_buckets.request_count + 1
    returning request_count
  )
  select counted.request_count <= bucket.request_limit
  from counted cross join bucket;
$$;

-- Tighten the original supersession helper without changing its public signature.
create or replace function public.supersede_memory(old_id uuid, new_id uuid)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  old_namespace text;
  new_namespace text;
  new_is_active boolean;
  new_superseded_by uuid;
begin
  if old_id = new_id then raise exception 'cannot_supersede_self'; end if;

  select namespace into old_namespace from public.memories where id = old_id;
  select namespace, is_active, superseded_by
  into new_namespace, new_is_active, new_superseded_by
  from public.memories where id = new_id;

  if old_namespace is null or new_namespace is null then raise exception 'memory_not_found'; end if;
  if old_namespace <> new_namespace then raise exception 'namespace_mismatch'; end if;
  if not new_is_active or new_superseded_by is not null then raise exception 'replacement_not_active'; end if;

  update public.memories
  set superseded_by = new_id, is_active = false
  where id = old_id;
end;
$$;

revoke all on function public.store_encrypted_secret(text, text, text, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_encrypted_secret(text, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.retire_encrypted_secret(text, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.check_memory_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.supersede_memory(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.store_encrypted_secret(text, text, text, text, jsonb, uuid, uuid)
  to service_role;
grant execute on function public.get_encrypted_secret(text, text, uuid, uuid)
  to service_role;
grant execute on function public.retire_encrypted_secret(text, text, uuid, uuid)
  to service_role;
grant execute on function public.check_memory_rate_limit(text, text, integer, integer)
  to service_role;
grant execute on function public.supersede_memory(uuid, uuid)
  to service_role;

comment on table public.memory_clients is
  'Hashed API credentials and least-privilege namespace grants. Raw tokens are never stored.';
comment on table public.memory_secrets is
  'Metadata registry for encrypted Supabase Vault secrets. Plaintext and ciphertext never live here.';
comment on table public.memory_audit_log is
  'Security audit metadata only. Never store memory content, raw tokens, or secret values here.';
comment on table public.memory_rate_limit_buckets is
  'Fixed-window per-client abuse control. Buckets contain identifiers and counts, never credential material.';
