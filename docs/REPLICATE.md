# Exact Replication Checklist

An agent can recreate this system from the repository alone:

1. Read `README.md` and `docs/ZERO_COST_SSOT_MEMORY.md`.
2. Create a free Supabase project.
3. Apply `supabase/migrations/0001_zero_cost_memory.sql`.
4. Optionally apply `supabase/migrations/0002_optional_maintenance.sql`.
5. Set `MEMORY_TOKEN` as a Supabase function secret.
6. Deploy `supabase/functions/memory`.
7. Set local `MEMORY_API_URL` and `MEMORY_TOKEN`.
8. Run `npm install`.
9. Run `npm run check`.
10. Store at least two seed memories with `remember`.
11. Replace eval fixture IDs with returned memory IDs.
12. Run `npm run eval`.
13. Configure any MCP client with `docs/MCP.md`.

No additional service is required. The only hosted dependency is the free Supabase
project. The only local runtime needed for MCP and evals is Node.js.
