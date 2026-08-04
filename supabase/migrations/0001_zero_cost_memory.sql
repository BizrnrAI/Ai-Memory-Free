-- Supabase preinstalls pgcrypto into the "extensions" schema, so the statement
-- below no-ops and digest() is not visible to the migration role. Generated
-- columns resolve functions at DDL time, so the search_path must be widened
-- before public.memories is created. Naming a schema that does not exist is
-- silently ignored by Postgres, so this stays correct on vanilla installs.
set search_path = public, extensions;

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  namespace text not null default 'default',
  content text not null,
  content_hash text generated always as (encode(digest(content, 'sha256'), 'hex')) stored,
  kind text not null default 'note',
  importance double precision not null default 0.5,
  base_importance double precision not null default 0.5,
  access_count integer not null default 0,
  is_active boolean not null default true,
  superseded_by uuid references public.memories(id),
  source text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(384),
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint memories_kind_check check (
    kind in ('note', 'fact', 'decision', 'correction', 'reference', 'procedure')
  ),
  constraint memories_importance_check check (importance >= 0 and importance <= 1),
  constraint memories_base_importance_check check (base_importance >= 0 and base_importance <= 1)
);

create unique index if not exists memories_namespace_hash_unique
  on public.memories(namespace, content_hash);

create index if not exists memories_vec
  on public.memories using hnsw (embedding vector_cosine_ops);

create index if not exists memories_fts
  on public.memories using gin (fts);

create index if not exists memories_live_namespace
  on public.memories(namespace, is_active)
  where is_active;

create index if not exists memories_tags
  on public.memories using gin (tags);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists memories_touch_updated_at on public.memories;
create trigger memories_touch_updated_at
before update on public.memories
for each row execute function public.touch_updated_at();

alter table public.memories enable row level security;

revoke all on table public.memories from public, anon, authenticated;
grant all on table public.memories to service_role;

create or replace function public.recall(
  query_embedding vector(384),
  query_text text,
  match_limit int default 8,
  pool int default 200,
  memory_namespace text default 'default'
)
returns table (
  id uuid,
  namespace text,
  content text,
  kind text,
  source text,
  tags text[],
  metadata jsonb,
  base_importance double precision,
  access_count integer,
  effective_score double precision,
  rrf_norm double precision,
  final_score double precision,
  created_at timestamptz,
  last_accessed_at timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  with args as (
    select
      greatest(1, least(coalesce(match_limit, 8), 50)) as match_limit,
      greatest(10, least(coalesce(pool, 200), 1000)) as pool,
      coalesce(nullif(memory_namespace, ''), 'default') as namespace
  ),
  vec as (
    select m.id, row_number() over (order by m.embedding <=> query_embedding) as rank
    from public.memories m, args a
    where m.namespace = a.namespace
      and m.is_active
      and m.superseded_by is null
      and m.embedding is not null
    order by m.embedding <=> query_embedding
    limit (select pool from args)
  ),
  fts as (
    select m.id,
           row_number() over (
             order by ts_rank(m.fts, websearch_to_tsquery('english', query_text)) desc
           ) as rank
    from public.memories m, args a
    where m.namespace = a.namespace
      and m.is_active
      and m.superseded_by is null
      and m.fts @@ websearch_to_tsquery('english', query_text)
    limit (select pool from args)
  ),
  fused as (
    select coalesce(v.id, f.id) as id,
           coalesce(1.0 / (60 + v.rank), 0) + coalesce(1.0 / (60 + f.rank), 0) as rrf
    from vec v
    full outer join fts f using (id)
  ),
  norm as (
    select id,
           case
             when max(rrf) over () = min(rrf) over () then 1.0
             else (rrf - min(rrf) over ()) / nullif(max(rrf) over () - min(rrf) over (), 0)
           end as rrf_norm
    from fused
  ),
  scored as (
    select
      m.id,
      m.namespace,
      m.content,
      m.kind,
      m.source,
      m.tags,
      m.metadata,
      m.base_importance,
      m.access_count,
      greatest(0.05, least(1.0,
            1.0 * m.base_importance
          + 0.15 * ln(1 + m.access_count) / ln(1 + 50)
          - 0.15 * least(
              extract(days from now() - coalesce(m.last_accessed_at, m.created_at)) / 180.0,
              1.0
            )
      )) as effective_score,
      coalesce(n.rrf_norm, 0) as rrf_norm,
      m.created_at,
      m.last_accessed_at
    from norm n
    join public.memories m on m.id = n.id
  )
  select
    s.id,
    s.namespace,
    s.content,
    s.kind,
    s.source,
    s.tags,
    s.metadata,
    s.base_importance,
    s.access_count,
    s.effective_score,
    s.rrf_norm,
    1.0 * s.rrf_norm + 0.15 * s.effective_score as final_score,
    s.created_at,
    s.last_accessed_at
  from scored s
  order by final_score desc
  limit (select match_limit from args);
$$;

create or replace function public.bump_access(ids uuid[])
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.memories
  set access_count = access_count + 1,
      last_accessed_at = now()
  where id = any(ids);
$$;

create or replace function public.supersede_memory(old_id uuid, new_id uuid)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.memories
  set superseded_by = new_id,
      is_active = false
  where id = old_id
    and id <> new_id;
$$;

create or replace function public.retire_memory(memory_id uuid, reason text default null)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.memories
  set is_active = false,
      metadata = metadata || jsonb_build_object(
        'retired_at', now(),
        'retired_reason', coalesce(reason, 'not specified')
      )
  where id = memory_id;
$$;

revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.recall(vector, text, int, int, text) from public, anon, authenticated;
revoke all on function public.bump_access(uuid[]) from public, anon, authenticated;
revoke all on function public.supersede_memory(uuid, uuid) from public, anon, authenticated;
revoke all on function public.retire_memory(uuid, text) from public, anon, authenticated;

grant execute on function public.touch_updated_at() to service_role;
grant execute on function public.recall(vector, text, int, int, text) to service_role;
grant execute on function public.bump_access(uuid[]) to service_role;
grant execute on function public.supersede_memory(uuid, uuid) to service_role;
grant execute on function public.retire_memory(uuid, text) to service_role;
