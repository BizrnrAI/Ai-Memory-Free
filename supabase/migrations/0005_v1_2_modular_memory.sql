-- Ai-Memory-Free v1.2 modular extensions.
--
-- This migration is additive. The v0.2 memories.embedding column and recall RPC
-- remain intact for backwards compatibility. Optional modules are isolated in
-- their own tables and can be ignored by installations that only need core memory.

-- See 0001: digest() lives in the "extensions" schema on Supabase and is used
-- by the memory_documents generated column below.
set search_path = public, extensions;

alter table public.memories
  add column if not exists source_system text,
  add column if not exists external_id text;

create unique index if not exists memories_external_id_unique
  on public.memories(namespace, source_system, external_id)
  where source_system is not null and external_id is not null;

create table if not exists public.memory_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  allowed_namespaces text[] not null default array['default']::text[],
  permissions text[] not null default array['memory:read']::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id),
  constraint memory_oauth_grants_name_check check (char_length(name) between 1 and 128),
  constraint memory_oauth_grants_namespaces_check check (cardinality(allowed_namespaces) between 1 and 128),
  constraint memory_oauth_grants_permissions_check check (cardinality(permissions) between 1 and 32)
);

create table if not exists public.memory_embeddings (
  memory_id uuid not null references public.memories(id) on delete cascade,
  profile text not null,
  model text not null,
  dimensions integer not null,
  strategy text not null,
  embedding vector not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(memory_id, profile),
  constraint memory_embeddings_profile_check check (profile ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_embeddings_dimensions_check check (dimensions between 1 and 16000),
  constraint memory_embeddings_vector_dimensions_check check (vector_dims(embedding) = dimensions)
);

create index if not exists memory_embeddings_gte_small_hnsw
  on public.memory_embeddings
  using hnsw ((embedding::vector(384)) vector_cosine_ops)
  where profile = 'gte-small-v1' and is_active;

create table if not exists public.memory_events (
  id uuid primary key default gen_random_uuid(),
  namespace text not null default 'default',
  event_type text not null,
  summary text not null,
  agent_id text,
  session_id text,
  tool_name text,
  source_system text not null default 'manual',
  external_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_by_type text not null default 'scoped',
  created_by_id text,
  created_at timestamptz not null default now(),
  constraint memory_events_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_events_type_check check (event_type ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_events_source_check check (source_system ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_events_summary_check check (char_length(summary) between 1 and 20000),
  constraint memory_events_payload_check check (jsonb_typeof(payload) = 'object')
);

create unique index if not exists memory_events_external_id_unique
  on public.memory_events(namespace, source_system, external_id)
  where external_id is not null;

create index if not exists memory_events_namespace_occurred
  on public.memory_events(namespace, occurred_at desc);

create table if not exists public.memory_sources (
  id uuid primary key default gen_random_uuid(),
  namespace text not null default 'default',
  uri text not null,
  source_type text not null default 'other',
  title text,
  checksum text,
  confidence double precision not null default 0.8,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by_type text not null default 'scoped',
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(namespace, uri),
  constraint memory_sources_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_sources_uri_check check (char_length(uri) between 1 and 2048),
  constraint memory_sources_type_check check (source_type ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_sources_confidence_check check (confidence between 0 and 1),
  constraint memory_sources_validity_check check (valid_until is null or valid_from is null or valid_until >= valid_from),
  constraint memory_sources_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists memory_sources_namespace_verified
  on public.memory_sources(namespace, last_verified_at desc nulls last);

create table if not exists public.memory_source_links (
  source_id uuid not null references public.memory_sources(id) on delete cascade,
  memory_id uuid not null references public.memories(id) on delete cascade,
  relation text not null default 'supports',
  created_at timestamptz not null default now(),
  primary key(source_id, memory_id, relation),
  constraint memory_source_links_relation_check check (relation in ('supports', 'derived_from', 'verifies'))
);

create index if not exists memory_source_links_memory_id
  on public.memory_source_links(memory_id);

create table if not exists public.memory_links (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  source_memory_id uuid not null references public.memories(id) on delete cascade,
  target_memory_id uuid not null references public.memories(id) on delete cascade,
  relation text not null,
  is_active boolean not null default true,
  note text,
  created_by_type text not null default 'scoped',
  created_by_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(source_memory_id, target_memory_id, relation),
  constraint memory_links_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_links_relation_check check (relation in ('supports', 'contradicts', 'derived_from', 'related_to')),
  constraint memory_links_not_self_check check (source_memory_id <> target_memory_id),
  constraint memory_links_note_check check (note is null or char_length(note) <= 2048)
);

create index if not exists memory_links_target_memory
  on public.memory_links(target_memory_id);

create index if not exists memory_links_namespace_active
  on public.memory_links(namespace, is_active, relation);

create table if not exists public.memory_documents (
  id uuid primary key default gen_random_uuid(),
  namespace text not null default 'default',
  title text not null,
  source_uri text,
  media_type text not null default 'text/plain',
  content text not null,
  content_hash text generated always as (encode(digest(content, 'sha256'), 'hex')) stored,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by_type text not null default 'scoped',
  created_by_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(namespace, content_hash),
  constraint memory_documents_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_documents_title_check check (char_length(title) between 1 and 512),
  constraint memory_documents_content_check check (char_length(content) between 1 and 500000),
  constraint memory_documents_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists memory_documents_namespace_active
  on public.memory_documents(namespace, is_active, created_at desc);

create table if not exists public.memory_document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.memory_documents(id) on delete cascade,
  namespace text not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(384),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  unique(document_id, chunk_index),
  constraint memory_document_chunks_namespace_check check (namespace ~ '^[a-zA-Z0-9_.:-]{1,128}$'),
  constraint memory_document_chunks_index_check check (chunk_index >= 0),
  constraint memory_document_chunks_content_check check (char_length(content) between 1 and 4000)
);

create index if not exists memory_document_chunks_namespace
  on public.memory_document_chunks(namespace, document_id);

create index if not exists memory_document_chunks_vec
  on public.memory_document_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists memory_document_chunks_fts
  on public.memory_document_chunks using gin (fts);

alter table public.memory_audit_log
  add column if not exists actor_type text,
  add column if not exists actor_id text;

drop trigger if exists memory_oauth_grants_touch_updated_at on public.memory_oauth_grants;
create trigger memory_oauth_grants_touch_updated_at
before update on public.memory_oauth_grants
for each row execute function public.touch_updated_at();

drop trigger if exists memory_embeddings_touch_updated_at on public.memory_embeddings;
create trigger memory_embeddings_touch_updated_at
before update on public.memory_embeddings
for each row execute function public.touch_updated_at();

drop trigger if exists memory_sources_touch_updated_at on public.memory_sources;
create trigger memory_sources_touch_updated_at
before update on public.memory_sources
for each row execute function public.touch_updated_at();

drop trigger if exists memory_documents_touch_updated_at on public.memory_documents;
create trigger memory_documents_touch_updated_at
before update on public.memory_documents
for each row execute function public.touch_updated_at();

create or replace function public.recall_document_chunks(
  query_embedding vector(384),
  query_text text,
  match_limit integer default 8,
  pool integer default 100,
  memory_namespace text default 'default'
)
returns table (
  id uuid,
  document_id uuid,
  namespace text,
  chunk_index integer,
  content text,
  title text,
  source_uri text,
  rrf_score double precision
)
language sql
stable
set search_path = public, pg_temp
as $$
  with args as (
    select greatest(1, least(coalesce(match_limit, 8), 50)) as match_limit,
           greatest(10, least(coalesce(pool, 100), 500)) as pool,
           coalesce(nullif(memory_namespace, ''), 'default') as namespace
  ),
  vec as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.memory_document_chunks c
    join public.memory_documents d on d.id = c.document_id
    cross join args a
    where c.namespace = a.namespace and d.is_active and c.embedding is not null
    order by c.embedding <=> query_embedding
    limit (select pool from args)
  ),
  fts as (
    select c.id,
           row_number() over (order by ts_rank(c.fts, websearch_to_tsquery('english', query_text)) desc) as rank
    from public.memory_document_chunks c
    join public.memory_documents d on d.id = c.document_id
    cross join args a
    where c.namespace = a.namespace and d.is_active
      and c.fts @@ websearch_to_tsquery('english', query_text)
    limit (select pool from args)
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as score
    from vec v full outer join fts f using (id)
  )
  select c.id, c.document_id, c.namespace, c.chunk_index, c.content,
         d.title, d.source_uri, fused.score::double precision
  from fused
  join public.memory_document_chunks c on c.id = fused.id
  join public.memory_documents d on d.id = c.document_id
  order by fused.score desc
  limit (select match_limit from args);
$$;

create or replace function public.memory_database_size_bytes()
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select pg_database_size(current_database());
$$;

create or replace function public.validate_memory_link_namespaces()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_namespace text;
  target_namespace text;
begin
  select namespace into source_namespace from public.memories where id = new.source_memory_id;
  select namespace into target_namespace from public.memories where id = new.target_memory_id;
  if source_namespace is null or target_namespace is null
     or source_namespace <> target_namespace or source_namespace <> new.namespace then
    raise exception 'namespace_mismatch';
  end if;
  return new;
end;
$$;

create or replace function public.validate_memory_source_link_namespaces()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_namespace text;
  memory_namespace text;
begin
  select namespace into source_namespace from public.memory_sources where id = new.source_id;
  select namespace into memory_namespace from public.memories where id = new.memory_id;
  if source_namespace is null or memory_namespace is null or source_namespace <> memory_namespace then
    raise exception 'namespace_mismatch';
  end if;
  return new;
end;
$$;

create or replace function public.validate_document_chunk_namespace()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  document_namespace text;
begin
  select namespace into document_namespace from public.memory_documents where id = new.document_id;
  if document_namespace is null or document_namespace <> new.namespace then
    raise exception 'namespace_mismatch';
  end if;
  return new;
end;
$$;

drop trigger if exists memory_links_validate_namespaces on public.memory_links;
create trigger memory_links_validate_namespaces
before insert or update on public.memory_links
for each row execute function public.validate_memory_link_namespaces();

drop trigger if exists memory_source_links_validate_namespaces on public.memory_source_links;
create trigger memory_source_links_validate_namespaces
before insert or update on public.memory_source_links
for each row execute function public.validate_memory_source_link_namespaces();

drop trigger if exists memory_document_chunks_validate_namespace on public.memory_document_chunks;
create trigger memory_document_chunks_validate_namespace
before insert or update on public.memory_document_chunks
for each row execute function public.validate_document_chunk_namespace();

alter table public.memory_oauth_grants enable row level security;
alter table public.memory_embeddings enable row level security;
alter table public.memory_events enable row level security;
alter table public.memory_sources enable row level security;
alter table public.memory_source_links enable row level security;
alter table public.memory_links enable row level security;
alter table public.memory_documents enable row level security;
alter table public.memory_document_chunks enable row level security;

revoke all on table public.memory_oauth_grants from public, anon, authenticated;
revoke all on table public.memory_embeddings from public, anon, authenticated;
revoke all on table public.memory_events from public, anon, authenticated;
revoke all on table public.memory_sources from public, anon, authenticated;
revoke all on table public.memory_source_links from public, anon, authenticated;
revoke all on table public.memory_links from public, anon, authenticated;
revoke all on table public.memory_documents from public, anon, authenticated;
revoke all on table public.memory_document_chunks from public, anon, authenticated;

grant all on table public.memory_oauth_grants to service_role;
grant all on table public.memory_embeddings to service_role;
grant all on table public.memory_events to service_role;
grant all on table public.memory_sources to service_role;
grant all on table public.memory_source_links to service_role;
grant all on table public.memory_links to service_role;
grant all on table public.memory_documents to service_role;
grant all on table public.memory_document_chunks to service_role;

revoke all on function public.recall_document_chunks(vector, text, integer, integer, text) from public;
revoke execute on function public.recall_document_chunks(vector, text, integer, integer, text) from anon, authenticated;
grant execute on function public.recall_document_chunks(vector, text, integer, integer, text) to service_role;
revoke all on function public.memory_database_size_bytes() from public;
revoke execute on function public.memory_database_size_bytes() from anon, authenticated;
grant execute on function public.memory_database_size_bytes() to service_role;

revoke all on function public.validate_memory_link_namespaces() from public;
revoke all on function public.validate_memory_source_link_namespaces() from public;
revoke all on function public.validate_document_chunk_namespace() from public;
revoke execute on function public.validate_memory_link_namespaces() from anon, authenticated;
revoke execute on function public.validate_memory_source_link_namespaces() from anon, authenticated;
revoke execute on function public.validate_document_chunk_namespace() from anon, authenticated;
grant execute on function public.validate_memory_link_namespaces() to service_role;
grant execute on function public.validate_memory_source_link_namespaces() to service_role;
grant execute on function public.validate_document_chunk_namespace() to service_role;

comment on table public.memory_events is
  'Optional append-only activity journal. Never store chain-of-thought or secrets.';
comment on table public.memory_embeddings is
  'Optional profile-specific embeddings. The v0.2 inline embedding remains the compatible default.';
comment on table public.memory_oauth_grants is
  'Explicit namespace and permission grants for validated Supabase OAuth users.';
comment on table public.memory_links is
  'Optional evidence relationships. is_active applies to the link, not memory lifecycle.';
