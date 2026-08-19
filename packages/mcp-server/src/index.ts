#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryClient } from '@ai-memory-free/client';

const client = new MemoryClient();

const server = new McpServer({
  name: 'ai-memory-free',
  version: '1.2.0',
});

server.tool(
  'memory_health',
  'Check the Ai-Memory-Free service health and supported actions.',
  {},
  async () => asText(await client.health()),
);

server.tool(
  'memory_whoami',
  'Show the authenticated client identity, namespace grants, permissions, expiry, and auth mode.',
  {},
  async () => asText(await client.whoAmI()),
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
    metadata: z.record(z.string(), z.unknown()).optional(),
    supersedes: z.string().optional(),
    source_system: z.string().max(128).optional(),
    external_id: z.string().max(512).optional(),
  },
  async (args) => asText(await client.remember(args)),
);

server.tool(
  'memory_remember_batch',
  'Store up to 50 idempotent durable memories in one request.',
  {
    items: z.array(z.object({
      content: z.string().min(1).max(100_000), namespace: z.string().optional(),
      kind: z.enum(['note', 'fact', 'decision', 'correction', 'reference', 'procedure']).optional(),
      importance: z.number().min(0).max(1).optional(), source: z.string().optional(),
      tags: z.array(z.string()).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
      source_system: z.string().max(128).optional(), external_id: z.string().max(512).optional(),
    })).min(1).max(50),
  },
  async (args) => asText(await client.rememberBatch(args.items)),
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
  'memory_context',
  'Build deterministic, budgeted evidence across explicitly authorized namespaces.',
  {
    query: z.string().min(1).max(20_000),
    namespaces: z.array(z.string()).min(1).max(8).optional(),
    max_chars: z.number().int().min(1000).max(100_000).optional(),
    per_namespace_limit: z.number().int().min(1).max(20).optional(),
    include_events: z.boolean().optional(),
  },
  async (args) => asText(await client.context(args)),
);

server.tool(
  'memory_event_append',
  'Append a tool/session outcome to the optional activity journal. Never store chain-of-thought or secrets.',
  {
    namespace: z.string().optional(), event_type: z.string().min(1).max(128),
    summary: z.string().min(1).max(20_000), agent_id: z.string().max(256).optional(),
    session_id: z.string().max(256).optional(), tool_name: z.string().max(256).optional(),
    source_system: z.string().max(128).optional(), external_id: z.string().max(512).optional(),
    payload: z.record(z.string(), z.unknown()).optional(), occurred_at: z.string().optional(),
  },
  async (args) => asText(await client.appendEvent(args)),
);

server.tool(
  'memory_event_list',
  'List recent activity events without semantic-memory pollution.',
  { namespace: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  async (args) => asText(await client.listEvents(args.namespace, args.limit)),
);

server.tool(
  'memory_source_upsert',
  'Register provenance, confidence, freshness, and validity for a source.',
  {
    namespace: z.string().optional(), uri: z.string().min(1).max(2048), source_type: z.string().max(128).optional(),
    title: z.string().max(512).optional(), checksum: z.string().max(256).optional(),
    confidence: z.number().min(0).max(1).optional(), observed_at: z.string().optional(),
    valid_from: z.string().optional(), valid_until: z.string().optional(), last_verified_at: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
  async (args) => asText(await client.upsertSource(args)),
);

server.tool(
  'memory_source_link',
  'Link a source record to a memory as supporting, derived, or verifying evidence.',
  { source_id: z.string().uuid(), memory_id: z.string().uuid(), relation: z.enum(['supports', 'derived_from', 'verifies']).optional() },
  async (args) => asText(await client.linkSource(args)),
);

server.tool(
  'memory_link_create',
  'Create a supports, contradicts, derived-from, or related-to evidence relationship.',
  {
    source_id: z.string().uuid(), memory_id: z.string().uuid(),
    relation: z.enum(['supports', 'contradicts', 'derived_from', 'related_to']), note: z.string().max(2048).optional(),
  },
  async (args) => asText(await client.createLink(args)),
);

server.tool(
  'memory_link_list',
  'List active evidence and contradiction relationships.',
  { namespace: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  async (args) => asText(await client.listLinks(args.namespace, args.limit)),
);

server.tool(
  'memory_link_resolve',
  'Resolve a relationship without changing either memory lifecycle.',
  { link_id: z.string().uuid(), note: z.string().max(2048).optional() },
  async (args) => asText(await client.resolveLink(args.link_id, args.note)),
);

server.tool(
  'memory_document_ingest',
  'Ingest bounded text into the optional document/chunk module.',
  {
    namespace: z.string().optional(), title: z.string().min(1).max(512), content: z.string().min(1).max(100_000),
    source_uri: z.string().max(2048).optional(), media_type: z.string().max(128).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  },
  async (args) => asText(await client.ingestDocument(args)),
);

server.tool(
  'memory_document_search',
  'Search optional document chunks with the same hybrid retrieval principles.',
  {
    namespace: z.string().optional(), query: z.string().min(1).max(20_000),
    limit: z.number().int().min(1).max(50).optional(), pool: z.number().int().min(10).max(500).optional(),
  },
  async (args) => asText(await client.searchDocuments(args)),
);

server.tool(
  'memory_maintenance_status',
  'Show namespace counts and module/profile status without returning stored content.',
  { namespace: z.string().optional() },
  async (args) => asText(await client.maintenanceStatus(args.namespace)),
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

// Secret tools are deliberately absent unless the operator opts in. This keeps a
// general-purpose LLM client from being offered credential-handling capabilities
// merely because its API token happens to have a broad grant.
if (process.env.MCP_ENABLE_SECRET_TOOLS === 'true') {
  server.tool(
    'memory_secret_store',
    'Encrypt and store a recoverable secret in Supabase Vault. Requires secrets:write.',
    {
      namespace: z.string().optional(),
      name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
      secret: z.string().min(1).max(16_384),
      description: z.string().max(2048).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    async (args) => asText(await client.storeSecret(args)),
  );

  server.tool(
    'memory_secret_get',
    'Decrypt and return a Supabase Vault secret. Requires secrets:read; use only in a dedicated trusted MCP process.',
    {
      namespace: z.string().optional(),
      name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    },
    async (args) => asText(await client.getSecret(args)),
  );

  server.tool(
    'memory_secret_list',
    'List encrypted-secret metadata only. Secret values and Vault ciphertext are never returned.',
    {
      namespace: z.string().optional(),
      include_retired: z.boolean().optional(),
    },
    async (args) => asText(await client.listSecrets(args.namespace, args.include_retired)),
  );

  server.tool(
    'memory_secret_retire',
    'Retire an encrypted secret without deleting its Vault ciphertext. Requires secrets:admin.',
    {
      namespace: z.string().optional(),
      name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    },
    async (args) => asText(await client.retireSecret(args.name, args.namespace)),
  );
}

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
