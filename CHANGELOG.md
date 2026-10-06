# Changelog

Notable changes are documented here. Versions follow semantic versioning after the
first public release.

## Unreleased

### Documentation

- The replication checklist applies every migration in `supabase/migrations/`
  instead of naming the first five, and points at the decision about the
  scheduled decay and expiry jobs.
- The install contract links the v1.4 upgrade guide and no longer quotes an
  action count; `health` is the list.
- Portable import is described as it works since 1.4.0: batches sized from the
  destination's limits.
- The two dated records that describe eight-chunk embeddings (the 2026-07-09
  decision and the audit) now say what replaced it.
- README, `llms.txt`, and the repository map link the release notes, the
  retrieval guide, the credential guide, and the v1.4 upgrade guide.

### Maintenance

- Dependabot leaves `@types/node` major versions alone: they follow the Node
  version CI runs.

## 1.4.0 - 2026-10-06

Upgrade notes: [docs/UPGRADE_V1_4.md](docs/UPGRADE_V1_4.md). Apply the two new
migrations (`0013_recall_any_word_and_external_ids` and
`20261006224234_vault_secret_access_hardening`), redeploy both functions, and
read "Changed" before upgrading a caller that relied on the old duplicate
handling.

### Added

- `list`: read a namespace in a fixed order, a budget-sized page at a time, with
  optional `kinds` and `tags` filters. For a namespace that fits in a model's
  context, reading it whole is the only recall with nothing to miss. Exposed in
  the TypeScript client (`list`, `listAll`) and both MCP adapters (`memory_list`)
- recall and document search fuse a third ranked list: memories that share
  **any** word with the query. The existing full-text list requires every word,
  which is right for an identifier and almost always empty for a question in
  the asker's own words. Measured on 227 real project memories and 36 queries
  with known answers: first result correct for 28 (was 23), correct memory in
  the top five for 35 (was 34). See [docs/RETRIEVAL.md](docs/RETRIEVAL.md)
- a per-request embedding budget. Hosted Supabase kills a worker that spends
  more than about 2 seconds of CPU, and `gte-small` spends most of it; a request
  that embedded more than a few chunks died with HTTP 546. The service now
  embeds at most `MEMORY_EMBED_CHARS_PER_REQUEST` characters per request
  (default 3,600, the largest size that never failed in measurement) and counts
  the fixed price of every model run, so many short texts are budgeted as
  honestly as one long one. A memory of any allowed length is stored and
  keyword-searchable, and a batch that cannot fit is refused up front with
  `413 embedding_budget_exceeded`
- `remember` reports `vector`: `full`, `sampled` or `none`, so a caller knows
  when a long memory's vector stands for a sample of it
