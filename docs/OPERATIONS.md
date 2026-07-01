# Operations

## Deploy

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase migration up --linked
supabase secrets set MEMORY_TOKEN="$(openssl rand -base64 48)"
supabase functions deploy memory --no-verify-jwt
```

For controlled environments, review the SQL and apply migrations through your
normal migration process. For a first free-tier personal install, the Supabase SQL
editor is also acceptable.

## Smoke Test

```bash
curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"health"}'
```

Expected:

```json
{
  "ok": true,
  "service": "ai-memory-free"
}
```

## Backups

Supabase free tier does not include managed backups. Use `pg_dump`:

```bash
pg_dump "$DATABASE_URL" --format=custom --file "backups/ai-memory-free-$(date +%Y%m%d).dump"
```

Test restore into a throwaway project before you trust the backup plan.

## Keepalive

Free Supabase projects can pause after inactivity. Normal use keeps the project
awake. If the memory may sit idle, add a free scheduled workflow or external cron
that calls `health` every few days.

## Optional Maintenance

`0002_optional_maintenance.sql` installs two `pg_cron` jobs:

- decay old unused lifecycle importance
- retire low-value never-used rows after 90 days

`0003_optional_compaction.sql` adds semantic near-duplicate compaction (the core
schema already blocks exact duplicates via the `content_hash` unique index). It is
safe by default — `compact_memories()` runs a dry run and only reports the pairs it
would merge:

```sql
-- preview what would be merged (no writes)
select * from public.compact_memories();

-- tune the threshold / recency window / namespace if you like
select * from public.compact_memories(0.94, interval '14 days', 'default');

-- apply once you trust the pairs (weaker row is superseded into the stronger,
-- recoverable via superseded_by, and already excluded from recall)
select * from public.compact_memories(dry_run => false);
```

To run it automatically, uncomment the commented `ai-memory-free-compact` weekly
cron at the bottom of `0003_optional_compaction.sql` after reviewing a dry run.

Both maintenance migrations are optional. Small stores can skip them — supersession
by the caller is enough for many use cases.

## Retrieval Eval

After seeding memories, replace IDs in `eval/fixtures.example.json`, or create a
private fixture file and set:

```bash
MEMORY_EVAL_FIXTURES=eval/fixtures.local.json npm run eval
```

The live eval calls recall with `track:false` so quality tests do not inflate usage.
