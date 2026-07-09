# Ai-Memory-Free

Ai-Memory-Free is a no-cost, LLM-agnostic memory service for agents, applications,
and MCP clients. It stores durable platform knowledge in one Supabase Postgres
database and returns ranked context without asking any generative model to reason,
summarize, or rewrite it.

The default path provides:

- hybrid pgvector + full-text retrieval with transparent Reciprocal Rank Fusion
- free in-edge `gte-small` embeddings with bounded multi-chunk averaging
- namespaces, tags, metadata, provenance, retirement, and supersession
- immutable ranking importance plus separate lifecycle decay
- exact duplicate prevention and optional semantic compaction
- hashed, revocable, expiring API credentials with per-client permissions
- namespace isolation enforced before every read or write
- database-backed per-client rate limits and security audit events
- recoverable platform secrets encrypted with Supabase Vault authenticated encryption
- one HTTPS API, a TypeScript client, and a thin MCP adapter
- unit tests, Deno tests, migration checks, and retrieval eval fixtures
- no paid model API, managed vector database, queue, or always-on server

The caller brings the LLM. The service only stores and retrieves inspectable data,
so Claude, Codex, Gemini, local models, ordinary software, and future agents can all
share the same memory.

## Credential Semantics

External caller tokens are high-entropy authentication credentials. Only their
SHA-256 hashes are stored, so a database leak does not yield usable bearer tokens.

Platform API keys and secrets have a different requirement: authorized services may
need to recover them. They are stored through Supabase Vault, which applies
authenticated encryption and keeps the encryption key outside the database.
Secrets never enter semantic memory, embeddings, FTS, metadata lists, or audit logs.

## Architecture

```text
Any LLM / agent / app
        |
        | scoped bearer token
        v
Supabase Edge Function
  auth -> namespace/permission gate -> rate limit -> action -> audit
        |                                  |
        |                                  +-> Supabase Vault encrypted secrets
        v
Postgres memories -> vector + FTS + RRF -> ranked context
        ^
        |
stdio MCP adapter (optional secret tools are off by default)
```

## Quick Start

1. Create a free Supabase project and install the Supabase CLI.
2. Install the locked Node dependencies:

```bash
npm ci
```

3. Link the project and apply the reviewed migrations:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase migration up --linked
```

For shared or production projects, use your normal controlled migration process.
Never apply unreviewed SQL directly.

4. Generate a high-entropy client token and its SHA-256 database representation:

```bash
npm run token:create -- \
  --name primary-agent \
  --namespaces platform \
  --permissions memory:read,memory:write
```

Save the displayed token in your client secret store, then run the displayed SQL
in the Supabase SQL editor. Only the hash is inserted. The plaintext token cannot
be recovered later.

5. Deploy the Edge Function:

```bash
supabase functions deploy memory --no-verify-jwt
```

6. Call the API with the plaintext client token:

```bash
export MEMORY_API_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory"
export MEMORY_TOKEN="amf_..."

curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"remember","namespace":"platform","content":"Deploy with supabase functions deploy memory --no-verify-jwt.","kind":"procedure","source":"README"}'

curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"recall","namespace":"platform","query":"how is the memory function deployed?","limit":5}'
```

`MEMORY_TOKEN` may still be set as an Edge Function secret for bootstrap or
emergency administration. That legacy token has wildcard access, so new installs
should prefer hashed scoped clients and leave the Edge `MEMORY_TOKEN` unset.

## MCP

Run the local stdio adapter with any scoped token:

```bash
MEMORY_API_URL="$MEMORY_API_URL" MEMORY_TOKEN="$MEMORY_TOKEN" npm run mcp
```

The normal tool set is:

- `memory_health`
- `memory_whoami`
- `memory_remember`
- `memory_recall`
- `memory_retire`
- `memory_supersede`

Encrypted-secret tools are absent unless the operator explicitly sets
`MCP_ENABLE_SECRET_TOOLS=true` **and** gives that client the matching secret
permissions. See [docs/MCP.md](docs/MCP.md).

The stdio server follows MCP guidance by reading credentials from its environment.
Any outside service can run this adapter with its own scoped token. A remotely
hosted HTTP MCP server is not included because the MCP specification requires an
OAuth-based authorization design for HTTP transports; the HTTPS memory API is the
zero-server remote integration surface.

## Verification

```bash
npm run check
deno task check
deno task test
npm audit --omit=dev
```

After seeding deployment-specific eval IDs:

```bash
MEMORY_EVAL_FIXTURES=eval/fixtures.local.json npm run eval
```

## Repository Map

- `docs/AUDIT.md` - full-repository audit and remediation record
- `docs/ARCHITECTURE.md` - system shape and trust boundaries
- `docs/SECURITY.md` - threat model, token scopes, and secret semantics
- `docs/MCP.md` - MCP tools and client configuration
- `docs/OPERATIONS.md` - deploy, rotate, revoke, back up, and restore
- `docs/ZERO_COST_SSOT_MEMORY.md` - canonical implementation guide
- `supabase/migrations/` - additive database contract
- `supabase/functions/memory/` - Edge Function and tested pure helpers
- `packages/client/` - TypeScript HTTPS client
- `packages/mcp-server/` - stdio MCP adapter
- `eval/` and `scripts/eval.ts` - retrieval quality gate

## Free-Tier Boundaries

The design targets the current Supabase Free Plan: a 500 MB database quota, free
Edge Function allocation, and project pausing after a low-activity week. These are
vendor limits, not architectural guarantees, so verify them before a deployment:
[pricing](https://supabase.com/pricing),
[database size](https://supabase.com/docs/guides/platform/database-size), and
[project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

## Non-Goals

- No built-in prose generation or model-specific prompt format.
- No application-managed encryption keys or custom crypto format.
- No public browser token, direct client access to Postgres, or permissive RLS.
- No paid API or hosted LLM dependency in the default path.
- No second ranking implementation inside MCP.

The full raw content remains in Postgres. The embedding model affects semantic
ranking only; full-text retrieval, provenance, and exports remain inspectable and
provider-neutral.
