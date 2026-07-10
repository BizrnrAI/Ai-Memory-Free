# Zero-Cost Single Source Of Truth Memory

This guide defines the secure reference architecture for durable, shared agent
memory on a free Supabase project. It has no generative-model dependency: the
service stores knowledge and returns ranked raw context; the caller reasons.

## 1. Definition Of Done

The system must provide:

- semantic and full-text retrieval
- transparent, measured ranking
- full raw content, provenance, namespaces, and lifecycle history
- one database contract used by HTTPS and MCP callers
- independent, least-privilege caller credentials stored only as hashes
- an isolated encrypted-secret partition with explicit decryption authorization
- RLS, revoked public privileges, bounded inputs, rate limits, and audit metadata
- no paid model API, managed vector database, queue, or always-on default server
- protocol-versioned optional modules for activity, provenance, relationships,
  documents, portability, maintenance, and OAuth MCP

## 2. Two Hosted Components

```text
caller / LLM / MCP
      |
      | scoped HTTPS
      v
Supabase Edge Function
  authenticate -> authorize -> rate limit -> validate -> execute -> audit
      |
      +--> in-edge gte-small embeddings
      |
      v
Supabase Postgres
  memories + clients + Vault secret metadata + audit + rate buckets
      |
      +--> Supabase Vault authenticated ciphertext (key outside database)
```

Everything hosted lives in one free Supabase project. The optional MCP adapter is a
local stdio process and calls the same HTTPS function. v1.2 may also deploy an
optional remote MCP Edge Function protected by Supabase Auth OAuth 2.1.

## 3. Precise Model Agnosticism

No generative model is called by the service. Responses are ordinary JSON and do
not contain provider-specific prompts, tool formats, or syntheses. Any current or
future LLM can consume the same ranked context.

Semantic vectors do require a fixed embedding space. The no-cost default uses
Supabase Edge Runtime `gte-small` (384 dimensions). Changing it requires
re-embedding all active rows and re-running retrieval evals.

v1.2 exposes this default as profile `gte-small-v1` through an `EmbeddingAdapter`.
Profile vectors dual-write to an additive table; the original vector remains the
compatible recall path. Future profiles must own their dimensions, index, reindex,
and eval baseline.

Supabase documents `gte-small` as English-focused and capped at 512 input tokens.
Long memories therefore use bounded multi-chunk averaging: up to eight distributed
chunks are embedded, averaged, and normalized. Postgres FTS indexes the complete raw
content, so no text is discarded.

Official references:

