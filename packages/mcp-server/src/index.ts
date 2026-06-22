#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryClient } from '@ai-memory-free/client';

const client = new MemoryClient();

const server = new McpServer({
  name: 'ai-memory-free',
  version: '0.1.0',
});

server.tool(
  'memory_health',
  'Check the Ai-Memory-Free service health and supported actions.',
  {},
  async () => asText(await client.health()),
);

server.tool(
  'memory_remember',
  'Store a note, fact, decision, correction, reference, or procedure in semantic memory.',
  {
    content: z.string().min(1).max(100_000),
    namespace: z.string().optional(),
    kind: z.enum(['note', 'fact', 'decision', 'correction', 'reference', 'procedure']).optional(),
    importance: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    supersedes: z.string().optional(),
  },
  async (args) => asText(await client.remember(args)),
);

server.tool(
  'memory_recall',
  'Recall ranked context from semantic memory. The caller is responsible for synthesis.',
  {
    query: z.string().min(1).max(20_000),
    namespace: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    pool: z.number().int().min(10).max(1000).optional(),
    track: z.boolean().optional(),
  },
  async (args) => asText(await client.recall(args)),
);

server.tool(
  'memory_retire',
  'Retire a memory without deleting its audit/provenance context.',
  {
    id: z.string().min(1),
    reason: z.string().optional(),
  },
  async (args) => asText(await client.retire(args.id, args.reason)),
);

server.tool(
  'memory_supersede',
  'Mark an old memory superseded by a newer memory.',
  {
    old_id: z.string().min(1),
    new_id: z.string().min(1),
  },
  async (args) => asText(await client.supersede(args.old_id, args.new_id)),
);

const transport = new StdioServerTransport();
await server.connect(transport);

function asText(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
