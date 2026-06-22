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

Small stores can skip this migration. Supersession is enough for many use cases.

## Retrieval Eval

After seeding memories, replace IDs in `eval/fixtures.example.json`, or create a
private fixture file and set:

```bash
MEMORY_EVAL_FIXTURES=eval/fixtures.local.json npm run eval
```

The live eval calls recall with `track:false` so quality tests do not inflate usage.
