# HTTPS Action Reference

Complete request/response contract for every protocol v1 action, for callers in
any language. Derived from the Edge Function source; when a deployed service
disagrees, trust its `health` response. The MCP adapters and TypeScript client
call exactly these actions.

## Request Envelope

Every call is one JSON `POST` to the memory Edge Function URL:

```text
POST https://PROJECT_REF.supabase.co/functions/v1/memory
Authorization: Bearer <scoped token>
Content-Type: application/json

{"protocol_version":"1","action":"<action>", ...fields}
```

- `action` is required (defaults to `health` when the body omits it).
- `protocol_version` is optional; if present it must be `"1"` or the request
  fails with `unsupported_protocol_version` (409).
- Non-POST methods receive 405. Unauthenticated requests receive 401.
- Success responses are `{"ok":true, ...}`. Failures are
  `{"ok":false,"error":"<stable_code>"}` with a matching HTTP status; internal
  errors add a `request_id` and never leak database detail.

## Common Conventions

- `namespace` defaults to `"default"` everywhere it is optional. The token must
  hold the listed permission **for that namespace** or the call fails with 403.
- Out-of-range numbers are clamped to the documented bounds, not rejected.
- Optional strings are trimmed; oversized required strings are rejected.
- Ordinary memory content is scanned for credential patterns and rejected with
  a 400 if a high-confidence secret is detected. Store recoverable secrets only
  through the `secret_*` actions.
- Timestamps are ISO-8601 strings.

## Core Module

### `health` — no permission required beyond authentication

No fields. Returns `service`, `version` (release), `protocol_version`,
`portable_format`/`portable_version`, `embedding_profile` (id, model,
dimensions, strategy), `auth_mode`, `actions`, and `modules` (the eight module
manifests). This is the canonical capability discovery call.

### `whoami`

No fields. Returns `client`: `id`, `name`, `token_prefix`,
`allowed_namespaces`, `permissions`, `expires_at`, `auth_mode`,
`protocol_version`.

### `remember` — `memory:write`

| Field | Type | Rules |
| --- | --- | --- |
| `content` | string | required, 1..100000 chars |
| `namespace` | string | optional |
| `kind` | string | one of `note`, `fact`, `decision`, `correction`, `reference`, `procedure`; default `note` |
| `importance` | number | 0..1, default 0.5; frozen as `base_importance` |
| `source` | string | optional, ≤2048 |
| `tags` | string[] | optional, deduplicated, max 64 |
| `metadata` | object | optional |
| `supersedes` | uuid | optional; atomically supersedes that memory |
| `source_system` | string | optional identifier, ≤128; must pair with `external_id` |
| `external_id` | string | optional, ≤512; must pair with `source_system` |

Returns `{created, memory:{id, namespace, content_hash, created_at, updated_at}}`.
An exact duplicate (same content hash, or same `source_system`+`external_id`
pair, per namespace) returns the existing row with `created:false` — safe to
retry after a timeout.

### `remember_batch` — `memory:write`

`items`: array of 1..50 `remember` objects (same fields, no `supersedes`
requirement difference). Returns `{results:[...]}` in input order, each entry
shaped like a `remember` result. Each item is idempotent independently.

### `recall` — `memory:read`

| Field | Type | Rules |
| --- | --- | --- |
| `query` | string | required, 1..20000 |
| `namespace` | string | optional |
| `limit` | int | 1..50, default 8 |
| `pool` | int | candidate pool per retrieval arm, 10..1000, default 200 |
| `track` | boolean | default true; set `false` for eval/system reads so access counts stay honest |

Returns `results`: ranked rows with `id`, `namespace`, `content`, `kind`,
`source`, `tags`, `metadata`, `base_importance`, `access_count`,
`effective_score`, `rrf_norm`, `final_score`, `created_at`,
`last_accessed_at`. Ranking is hybrid vector + full-text with Reciprocal Rank
Fusion; the caller synthesizes.

### `context` — `memory:read` for every requested namespace

| Field | Type | Rules |
| --- | --- | --- |
| `query` | string | required, 1..20000 |
| `namespaces` | string[] | 1..8 explicit namespaces; falls back to `namespace`, then `["default"]` |
| `per_namespace_limit` | int | 1..20, default 8 |
| `max_chars` | int | 1000..100000, default 20000 |
| `max_characters` | int | deprecated compatibility alias for `max_chars` |
| `include_events` | boolean | default false; adds up to 5 recent events per namespace |

Returns a deterministic budgeted bundle: `memories` (merged by `final_score`),
`sources`, `relationships`, `recent_events`, and
`budget:{max_chars, used_chars, truncated}`. Wildcard namespaces are never
inferred.

### `retire` — `memory:write`

`id` (uuid, required), `reason` (string, optional, ≤2048). Deactivates the
memory without deleting audit or provenance context. Returns `{id}`.

### `supersede` — `memory:write`

`old_id`, `new_id` (uuids, required; must share one namespace). Marks the old
memory superseded by the new one. Returns `{old_id, new_id}`.

### `portable_export` — `memory:admin`

| Field | Type | Rules |
| --- | --- | --- |
| `resource` | string | required: `memories`, `events`, `sources`, `source_links`, `links`, `documents`, `supersessions` |
| `namespace` | string | optional |
| `offset` | int | 0..1000000, default 0 |
| `limit` | int | 1..200, default 100 |

Returns `{format, version, resource, namespace, offset, next_offset, records,
excluded}`. `next_offset` is null on the last page. Exports never include
secrets, Vault ciphertext, credentials, embeddings, audit logs, or rate-limit
state; embeddings are regenerated on import.

### `portable_import` — `memory:admin`

