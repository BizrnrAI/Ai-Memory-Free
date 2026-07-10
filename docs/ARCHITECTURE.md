# Architecture

Ai-Memory-Free has one database implementation, one Edge API, and thin callers.

```text
LLM / agent / app / stdio MCP client
        |
        | Authorization: Bearer <scoped token>
        v
Supabase Edge Function: memory
        |
        +-- SHA-256 token lookup -> client identity
        +-- permission + namespace authorization
        +-- database-backed rate limit
        +-- input validation + secret guard
        +-- gte-small bounded-chunk embedding
        +-- action handler + non-sensitive audit event
        |
        v
Supabase Postgres
  memories                ranked semantic + FTS content
  memory_clients          hashed access tokens and grants
  memory_secrets          safe metadata + Supabase Vault UUID
  vault.secrets           authenticated encrypted secret payloads
  memory_audit_log        actor/action/resource metadata
  memory_rate_limit_buckets
```

## Trust Boundaries

1. Clients receive a unique high-entropy token. Only its SHA-256 hash is stored.
2. The Edge Function holds the service-role key and is the only normal database
   caller. Service-role access bypasses RLS, so every action is authorized in the
   function before a query or RPC.
3. Postgres independently constrains dangerous state transitions such as
   supersession and restricts all tables/functions to `service_role`.
4. MCP never connects to Postgres. It calls the same HTTPS API as every other
   client, preventing a second authorization or ranking implementation.
5. Secret values cross the authenticated API only for explicit store/get actions.
   Supabase Vault encrypts them at rest; they are never logged, embedded, placed in
   semantic memory, or returned by list/recall.

## Core API Contract

Memory actions:

- `health`
- `whoami`
- `remember`
- `recall`
- `retire`
- `supersede`

Encrypted-secret actions:

- `secret_store`
- `secret_get`
- `secret_list`
- `secret_retire`

Secret actions are a separate authorization domain. A client with `memory:admin`
does not automatically receive secret access.

## Authorization Model

`memory_clients` grants:

- `allowed_namespaces`: explicit names or `*`
- `memory:read`, `memory:write`, `memory:admin`
- `secrets:list`, `secrets:read`, `secrets:write`, `secrets:admin`

`memory:admin` implies memory read/write. `secrets:admin` implies secret
list/read/write. A literal `*` is reserved for the optional bootstrap token and
deliberately broad operator credentials.

The Edge Function checks both the permission and namespace before each operation.
ID-based mutations first resolve the row, then apply the same namespace check.

## Data Model

### `memories`

- `namespace` isolates projects, users, teams, or agents.
- `content` stores the full raw memory.
- `kind` is `note`, `fact`, `decision`, `correction`, `reference`, or `procedure`.
- `source`, `tags`, and `metadata` preserve provenance.
- `embedding vector(384)` stores the averaged `gte-small` representation.
- generated `fts` indexes the entire raw content.
- `base_importance` is frozen ranking input.
- `importance` is mutable lifecycle state for optional decay/expiry.
- `is_active` plus `superseded_by` is the single lifecycle model.

### `memory_clients`

Contains identity and authorization metadata plus a SHA-256 hash of a generated
high-entropy bearer token. It never contains the raw token.

### `memory_secrets` + Supabase Vault

`public.memory_secrets` contains namespace/name, safe metadata, access history, and
a UUID pointing to `vault.secrets`. The payload is stored only in Supabase Vault
using authenticated encryption; Supabase manages the encryption key outside the
database. A guarded security-definer RPC is the only application path to
`vault.decrypted_secrets`.

`secret_list` returns registry metadata only. `secret_get` requires a separate
`secrets:read` permission and returns plaintext only for that explicit call.

### `memory_audit_log`

Contains request ID, client ID, action, namespace, resource identifier, outcome,
and bounded details. It must never contain content, bearer tokens, candidates,
hashes, or salts. Recall auditing is opt-in to control free-tier growth.

## Retrieval

`gte-small` handles at most 512 tokens per inference. Long items are therefore
split into bounded text chunks; up to eight evenly distributed chunks are embedded,
averaged, and normalized into one vector. The full raw content remains available to
Postgres FTS, so no content is discarded.

`recall()` builds vector and full-text candidate sets, fuses them with Reciprocal
Rank Fusion, normalizes the fused signal, and blends a transparent effective score:

```text
effective_score =
  frozen base importance
  + log-damped access usage
  - bounded age penalty
```

The response returns `rrf_norm`, `effective_score`, and `final_score`.

## Duplicate And Lifecycle Rules

- `(namespace, sha256(content))` blocks exact duplicates.
- Duplicate remember calls return the existing row and do not rewrite frozen
  importance or provenance.
- Optional semantic compaction supersedes weaker near-duplicates.
- Supersession is recoverable and must stay inside one namespace.
- Vault secrets use in-place encrypted rotation with an incremented registry version.

## Model Agnosticism

The memory service never invokes a generative model and never emits a
provider-specific prompt. Any caller can consume the same JSON context.

The default embedding implementation is intentionally fixed to Supabase
`gte-small` for zero-cost hosted inference. Embedding spaces are not interchangeable;
changing that model requires re-embedding every active row and re-running evals.

## Safe Extension Points

- additional adapters that call the HTTPS API
- import/export and backup tools
- domain-specific seeders and eval fixtures
- optional chunk/document schema for very large corpora
- spec-compliant remote HTTP MCP behind OAuth 2.1
- additional external secret managers behind the same explicit secret boundary

Paid APIs, direct public Postgres access, remote bearer-only MCP, or a second
ranking implementation do not belong in the default path.
