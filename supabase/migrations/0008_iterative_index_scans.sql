-- 0008_iterative_index_scans.sql
--
-- Enable pgvector 0.8+ iterative index scans on every hybrid-search function.
--
-- The vector arm of public.recall and public.recall_document_chunks filters by
-- namespace and lifecycle before ranking. Before pgvector 0.8 a filtered HNSW
-- scan inspects a fixed candidate set (hnsw.ef_search) and can return fewer
-- rows than requested when most nearby candidates belong to other namespaces
-- ("overfiltering"). Iterative scans keep walking the graph until enough
-- matching rows are found, so recall quality no longer degrades as more
-- namespaces share one database.
--
-- The setting is attached per function (ALTER FUNCTION ... SET), so it applies
-- only for the duration of each call and never changes database-wide behavior.
-- relaxed_order permits slightly out-of-order candidates for speed; Reciprocal
-- Rank Fusion consumes ranks, so local swaps have negligible effect on fused
-- scores.
--
-- Guarded and idempotent: on pgvector < 0.8 (which lacks the GUC) this
-- migration records itself and changes nothing; re-running the block refreshes
-- the same per-function setting. Coverage is discovery-based: every public
-- function whose body performs a vector distance search is included, so an
-- operator can re-run the DO block after upgrading pgvector or adding search
-- functions.
--
-- Numbering note: 0006 and 0007 are intentionally unused upstream; they are
-- reserved by deployment-specific hardening migrations that predate this file.

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
