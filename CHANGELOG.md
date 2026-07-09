# Changelog

Notable changes are documented here. Versions follow semantic versioning after the
first public release.

## 0.2.0 - Unreleased

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
