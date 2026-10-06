# Full-Repository Audit

Audit date: 2026-07-09. Scope: every tracked source, migration, workflow,
configuration, package, fixture, and documentation file in the repository.

## Executive Result

The original repository had a sound minimal retrieval core, but it was safe only
for a single fully trusted caller. Version 0.2.0 keeps the two-component no-cost
architecture while adding the controls required for multiple agents and outside
services: hashed client credentials, least privilege, namespace enforcement,
bounded abuse controls, auditable mutations, and Supabase Vault encrypted secrets.

This file is a dated record. Where a later release changed something it
describes, the note below says so and the current behavior is in the linked
document.

- The long-memory remedy (average up to eight chunks) exceeded the hosted Edge
  CPU limit and failed with HTTP 546. Since v1.4.0 one request embeds two chunks
  by default, the response says whether the vector is `full` or `sampled`, and
  full-text search still covers every character. See [RETRIEVAL.md](RETRIEVAL.md).
- The separate document/chunk schema anticipated under "Deliberate Boundaries"
  shipped in v1.2. See [DOCUMENTS.md](DOCUMENTS.md).
- The migrations verified here are the ones that existed at the audit date. The
  current set is `supabase/migrations/`.

## v1.2 Follow-Up Audit

Follow-up date: 2026-07-10. The twelve roadmap improvements were implemented as
seven optional modules behind backwards-compatible protocol v1:

| Roadmap area | v1.2 disposition |
| --- | --- |
| Versioned contract | Release/protocol/portable versions, module manifests, JSON schemas, action-registry conformance |
| Portability | Checksummed paginated NDJSON, dry-run/write gates, dependency-ordered import, lifecycle second pass |
| Embedding profiles | `EmbeddingAdapter`, explicit `gte-small-v1`, additive profile table, bounded reindex |
| Agent activity | Idempotent append-only events, no default embeddings, no chain-of-thought |
| Provenance/freshness | Sources with confidence, observation, validity, verification, and memory links |
| Idempotent ingestion | External keys and bounded batch memory writes |
| Retrieval regression | Forbidden IDs, expected top ID, minimum score, protocol/module tests |
| Context bundles | One-to-eight explicit namespaces and a whole-response character budget |
| Relationships | Database-enforced same-namespace supports/contradicts/derived/related edges |
| Documents | Isolated raw text/chunks, local safe-text ingester, hybrid chunk recall |
| Maintenance | Namespace counts, inactive/unverified state, profile status, bounded reindex |
| Remote MCP | Optional sessionless HTTP adapter using Supabase OAuth 2.1 grants; no secret tools |

The migration was applied on a clean official Supabase Postgres 17 image. All eight
new tables had RLS enabled with effective anon/authenticated privileges denied. All
new functions pinned `search_path`; direct anon/authenticated execution was denied;
trigger lint returned no findings. Functional probes proved event idempotency,
document FTS recall, and database rejection of cross-namespace relationships and
document chunks.

