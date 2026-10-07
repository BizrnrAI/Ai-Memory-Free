# Ai-Memory-Free

**Current release: v1.4.1 — protocol v1, eight independently discoverable modules.**
Release notes: [CHANGELOG.md](CHANGELOG.md) and
[GitHub releases](https://github.com/BizrnrAI/Ai-Memory-Free/releases). Upgrading
from v1.3: [docs/UPGRADE_V1_4.md](docs/UPGRADE_V1_4.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-16a34a.svg)](LICENSE)
[![No paid LLM API required](https://img.shields.io/badge/paid%20LLM%20API-not%20required-2563eb.svg)](docs/FAQ.md#is-ai-memory-free-really-free)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-7c3aed.svg)](docs/MCP.md)

**Give this repository link to any capable AI coding agent:**
<https://github.com/BizrnrAI/Ai-Memory-Free>

The ready-to-paste prompt is in [INSTALL_WITH_AI.md](INSTALL_WITH_AI.md). The
complete model-neutral implementation contract is
[docs/AI_AGENT_INSTALL.md](docs/AI_AGENT_INSTALL.md).

Created by [Kristian Peter](https://kristianpeter.com), Chief Automation Officer.
Free under the [MIT License](LICENSE): no licensing fee, account, or required paid
model API.

Ai-Memory-Free is a no-cost, LLM-agnostic memory service for agents, applications,
and MCP clients. It stores durable platform knowledge in one Supabase Postgres
database and returns ranked context without asking any generative model to reason,
summarize, or rewrite it.

The default path provides:

- hybrid retrieval: pgvector plus two full-text lists (all words, any word), fused
  with transparent Reciprocal Rank Fusion — measured, see [docs/RETRIEVAL.md](docs/RETRIEVAL.md)
- `list`: read a small namespace whole, in a fixed order, with nothing to miss
- free in-edge `gte-small` embeddings inside a per-request budget the hosted
  runtime can always afford; an optional keyword-only mode with no embeddings
- namespaces, tags, metadata, provenance, retirement, and supersession
- immutable ranking importance plus separate lifecycle decay
- exact duplicate prevention and optional semantic compaction
- hashed, revocable, expiring API credentials with per-client permissions
- namespace isolation enforced before every read or write
- database-backed per-client rate limits and security audit events
- recoverable platform secrets encrypted with Supabase Vault authenticated encryption
- one HTTPS API, a TypeScript client, and a thin MCP adapter
- deterministic multi-namespace context bundles with explicit character budgets
- idempotent batch ingestion and an optional append-only agent activity journal
- first-class source confidence, freshness, validity, and contradiction evidence
- portable checksummed export/import that excludes credentials and regenerates vectors
- pluggable embedding profiles while preserving free `gte-small` as the default
- optional document/chunk search, maintenance status, and OAuth-protected remote MCP
- unit tests, Deno tests, migration checks, and retrieval eval fixtures
- no paid model API, managed vector database, queue, or always-on server

The caller brings the LLM. The service only stores and retrieves inspectable data,
so Claude, Codex, Gemini, local models, ordinary software, and future agents can all
share the same memory.

## Choose Your Path

| Goal | Start here |
| --- | --- |
| Give the GitHub link to an AI agent | [INSTALL_WITH_AI.md](INSTALL_WITH_AI.md) |
| Deploy a new memory backend | [AI agent installation contract](docs/AI_AGENT_INSTALL.md#path-a-deploy-a-new-independent-memory) |
| Connect an existing repo | [Existing-project path](docs/AI_AGENT_INSTALL.md#path-b-connect-an-existing-project-or-repository) |
| Configure MCP | [MCP guide](docs/MCP.md) |
| Understand v1.2 modules | [Module contract](docs/MODULES.md) |
| Upgrade from v0.2 | [v1.2 upgrade guide](docs/UPGRADE_V1_2.md) |
| Upgrade from v1.3 | [v1.4 upgrade guide](docs/UPGRADE_V1_4.md) |
| How recall works and how it was measured | [Retrieval](docs/RETRIEVAL.md) |
| Move data between installations | [Portable export/import](docs/PORTABILITY.md) |
| Call from TypeScript or HTTPS | [Integration choices](docs/AI_AGENT_INSTALL.md#integration-choices) |
| Call the API from any language | [HTTPS action reference](docs/ACTIONS.md) |
| Store and retrieve encrypted API keys/tokens | [Credential access](docs/SECRETS.md) |
| Understand security and Vault | [Security model](docs/SECURITY.md) |
| Browse all documentation | [Documentation index](docs/INDEX.md) |

The project is self-deployed. Your Supabase account owns the database, memories,
tokens, and Vault secrets. The repository sends no telemetry to KristianPeter.com
or BizRnR.

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

1. Clone the repository, create a free Supabase project, and install the Supabase
   CLI:

```bash
git clone https://github.com/BizrnrAI/Ai-Memory-Free.git
cd Ai-Memory-Free
```

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

The always-on core tool set is:

- `memory_health`
- `memory_whoami`
- `memory_remember`
- `memory_recall`
- `memory_retire`
- `memory_supersede`

The adapter also registers list, context, batch, event, provenance, relationship,
document, and maintenance tools. `memory_health` is the machine-readable capability source.

Encrypted-secret tools are absent unless the operator explicitly sets
`MCP_ENABLE_SECRET_TOOLS=true` **and** gives that client the matching secret
permissions. See [docs/MCP.md](docs/MCP.md).

The adapter is built on `@modelcontextprotocol/server` v2 and negotiates the MCP
protocol era per connection: modern clients receive the 2026-07-28 revision while
existing hosts keep the classic `initialize` handshake, with no configuration.
The stdio server follows MCP guidance by reading credentials from its environment.
Any outside service can run this adapter with its own scoped token. v1.2 also
provides an optional sessionless HTTP MCP Edge Function protected by
Supabase Auth OAuth 2.1 and explicit database grants. It never exposes Vault tools.
See [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md).

## v1.2 Modular Capabilities

Call `health` to discover the protocol, embedding profile, actions, and installed
module manifests. The required `core` remains small; events, provenance,
relationships, documents, maintenance, Vault secrets, and remote MCP are isolated
modules that reuse the same authorization and API.

```bash
# Safe, retryable activity capture
curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"protocol_version":"1","action":"event_append","namespace":"platform","event_type":"deploy.completed","summary":"Production deployment completed and smoke checks passed.","source_system":"deploy-agent","external_id":"deploy-2026-07-10"}'

# Deterministic context across explicitly granted namespaces
curl -s "$MEMORY_API_URL" \
  -H "authorization: Bearer $MEMORY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"protocol_version":"1","action":"context","query":"What changed in the latest deployment?","namespaces":["platform","operations"],"max_chars":12000,"include_events":true}'
```

Portable export and local text-document ingestion are dry-run/safe by default or
strictly bounded. See [PORTABILITY.md](docs/PORTABILITY.md) and
[DOCUMENTS.md](docs/DOCUMENTS.md).

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

- `AI.md` - compact routing instructions for any AI coding agent
- `INSTALL_WITH_AI.md` - copy-paste handoff prompt
- `docs/INDEX.md` - complete documentation navigation
- `docs/AI_AGENT_INSTALL.md` - deploy/integrate/verify contract for agents
- `docs/MODULES.md` - stable core/module seams and extension rules
- `docs/PROTOCOL.md` - protocol v1, capability discovery, and idempotency
- `docs/ACTIONS.md` - complete HTTPS request/response reference for all actions
- `docs/EVENTS.md` - safe agent activity journal
- `docs/PROVENANCE.md` - freshness and evidence relationships
- `docs/DOCUMENTS.md` - optional text document ingestion and search
- `docs/PORTABILITY.md` - checksummed export/import
- `docs/REMOTE_MCP.md` - optional Supabase OAuth 2.1 remote MCP
- `docs/UPGRADE_V1_2.md` - additive upgrade from v0.2 and rollback
- `docs/UPGRADE_V1_4.md` - upgrade from v1.3: migrations, new limits, changed responses
- `docs/RETRIEVAL.md` - how recall works, what was measured, embedding budget and modes
- `docs/SECRETS.md` - storing and reading encrypted API keys and tokens
- `CHANGELOG.md` - release notes for every version
- `docs/FAQ.md` - ownership, cost, model, security, and integration answers
- `docs/AUDIT.md` - full-repository audit and remediation record
- `docs/ARCHITECTURE.md` - system shape and trust boundaries
- `docs/SECURITY.md` - threat model, token scopes, and secret semantics
- `docs/MCP.md` - MCP tools and client configuration
- `docs/OPERATIONS.md` - deploy, rotate, revoke, back up, and restore
- `docs/ZERO_COST_SSOT_MEMORY.md` - canonical implementation guide
- `supabase/migrations/` - additive database contract
- `supabase/functions/memory/` - Edge Function and tested pure helpers
- `supabase/functions/mcp/` - optional OAuth-protected Streamable HTTP MCP
- `schemas/` - machine-readable protocol, module, and portable contracts
- `packages/client/` - TypeScript HTTPS client
- `packages/mcp-server/` - stdio MCP adapter
- `scripts/scaffold-integration.ts` - dry-run-first target repository integration
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

## Open Source And Attribution

Ai-Memory-Free may be used, copied, modified, distributed, sublicensed, or included
in commercial projects under the [MIT License](LICENSE). There is no required fee
or hosted subscription. Preserve the license notice in copies or substantial
portions of the software.

The project was created by [Kristian Peter](https://kristianpeter.com), a Chief
Automation Officer building AI voice, marketing, and workflow systems that let one
operator run an entire company. Attribution and a GitHub star are appreciated, but
the software remains genuinely free and user-owned.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md),
[SUPPORT.md](SUPPORT.md), and the private reporting process in [SECURITY.md](SECURITY.md).
