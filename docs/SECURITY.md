# Security

## Threat Model

The public attack surface is one Supabase Edge Function. Threats include stolen
caller tokens, cross-namespace access, secret leakage into recall or logs,
unauthorized decryption, embedding-cost exhaustion, oversized inputs, malicious
browser origins, database error disclosure, and untraceable mutations.

Postgres is not a public client API. Public tables have RLS enabled;
`public`, `anon`, and `authenticated` privileges are revoked. The Edge Function
uses the service role only after authenticating and authorizing the caller.

## Two Different Credential Classes

### Caller Access Tokens: Hashed

Each MCP client, agent, service, or operator receives a unique high-entropy token:

```bash
npm run token:create -- \
  --name deployment-agent \
  --namespaces platform \
  --permissions memory:read,memory:write \
  --expires 2027-01-01T00:00:00Z
```

The command prints the bearer token once and emits SQL containing only its SHA-256
hash. Generated tokens carry at least 288 bits of randomness, so indexed SHA-256
lookup is appropriate. The database cannot reconstruct the bearer token.

Each `memory_clients` row supports explicit namespaces, permissions, expiry,
immediate revocation, a safe display prefix, and last-use metadata.

### Platform Secrets: Encrypted With Supabase Vault

Recoverable vendor API keys and platform secrets are stored through Supabase Vault,
not application crypto and not the semantic memory table.

Supabase Vault provides authenticated encryption for `vault.secrets`, exposes
on-demand decryption through `vault.decrypted_secrets`, and keeps the encryption key
outside the database. Encrypted values remain protected in database backups and
replication streams. See the [official Vault documentation](https://supabase.com/docs/guides/database/vault).

`public.memory_secrets` stores only:

- namespace and logical name
- safe description and metadata
- Vault secret UUID
- version, active state, access counters, and actor timestamps

It stores neither plaintext nor ciphertext. The Edge API can cross into Vault only
through security-definer RPCs that pin `search_path`, check the service-role caller,
and have execute revoked from public/anon/authenticated.

## Permissions

| Permission | Capability |
| --- | --- |
| `memory:read` | recall ranked memory |
| `memory:write` | remember, retire, supersede |
| `memory:admin` | implies memory read/write |
| `secrets:list` | encrypted-secret metadata only |
| `secrets:read` | explicitly decrypt one active Vault secret |
| `secrets:write` | create or rotate a Vault secret |
| `secrets:admin` | implies secret list/read/write and allows retirement |

A client must have both the action permission and the target namespace grant.
Use separate memory and secret tokens unless one trusted process genuinely needs
both. Grant `secrets:read` more narrowly than `secrets:list`.

## Secret API Guarantees

- `secret_store`: sends plaintext only to the authenticated Edge function and
  `vault.create_secret`/`vault.update_secret`; returns safe registry metadata.
- `secret_get`: decrypts one named active secret and returns it only to a client with
  `secrets:read` for that namespace.
- `secret_list`: never reads Vault and never returns plaintext or ciphertext.
- `secret_retire`: disables API retrieval without deleting the encrypted Vault row;
  a later store rotates/reactivates it.

Secret values never enter memory content, embeddings, FTS, source/tags/metadata,
audit details, application logs, error responses, or list results. Ordinary
`remember` rejects high-confidence credential patterns across content and metadata
by default.

## Service Role And Vault Boundary

Supabase service/secret keys bypass RLS and are backend-only credentials. Never put
them in MCP client config, browsers, mobile apps, logs, or git. The Vault schema is
not part of the exposed public Data API schema. Application clients receive only
Ai-Memory-Free scoped tokens and cannot query Postgres or Vault directly.

The service role is intentionally powerful; the security-definer wrapper narrows
the application's normal code path but is not a substitute for protecting the
service-role key itself.

## Bootstrap Token

For upgrade compatibility, an Edge Function `MEMORY_TOKEN` may act as a wildcard
bootstrap administrator. It is compared in constant time and never logged. It has
no per-client revocation or namespace boundary, so leave it unset after provisioning
scoped clients whenever possible.

## Abuse Controls

Every authenticated request consumes an atomic database rate-limit bucket:

- secret decryption: 30/minute/client
- remember and recall: 60/minute/client/action
- other actions: 120/minute/client/action

Buckets older than two days are pruned automatically. Requests are capped at 1 MiB;
memory content is capped at 100,000 characters and stored secrets at 16,384.

## Browser Origins

Browser CORS is denied unless `MEMORY_ALLOWED_ORIGINS` contains the exact origin.
Do not use `*` in production. Backend and stdio MCP calls have no `Origin` header.

## Error, Logging, And Audit Rules

- callers receive stable error codes, never raw Postgres/Vault messages
- unexpected failures include a request ID
- logs contain request ID, action, error type, and bounded database code only
- audit rows contain identifiers and outcomes only
- tokens, secrets, Authorization headers, ciphertext, content, and request bodies
  must never be logged

Memory mutations and every secret operation write `memory_audit_log`. The table is
insert-only for the service role. Recall logging is opt-in via
`MEMORY_AUDIT_READS=true` to conserve free-tier space.

## Rotation And Revocation

Caller token rotation:

1. Generate and insert a replacement token hash.
2. Verify `whoami`, remember, and recall with the new token.
3. Update the external client's secret store.
4. Set `revoked_at = now()` on the old client.
5. Prove the old token receives 401.

Vault secret rotation calls `secret_store` with the same namespace/name and a new
value. Vault updates the authenticated ciphertext; the registry version increments.
Prove `secret_get` returns the replacement before revoking the old vendor value.

## MCP Secret Access

Secret tools are not registered unless `MCP_ENABLE_SECRET_TOOLS=true`. A separate
Edge permission check still applies. Because `memory_secret_get` returns plaintext
to the MCP client and potentially its model context, enable it only in a dedicated,
trusted process. Tool visibility is never treated as authorization.

## Backups And Data Classification

Memories and secret metadata may be sensitive. Vault ciphertext remains encrypted
in database dumps because its encryption key is stored separately by Supabase.
Still encrypt backup files, restrict access, and test restores. A restored project
must have the correct Supabase Vault key context to decrypt its Vault data.
