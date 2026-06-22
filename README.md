# Ai-Memory-Free

Ai-Memory-Free is a complete, zero-cost, model-agnostic memory system for agents,
apps, and LLM tools.

It gives any caller a persistent single source of truth (SSOT) memory with:

- semantic retrieval using Supabase in-edge `gte-small` embeddings
- hybrid vector plus full-text ranking with Reciprocal Rank Fusion
- transparent relevance scoring
- provenance, namespaces, tags, supersession, and retirement
- a tiny HTTPS API
- a Model Context Protocol (MCP) server adapter
- eval fixtures so retrieval quality can be measured
- no generative model dependency inside the memory service
- no paid API keys, no hosted vector database, no queue, no always-on server

The design is intentionally boring in the best way: one free Supabase project,
one Postgres table, one Edge Function, one optional local MCP wrapper.

## Quick Start

1. Create a free Supabase project.
2. Install the Supabase CLI.
3. Link the project:

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

4. Apply the core migration after review:

```bash
supabase migration up --linked
```

You can also paste `supabase/migrations/0001_zero_cost_memory.sql` into the
Supabase SQL editor for a first free-tier install. Do not apply unreviewed schema
changes to a shared or production project.

5. Create a caller token and set it as a function secret:

```bash
supabase secrets set MEMORY_TOKEN="$(openssl rand -base64 48)"
```

6. Deploy the Edge Function:

```bash
supabase functions deploy memory --no-verify-jwt
```

7. Call it:

```bash
curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"remember","content":"The deploy command is supabase functions deploy memory --no-verify-jwt.","kind":"procedure","source":"README"}'

curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"recall","query":"how do I deploy the memory function?","limit":5}'
```

## MCP

Install dependencies and run the MCP server:

```bash
npm install
MEMORY_API_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory" \
MEMORY_TOKEN="..." \
npm run mcp
```

Example client config:

```json
{
  "mcpServers": {
    "ai-memory-free": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Ai-Memory-Free", "run", "mcp"],
      "env": {
        "MEMORY_API_URL": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory",
        "MEMORY_TOKEN": "your-token"
      }
    }
  }
}
```

The MCP tools are:

- `memory_health`
- `memory_remember`
- `memory_recall`
- `memory_retire`
- `memory_supersede`

## Repository Map

- `docs/ZERO_COST_SSOT_MEMORY.md` - canonical implementation guide mirrored from
  `BizrnrAI/mas-memory`
- `docs/RESEARCH_REVIEW.md` - review of comparable open-source memory systems
- `docs/ARCHITECTURE.md` - system shape and extension points
- `docs/MCP.md` - MCP setup and tool contract
- `docs/OPERATIONS.md` - deploy, backup, keepalive, and restore notes
- `docs/REPLICATE.md` - exact reproduction checklist
- `docs/SECURITY.md` - auth, RLS, secrets, and threat model
- `supabase/migrations/` - database contract
- `supabase/functions/memory/` - Edge Function API
- `packages/client/` - TypeScript client
- `packages/mcp-server/` - MCP adapter
- `eval/` and `scripts/eval.ts` - retrieval quality gate

## Design Non-Goals

- No built-in prose generation.
- No dependency on OpenAI, Anthropic, Gemini, OpenRouter, Vercel AI Gateway, or
  any other paid model provider.
- No managed vector database.
- No SaaS-only memory API.
- No second implementation hidden inside the MCP server.

The caller brings reasoning. The memory brings ranked, durable, inspectable
context.
