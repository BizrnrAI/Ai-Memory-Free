# MCP Integration

The MCP server is a stdio adapter over the deployed Edge Function. It has no
database connection, storage, ranking, or authorization logic of its own.

## Protocol Support

The adapter is built on `@modelcontextprotocol/server` v2 and serves both MCP
protocol eras from one process. A client that opts into modern version
negotiation receives the 2026-07-28 revision; every other client — including
current Claude, Codex, and Gemini hosts — receives the classic `initialize`
handshake (2025-06-18 / 2025-11-25) unchanged. No configuration is required and
no client is dropped.

## Normal Tools

### `memory_health`

Returns service, embedding strategy, supported actions, and whether the caller used
bootstrap or scoped authentication.

### `memory_whoami`

Returns the client identity, token prefix, namespace grants, permissions, expiry,
and auth mode. Use this first when diagnosing an authorization failure.

### `memory_remember`

Stores a note, fact, decision, correction, reference, or procedure. Arguments:

- `content` string, required
- `namespace` string, optional (`default` if omitted)
- `kind` enum, optional
- `importance` number 0..1, optional
- `source`, `tags`, `metadata`, optional provenance
- `supersedes` UUID, optional

Exact duplicates return the existing row without rewriting frozen importance.

### `memory_recall`

Returns ranked raw context. Arguments: `query`, optional `namespace`, `limit`,
`pool`, and `track`. Set `track:false` for eval/system reads.

### `memory_retire`

Retires a memory without deleting provenance.

### `memory_supersede`

Links an old row to an active replacement in the same namespace.

## v1.2 Module Tools

- `memory_remember_batch`
- `memory_list` — read a namespace in a fixed order, a page at a time; the
  reliable way to load everything a project knows
- `memory_context`
- `memory_event_append`, `memory_event_list`
- `memory_source_upsert`, `memory_source_link`
- `memory_link_create`, `memory_link_list`, `memory_link_resolve`
- `memory_document_ingest`, `memory_document_search`, `memory_document_list`,
  `memory_document_retire`
- `memory_maintenance_status`

`memory_remember_batch` splits what it is given into requests the service can
embed, and `memory_document_ingest` repeats its call until every chunk has a
vector, so each is one finished operation for the agent.

These tools call the same versioned API as HTTPS and TypeScript. `memory_health`
is the canonical capability list. Activity events never accept chain-of-thought;
remote MCP never registers secret tools.

## Secret Tools (Explicit Opt-In)

Set `MCP_ENABLE_SECRET_TOOLS=true` to register:

- `memory_secret_store`
- `memory_secret_get`
- `memory_secret_get_many` — 1..10 explicitly selected logical names
- `memory_secret_list`
- `memory_secret_retire`

The API token must separately hold matching `secrets:*` permissions and a grant for
the namespace. List results never contain plaintext or Vault ciphertext.

Enable these tools only for a dedicated MCP client whose operator understands that
`memory_secret_get` places decrypted plaintext in the MCP result and potentially the
model context. Supabase Vault protects storage; it cannot protect a value after an
authorized caller requests decryption.

## Local Run

```bash
npm ci
MEMORY_API_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory" \
MEMORY_TOKEN="amf_scoped_client_token" \
npm run mcp
```

Dedicated secret-capable process:

```bash
MCP_ENABLE_SECRET_TOOLS=true \
MEMORY_API_URL="$MEMORY_API_URL" \
MEMORY_TOKEN="$SECRET_OPERATOR_TOKEN" \
npm run mcp
```

## Client Configuration

```json
{
  "mcpServers": {
    "ai-memory-free": {
      "command": "npm",
      "args": ["--prefix", "/absolute/path/to/Ai-Memory-Free", "run", "mcp"],
      "env": {
        "MEMORY_API_URL": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory",
        "MEMORY_TOKEN": "amf_scoped_client_token"
      }
    }
  }
}
```

Use the MCP client's operating-system secret store when available. Never commit the
token in a shared configuration file.

## Scaffold An Existing Repository

From the Ai-Memory-Free checkout, preview a model-neutral target-repo integration:

```bash
npm run integrate -- \
  --target /absolute/path/to/your-project \
  --namespace your-project \
  --api-url https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory
```

The command is dry-run by default. Add `--write` only after reviewing the three
planned `.ai-memory-free/` files. It never writes a token or edits existing source,
package, or agent instruction files.

## Outside Services

Any service capable of running a stdio MCP subprocess can run this adapter with its
own least-privilege token. Services that do not support MCP can call the same HTTPS
API through `@ai-memory-free/client`.

This repository intentionally does not expose a remote HTTP MCP endpoint with a
static bearer token. Current MCP authorization guidance distinguishes local stdio
(environment credentials) from hosted HTTP (OAuth 2.1 and protected-resource
metadata). A secure hosted MCP deployment should add a compliant authorization
layer in front of the same API, not bypass it or fork the memory implementation.

References:

- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [Optional Supabase OAuth remote MCP](REMOTE_MCP.md)

Secret inventory supports `limit`, `cursor`, and literal `name_prefix`; follow
`next_cursor` until null. See [SECRETS.md](SECRETS.md) for scoped credential access.
