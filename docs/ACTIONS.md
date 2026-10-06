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
dimensions, strategy), `embeddings` (`on` or `off`), `auth_mode`, `limits`,
`server_key`, `actions`, and `modules` (the eight module manifests). This is
the canonical capability discovery call.

`limits` says what one request can carry, so a caller can size its writes
without trial and error: `max_content_chars`, `max_content_bytes` (null unless
the operator set a cap), `embed_chars_per_request`, `embed_chunk_chars`,
`embed_chunks_per_text`, `embed_cost_per_request` and `embed_cost_per_run` (the
embedding budget; the two `_per_request` values are null when embeddings are
off), `remember_batch_items`, `portable_import_records`, `document_chunks`. See
[Limits](#limits).

`server_key` is `secret_keys` or `service_role`: which Supabase key the
function is running on, never the key itself.

### `whoami`

No fields. Returns `client`: `id`, `name`, `token_prefix`,
`allowed_namespaces`, `permissions`, `expires_at`, `auth_mode`,
`protocol_version`.

### `remember` — `memory:write`

| Field | Type | Rules |
| --- | --- | --- |
| `content` | string | required, 1..100000 chars; also `limits.max_content_bytes` when the operator set one (`413 content_too_large`) |
| `namespace` | string | optional |
| `kind` | string | one of `note`, `fact`, `decision`, `correction`, `reference`, `procedure`; default `note`; anything else fails with `400 invalid_kind` |
| `importance` | number | 0..1, default 0.5; frozen as `base_importance` |
| `source` | string | optional, ≤2048 |
| `tags` | string[] | optional, deduplicated, max 64 |
| `metadata` | object | optional |
| `supersedes` | uuid | optional; atomically supersedes that memory |
| `source_system` | string | optional identifier, ≤128; must pair with `external_id` |
| `external_id` | string | optional, ≤512; must pair with `source_system` |

Returns `{created, memory:{id, namespace, content_hash, created_at, updated_at},
vector}`. `vector` is present when the memory was created and says how much of
it the vector stands for: `full`, `sampled` (the text is longer than one
request can embed, so evenly spaced windows represent it), or `none`
(embeddings are off). Full-text search covers the whole text in every case.

Duplicates, per namespace — found by a lookup **before** anything is embedded,
so a retry costs no model time:

- the same content again (with the same `source_system`+`external_id`, or with
  none) returns the existing row with `created:false` — safe to retry after a
  timeout or an HTTP 546
- an existing `source_system`+`external_id` with **different** content fails
  with `409 external_id_content_conflict` and the existing `memory_id`. The pair
  is an idempotency key, not an update address: write the correction as a new
  memory and link it with `supersede`
- content that already exists, sent with a **new** `source_system`+`external_id`,
  fails with `409 content_already_exists` and the existing `memory_id`

A long memory is stored whole and indexed whole for full-text search. Its vector
is **not** unlimited: it is averaged from at most `limits.embed_chunks_per_text`
evenly spaced 1,800-character windows (two by default), and the result says
`vector:"sampled"`. Text that must be findable by meaning throughout belongs in
several memories or in a document.

### `remember_batch` — `memory:write`

`items`: array of 1..50 `remember` objects (same fields, no `supersedes`
requirement difference). An item without its own `namespace` takes the batch's
top-level `namespace`. Returns `{results:[...]}` in input order, each entry
shaped like a `remember` result. Each item is idempotent independently.

Every item must be an object (`400 items_must_be_objects`). The whole batch must
fit the request's embedding budget. If it does not, nothing is written and the
call fails with `413 embedding_budget_exceeded`, carrying `embed_cost` (what the
batch needs) and `max_embed_cost`. Split the batch; one item always fits on its
own. Short items are limited by number, not length — about seven one-line
memories fit in a default request — because each is a separate run of the
model. The TypeScript client's `rememberMany` does the splitting.

### `recall` — `memory:read`

| Field | Type | Rules |
| --- | --- | --- |
| `query` | string | required, 1..20000 |
| `namespace` | string | optional |
| `limit` | int | 1..50, default 8 |
| `pool` | int | candidate pool per retrieval arm, 10..1000, default 200 |
| `track` | boolean | default true; set `false` for eval/system reads so access counts stay honest |

Returns `results`: ranked rows with `id`, `namespace`, `content`, `kind`,
`source`, `tags`, `metadata`, `source_system`, `external_id`,
`base_importance`, `access_count`, `effective_score`, `rrf_norm`,
`final_score`, `created_at`, `last_accessed_at`. Three ranked lists are fused
with Reciprocal Rank Fusion — nearest vectors, full-text matches containing
every query word, and full-text matches containing any query word; the caller
synthesizes. See [RETRIEVAL.md](RETRIEVAL.md).

### `list` — `memory:read`

Reads a namespace in a fixed order instead of searching it. Use it to load
everything a project knows, or everything of one kind; nothing is ranked and
nothing is embedded, so nothing can be missed.

| Field | Type | Rules |
| --- | --- | --- |
| `namespace` | string | optional |
| `kinds` | string[] | optional; only these kinds (each must be a valid kind) |
| `tags` | string[] | optional; memories carrying any of these tags |
| `order` | string | `importance` (default: most important first, then most recently updated) or `recent` |
| `limit` | int | 1..200, default 50 |
| `offset` | int | 0..1000000, default 0 |
| `max_chars` | int | 1000..200000, default 20000; a page stops before the memory that would exceed it |
| `include_retired` | boolean | default false; also return retired and superseded memories |

Returns `{namespace, order, memories, next_offset, budget:{max_chars,
used_chars, truncated}}`. Pass `next_offset` as `offset` until it is `null`. A
single memory longer than `max_chars` returns `413 list_budget_too_small` with
`required_chars`; raise `max_chars` and retry the same offset. List pages never
truncate memory content. The client’s `listAll` raises its budget automatically. Reading does not
count as access for ranking.

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
re-embedded with the active profile on import, so a page of memories must fit
the embedding budget (`413 embedding_budget_exceeded` otherwise, with nothing
imported); `npm run portable` sizes its pages from `health`. A memory that is
already present is skipped before it is embedded. Imported documents are
written whole and their chunks embedded afterwards with `embedding_reindex`
`target:"document_chunks"`; a document exported as retired is imported retired.

## Vault Secrets Module (optional)

Secret values never enter semantic memory, embeddings, search, or audit logs.

### `secret_store` — `secrets:write`

`namespace` (optional), `name` (identifier, ≤128, `[a-zA-Z0-9_.:-]`),
`secret` (string, 1..16384, exempt from credential scanning), `description`
(optional, ≤2048), `metadata` (optional object). Returns stored secret
metadata; storing an existing name creates a new version. When metadata supplies
`service`, `environment`, and `credential_type`, each must use lowercase identifier
components (1..40 characters, letters/digits/underscores/hyphens) and `name` must
equal `service.environment.credential_type`. The client provides `formatSecretName`,
`storeCredential`, and `getCredential`; legacy names remain supported.

### `secret_get` — `secrets:read`

`namespace` (optional), `name`. Returns the decrypted secret value with its
metadata. 404 if absent. Decryption is audited.

### `secret_list` — `secrets:list` (plus `secrets:admin` for `include_retired`)

`namespace` (optional), `include_retired` (boolean), `limit` (1..500, default
500), `cursor` (the previous `next_cursor`), and `name_prefix` (literal logical-name
prefix), and `query` (1..256 characters, web-search words from indexed names,
descriptions, service, environment and credential type). Values are not indexed.
Returns `{secrets, next_cursor}` with metadata only — never plaintext or
ciphertext. Follow `next_cursor` until null to enumerate the complete inventory.
The client provides `listAllSecrets` and `getSecrets` for 1..10 explicitly selected
names; selected retrieval uses ordinary `secret_get` calls and their individual
permission, rate-limit, and audit boundaries.

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
`text/plain`), `metadata` (object), and two ways to replace an earlier version
in the same call:

