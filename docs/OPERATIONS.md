# Operations

## Deploy

```bash
npm ci
supabase link --project-ref YOUR_PROJECT_REF
supabase migration up --linked
supabase functions deploy memory --no-verify-jwt
```

Apply schema changes through a controlled migration process for shared or
production databases. Migration `0004` enables Supabase Vault and is required for
scoped clients, encrypted secrets, audit events, rate limits, and cross-namespace
supersession protection.

Migration `0008` enables pgvector 0.8+ iterative index scans on the hybrid-search
functions so namespace-filtered vector recall does not degrade as more namespaces
share one database. It is guarded: on pgvector below 0.8 it records itself and
changes nothing, and it can be re-applied after a pgvector upgrade. Versions
`0006` and `0007` are intentionally unused upstream.

Migration `0013` gives recall its third ranked list (memories sharing any word
with the query), adds `source_system` and `external_id` to recall rows, fixes the
full-text pool ordering, and re-applies the iterative-scan setting from `0008`,
which recreating a function discards. Versions `0009`–`0012` are intentionally
unused upstream. Apply it before deploying the v1.4 function: the function reads
the new columns. See [UPGRADE_V1_4.md](UPGRADE_V1_4.md).

Migration `0005` adds v1.2 modules. It is additive and leaves the v0.2 memory table,
inline embeddings, actions, and tokens compatible. Follow
[UPGRADE_V1_2.md](UPGRADE_V1_2.md) for the effect checks.

## Settings

All optional. Set them with `supabase secrets set NAME=value` and redeploy.

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMORY_EMBED_CHARS_PER_REQUEST` | `3600` | Characters one request may hand to the embedding model. The default is the largest size that never failed on hosted Supabase (see [RETRIEVAL.md](RETRIEVAL.md)). Raise it only on a runtime without the 2-second CPU limit; `14400` restores the old eight-chunk average |
| `MEMORY_EMBEDDINGS` | `on` | `off` runs keyword-only: nothing is embedded, no request can hit the CPU limit, and recall loses the matches that share no words with the query |
| `MEMORY_MAX_CONTENT_BYTES` | unset | Operator cap on one memory's content, in UTF-8 bytes. Unset means only the 100,000-character limit applies |
| `MEMORY_SUPABASE_SECRET_KEY_NAME` | `default` | Which entry of `SUPABASE_SECRET_KEYS` the function uses |
| `MEMORY_REJECT_LIKELY_SECRETS` | `true` | Refuse content that looks like a credential |
| `MEMORY_AUDIT_READS` | `false` | Also audit recall metadata |
| `MEMORY_ALLOWED_ORIGINS` | empty | Exact browser origins allowed by CORS |

`health` reports the limits in force, whether embeddings are on, and which
Supabase key the function is running on.

## Supabase API Keys

Supabase is retiring the JWT `anon` and `service_role` keys at the end of 2026
in favour of publishable and secret keys. The Edge runtime provides the secret
keys as `SUPABASE_SECRET_KEYS` (a JSON dictionary keyed by key name) and still
sets `SUPABASE_SERVICE_ROLE_KEY` to the legacy key. The function uses the
`default` secret key when the runtime provides one and the legacy key
otherwise, so a project keeps working when its legacy keys are disabled.

Before disabling legacy keys on a project, confirm `health` returns
`"server_key": "secret_keys"`. If it returns `service_role`, create a secret key
named `default` in the dashboard (or point `MEMORY_SUPABASE_SECRET_KEY_NAME` at
the one you have) and redeploy.

## HTTP 546

A 546 with no JSON body means the worker serving the request ran out of CPU. It
is safe to send the request again — the next one gets a fresh worker — except
for `secret_store` and an `event_append` without an `external_id`. The bundled
client retries twice. If 546s are frequent, lower
`MEMORY_EMBED_CHARS_PER_REQUEST` to `1800`, or set `MEMORY_EMBEDDINGS=off`.

## Provision A Client

```bash
npm run token:create -- \
  --name codex-platform \
  --namespaces platform \
  --permissions memory:read,memory:write
```

Store the printed token in the caller's secret store. Review and execute the
printed SQL, which contains only the token hash.

Recommended roles:

```text
read-only agent:       memory:read
normal memory agent:   memory:read,memory:write
secret inventory:      secrets:list
secret consumer:       secrets:list,secrets:read
secret operator:       secrets:admin
```

Avoid `*`. Use separate memory and secret tokens unless one human-operated process
genuinely needs both.

## Store And Read A Vault Secret

Use the TypeScript client so plaintext is taken from the process environment rather
than a shell argument or committed file:

```ts
import { MemoryClient } from '@ai-memory-free/client';

const client = new MemoryClient();

await client.storeSecret({
  namespace: 'platform',
  name: 'stripe.api-key',
  secret: process.env.STRIPE_SECRET_KEY!,
  description: 'Stripe server credential',
  metadata: { owner: 'billing' },
});

