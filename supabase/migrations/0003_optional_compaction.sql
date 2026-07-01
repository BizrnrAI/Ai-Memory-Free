-- 0003_optional_compaction.sql
--
-- Optional: semantic near-duplicate compaction.
--
-- The core schema (0001) already prevents EXACT duplicates at write time via the
-- `memories_namespace_hash_unique` index on (namespace, content_hash). This adds
-- SEMANTIC near-duplicate merging: two rows that say the same thing in different
-- words (cosine similarity >= a threshold) are collapsed so recall does not return
-- three phrasings of one fact.
--
-- It reuses the existing lifecycle — no new columns, no new state. A weaker
-- near-duplicate is superseded into the stronger one exactly like `supersede_memory`
-- (sets `superseded_by` + `is_active = false`), so it stays fully recoverable and is
-- already excluded from `recall`.
--
-- Safe by default: `dry_run` is TRUE, so the function only REPORTS the pairs it
-- would merge. Review them, then call with `dry_run => false`. A conservative
-- weekly cron is provided COMMENTED OUT at the bottom — opt in when you trust the
-- pairs. Small stores can skip this migration entirely; supersession by the caller
-- is enough for many use cases.
--
-- This mirrors a lesson from the production vault (BizrnrAI/mas-memory): exact-hash
-- dedup is not enough on its own; topical/near-duplicate memories accumulate and
-- dilute retrieval unless something folds them.

create or replace function public.compact_memories(
  similarity_threshold double precision default 0.92,
  older_than interval default interval '7 days',
  memory_namespace text default null,   -- null = every namespace
  dry_run boolean default true
)
returns table (
  canonical_id  uuid,
  superseded_id uuid,
  namespace     text,
  cosine        double precision
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  -- For each live memory `m`, find its single strongest live near-duplicate `lead`
  -- in the same namespace. Fold `m` into `lead` only when `lead` ranks STRICTLY
  -- above `m` by a deterministic total order (importance, then usage, then age,
  -- then id). The asymmetry guarantees the stronger row is always the survivor and
  -- no two rows supersede each other.
  for r in
    select
      m.id        as member_id,
      m.namespace as ns,
      lead.id     as canonical_id,
      1 - (m.embedding <=> lead.embedding) as cosine
    from public.memories m
    join lateral (
      select c.id, c.embedding, c.base_importance, c.access_count, c.created_at
      from public.memories c
      where c.namespace = m.namespace
        and c.is_active
        and c.superseded_by is null
        and c.embedding is not null
        and c.id <> m.id
        and (1 - (c.embedding <=> m.embedding)) >= similarity_threshold
      order by c.base_importance desc, c.access_count desc, c.created_at asc, c.id asc
      limit 1
    ) lead on true
    where m.is_active
      and m.superseded_by is null
      and m.embedding is not null
      and m.created_at < now() - older_than
      and (memory_namespace is null or m.namespace = memory_namespace)
      and (
        lead.base_importance > m.base_importance
        or (lead.base_importance = m.base_importance and lead.access_count > m.access_count)
        or (lead.base_importance = m.base_importance and lead.access_count = m.access_count and lead.created_at < m.created_at)
        or (lead.base_importance = m.base_importance and lead.access_count = m.access_count and lead.created_at = m.created_at and lead.id < m.id)
      )
  loop
    canonical_id  := r.canonical_id;
    superseded_id := r.member_id;
    namespace     := r.ns;
    cosine        := r.cosine;
    return next;

    if not dry_run then
      update public.memories
      set superseded_by = r.canonical_id,
          is_active = false,
          metadata = metadata || jsonb_build_object(
            'compacted_at', now(),
            'compacted_into', r.canonical_id,
            'compact_cosine', round(r.cosine::numeric, 4)
          )
      where id = r.member_id
        and is_active
        and superseded_by is null;
    end if;
  end loop;
end;
$$;

revoke all on function public.compact_memories(double precision, interval, text, boolean)
  from public, anon, authenticated;
grant execute on function public.compact_memories(double precision, interval, text, boolean)
  to service_role;

-- Optional weekly compaction (opt in). Uncomment after reviewing a dry run:
--   select * from public.compact_memories();                 -- preview (dry run)
--   select * from public.compact_memories(dry_run => false); -- apply once
--
-- create extension if not exists pg_cron;
-- select cron.schedule(
--   'ai-memory-free-compact',
--   '30 4 * * 0',  -- Sundays 04:30 UTC, after decay/expire
--   $$ select public.compact_memories(0.92, interval '7 days', null, false); $$
-- );
