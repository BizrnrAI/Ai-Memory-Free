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

Update: this describes the v0.1 retrieval core. The 2026-07-09 hardening decision
keeps one primary memory table but adds small service-role-only control tables for
clients, Vault secret metadata, audits, and rate limits.

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
and off the write path preserves the minimal core; keeping it out of the caller API
preserves its operator/cron role alongside decay and expiry.

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

## 2026-07-09 - Hashed Scoped Clients Replace The Global Token As Default

Decision: keep `MEMORY_TOKEN` only as an optional bootstrap compatibility path.
Normal callers use independent high-entropy tokens whose SHA-256 hashes, namespace
grants, permissions, expiry, revocation, and last-use metadata live in
`memory_clients`.

Reasoning: a single environment token cannot identify callers, enforce least
privilege, isolate namespaces, or support independent revocation. High-entropy
generated tokens do not need a slow password KDF; SHA-256 permits indexed lookup
without making the database value usable as a bearer credential.

## 2026-07-09 - Recoverable Secrets Use Supabase Vault

Decision: keep caller access tokens hashed, but store recoverable platform/API
secrets with Supabase Vault authenticated encryption. `public.memory_secrets`
contains safe metadata and a Vault UUID only. Explicit `secret_get` is the sole
application decryption action and requires `secrets:read`.

Reasoning: authorized agents may need the original API credential, which hashing
cannot provide. Supabase Vault is already part of the no-cost platform, manages the
encryption key outside the database, preserves encrypted data in backups, and avoids
custom application cryptography. Strict separation keeps plaintext out of semantic
memory, embeddings, FTS, lists, logs, and audit details.

## 2026-07-09 - Long Memories Use Bounded Chunk-Average Embeddings

Decision: preserve the single-row memory model and full raw content, but embed up to
eight evenly distributed, 1,800-character chunks and average/normalize their
vectors.

Reasoning: Supabase documents `gte-small` as English-focused with a 512-token input
limit. The old 100,000-character API silently represented only the beginning of a
long memory. Chunk averaging covers the whole item without a destructive schema
rewrite, while FTS continues to index every character. A future large-document
corpus may justify a separate document/chunk model and a new eval baseline.

## 2026-07-09 - Stdio MCP Remains The Free Default Transport

Decision: keep MCP as a local stdio adapter using environment credentials. Do not
ship a remote bearer-only HTTP MCP endpoint.

Reasoning: official MCP guidance treats stdio environment credentials and hosted
HTTP authorization differently; hosted HTTP should use OAuth 2.1 discovery and
protected-resource metadata. Adding an insecure shortcut would weaken the system,
while adding a full authorization service would violate the minimal no-cost default.
Remote non-MCP services can call the same scoped HTTPS API.

## 2026-07-09 - Security State Is Additive And Auditable

Decision: migration `0004` adds clients, Vault secret metadata, audit events, rate-limit
buckets, and stricter supersession without deleting or rewriting existing memories.

Reasoning: existing installations need a controlled upgrade. Additive schema keeps
rollback possible, lets the bootstrap token bridge provisioning, and avoids a data
migration. Read auditing remains optional to protect the 500 MB free-tier budget;
mutations and all secret operations are always audited.

## 2026-07-09 - Public Distribution Is AI-Agent-First

Decision: treat the canonical GitHub URL as an installation interface. Ship a
model-neutral `AI.md`, copy-paste handoff prompt, complete agent contract, docs
index, `llms.txt`, and dry-run integration scaffold.

Reasoning: a user should need only the GitHub URL and a capable coding agent. The
repository must specify inputs, safety constraints, commands, outcomes, and the
definition of done without assuming a model vendor. The scaffold writes only
namespaced guidance and an MCP example; it never writes a token or rewrites the
target application.

## 2026-07-09 - Brand Attribution Stays Useful-First

Decision: identify Kristian Peter and KristianPeter.com near the README entry
point, in citation metadata, and in ownership sections while keeping technical
guidance dominant.

Reasoning: the repository is both public infrastructure and proof of work for the
Chief Automation Officer brand. Factual, consistent attribution builds discovery
without gated leadware, invasive telemetry, or advertising inside the tool.

## 2026-07-10 - v1.2 Uses A Stable Core And Optional Modules

Decision: keep protocol v1 backwards compatible and register capabilities for
events, provenance, relationships, documents, maintenance, Vault, and remote MCP.
Each module owns additive tables and actions but reuses the core security boundary.

Reasoning: modularity is a stable contract at seams, not a plugin framework. A
small manifest and action registry make upgrades discoverable without package
loading, extra services, or duplicate ranking.

## 2026-07-10 - Activity, Documents, And Durable Truth Stay Separate

Decision: use `memory_events` for agent/tool outcomes, `memory_documents` plus
chunks for source corpora, and `memories` for curated cross-session truth.