- `supersedes` (uuid): the document this one replaces. It must exist in the same
  namespace (`404 document_not_found`, `409 namespace_mismatch`, checked before
  anything is written) and is retired after the replacement and all its text chunks are stored.
- `replace_same_title` (boolean): retire every other active document in the
  namespace with the same title.

Returns `{created, reactivated, retired, document, chunks_created,
chunks_embedded, chunks_pending}`; `retired` lists the ids this call stood down.

Every chunk is written first and is found by full-text search at once. The call
then embeds as many chunks as the request's embedding budget allows — two by
default — and reports the rest as `chunks_pending`. **Send the same document
again to embed the next chunks**, until `chunks_pending` is 0; identical content
returns the existing document with `created:false` and continues where the last
call stopped. A call that dies halfway loses nothing. If the existing document
had been retired, ingesting it again makes it active (`reactivated:true`). The
TypeScript client's `ingestDocumentFully` repeats the call for you.

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
`unverified_sources`, `document_chunks_pending_embedding`,
`memories_without_vector`, `limits`,
`embedding_profile`, `modules`, and — only when the caller holds
`memory:admin` — `database_size_bytes`. Never returns stored content. Chunks of
retired documents are not counted as pending.

### `embedding_reindex` — `memory:admin`

`namespace`, `profile` (must be the active profile or the call fails with
409), `target` (`memories`, the default; `missing`; or `document_chunks`).

