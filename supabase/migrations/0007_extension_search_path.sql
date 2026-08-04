-- 0007_extension_search_path.sql
--
-- Companion to 0006. Moving pgvector and pg_trgm out of `public` relocates their
-- OPERATORS too (`<=>`, `<->`, `%`). Unlike types and index operator classes,
-- which resolve by OID, operators inside a function body are resolved against
-- that function's own pinned `search_path` at execution time. Upstream pins
-- `set search_path = public, pg_temp`, so after 0006 every vector search fails with:
--
--   operator does not exist: extensions.vector <=> extensions.vector
--
-- This was caught by the deployment verification suite, which is why that suite
-- runs on every upgrade (scripts/verify-memory.sh in the Buzz repo).
--
-- The fix is deliberately discovery-based rather than a hardcoded list of
-- signatures: an upstream release that adds or renames a vector-searching
-- function is picked up automatically the next time this runs.

set search_path = public, extensions;

create or replace function public.fix_extension_search_paths()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  patched integer := 0;
begin
  for target in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~ '<=>|<->|similarity\(|word_similarity\('
      -- only touch functions that do not already resolve the extensions schema
      and not coalesce(
        array_to_string(p.proconfig, ',') like '%search_path=%extensions%',
        false
      )
  loop
    execute format(
      'alter function %s set search_path = public, extensions, pg_temp',
      target.signature
    );
    patched := patched + 1;
    raise notice 'patched search_path for %', target.signature;
  end loop;
  return patched;
end;
$$;

revoke all on function public.fix_extension_search_paths() from public, anon, authenticated;
grant execute on function public.fix_extension_search_paths() to service_role;

comment on function public.fix_extension_search_paths() is
  'Re-point functions that use pgvector/pg_trgm operators at the extensions schema. Run after any upstream migration that recreates recall(), compact_memories(), or recall_document_chunks().';

select public.fix_extension_search_paths();
