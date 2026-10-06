# v1.2 Module Contract

Ai-Memory-Free keeps one small required core and seven isolated modules. `health`
returns the installed module manifest, module versions, actions, protocol version,
portable format version, and active embedding profile.

| Module | Required | Owns |
| --- | --- | --- |
| `core` | yes | memory lifecycle, recall, list, context, portable protocol |
| `vault-secrets` | no | Supabase Vault metadata and explicit decrypt actions |
| `events` | no | append-only agent/tool activity summaries |
| `provenance` | no | sources, confidence, validity, verification, source links |
| `relationships` | no | supports/contradicts/derived-from/related links |
| `documents` | no | text documents, chunks, hybrid search, paginated inventory, retirement |
| `maintenance` | no | safe counts, profile status, bounded reindex batches |
| `remote-mcp` | no | sessionless HTTP MCP protected by Supabase OAuth 2.1 |

## Stability Rules

- Public requests use protocol `1`. New optional fields/actions do not break v0.2
  callers that omit `protocol_version`.
- Every module owns additive tables and actions. Modules never create a second
  memory lifecycle or ranking implementation.
- Authorization always uses the core permission and namespace gate.
- MCP, TypeScript, scripts, and direct HTTPS all call the same Edge API.
- Unknown protocol versions fail with `unsupported_protocol_version`.
- Machine-readable schemas live in `schemas/`.

## Adding A Module

1. Add its manifest to `protocol.ts`.
2. Create additive, RLS-enabled, service-role-only tables if required.
3. Route actions through the existing authentication, rate-limit, audit, and error
   boundaries.
4. Add TypeScript and MCP adapters without duplicating business logic.
5. Add contract, security, migration, and effect tests.
6. Document installation, cost, data ownership, and removal boundaries.

Run `npm run protocol:check` to verify version and manifest consistency.
