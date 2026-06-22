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