- `target:"memories"` — `limit` (1..50, default 25) and `offset` (0..1000000,
  default 0). Re-embeds memories in id order until `limit` is reached or the
  request's embedding budget is spent, whichever comes first. Returns
  `{profile, target, processed, next_offset, done}`; continue from `next_offset`
  until `done` is true.
- `target:"missing"` — gives a vector to active memories that have none (written
  or imported while embeddings were off). Returns `{profile, target, processed,
  remaining}`; repeat until `remaining` is 0.
- `target:"document_chunks"` — embeds chunks that have no vector yet. Returns
  `{profile, target, processed, remaining}`; repeat until `remaining` is 0.

Fails with `409 embeddings_disabled` when the service runs in keyword-only mode.

## Limits

One request can only do so much. Hosted Supabase ends a worker that uses about
2 seconds of CPU, and the caller sees **HTTP 546** with no JSON body. The
built-in embedding model is what uses that CPU, so the service budgets it:

- every chunk the model reads costs its characters plus a fixed
  `limits.embed_cost_per_run` (600), because each run of the model has a price
  before it reads a word
- one request may spend `limits.embed_cost_per_request` (default 4,800: two
  full 1,800-character chunks, the most that never failed in measurement)
- one text is embedded from at most `limits.embed_chunks_per_text` windows of
  `limits.embed_chunk_chars` characters, so a single `remember`, `recall` or
  `context` always fits
- requests that embed several texts (`remember_batch`, `portable_import` of
  memories) are refused up front with `413 embedding_budget_exceeded` when they
  do not fit
- documents and re-indexing proceed in steps and say how much is left

**An HTTP 546 is safe to retry** for every action except `secret_store` and an
`event_append` without an `external_id`: the next request is served by a fresh
worker, and a write that did land is recognised as a duplicate without being
embedded again. The same goes for a 502 or 503 while a worker is being replaced.
The bundled TypeScript client and the remote MCP function retry twice on their
own. The numbers
behind the default, and the settings that change it, are in
[RETRIEVAL.md](RETRIEVAL.md) and [OPERATIONS.md](OPERATIONS.md#settings).

## Error Codes

Errors are stable machine-readable strings, for example `unauthorized` (401),
`forbidden` (403, permission or namespace denied), `unknown_action` (400),
`unsupported_protocol_version` (409), `namespace_mismatch` (409),
`rate_limited` (429), validation codes such as
`items_must_contain_1_to_50_records` (400), `items_must_be_objects` (400) and
`invalid_kind` (400), `document_not_found` (404),
`external_id_content_conflict` and `content_already_exists` (409, with
`memory_id`), `content_too_large` and `embedding_budget_exceeded` (413, with
the measured and allowed sizes), `embeddings_disabled` (409), and
`internal_error` (500, with `request_id`). Some errors carry extra
machine-readable fields beside `error`, as noted above. Handle by code, never by
message text.