`resource` (as above), `namespace`, `records` (array of 1..20 exported
records). Returns `{resource, namespace, imported, skipped}` — records that
already exist are skipped, so pages can be retried. Memory records are
re-embedded with the active profile on import.

## Vault Secrets Module (optional)

Secret values never enter semantic memory, embeddings, search, or audit logs.

### `secret_store` — `secrets:write`

`namespace` (optional), `name` (identifier, ≤128, `[a-zA-Z0-9_.:-]`),
`secret` (string, 1..16384, exempt from credential scanning), `description`
(optional, ≤2048), `metadata` (optional object). Returns stored secret
metadata; storing an existing name creates a new version.

### `secret_get` — `secrets:read`

`namespace` (optional), `name`. Returns the decrypted secret value with its
metadata. 404 if absent. Decryption is audited.

### `secret_list` — `secrets:list` (plus `secrets:admin` for `include_retired`)

`namespace` (optional), `include_retired` (boolean). Returns metadata only —
never plaintext or ciphertext.

### `secret_retire` — `secrets:admin`

`namespace` (optional), `name`. Deactivates the secret without deleting Vault
ciphertext. Returns `{namespace, name}`.

## Events Module (optional)

### `event_append` — `memory:write`

| Field | Type | Rules |
| --- | --- | --- |
| `event_type` | string | required identifier, ≤128 |
| `summary` | string | required, 1..20000; never chain-of-thought or secrets |
| `namespace` | string | optional |
| `agent_id`, `session_id`, `tool_name` | string | optional, ≤256 each |
| `source_system` | string | optional identifier, default `manual` |
| `external_id` | string | optional, ≤512; with `source_system` makes the append idempotent |
| `payload` | object | optional |
| `occurred_at` | timestamp | optional, defaults to now |

Returns `{created, event}`; a retried `source_system`+`external_id` pair
returns the existing event with `created:false`.

### `event_list` — `memory:read`

`namespace` (optional), `limit` (1..200, default 50). Returns `events`, newest
first by `occurred_at`.

## Provenance Module (optional)

### `source_upsert` — `memory:write`

`uri` (required, ≤2048; unique per namespace — upserting the same URI updates
the record), `namespace`, `source_type` (identifier, default `other`),
`title` (≤512), `checksum` (≤256), `confidence` (0..1, default 0.8),
`observed_at`, `valid_from`, `valid_until`, `last_verified_at` (timestamps),
`metadata` (object). Returns `{source}`.

### `source_link` — `memory:write` on the memory's namespace

`source_id`, `memory_id` (uuids; must share a namespace), `relation`: one of
`supports`, `derived_from`, `verifies` (default `supports`). Upsert; returns
`{source_id, memory_id, relation}`.

### `source_list` — `memory:read`

`namespace` (optional), `limit` (1..500, default 100). Returns `sources`,
most recently updated first.

## Relationships Module (optional)

### `link_create` — `memory:write`

`source_id`, `memory_id` (uuids for the two related memories; must share one
namespace), `relation`: `supports`, `contradicts`, `derived_from`, or
`related_to` (default `related_to`), `note` (optional, ≤2048). Upsert on the
(source, target, relation) triple. Returns `{link}`.

### `link_list` — `memory:read`

`namespace` (optional), `limit` (1..500, default 100), `include_retired`
(boolean; default only active links). Returns `links`.

### `link_resolve` — `memory:write` on the link's namespace

`link_id` (uuid), `note` (optional, ≤2048). Deactivates the relationship and
stamps `resolved_at` without changing either memory's lifecycle. Returns
`{id}`.

## Documents Module (optional)

### `document_ingest` — `memory:write`

`title` (required, 1..512), `content` (required, 1..100000; rejected above 64
chunks), `namespace`, `source_uri` (≤2048), `media_type` (≤128, default
`text/plain`), `metadata` (object). Chunks and embeds the text. Returns
`{created, document, chunks_created}`; identical content in the namespace
returns the existing document with `created:false`.

### `document_search` — `memory:read`

`query` (required, 1..20000), `namespace`, `limit` (1..50, default 8),
`pool` (10..500, default 100). Returns hybrid-ranked chunk `results`.

### `document_list` — `memory:read`

`namespace`, `limit` (1..500, default 100), `offset` (0..1000000, default 0),
and `include_retired` (default false). Returns `documents` (metadata and content
hash, not chunk vectors) plus `next_offset`; pass that value as `offset` until it
is `null`.

### `document_retire` — `memory:write` on the document's namespace

`id` (uuid, required), `reason` (optional, ≤2048). Deactivates the document so
its chunks no longer participate in `document_search`. The operation is
idempotent and returns `{id, retired}`; `retired` is true only when this call
changed an active document.

## Maintenance Module (optional)

### `maintenance_status` — `memory:read`

`namespace` (optional). Returns per-table `counts`, `inactive_memories`,
`unverified_sources`, `embedding_profile`, `modules`, and — only when the
caller holds `memory:admin` — `database_size_bytes`. Never returns stored
content.

### `embedding_reindex` — `memory:admin`

`namespace`, `profile` (must be the active profile or the call fails with
409), `limit` (1..50, default 25), `offset` (0..1000000, default 0). Re-embeds
a bounded batch. Returns `{profile, processed, next_offset}` for cursor-style
continuation.

## Error Codes

Errors are stable machine-readable strings, for example `unauthorized` (401),
`forbidden` (403, permission or namespace denied), `unknown_action` (400),
`unsupported_protocol_version` (409), `namespace_mismatch` (409),
`rate_limited` (429), validation codes such as
`items_must_contain_1_to_50_records` (400), and `internal_error` (500, with
`request_id`). Handle by code, never by message text.