- [Supabase AI models](https://supabase.com/docs/guides/functions/ai-models)
- [Supabase semantic search](https://supabase.com/docs/guides/ai/semantic-search)

## 4. Memory Data Model

Migration `0001_zero_cost_memory.sql` creates `public.memories` with:

- UUID identity and namespace
- raw content and generated SHA-256 content hash
- kind, frozen `base_importance`, mutable lifecycle `importance`
- usage and access timestamps
- one lifecycle signal (`is_active`) plus `superseded_by`
- source, tags, metadata, and timestamps
- `vector(384)` embedding and generated English FTS

`(namespace, content_hash)` prevents exact duplicates. Duplicate remember calls
must return the existing row without modifying frozen ranking state.

RLS is enabled with no public policy. `public`, `anon`, and `authenticated` receive
no table access; only `service_role` can query.

## 5. Retrieval

`public.recall()`:

1. selects a widened vector candidate pool
2. selects a widened FTS candidate pool
3. fuses ranks using Reciprocal Rank Fusion
4. normalizes the fused score
5. blends a bounded effective score
6. returns each score component

```text
effective_score = clamp(
  frozen base importance
  + log-damped access usage
  - bounded age penalty
)

final_score = rrf_norm + 0.15 * effective_score
```

Ranking remains a pure function of current state. `track:false` prevents eval or
system reads from changing access counts.

## 6. Lifecycle And Deduplication

- `retire` marks a row inactive and records safe retirement metadata.
- `supersede` links an old row to an active replacement in the same namespace.
- `0002_optional_maintenance.sql` can decay unused lifecycle importance and expire
  never-used low-value rows.
- `0003_optional_compaction.sql` detects semantic near-duplicates, dry-run first,
  and reuses supersession for recoverable compaction.

Never add a second status/lifecycle field. Never let decay mutate
`base_importance`.

## 7. Hashed Caller Credentials

Migration `0004_scoped_access_and_supabase_vault.sql` adds `memory_clients` and
enables Supabase Vault.
Each outside service receives a generated token such as `amf_...`. The database
stores only:

- SHA-256 token hash
- safe prefix and caller name
- allowed namespaces
- explicit permissions
- expiry, revocation, last-use, and timestamps

Generate a token and hash-only insert:

```bash
npm run token:create -- \
  --name primary-agent \
  --namespaces platform \
  --permissions memory:read,memory:write
```

SHA-256 is used for tokens because they are randomly generated with high entropy
and need indexed authentication lookup. It is not used for human passwords or
lower-entropy vendor secrets.

An optional Edge `MEMORY_TOKEN` remains a wildcard bootstrap credential for
upgrades. Do not use it as the long-term multi-client design.

## 8. Authorization

Permissions are separate from namespace grants:

```text
memory:read      recall
memory:write     remember, retire, supersede
memory:admin     implies read + write
secrets:list     metadata only
secrets:read     decrypt one named active Vault secret
secrets:write    create/rotate encrypted secret
secrets:admin    implies secret permissions + retire
```

ID-based mutation resolves the rows first and applies the same namespace gate. The
supersession RPC independently rejects self-links, cross-namespace links, and
inactive replacements.

## 9. Supabase Vault Encrypted Secrets

Secrets do not belong in semantic memory. Recoverable vendor credentials use
Supabase Vault authenticated encryption. Supabase manages the encryption key
outside the database; `vault.secrets` contains ciphertext and
`vault.decrypted_secrets` decrypts only at query time.

`public.memory_secrets` stores safe namespace/name metadata and a Vault UUID only.
Security-definer RPCs with pinned `search_path` create, rotate, decrypt, and retire
secrets. Public/anon/authenticated cannot execute them.

- `secret_store` creates or rotates Vault ciphertext.
- `secret_get` explicitly decrypts one active name and requires `secrets:read`.
- `secret_list` never reads Vault and returns metadata only.
- `secret_retire` disables application retrieval while keeping ciphertext.

Access tokens remain hashed because they never need recovery; platform secrets are
encrypted because authorized services may need their original values.

Ordinary memory rejects high-confidence credential patterns by default. This guard
is defense in depth and cannot replace secret scanning or operator discipline.

## 10. Abuse And Input Controls

The Edge Function enforces:

- exact browser-origin allowlist (`MEMORY_ALLOWED_ORIGINS`)
- 1 MiB request bodies
- bounded fields, tag counts, identifiers, and UUIDs
- 60/min/client for remember and recall
- 30/min/client for secret verification
- 120/min/client for other actions
- stable public errors rather than raw database errors

Rate limits are atomic Postgres fixed-window buckets and prune after two days.

## 11. Audit

`memory_audit_log` records request ID, caller, action, namespace, resource, outcome,
and non-sensitive details for:

- every memory mutation
- every secret operation
- failed authorized actions

It must never contain memory content, access tokens, plaintext secrets, ciphertext,
or request bodies. Read audit is optional via `MEMORY_AUDIT_READS=true` because full recall
logging can consume the free database quota.

## 12. MCP

The stdio MCP server uses `MEMORY_API_URL` plus a scoped `MEMORY_TOKEN` from its
environment and exposes the same API actions as tools. Secret tools require both:

1. `MCP_ENABLE_SECRET_TOOLS=true`
2. matching `secrets:*` API permissions

For hosted HTTP MCP, follow the current MCP OAuth authorization specification. Do
not expose this stdio adapter as an unauthenticated or bearer-only network service.

## 13. Quality Gate

Keep deployment-specific fixtures of `{query, expected_ids, namespace}`. The eval:

1. calls recall with `track:false`
2. checks all expected IDs in top K
3. reports recall@K
4. fails below the configured threshold

```bash
MEMORY_EVAL_FIXTURES=eval/fixtures.local.json npm run eval
```

Any ranking, chunking, embedding, or compaction change requires an updated eval or
a written reason in `docs/DECISIONS.md`.

## 14. Deployment

```bash
npm ci
supabase link --project-ref YOUR_PROJECT_REF
supabase migration up --linked
npm run token:create -- --name primary-agent --namespaces default \
  --permissions memory:read,memory:write
# Execute the generated hash-only SQL in the Supabase SQL editor.
supabase functions deploy memory --no-verify-jwt
```

Then verify the effect:

1. `whoami` shows the intended identity/grants.
2. `remember` writes a disposable marker in an allowed namespace.
3. `recall` returns the marker.
4. the same token receives 403 for a forbidden namespace.
5. a revoked token receives 401.

## 15. Operations On The Free Tier

Current Supabase Free Plan boundaries include a 500 MB database quota, no managed
backups, free Edge allocation, and possible pause after a low-activity week. Vendor
limits can change; verify official pricing and platform docs before deployment.

- monitor `pg_database_size(current_database())`
- keep recall audit off unless needed
- use optional expiry/compaction carefully
- create encrypted `pg_dump` backups
- prove restore and recall in an isolated project

## 16. Final Checklist

- [ ] migrations `0001` and `0004` applied; optional maintenance reviewed
- [ ] all tables RLS-enabled; public/anon/authenticated privileges absent
- [ ] scoped hashed client created; wildcard bootstrap token not used normally
- [ ] namespace-denial, revocation, and expiry verified
- [ ] long-memory embedding strategy reported by health
- [ ] secret values excluded from semantic memory, lists, logs, and audits
- [ ] Vault plaintext returned only by explicit `secrets:read` action
- [ ] MCP secret tools disabled unless a dedicated operator needs them
- [ ] Node checks, Deno checks/tests, dependency audit, and retrieval eval pass
- [ ] encrypted backup restored and queried successfully

This is the smallest secure memory core that remains no-cost, inspectable, and
usable by any LLM without making the memory service itself model-dependent.