Reasoning: storing everything in the semantic table makes relevance and lifecycle
unmanageable. Separate modules preserve activity and source text while keeping
core recall precise. Chain-of-thought and secrets remain prohibited.

## 2026-07-10 - Embedding Profiles Are Additive And Explicit

Decision: introduce an adapter contract and profile-specific vector table without
removing the v0.2 inline vector. `gte-small-v1` remains the built-in default.

Reasoning: a destructive vector rewrite would make upgrades fragile. Dual-write
and bounded reindex batches establish a future seam while preserving the no-cost
path and preventing incompatible vector spaces from mixing.

## 2026-07-10 - Remote MCP Uses Supabase OAuth

Decision: provide remote MCP as an optional sessionless HTTP adapter using
Supabase Auth OAuth 2.1 and explicit `memory_oauth_grants`. Remote secret tools are
absent.

Reasoning: hosted MCP adoption matters, but a shared bearer token is not a secure
authorization design. Supabase provides the authorization server inside the same
platform; the MCP function remains only a protected protocol adapter.

## 2026-10-06 - One Request Embeds What The Hosted Runtime Can Always Afford

Decision: the service budgets the characters one request may hand to `gte-small`
(`MEMORY_EMBED_CHARS_PER_REQUEST`, default 3,600 — two 1,800-character chunks).
A single text is sampled down to fit; a batch that cannot fit is refused before
anything is written; documents embed in resumable steps.

Reasoning: this supersedes the eight-chunk average of 2026-07-09. Hosted Supabase
kills a worker that uses about 2 seconds of CPU and answers HTTP 546. Measured
against a hosted project, back to back: one and two chunks never failed (0 of 24),
three failed 1 of 14, four and five 2 of 14, seven always. A worker serves
several requests and retires at a lower soft limit, so a request can arrive with
only part of the 2 seconds left; only a request small enough for the remainder is
always safe. The eight-chunk design could not store any memory above roughly
10,000 characters on the platform the project targets.

Characters alone understate the cost: every run of the model has a fixed price,
and a batch of thirty one-line memories killed a local worker at the
twenty-fourth. The budget charges each chunk its characters plus a fixed 600 —
set on the high side of what was observed — so short texts are limited by
number. A stored memory is recognised before it is embedded, so a retry spends
nothing.

## 2026-10-06 - Recall Fuses Three Lists, And Embeddings Are Optional

Decision: recall fuses nearest vectors, all-words full-text matches, and any-word
full-text matches. `MEMORY_EMBEDDINGS=off` runs the service on full-text alone.

Reasoning: measured on 227 real memories and 36 queries with known answers
([RETRIEVAL.md](RETRIEVAL.md)). Embeddings alone were the weakest method (first
result correct for 14). The all-words list is precise for identifiers and found
nothing for 17 of 20 plain-language questions, so for questions the old hybrid
was embeddings alone. Three lists gave 28 correct first results and 35 in the top
five; keyword-only gave 24 and 30. Embeddings earn their place — they add the
matches that share no words with the query — but they are the costly, fragile
part, so an operator may turn them off and keep most of the recall.

## 2026-10-06 - A Namespace That Fits In Context Is Read Whole

Decision: add `list`, a deterministic, paginated, budgeted read of a namespace.

Reasoning: every ranked retrieval can miss. A project namespace is usually tens
of memories — far below a model's context — and an agent starting work needs all
of the standing decisions and procedures, not the eight most similar to a prompt.
Similarity-ranked startup bundles were observed truncating at their budget and
leaving standing decisions out.

## 2026-10-06 - A Reused Idempotency Key With New Content Is A Conflict

Decision: `remember` with an existing `source_system` + `external_id` and
different content returns `409 external_id_content_conflict`. An unknown `kind`
returns `400 invalid_kind`.

Reasoning: both used to succeed while doing something other than what was asked —
keeping the old content, or storing a `note`. A memory system that silently
discards a correction is worse than one that refuses it. Corrections are written
as a new memory and linked with `supersede`.

## 2026-10-06 - Named Credential Access Keeps Vault And Hashed Authentication

Decision: retain Supabase Vault for recoverable credentials and SHA-256 for
high-entropy caller tokens. Add paginated metadata discovery and bounded retrieval
of explicitly named secrets, without placing values in semantic search.

Reasoning: the primitives already fit their distinct purposes. Access needed
repair: missing descriptions failed Vault writes; colon-concatenated identifiers
could collide; rotation could mix a value with stale version metadata; inventory
stopped at 500 entries. An additive wrapper migration and client/adapter helpers
fix these boundaries without custom cryptography or weakening namespace grants.
HTTPS and redirect rejection protect values and bearer tokens in transit.

Secret discovery indexes registry names, descriptions and explicit service,
environment and credential-type metadata, including legacy entries, without
indexing Vault values. New credential helpers enforce consistent
`service.environment.credential_type` identities; complete identities submitted
through the raw API must match their names. Legacy identifiers remain usable.
