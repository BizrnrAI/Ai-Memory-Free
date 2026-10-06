#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { MemoryClient } from '@ai-memory-free/client';

const client = new MemoryClient({ allowInsecureHttp: process.env.MEMORY_ALLOW_INSECURE_HTTP === 'true' });

function buildServer() {
  const server = new McpServer({
    name: 'ai-memory-free',
    version: '1.4.0',
  });

  server.registerTool(
    'memory_health',
    {
      description: 'Check the Ai-Memory-Free service health and supported actions.',
      inputSchema: z.object({}),
    },
    async () => asText(await client.health()),
  );

  server.registerTool(
    'memory_whoami',
    {
      description: 'Show the authenticated client identity, namespace grants, permissions, expiry, and auth mode.',
      inputSchema: z.object({}),
    },
    async () => asText(await client.whoAmI()),
  );

  server.registerTool(
    'memory_remember',
    {
      description: 'Store a note, fact, decision, correction, reference, or procedure in semantic memory.',
      inputSchema: z.object({
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
      }),
    },
    async (args) => asText(await client.remember(args)),
  );

  server.registerTool(
    'memory_remember_batch',
    {
      description: 'Store up to 50 idempotent durable memories. The adapter splits them into requests the service can embed, so any mix of sizes works.',
      inputSchema: z.object({
        items: z.array(z.object({
          content: z.string().min(1).max(100_000), namespace: z.string().optional(),
          kind: z.enum(['note', 'fact', 'decision', 'correction', 'reference', 'procedure']).optional(),
          importance: z.number().min(0).max(1).optional(), source: z.string().optional(),
          tags: z.array(z.string()).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
          source_system: z.string().max(128).optional(), external_id: z.string().max(512).optional(),
        })).min(1).max(50),
      }),
    },
    async (args) => asText({ ok: true, results: await client.rememberMany(args.items) }),
  );

  server.registerTool(
    'memory_recall',
    {
      description: 'Recall ranked context from semantic memory. The caller is responsible for synthesis.',
      inputSchema: z.object({
        query: z.string().min(1).max(20_000),
        namespace: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        pool: z.number().int().min(10).max(1000).optional(),
        track: z.boolean().optional(),
      }),
    },
    async (args) => asText(await client.recall(args)),
  );

  server.registerTool(
    'memory_list',
    {
      description: 'Read a namespace in a fixed order, a page at a time. Use this to load everything a project knows (or all of one kind) instead of guessing search terms; follow next_offset until it is null.',
      inputSchema: z.object({
        namespace: z.string().optional(),
        kinds: z.array(z.enum(['note', 'fact', 'decision', 'correction', 'reference', 'procedure'])).optional(),
        tags: z.array(z.string()).max(64).optional(),
        order: z.enum(['importance', 'recent']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1000).max(200_000).optional(),
        include_retired: z.boolean().optional(),
      }),
    },
    async (args) => asText(await client.list(args)),
  );

  server.registerTool(
    'memory_context',
    {
      description: 'Build deterministic, budgeted evidence across explicitly authorized namespaces.',
      inputSchema: z.object({
        query: z.string().min(1).max(20_000),
        namespaces: z.array(z.string()).min(1).max(8).optional(),
        max_chars: z.number().int().min(1000).max(100_000).optional(),
        max_characters: z.number().int().min(1000).max(100_000).optional()
          .describe('Deprecated alias for max_chars.'),
        per_namespace_limit: z.number().int().min(1).max(20).optional(),
        include_events: z.boolean().optional(),
      }),
    },
    async (args) => asText(await client.context(args)),
  );

  server.registerTool(
    'memory_event_append',
    {
      description: 'Append a tool/session outcome to the optional activity journal. Never store chain-of-thought or secrets.',
      inputSchema: z.object({
        namespace: z.string().optional(), event_type: z.string().min(1).max(128),
        summary: z.string().min(1).max(20_000), agent_id: z.string().max(256).optional(),
        session_id: z.string().max(256).optional(), tool_name: z.string().max(256).optional(),
        source_system: z.string().max(128).optional(), external_id: z.string().max(512).optional(),
        payload: z.record(z.string(), z.unknown()).optional(), occurred_at: z.string().optional(),
      }),
    },
    async (args) => asText(await client.appendEvent(args)),
  );

  server.registerTool(
    'memory_event_list',
    {
      description: 'List recent activity events without semantic-memory pollution.',
      inputSchema: z.object({ namespace: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
    },
    async (args) => asText(await client.listEvents(args.namespace, args.limit)),
  );

  server.registerTool(
    'memory_source_upsert',
    {
      description: 'Register provenance, confidence, freshness, and validity for a source.',
      inputSchema: z.object({
        namespace: z.string().optional(), uri: z.string().min(1).max(2048), source_type: z.string().max(128).optional(),
        title: z.string().max(512).optional(), checksum: z.string().max(256).optional(),
        confidence: z.number().min(0).max(1).optional(), observed_at: z.string().optional(),
        valid_from: z.string().optional(), valid_until: z.string().optional(), last_verified_at: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (args) => asText(await client.upsertSource(args)),
  );

  server.registerTool(
    'memory_source_link',
    {
      description: 'Link a source record to a memory as supporting, derived, or verifying evidence.',
      inputSchema: z.object({
        source_id: z.string().uuid(), memory_id: z.string().uuid(),
        relation: z.enum(['supports', 'derived_from', 'verifies']).optional(),
      }),
    },
    async (args) => asText(await client.linkSource(args)),
  );

  server.registerTool(
    'memory_link_create',
    {
      description: 'Create a supports, contradicts, derived-from, or related-to evidence relationship.',
      inputSchema: z.object({
        source_id: z.string().uuid(), memory_id: z.string().uuid(),
        relation: z.enum(['supports', 'contradicts', 'derived_from', 'related_to']), note: z.string().max(2048).optional(),
      }),
    },
    async (args) => asText(await client.createLink(args)),
  );

  server.registerTool(
    'memory_link_list',
    {
      description: 'List active evidence and contradiction relationships.',
      inputSchema: z.object({ namespace: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
    },
    async (args) => asText(await client.listLinks(args.namespace, args.limit)),
  );

  server.registerTool(
    'memory_link_resolve',
    {
      description: 'Resolve a relationship without changing either memory lifecycle.',
      inputSchema: z.object({ link_id: z.string().uuid(), note: z.string().max(2048).optional() }),
    },
    async (args) => asText(await client.resolveLink(args.link_id, args.note)),
  );

  server.registerTool(
    'memory_document_ingest',
    {
      description: 'Ingest bounded text into the optional document/chunk module. To replace an earlier version, pass supersedes (its id) or replace_same_title, so two versions never compete in search.',
      inputSchema: z.object({
        namespace: z.string().optional(), title: z.string().min(1).max(512), content: z.string().min(1).max(100_000),
        source_uri: z.string().max(2048).optional(), media_type: z.string().max(128).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        supersedes: z.string().uuid().optional()
          .describe('Id of the document this one replaces; it is retired once this one is stored.'),
        replace_same_title: z.boolean().optional()
          .describe('Retire every other active document in the namespace with the same title.'),
      }),
    },
    // Repeats the call until every chunk has its vector, so one tool call is a finished ingest.
    async (args) => asText(await client.ingestDocumentFully(args)),
  );

  server.registerTool(
    'memory_document_search',
    {
      description: 'Search optional document chunks with the same hybrid retrieval principles.',
      inputSchema: z.object({
        namespace: z.string().optional(), query: z.string().min(1).max(20_000),
        limit: z.number().int().min(1).max(50).optional(), pool: z.number().int().min(10).max(500).optional(),
      }),
    },
    async (args) => asText(await client.searchDocuments(args)),
  );

  server.registerTool(
    'memory_document_list',
    {
      description: 'Page through documents in the optional document/chunk module.',
      inputSchema: z.object({
        namespace: z.string().optional(), limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(1_000_000).optional(), include_retired: z.boolean().optional(),
      }),
    },
    async (args) => asText(await client.listDocuments(args)),
  );

  server.registerTool(
    'memory_document_retire',
    {
      description: 'Retire a document so its chunks no longer participate in search.',
      inputSchema: z.object({ id: z.string().uuid(), reason: z.string().max(2048).optional() }),
    },
    async (args) => asText(await client.retireDocument(args.id, args.reason)),
  );

  server.registerTool(
    'memory_maintenance_status',
    {
      description: 'Show namespace counts and module/profile status without returning stored content.',
      inputSchema: z.object({ namespace: z.string().optional() }),
    },
    async (args) => asText(await client.maintenanceStatus(args.namespace)),
  );

  server.registerTool(
    'memory_retire',
    {
      description: 'Retire a memory without deleting its audit/provenance context.',
      inputSchema: z.object({
        id: z.string().min(1),
        reason: z.string().optional(),
      }),
    },
    async (args) => asText(await client.retire(args.id, args.reason)),
  );

  server.registerTool(
    'memory_supersede',
    {
      description: 'Mark an old memory superseded by a newer memory.',
      inputSchema: z.object({
        old_id: z.string().min(1),
        new_id: z.string().min(1),
      }),
    },
    async (args) => asText(await client.supersede(args.old_id, args.new_id)),
  );

  // Secret tools are deliberately absent unless the operator opts in. This keeps a
  // general-purpose LLM client from being offered credential-handling capabilities
  // merely because its API token happens to have a broad grant.
  if (process.env.MCP_ENABLE_SECRET_TOOLS === 'true') {
    server.registerTool(
      'memory_secret_store',
      {
        description: 'Encrypt and store a recoverable secret in Supabase Vault. Use service.environment.credential_type with matching service, environment, credential_type metadata for discoverability. Requires secrets:write.',
        inputSchema: z.object({
          namespace: z.string().optional(),
          name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
          secret: z.string().min(1).max(16_384),
          description: z.string().max(2048).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      },
      async (args) => asText(await client.storeSecret(args)),
    );

    server.registerTool(
      'memory_secret_get',
      {
        description: 'Decrypt and return a Supabase Vault secret. Requires secrets:read; use only in a dedicated trusted MCP process.',
        inputSchema: z.object({
          namespace: z.string().optional(),
          name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
        }),
      },
      async (args) => asText(await client.getSecret(args)),
    );

    server.registerTool(
      'memory_secret_list',
      {
        description: 'Find credentials by indexed safe metadata (query), literal name_prefix, and cursor. Returns names and metadata without values; use an exact name with memory_secret_get.',
        inputSchema: z.object({
          namespace: z.string().optional(),
          include_retired: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
          cursor: z.string().optional(),
          name_prefix: z.string().optional(),
          query: z.string().min(1).max(256).optional(),
        }),
      },
      async (args) => asText(await client.listSecrets(args)),
    );

    server.registerTool(
      'memory_secret_get_many',
      {
        description: 'Decrypt 1 to 10 explicitly named credentials. Requires secrets:read; returns values to this trusted client.',
        inputSchema: z.object({ namespace: z.string().optional(), names: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)).min(1).max(10) }),
      },
      async (args) => asText(await client.getSecrets(args)),
    );

    server.registerTool(
      'memory_secret_retire',
      {
        description: 'Retire an encrypted secret without deleting its Vault ciphertext. Requires secrets:admin.',
        inputSchema: z.object({
          namespace: z.string().optional(),
          name: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
        }),
      },
      async (args) => asText(await client.retireSecret(args.name, args.namespace)),
    );
  }

  return server;
}

// serveStdio owns the transport and negotiates the protocol era per connection:
// 2026-07-28 for modern clients, with automatic fallback to the legacy initialize
// handshake for pre-2026 clients.
serveStdio(() => buildServer());

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
