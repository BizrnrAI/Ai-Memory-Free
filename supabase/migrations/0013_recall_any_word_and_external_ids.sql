-- Recall that answers questions as well as keyword lookups.
--
-- WHAT WAS WRONG. Recall fused two ranked lists: nearest embeddings, and
-- full-text matches from websearch_to_tsquery — which requires EVERY word of the
-- query to be in the memory. That is right for a lookup ("ORDER_EXPORT_V2")
-- and almost always empty for a question written in the asker's own words
-- ("how do I test a preview that sits behind a login"). Measured
-- on 227 real project memories and 36 questions with known answers, the
-- all-words list found nothing for 17 of 20 plain-language questions, so for
-- questions recall was embeddings alone.
--
-- WHAT THIS DOES. A third list: memories that share ANY word with the query,
-- ranked by how well they match. The three lists are fused with the same
-- Reciprocal Rank Fusion as before. On the same test the first result was the
-- right one for 27 of 36 queries (23 before) and the right memory was in the top
-- five for 35 of 36 (34 before). Keyword lookups keep their precision because
-- the all-words list is still there.
--
-- ALSO IN THIS FILE
--  * Both full-text lists now take their best `pool` rows. They used LIMIT with
--    no ORDER BY, which keeps arbitrary rows once more than `pool` match.
--  * Rows carry the caller's idempotency identifiers (`source_system`,
--    `external_id`), so a recalled memory can be matched to the record written.
--  * Document chunk search gets the same third list.
--  * A NULL query embedding now means "no vector list" instead of an arbitrary
--    order. The service passes NULL when it runs with MEMORY_EMBEDDINGS=off
--    (keyword-only mode), and rows stored without an embedding were already
--    skipped by the vector list.
--  * PostgreSQL cannot change a function's return type in place, so `recall` is
--    dropped and recreated. DROP discards the function's settings, including the
--    `hnsw.iterative_scan` setting from 0008; the block at the end applies it
--    again to every vector-search function. Any future migration that recreates
--    a search function must do the same.
--
-- Numbering note: 0009–0012 are intentionally unused upstream; like 0006 and
-- 0007 they are taken by deployment-specific migrations. A deployment that
-- already changed `recall` in one of those can apply this file safely.

drop function if exists public.recall(vector, text, integer, integer, text);