const result = await client.getSecret({
  namespace: 'platform',
  name: 'stripe.api-key',
});

// Use result.secret.secret without logging it.
```

`secret_store` creates or rotates the Supabase Vault row. `secret_get` increments
access metadata and writes an audit event. `secret_list` returns safe registry
metadata only.

## Smoke Test The Effect

`health` proves reachability, not authorization effect. Verify identity, then write
and recall a disposable memory in an authorized namespace:

```bash
curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"whoami"}'

curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"remember","namespace":"platform","content":"smoke-test marker 2026-07-09","kind":"reference","tags":["smoke-test"]}'

curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"recall","namespace":"platform","query":"smoke test marker","track":false}'
```

Retire the returned test ID after verifying it appears.

## Rotate Or Revoke

1. Generate and insert a replacement token hash.
2. Verify `whoami`, remember, and recall using the replacement.
3. Update the client secret store.
4. Revoke the old row:

```sql
update public.memory_clients
set revoked_at = now()
where id = 'OLD_CLIENT_UUID';
```

5. Verify the old token gets 401.

Inspect active clients without exposing token hashes:

```sql
select id, name, token_prefix, allowed_namespaces, permissions,
       expires_at, revoked_at, last_used_at, created_at
from public.memory_clients
order by created_at desc;
```

## Browser CORS

Browser callers require an exact allowlist:

```bash
supabase secrets set MEMORY_ALLOWED_ORIGINS="https://app.example.com,https://admin.example.com"
supabase functions deploy memory --no-verify-jwt
```

Do not use `*` for a production browser integration. Stdio MCP and server callers
do not send an `Origin` header.

## Backups

Free Supabase projects do not include managed backups. Use an encrypted destination:

```bash
pg_dump "$DATABASE_URL" --format=custom \
  --file "backups/ai-memory-free-$(date +%Y%m%d).dump"
```

A backup is not proven until it restores into an isolated project and the restored
memory can be recalled. Restrict backup access because memory, client-token hashes,
and Vault-encrypted secrets are all sensitive. Vault ciphertext remains encrypted
in the dump, but backup access should still be restricted.

## Keepalive And Capacity

Free projects may pause after a low-activity week. A scheduled authenticated
`health` request can keep a lightly used project active, but verify current vendor
terms before relying on it.

The repository ships an optional ready-made workflow at
`.github/workflows/keepalive.yml`. It is disabled by default: add the
`MEMORY_API_URL` and `MEMORY_TOKEN` repository secrets, then set a repository
variable `KEEPALIVE_ENABLED` to `true`. It sends one authenticated `health`
request twice a week. GitHub itself disables scheduled workflows in repositories
with no activity for sixty days, so a fully idle fork still needs an occasional
manual run.

Monitor database size:

```sql
select pg_size_pretty(pg_database_size(current_database()));
```

`MEMORY_AUDIT_READS` defaults to false so reads do not consume audit space. Rate
limit buckets automatically prune after two days.

For a safe namespace-scoped overview, call `maintenance_status`. It reports counts,
inactive memory, unverified sources, modules, and the active embedding profile
without returning stored content. `embedding_reindex` requires `memory:admin`; it
stops when the request's embedding budget is spent and tells the caller where to
continue. `maintenance_status` also reports document chunks still waiting for a
vector.

## Portable Copies

Use `npm run portable` for checksummed, provider-mobility exports and
[PORTABILITY.md](PORTABILITY.md) for the restore procedure. Portable files exclude
security state but still contain memory content and must be encrypted at rest.

## Optional Memory Maintenance

`0002_optional_maintenance.sql` installs decay and expiry cron jobs.

`0003_optional_compaction.sql` provides dry-run semantic near-duplicate detection:

```sql
select * from public.compact_memories();
select * from public.compact_memories(0.94, interval '14 days', 'platform');
select * from public.compact_memories(dry_run => false);
```

Review dry-run pairs before enabling writes or the commented weekly cron.

## Retrieval Eval

Copy the example fixture to an ignored local path, seed real IDs, and run:

```bash
MEMORY_EVAL_FIXTURES=eval/fixtures.local.json npm run eval
```

Ranking, embedding, chunking, or compaction changes require an updated eval or a
written reason in `docs/DECISIONS.md`.

v1.2 fixtures may additionally assert forbidden IDs, the expected top ID, and a
minimum top score. Use these gates for stale/conflicting knowledge and profile
migrations.

## Incident Checklist

If a client token leaks:

1. Revoke its row immediately.
2. Confirm the old token returns 401.
3. Generate a replacement with no broader permissions than the old token.
4. Inspect `memory_audit_log` for the client ID and exposure window.
5. Review affected namespaces and rotate any Vault secrets that client could read.
6. Search git history and logs for the leaked fragment; never paste the full token
   into an issue or incident note.
