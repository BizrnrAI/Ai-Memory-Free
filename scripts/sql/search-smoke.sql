-- Checks the search functions against a freshly migrated database. No
-- embeddings are involved: a NULL query vector means "no vector list", so every
-- assertion here is about the full-text lists, the filters and the settings,
-- and the result is the same on every run.
--
--   supabase db start
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f scripts/sql/search-smoke.sql
--
-- Everything is rolled back.
begin;

insert into public.memories (namespace, content, kind, source_system, external_id) values
  ('sql-smoke', 'The deploy pipeline publishes on every merge to main.', 'procedure', 'smoke', 'deploy'),
  ('sql-smoke', 'ORDER_EXPORT_V2 runs nightly at two in the morning.', 'fact', 'smoke', 'export'),
  ('sql-smoke', 'Preview deployments sit behind a login page.', 'note', null, null),
  ('sql-smoke-other', 'The deploy pipeline of a different project.', 'note', null, null);
insert into public.memories (namespace, content, kind, is_active) values
  ('sql-smoke', 'The deploy pipeline used to publish by hand. Retired.', 'note', false);

insert into public.memory_documents (id, namespace, title, content) values
  ('00000000-0000-4000-8000-0000000000d1', 'sql-smoke', 'Current runbook', 'current'),
  ('00000000-0000-4000-8000-0000000000d2', 'sql-smoke', 'Old runbook', 'old');
update public.memory_documents set is_active = false where id = '00000000-0000-4000-8000-0000000000d2';
insert into public.memory_document_chunks (document_id, namespace, chunk_index, content) values
  ('00000000-0000-4000-8000-0000000000d1', 'sql-smoke', 0, 'Rotate the signing key every quarter.'),
  ('00000000-0000-4000-8000-0000000000d2', 'sql-smoke', 0, 'Rotate the signing key every year.');

do $$
declare
  top record;
  n integer;
  pgvector integer[];
begin
  -- An identifier is found by the all-words list and comes first.
  select * into top from public.recall(null, 'ORDER_EXPORT_V2', 5, 50, 'sql-smoke') limit 1;
  assert top.external_id = 'export', 'identifier lookup did not return the matching memory first';
  assert top.source_system = 'smoke', 'recall rows must carry source_system';

  -- A question that shares only some words is still answered (the any-word list).
  select count(*) into n from public.recall(null, 'how do I test a preview that needs a login', 5, 50, 'sql-smoke')
  where content like 'Preview deployments%';
  assert n = 1, 'a plain-language question did not find the memory it shares words with';

  -- Nothing leaks across namespaces; retired memories never come back.
  select count(*) into n from public.recall(null, 'deploy pipeline', 10, 50, 'sql-smoke')
  where namespace <> 'sql-smoke' or content like '%Retired.';
  assert n = 0, 'recall returned another namespace or a retired memory';
  select count(*) into n from public.recall(null, 'deploy pipeline', 10, 50, 'sql-smoke');
  assert n >= 1, 'recall found nothing for words that are present';

  -- A query with no searchable words matches nothing rather than everything.
  select count(*) into n from public.recall(null, 'the of and', 10, 50, 'sql-smoke');
  assert n = 0, 'a stop-word query should match nothing';

  -- match_limit is honoured.
  select count(*) into n from public.recall(null, 'deploy pipeline preview nightly', 1, 50, 'sql-smoke');
  assert n = 1, 'match_limit was not honoured';

  -- Document chunks: found by words, and a retired document's chunks are not.
  select count(*) into n from public.recall_document_chunks(null, 'when do we rotate the signing key', 5, 50, 'sql-smoke');
  assert n = 1, 'document search should return the active document''s chunk only';
  select count(*) into n from public.recall_document_chunks(null, 'when do we rotate the signing key', 5, 50, 'sql-smoke')
  where title = 'Old runbook';
  assert n = 0, 'a retired document''s chunk was returned';

  -- Recreating a function drops its settings; 0013 must have put this one back.
  select string_to_array(regexp_replace(extversion, '[^0-9.].*$', ''), '.')::int[] into pgvector
  from pg_extension where extname = 'vector';
  if pgvector >= array[0, 8] then
    select count(*) into n
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('recall', 'recall_document_chunks')
      and exists (select 1 from unnest(p.proconfig) c where c like 'hnsw.iterative_scan=%');
    assert n = 2, 'a search function is missing its hnsw.iterative_scan setting';
  end if;

  -- The search functions stay closed to the public API roles.
  assert not has_function_privilege('anon', 'public.recall(vector, text, integer, integer, text)', 'execute'),
    'anon can execute recall';
  assert not has_function_privilege('authenticated', 'public.recall_document_chunks(vector, text, integer, integer, text)', 'execute'),
    'authenticated can execute recall_document_chunks';
end
$$;

rollback;
\echo search functions: all checks passed
