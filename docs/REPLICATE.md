# Exact Replication Checklist

An agent can recreate the secure no-cost system from this repository alone:

1. Read `AI.md`, `docs/AI_AGENT_INSTALL.md`, `README.md`,
   `docs/ARCHITECTURE.md`, and `docs/SECURITY.md`.
2. Create a free Supabase project.
3. Run `npm ci`.
4. Apply every file in `supabase/migrations/` in filename order with
   `supabase migration up --linked`. The directory is the list; nothing here
   restates it.
5. Decide on the scheduled jobs before relying on the memory.
   `0002_optional_maintenance.sql` schedules importance decay and the automatic
   retirement of memories that are never recalled with tracking. Read
   [Optional Memory Maintenance](OPERATIONS.md#optional-memory-maintenance) and
   unschedule both jobs if the installation should keep every memory until
   someone retires it. `0003_optional_compaction.sql` only adds a dry-run
   near-duplicate report; it schedules nothing.
6. Confirm `0004_scoped_access_and_supabase_vault.sql` enabled Supabase Vault.
7. When the project already runs an earlier release, follow
   [UPGRADE_V1_4.md](UPGRADE_V1_4.md) instead of this checklist.
8. Generate a scoped client with `npm run token:create -- ...`.
9. Save the plaintext token in the caller's secret store and execute the generated
   hash-only SQL in Supabase.
10. Deploy `supabase/functions/memory` and optionally the OAuth MCP function.
11. Set local `MEMORY_API_URL` and client `MEMORY_TOKEN`.
12. Run `npm run check`, `deno task check`, and `deno task test`.
13. Verify `whoami`, then remember and recall a disposable memory.
14. Verify event idempotency, provenance, links, documents, context, and portable restore.
15. Seed real eval IDs and run `npm run eval`.
16. Configure MCP using `docs/MCP.md`.
17. When connecting another repository, dry-run `npm run integrate -- ...`, review
    the proposed `.ai-memory-free/` files, and rerun it with `--write`.
18. Run an encrypted `pg_dump`, restore it into an isolated project, and prove a
    restored recall.

No generative model, paid API, queue, managed vector database, or always-on local
service is required. The hosted dependency is one free Supabase project. Node is
needed locally for MCP, token generation, and evals.

Do not finish replication with the wildcard bootstrap token as the normal caller.
The secure definition of done is a hashed, scoped, independently revocable token.