- `document_ingest` can replace an earlier version in the same call
  (`supersedes`, `replace_same_title`) and reports what it `retired` (#18)
- CI applies every migration to a fresh database and runs
  `scripts/sql/search-smoke.sql` against the search functions
- documents embed in resumable steps: every chunk is written and full-text
  searchable at once, then embedded as far as the budget allows; sending the
  same document again continues. `document_ingest` returns `chunks_embedded` and
  `chunks_pending`. `embedding_reindex` accepts `target: "document_chunks"`, and
  `target: "missing"` for memories stored without a vector
- `MEMORY_EMBEDDINGS=off`: keyword-only mode. Nothing is embedded and no request
  can hit the CPU limit
- `MEMORY_MAX_CONTENT_BYTES`: an optional operator cap on memory content
- `health` reports `limits`, `embeddings`, and which Supabase key the service
  is running on (`server_key`)
- support for Supabase's new secret API keys: the function reads
  `SUPABASE_SECRET_KEYS` and falls back to the legacy `SUPABASE_SERVICE_ROLE_KEY`,
  which Supabase retires at the end of 2026
- recall, context and list rows carry `source_system` and `external_id`
- client: `MemoryRequestError` (status and details), automatic retry on HTTP
  546, 502 and 503 for requests that are safe to repeat (the remote MCP function
  does the same), `rememberMany` (packs batches to the
  service's budget), `ingestDocumentFully`, `embedPendingDocumentChunks`
- paginated document inventory and soft document retirement (`document_retire`),
  so stale document versions stop competing in search; ingesting a retired
  document again reactivates it
- `.github/dependabot.yml`: weekly grouped updates for npm and GitHub Actions

### Changed

- `remember` with a `source_system` + `external_id` that already exists **with
  different content** now fails with `409 external_id_content_conflict` and the
  existing `memory_id`. It used to return the old row with `created:false`,
  silently discarding the new content. An identical retry still returns the
  existing row
- an unknown `kind` now fails with `400 invalid_kind` instead of being stored as
  a `note`
- `remember_batch` items without a `namespace` take the batch's `namespace`
  instead of `default`
- one text is embedded from at most two evenly spaced 1,800-character windows by
  default (was up to eight, which hosted Supabase could not run). Full-text
  search still indexes every word. Raise `MEMORY_EMBED_CHARS_PER_REQUEST` on a
  runtime without the CPU limit
- `embedding_reindex` stops when the request's embedding budget is spent and
  reports `next_offset` and `done`; `limit` is an upper bound
- error responses may carry machine-readable details beside `error`
- dependencies: `@modelcontextprotocol/server` 2.3.1, `zod` 4.6.5, `tsx`
  4.23.15, `@types/node` 24.19.1, `@supabase/supabase-js` 2.117.2;
  `actions/setup-node` v7

### Documentation

- the optional maintenance jobs (`0002`) retire any memory never recalled with
  tracking after about 90 days, and `list`, `context` and untracked recalls do
  not count; OPERATIONS and RETRIEVAL now say so and show how to remove the jobs

### Fixed

- a duplicate or retried `remember` (and a re-sent import page) embedded the
  text again before discovering it was already stored; the lookup now comes
  first, so retries cost no model time
- portable import made retired documents active again
- portable export pages could repeat or skip rows that share a timestamp
- `remember` returned `500 memory_write_failed` when the content already existed
  and the caller supplied a new `external_id`; it now answers
  `409 content_already_exists` with the existing `memory_id`
- both full-text lists took an arbitrary `pool` of matches instead of the best
  ones once more than `pool` rows matched (LIMIT without ORDER BY)
- a document longer than a few chunks could not be ingested on hosted Supabase,
  and a failed attempt left a document with no chunks that every retry skipped;
  ingest now repairs such a document
- the credential detector did not recognise Supabase secret API keys
  (`sb_secret_…`)
- accept the early `max_characters` context-budget spelling as a compatibility
  alias for canonical `max_chars`, while rejecting out-of-range budgets instead
  of silently ignoring them
- release version strings are checked against `protocol.ts`, so a bump cannot
  leave one behind

### Credential Security And Access

- Preserve Vault authenticated encryption and hash-only caller authentication.
  Add the `vault_secret_access_hardening` migration: secrets work without a
  description, namespace/name pairs cannot collide, and concurrent writes/reads
  serialize so values and versions remain coherent. Existing values are preserved.
- Secret inventory indexes all names and safe descriptive metadata for full-text
  search, with name-cursor pagination and literal name prefixes. Canonical
  `service.environment.credential_type` helpers and server validation prevent
  inconsistent identities without breaking legacy names.
  `listAllSecrets` discovers complete metadata; `getSecrets` and optional stdio
  `memory_secret_get_many` retrieve 1..10 explicitly selected names.
- HTTPS is the client default, with HTTP loopback and explicit private-network
  opt-in. Requests reject redirects and use `cache:no-store`.
- CI exercises encrypted storage, scoped permissions, full discovery, literal
  prefixes, concurrent rotation, retirement, expiry/revocation, and isolation from
  semantic recall and portable export.

### Review Hardening

- Remote OAuth MCP now uses the official SDK for both the 2026-07-28 stateless
  protocol and legacy initialization (#21), validates tool arguments, and reuses
  the client’s batch packing and resumable ingestion.
- `list` preserves whole memory content; an insufficient first-row budget returns
  `413 list_budget_too_small` with `required_chars`. `listAll` retries that offset
  with enough budget.
- Document replacement stores chunks before retiring prior versions. Idempotent
  chunk insertion repairs missing chunks and preserves vectors during retries.
- Reindexing updates the authoritative inline recall vector as well as its
  profile row; portable memory import respects the configured byte cap.
- Retries use an explicit action allowlist, and generic call arguments cannot
  override the selected action. Source-link export pagination includes relation
  as the final ordering key.

## 1.3.0 - 2026-08-19

### Added

- `docs/ACTIONS.md`: complete HTTPS request/response reference for all 27
  protocol v1 actions — fields, bounds, permissions, idempotency semantics, and
  error codes — so any language or agent can integrate without reading the
  Edge Function source

- migration `0008`: pgvector 0.8+ iterative HNSW index scans on the hybrid-search
  functions (guarded, idempotent, per-function scope) so namespace-filtered vector
  recall stays complete as namespaces multiply; verified against a local Supabase
  stack as the non-superuser migration role
- optional `.github/workflows/keepalive.yml` scheduled health ping to keep a
  lightly used free-tier project from pausing; disabled unless the operator sets
  the `KEEPALIVE_ENABLED` repository variable and token secrets

### Changed

- stdio MCP adapter migrated from `@modelcontextprotocol/sdk` 1.x to
  `@modelcontextprotocol/server` 2.0: `registerTool` with explicit `z.object()`
  schemas, and `serveStdio` per-connection era negotiation — modern clients get
  protocol 2026-07-28, everyone else keeps the classic `initialize` handshake
- remote OAuth MCP Edge Function audited against the MCP 2026-07-28 revision:
  no SSE or Dynamic Client Registration surface exists, so no code change was
  required; posture documented in docs/REMOTE_MCP.md

## 1.2.0 - 2026-07-10

### Added

- protocol v1 schemas, module manifests, capability discovery, and conformance checks
- checksummed, dry-run-first portable export/import with lifecycle restoration
- pluggable embedding adapter/profile storage and bounded reindex batches
- idempotent batch memory writes and append-only agent activity events
- source confidence, freshness, validity, and source-to-memory links
- deterministic multi-namespace context bundles with character budgets
- evidence and contradiction relationships independent from memory lifecycle
- optional text document/chunk ingestion and hybrid document search
- namespace maintenance/capacity status
- optional remote Streamable HTTP MCP protected by Supabase Auth OAuth 2.1
- v0.2 upgrade/rollback guide and module-specific documentation

### Compatibility And Security

- every v0.2 action remains compatible when `protocol_version` is omitted
- migration `0005` is additive; the default inline `gte-small` vector remains
- all new tables use service-role-only RLS and all new functions pin `search_path`
- portable files exclude secrets, credentials, embeddings, audits, and rate limits
- remote MCP never registers encrypted-secret tools

## 0.2.0 - 2026-07-09

### Added

- hashed scoped clients with namespaces, permissions, expiry, and revocation
- Supabase Vault encrypted secret storage and explicit decryption authorization
- database-backed rate limits and append-only audit metadata
- bounded multi-chunk embeddings for long memory content
- expanded TypeScript and opt-in MCP secret tools
- Node, Deno, migration, dependency, and secret-scan verification
- model-neutral AI installation contract and safe target-repository scaffold
- public project documentation, contribution, support, security, and issue templates

### Changed

- exact duplicate writes no longer mutate frozen ranking importance
- ID-based mutations enforce namespace access
- browser CORS fails closed unless explicitly configured
- errors no longer return raw database details

## 0.1.0 - 2026-06-22

- initial zero-cost Supabase memory core
- hybrid pgvector and full-text recall
- HTTPS API, TypeScript client, MCP adapter, and eval fixtures
