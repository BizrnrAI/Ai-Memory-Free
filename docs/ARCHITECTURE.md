# Architecture

Ai-Memory-Free has one core implementation and thin adapters around it.

```text
Any LLM / agent / app / MCP client
        |
        | HTTPS remember / recall
        v
Supabase Edge Function: memory
        |
        | gte-small in-edge embeddings
        | service-role database access
        v
Supabase Postgres
        |
        | memories table
        | recall() RPC
        | bump_access(), retire_memory(), supersede_memory()
        | compact_memories() (optional maintenance)
        v
Ranked context bundle
```

## Core Contract

The Edge Function exposes five actions:

- `health` - reports service status and supported actions
- `remember` - embeds and stores content
- `recall` - embeds a query and returns ranked memory rows
- `retire` - marks a row inactive
- `supersede` - links an older row to a newer row

Every adapter must call this API. Adapters should not store or rank memory
themselves.

## Data Model

`public.memories` is namespace-aware so one project can serve many agents or apps:

- `namespace` isolates projects, users, teams, or agents.
- `content` is the raw memory text.
- `kind` classifies the memory: `note`, `fact`, `decision`, `correction`,
  `reference`, or `procedure`.
- `source`, `tags`, and `metadata` provide provenance.
- `embedding vector(384)` stores the `gte-small` embedding.
- `fts` is a generated Postgres full-text column.
- `base_importance` is frozen for ranking.
- `importance` is mutable lifecycle state for optional decay and expiry.
- `superseded_by` points to the replacing row.

## Retrieval

`recall()` builds two candidate sets:

1. vector similarity over `embedding`
2. full-text search over `fts`

It fuses those candidates with Reciprocal Rank Fusion, normalizes the rank signal,
then blends in a transparent effective score:

```text
effective_score =
  base_importance
  + log-damped usage
  - bounded age penalty
```

The API returns `rrf_norm`, `effective_score`, and `final_score` so callers can see
why an item ranked. Because scoring is transparent, a caller that wants a stricter
result set can drop rows below a `final_score` floor itself — the service returns
the ranked candidates; the caller brings the judgement.

## Deduplication and Compaction

Duplicate handling has two layers:

1. **Exact duplicates** are prevented at write time. `content_hash` is a generated
   `sha256(content)` column and `memories_namespace_hash_unique` makes
   `(namespace, content_hash)` unique, so `remember` upserts identical content
   instead of creating a second row.
2. **Semantic near-duplicates** — the same fact phrased differently — are collapsed
   by the optional `compact_memories()` maintenance function
   (`0003_optional_compaction.sql`). Within a namespace it keeps the strongest row
   (by `base_importance`, then usage, then age) and supersedes weaker near-duplicates
   into it, reusing the existing lifecycle (`superseded_by` + `is_active = false`).
   It is `dry_run` by default, fully recoverable, and opt-in — see
   [OPERATIONS.md](OPERATIONS.md).

This keeps recall from returning three phrasings of one memory without adding any
new state to the data model.

## Model Agnosticism

The memory service never calls a generative model. It only embeds text with the
free Supabase in-edge `gte-small` model. Any LLM, local model, coding agent, chat
tool, or non-LLM app can use the same memory.

## Extension Points

Safe extensions:

- additional adapters that call the same HTTPS API
- domain-specific seed scripts
- backup and restore scripts
- importers that call `remember`
- dashboards that call `recall` with `track:false`
- eval fixtures and scoring reports

Extensions that should remain optional:

- local-only embeddings
- richer provenance tables
- graph views
- markdown wiki exports
- additional auth tokens per consumer

Do not put paid APIs or hosted LLM calls in the default path.