## Findings And Disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| High | One plaintext `MEMORY_TOKEN` granted wildcard access to every namespace and action. There was no per-client revocation, expiry, identity, or permission model. | Added `memory_clients` with SHA-256 token hashes, prefixes, namespace grants, permissions, expiry, revocation, and last-use metadata. Bootstrap token remains optional only for upgrade compatibility. |
| High | Retirement and supersession accepted IDs without proving the caller could access the rows. The RPC allowed cross-namespace links. | The Edge Function resolves and authorizes each ID; the database RPC independently rejects missing, cross-namespace, inactive, and self-replacement targets. |
| High | The requested secret/token partition did not exist. Putting credentials into `memories` would make them searchable and returnable. | Added `memory_secrets` as a metadata registry over Supabase Vault. Vault stores authenticated ciphertext with a key outside the database; only explicit `secrets:read` calls decrypt. Recall/list never return values. High-confidence secrets are rejected by ordinary `remember` by default. |
| High | No rate limiting protected embedding inference or secret verification. | Added atomic per-client, per-action database buckets with bounded fixed windows and automatic two-day pruning. |
| Medium | CORS allowed every browser origin even though requests carry a bearer token. | Browser CORS now fails closed unless `MEMORY_ALLOWED_ORIGINS` explicitly allows the origin. Backend, curl, and stdio MCP calls send no Origin and continue to work. |
| Medium | Database error messages were returned to callers and could reveal schema/implementation details. | External errors are stable codes; unexpected failures receive a request ID. Logs contain action/type metadata, never request bodies or tokens. |
| Medium | Exact-duplicate upsert rewrote `base_importance`, contradicting the documented frozen ranking invariant. | Duplicate writes now return the existing row without mutating it. |
| Medium | The API accepted 100,000-character memories while `gte-small` truncates each inference at 512 tokens. Semantic ranking represented only the beginning of long content. | Raw content still remains intact for FTS. Semantic embeddings now average up to eight bounded chunks sampled across the full item. |
| Medium | Mutations and secret operations had no actor audit trail. | Added `memory_audit_log` with request, client, action, namespace, resource, outcome, and non-sensitive details. Recall auditing is optional to conserve space. |
| Medium | Secret-capable MCP tools would be dangerous if automatically exposed to every LLM client. | Secret tools are not registered unless `MCP_ENABLE_SECRET_TOOLS=true`; API permissions are still enforced independently. |
| Medium | CI used `npm install` despite a lockfile and did not execute unit tests, Deno tests, or a dependency audit. | CI now uses `npm ci`, runs Node and Deno tests, uses read-only workflow permissions, serializes duplicate runs, and audits runtime dependencies. |
| Medium | The repository had no one-link AI installation contract or safe way to connect an arbitrary existing project. | Added `AI.md`, a copy-paste installation handoff, a complete model-neutral agent contract, and a dry-run-by-default scaffold that never writes credentials or rewrites target source. |
| Low | The client assumed every response was JSON and could throw an unrelated parser error on proxy failures. | Added bounded response parsing, stable errors, and a 30-second timeout. |
| Low | Documentation described “model agnosticism” without separating caller LLM independence from the fixed embedding space. | Docs now state the precise contract: no generative-model dependency; the default semantic index is fixed to Supabase `gte-small` and requires re-embedding if replaced. |
| Low | The project lacked the community, support, citation, machine-readable, and release metadata expected of a public open-source repository. | Added an MIT-first public documentation index, contribution and security policies, issue/PR templates, `CITATION.cff`, `llms.txt`, changelog, FAQ, and public-release checklist. |

## Verification Performed

- TypeScript root and workspace type checks
- Node client tests
- Deno type checks and pure security/helper tests
- documentation contract checks for required files, internal links, anchors,
  canonical URL, license language, secret safety, and creator attribution
- scaffold dry-run and write-mode tests proving no credential is generated or
  persisted and only the three namespaced integration files are created
- `npm audit --omit=dev`
- clean application of migrations `0001`, `0003`, and `0004` to an isolated
  disposable PostgreSQL 17 + pgvector database
- RLS and privilege probes proving `anon` and `authenticated` cannot select new
  tables or execute new RPCs
- service-role execute probes for every new RPC
- `search_path = public, pg_temp` verification for new and replaced functions
- functional token-bucket test proving requests 1/2 pass and request 3 is denied
- functional cross-namespace supersession test proving rejection without mutation
- Supabase Vault create/decrypt/rotate/retire checks proving the public registry
  contains neither plaintext nor ciphertext

## Deliberate Boundaries

1. `gte-small` is English-focused. This repository remains LLM-agnostic, but the
   default embedding model is not multilingual. Replacing it requires a full
   re-embedding migration and a retrieval eval.
2. Chunk averaging creates one representative vector per memory. It prevents silent
   head-only truncation without adding tables, but a large document corpus may
   eventually justify a separate document/chunk schema.
3. The default MCP transport remains stdio. Official MCP guidance expects
   environment credentials for stdio and OAuth 2.1 for hosted HTTP. Shipping a
   remotely reachable bearer-only MCP endpoint would be a security regression.
4. Recoverable vendor credentials use Supabase Vault authenticated encryption and
   must never be returned by semantic recall or metadata listing.
5. Supabase free projects have no managed backups and may pause. Operators must run
   and test their own encrypted `pg_dump` recovery process.
