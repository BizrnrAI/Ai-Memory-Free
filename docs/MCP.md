# MCP Integration

The MCP server is an adapter over the deployed Edge Function. It does not keep its
own database and does not implement separate ranking logic.

## Tools

### `memory_health`

Checks that the Edge Function is reachable and configured.

### `memory_remember`

Stores a memory.

Arguments:

- `content` string, required
- `namespace` string, optional
- `kind` enum, optional: `note`, `fact`, `decision`, `correction`, `reference`,
  `procedure`
- `importance` number 0 to 1, optional
- `source` string, optional
- `tags` string array, optional
- `metadata` object, optional
- `supersedes` string id, optional

### `memory_recall`

Retrieves ranked context.

Arguments:

- `query` string, required
- `namespace` string, optional
- `limit` integer 1 to 50, optional
- `pool` integer 10 to 1000, optional
- `track` boolean, optional. Set `false` for evals and system reads.

### `memory_retire`

Marks a memory inactive.

### `memory_supersede`

Marks an old memory superseded by a new memory.

## Local Run

```bash
npm install
MEMORY_API_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/memory" \
MEMORY_TOKEN="..." \
npm run mcp
```

## Claude Desktop / Codex Style Config

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

Keep `MEMORY_TOKEN` out of git. Use the client secret store for your MCP client
when one is available.
