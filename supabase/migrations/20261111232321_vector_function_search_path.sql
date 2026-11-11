-- Repair already-installed routines after pgvector was moved to extensions.
-- Keep the same signatures, permissions, bodies and iterative-scan settings.
do $$
declare
  vector_schema text;
  function_path text;
begin
  select n.nspname into strict vector_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';
  function_path := case when vector_schema in ('public', 'extensions')
    then 'public, extensions, pg_temp'
    else format('public, %I, pg_temp', vector_schema)
  end;

  execute format(
    'alter function public.recall(%I.vector, text, integer, integer, text) set search_path = %s',
    vector_schema, function_path
  );
  execute format(
    'alter function public.recall_document_chunks(%I.vector, text, integer, integer, text) set search_path = %s',
    vector_schema, function_path
  );
  execute format(
    'alter function public.compact_memories(double precision, interval, text, boolean) set search_path = %s',
    function_path
  );
end
$$;
