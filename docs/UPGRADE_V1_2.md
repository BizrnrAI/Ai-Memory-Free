# Upgrade From v0.2 To v1.2

v1.2 is additive and keeps every v0.2 action, memory row, inline embedding, scoped
token, and Vault secret.

1. Back up the database and prove the backup can be read.
2. Pull the reviewed v1.2 tag and run `npm ci`.
3. Read migration `0005_v1_2_modular_memory.sql`.
4. Apply it through `supabase migration up --linked` or your controlled migration
   process. Never use `supabase db push`.
5. Deploy `memory`; deploy `mcp` only if remote OAuth MCP is wanted.
6. Run `health` and confirm version `1.2.0`, protocol `1`, and eight modules.
7. Run the existing whoami/remember/recall/forbidden-namespace tests.
8. Test event idempotency, a source link, a contradiction link, document search,
   context budget truncation, and portable export dry-run.
9. Run `embedding_reindex` in batches if profile rows are desired for old memories.

The old inline `vector(384)` remains authoritative for default recall. The new
profile table is dual-written for new/reindexed rows and can host future profiles
without a destructive core migration.

Rollback means deploying the prior Edge code and leaving the additive tables
unused. Do not drop v1.2 tables until exports/backups and all callers prove they no
longer depend on them.
