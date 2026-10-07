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

A token is accepted only after its lookup completed and returned an active row.
If the lookup itself fails, the request is refused with 503 `auth_unavailable`
instead of 401, so a caller retries without discarding a valid token; nothing
is ever authenticated without a completed lookup. Last use is recorded
best-effort: a failed write is logged and does not reject the request, so
`last_used_at` can be older than the real last use.

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

The same memory permissions govern events, provenance, relationships, documents,
context, portability, and maintenance. Export/import and embedding reindex require
`memory:admin`. Multi-namespace context fails unless every requested namespace is
explicitly granted.

## OAuth For Remote MCP

The optional HTTP MCP function accepts Supabase Auth OAuth 2.1 access tokens, not
Ai-Memory-Free static remote tokens. The memory API validates the token with
Supabase Auth, then loads an explicit `memory_oauth_grants` row containing
namespaces, permissions, expiry, and revocation state.

OAuth identity alone grants nothing. Grant creation remains a reviewed SQL/admin
operation. Remote MCP never exposes secret actions, and its 401 response advertises
protected-resource metadata for authorization-server discovery.

## v1.2 Module Isolation

Every new table has RLS enabled and direct `public`, `anon`, and `authenticated`
access revoked. Cross-namespace memory, source, relationship, and document links
are rejected both by the Edge API and database triggers. Trigger/RPC functions pin
`search_path` and execute only for `service_role`.

Portable export excludes Vault values/ciphertext, credentials, token hashes, OAuth
grants, embeddings, audit logs, and rate-limit state. The events and documents
modules apply the ordinary secret-material guard and bounded inputs. The local
document ingester accepts only small UTF-8 text files and never fetches URLs or
executes file content.

## Secret API Guarantees

- `secret_store`: sends plaintext only to the authenticated Edge function and
  `vault.create_secret`/`vault.update_secret`; returns safe registry metadata.
- `secret_get`: decrypts one named active secret and returns it only to a client with
  `secrets:read` for that namespace.
- `secret_list`: uses indexed names/safe metadata, name-cursor pagination and a literal name prefix; never reads Vault and never returns plaintext or ciphertext.
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

Supabase is retiring the JWT `service_role` key at the end of 2026 in favour of
secret API keys (`sb_secret_…`). The Edge runtime provides them as
`SUPABASE_SECRET_KEYS`, a JSON dictionary keyed by key name, and the function
uses the `default` entry when it exists (or the name in
`MEMORY_SUPABASE_SECRET_KEY_NAME`), falling back to `SUPABASE_SERVICE_ROLE_KEY`.
`health` reports which one is in use as `server_key`, never the key. A secret
key carries the same power as the service role and needs the same care; the
credential detector rejects one pasted into memory content.

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

## v1.4 Credential Access Hardening

The additive Vault wrapper migration fixes empty-description storage, serializes
first creation and rotation per logical credential, and locks retrieval against
concurrent rotation/retirement. Internal Vault names use a JSON namespace/name
pair so valid identifiers containing colons cannot collide. Existing ciphertext
and Vault UUIDs are preserved; the encryption primitive remains Supabase Vault.

Client requests require HTTPS by default (HTTP loopback is permitted), reject
redirects, and use `cache:no-store`. Private HTTP deployments require explicit
opt-in. Inventory is metadata-only and fully paginated; `getSecrets` decrypts only
1..10 explicit names through individually authorized/audited `secret_get` calls.
Caller authentication tokens remain hash-only. See [SECRETS.md](SECRETS.md) for the
credential retrieval and rotation workflow.