create function public.recall(
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
  source_system text,
  external_id text,
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
      coalesce(nullif(memory_namespace, ''), 'default') as namespace,
      websearch_to_tsquery('english', query_text) as all_words,
      -- The same words joined with OR. plainto_tsquery quotes every lexeme, so
      -- swapping its operator is safe; a query of only stop words matches nothing.
      replace(plainto_tsquery('english', query_text)::text, '&', '|')::tsquery as any_word
  ),
  vec as (
    select m.id, row_number() over (order by m.embedding <=> query_embedding) as rank
    from public.memories m, args a
    where m.namespace = a.namespace
      and m.is_active
      and m.superseded_by is null
      and m.embedding is not null
      and query_embedding is not null
    order by m.embedding <=> query_embedding
    limit (select pool from args)
  ),
  fts as (
    select m.id,
           row_number() over (order by ts_rank(m.fts, a.all_words) desc, m.id) as rank
    from public.memories m, args a
    where m.namespace = a.namespace
      and m.is_active
      and m.superseded_by is null
      and m.fts @@ a.all_words
    order by rank
    limit (select pool from args)
  ),
  any_word as (
    select m.id,
           row_number() over (order by ts_rank(m.fts, a.any_word) desc, m.id) as rank
    from public.memories m, args a
    where m.namespace = a.namespace
      and m.is_active
      and m.superseded_by is null
      and m.fts @@ a.any_word
    order by rank
    limit (select pool from args)
  ),
  ranked as (
    select id, rank from vec
    union all
    select id, rank from fts
    union all
    select id, rank from any_word
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as rrf
    from ranked
    group by id
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
      m.source_system,
      m.external_id,
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
    s.source_system,
    s.external_id,
    s.base_importance,
    s.access_count,
    s.effective_score,
    s.rrf_norm,
    1.0 * s.rrf_norm + 0.15 * s.effective_score as final_score,
    s.created_at,
    s.last_accessed_at
  from scored s
  order by final_score desc, s.id
  limit (select match_limit from args);
$$;

revoke all on function public.recall(vector, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.recall(vector, text, integer, integer, text)
  to service_role;

-- Document chunk search: the same three lists. The return type is unchanged, so
-- the function is replaced in place.
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
           coalesce(nullif(memory_namespace, ''), 'default') as namespace,
           websearch_to_tsquery('english', query_text) as all_words,
           replace(plainto_tsquery('english', query_text)::text, '&', '|')::tsquery as any_word
  ),
  vec as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.memory_document_chunks c
    join public.memory_documents d on d.id = c.document_id
    cross join args a
    where c.namespace = a.namespace and d.is_active and c.embedding is not null
      and query_embedding is not null
    order by c.embedding <=> query_embedding
    limit (select pool from args)
  ),
  fts as (
    select c.id,
           row_number() over (order by ts_rank(c.fts, a.all_words) desc, c.id) as rank
    from public.memory_document_chunks c
    join public.memory_documents d on d.id = c.document_id
    cross join args a
    where c.namespace = a.namespace and d.is_active
      and c.fts @@ a.all_words
    order by rank
    limit (select pool from args)
  ),
  any_word as (
    select c.id,
           row_number() over (order by ts_rank(c.fts, a.any_word) desc, c.id) as rank
    from public.memory_document_chunks c
    join public.memory_documents d on d.id = c.document_id
    cross join args a
    where c.namespace = a.namespace and d.is_active
      and c.fts @@ a.any_word
    order by rank
    limit (select pool from args)
  ),
  ranked as (
    select id, rank from vec
    union all
    select id, rank from fts
    union all
    select id, rank from any_word
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from ranked
    group by id
  )
  select c.id, c.document_id, c.namespace, c.chunk_index, c.content,
         d.title, d.source_uri, fused.score::double precision
  from fused
  join public.memory_document_chunks c on c.id = fused.id
  join public.memory_documents d on d.id = c.document_id
  order by fused.score desc, c.id
  limit (select match_limit from args);
$$;

revoke all on function public.recall_document_chunks(vector, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.recall_document_chunks(vector, text, integer, integer, text)
  to service_role;

-- Re-apply iterative HNSW scans (see 0008 for the reasoning behind each step).
do $$
declare
  fn regprocedure;
  ver int[];
  ext_schema text;
begin
  select string_to_array(regexp_replace(e.extversion, '[^0-9.].*$', ''), '.')::int[],
         n.nspname
    into ver, ext_schema
  from pg_extension e
  join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if ver is null or ver < array[0, 8] then
    raise notice 'pgvector % lacks iterative index scans; skipping',
      coalesce(array_to_string(ver, '.'), '(absent)');
    return;
  end if;

  -- Force-load the pgvector library into this session so hnsw.iterative_scan
  -- is a defined (USERSET) parameter. Without this, a non-superuser migration
  -- role — such as `postgres` on hosted Supabase — gets "permission denied to
  -- set parameter" because unknown placeholder GUCs are superuser-only.
  -- Schema-agnostic: works whether the extension lives in public or extensions.
  execute format(
    'select %I.cosine_distance(%L::%I.vector, %L::%I.vector)',
    ext_schema, '[1]', ext_schema, '[1]', ext_schema
  );

  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosrc like '%<=>%'
  loop
    execute format(
      'alter function %s set hnsw.iterative_scan = %L',
      fn,
      'relaxed_order'
    );
    raise notice 'enabled iterative HNSW scans for %', fn;
  end loop;
end
$$;
