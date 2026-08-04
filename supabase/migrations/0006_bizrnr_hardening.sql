-- 0006_bizrnr_hardening.sql
--
-- Deployment-specific hardening for the Core Infra / MemDB installation.
-- Additive and idempotent; safe to re-run and safe on a fresh database.
--
-- 1. Move extensions out of `public`.
--    Supabase's linter flags this (0014_extension_in_public) because PostgREST
--    exposes the `public` schema, so extension-provided functions become callable
--    by the `anon` and `authenticated` roles. Nothing we own moves: column types,
--    operator classes, and indexes all resolve by OID, so `memories.embedding`,
--    the HNSW index, and `public.recall` are unaffected.
--
-- 2. Deny future objects by default.
--    Every table and function created so far is explicitly revoked from
--    public/anon/authenticated, but that is a per-object discipline that a future
--    migration can forget. Default privileges make the safe outcome automatic.

create schema if not exists extensions;

do $$
declare
  ext text;
begin
  foreach ext in array array['vector', 'pg_trgm', 'pgcrypto', 'pg_stat_statements']
  loop
    if exists (
      select 1
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
      where e.extname = ext and n.nspname = 'public'
    ) then
      execute format('alter extension %I set schema extensions', ext);
      raise notice 'relocated extension % from public to extensions', ext;
    end if;
  end loop;
end
$$;

-- Objects created from here on are closed by default rather than by remembering
-- to revoke. Applies to the role running migrations, which is the only role that
-- creates objects in this deployment.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on sequences from authenticated;

-- Backstop for anything already present that was missed above.
revoke execute on all functions in schema public from anon, authenticated;

comment on schema extensions is
  'Extension objects live here, not in public, so PostgREST does not expose them to anon/authenticated.';
