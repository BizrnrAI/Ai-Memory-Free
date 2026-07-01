# Decisions

## 2026-06-22 - New Private Repo Instead Of Auth Citadel

Decision: create a new private repository named `Ai-Memory-Free` instead of
modifying `BizrnrAI/auth-citadel`.

Reasoning: Auth Citadel is an authorization platform. The corrected deliverable is
a standalone no-cost AI memory system. Keeping the memory system in its own repo
prevents domain bleed, makes replication easier, and lets any agent inspect one
small repository to reproduce the pattern.

## 2026-06-22 - Supabase Free Tier As The Default Runtime

Decision: use one Supabase project, one Postgres table, one Edge Function, and
Supabase in-edge `gte-small` embeddings as the default runtime.

Reasoning: this is the only reviewed architecture that satisfies all constraints at
once: zero paid API keys, no generative model inside the memory service, vector
search, full-text search, RLS, Edge deployment, and enough free quota for practical
agent memory.

## 2026-06-22 - MCP Is An Adapter, Not A Fork

Decision: MCP tools call the same HTTPS API used by every other client.

Reasoning: duplicate memory implementations drift. A single API contract keeps
ranking, auth, provenance, and eval behavior identical across Claude, Codex,
Cursor, local scripts, and ordinary apps.

## 2026-07-01 - Semantic Compaction Is Optional And Reuses Supersession

Decision: ship near-duplicate compaction as an optional maintenance function
(`0003_optional_compaction.sql`), dry-run by default, that folds weaker
near-duplicates into the stronger row using the existing `superseded_by` +
`is_active` lifecycle — no new columns, no new state, no new API action.

Reasoning: exact-hash dedup at write time is not enough — the same fact phrased
differently still lands as separate rows and dilutes recall. The production vault
(`BizrnrAI/mas-memory`) confirmed this: topical/near-duplicate memories accumulate
until something folds them. Compaction is the fold. Keeping it optional, reversible,
and off the write path preserves the minimal core; keeping it out of the five-action
API keeps the client contract small (it is an operator/cron task, like decay and
expiry).

## 2026-07-01 - One Lifecycle Field, Validated By Production

Decision: keep a single lifecycle signal (`is_active`, plus `superseded_by` for
provenance). Do not add a parallel status enum or a second "active" flag. Keep
`base_importance` frozen for ranking and let the mutable `importance` decay only to
drive expiry.

Reasoning: the production vault originally ran two lifecycle systems in parallel (an
`is_active` boolean written by cron jobs and a `status` enum written by a separate
path). They drifted, hid some memories, and risked resurfacing stale ones; the fix
was a careful cutover to a single source of truth. This template was designed to
avoid that from the start — one lifecycle field, and a deliberate split between the
frozen ranking anchor (`base_importance`) and the decaying expiry signal
(`importance`) so decay can never silently move ranking. That design is the
validated end state; do not reintroduce a second lifecycle field.
