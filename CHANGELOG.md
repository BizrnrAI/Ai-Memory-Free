# Changelog

Notable changes are documented here. Versions follow semantic versioning after the
first public release.

## Unreleased

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
