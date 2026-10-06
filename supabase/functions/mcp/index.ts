import { isOAuthIdentity } from './lib.ts';
import { RELEASE_VERSION } from '../memory/protocol.ts';

const MEMORY_API_URL = Deno.env.get('MEMORY_API_URL');
const AUTHORIZATION_SERVER = Deno.env.get('MCP_AUTHORIZATION_SERVER');
const RESOURCE_URL = Deno.env.get('MCP_RESOURCE_URL');
// This endpoint speaks the handshake-based protocol. The 2026-07-28 revision
// (stateless requests, `server/discover`) is not implemented here yet; clients
// built for it fall back to this handshake. The local stdio adapter, which uses
// the official SDK, speaks both.
const MCP_PROTOCOL_VERSION = '2025-06-18';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const tools = [
  tool('memory_health', 'Service version, modules, capabilities, and embedding profile.', {}),
  tool('memory_whoami', 'Authenticated identity, permissions, and namespace grants.', {}),
  tool('memory_remember', 'Store durable semantic memory.', objectSchema(['content'], {
    content: stringSchema(), namespace: stringSchema(), kind: stringSchema(), importance: numberSchema(),
    source: stringSchema(), tags: arraySchema(stringSchema()), metadata: objectSchema(),
    source_system: stringSchema(), external_id: stringSchema(), supersedes: stringSchema(),
  })),
  tool('memory_remember_batch', 'Store up to 50 idempotent memories.', objectSchema(['items'], {
    items: arraySchema(objectSchema()),
  })),
  tool('memory_recall', 'Recall ranked evidence from one namespace.', objectSchema(['query'], {
    query: stringSchema(), namespace: stringSchema(), limit: numberSchema(), pool: numberSchema(), track: booleanSchema(),
  })),
  tool('memory_list', 'Read a namespace in a fixed order, a page at a time; follow next_offset until it is null.', objectSchema([], {
    namespace: stringSchema(), kinds: arraySchema(stringSchema()), tags: arraySchema(stringSchema()), order: stringSchema(),
    limit: numberSchema(), offset: numberSchema(), max_chars: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_context', 'Build a deterministic, budgeted context bundle across authorized namespaces.', objectSchema(['query'], {
    query: stringSchema(), namespaces: arraySchema(stringSchema()), max_chars: numberSchema(),
    max_characters: numberSchema(),
    per_namespace_limit: numberSchema(), include_events: booleanSchema(),
  })),
  tool('memory_event_append', 'Append a durable agent/tool activity event without chain-of-thought.', objectSchema(['event_type', 'summary'], {
    namespace: stringSchema(), event_type: stringSchema(), summary: stringSchema(), agent_id: stringSchema(),
    session_id: stringSchema(), tool_name: stringSchema(), source_system: stringSchema(), external_id: stringSchema(),
    payload: objectSchema(), occurred_at: stringSchema(),
  })),
  tool('memory_event_list', 'List recent activity events.', objectSchema([], { namespace: stringSchema(), limit: numberSchema() })),
  tool('memory_source_upsert', 'Register or refresh provenance and freshness metadata.', objectSchema(['uri'], {
    namespace: stringSchema(), uri: stringSchema(), source_type: stringSchema(), title: stringSchema(),
    checksum: stringSchema(), confidence: numberSchema(), observed_at: stringSchema(), valid_from: stringSchema(),
    valid_until: stringSchema(), last_verified_at: stringSchema(), metadata: objectSchema(),
  })),
  tool('memory_source_link', 'Link a registered source to a memory.', objectSchema(['source_id', 'memory_id'], {
    source_id: stringSchema(), memory_id: stringSchema(), relation: stringSchema(),
  })),
  tool('memory_link_create', 'Create supports/contradicts/derived-from/related evidence links.', objectSchema(['source_id', 'memory_id'], {
    source_id: stringSchema(), memory_id: stringSchema(), relation: stringSchema(), note: stringSchema(),
  })),
  tool('memory_link_list', 'List evidence and contradiction links.', objectSchema([], {
    namespace: stringSchema(), limit: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_link_resolve', 'Resolve a relationship without changing memory lifecycle.', objectSchema(['link_id'], {
    link_id: stringSchema(), note: stringSchema(),
  })),
  tool('memory_document_ingest', 'Ingest a bounded text document into an optional chunk index. To replace an earlier version, pass supersedes (its id) or replace_same_title.', objectSchema(['title', 'content'], {
    namespace: stringSchema(), title: stringSchema(), content: stringSchema(), source_uri: stringSchema(),
    media_type: stringSchema(), metadata: objectSchema(), supersedes: stringSchema(), replace_same_title: booleanSchema(),
  })),
  tool('memory_document_search', 'Search document chunks with hybrid retrieval.', objectSchema(['query'], {
    namespace: stringSchema(), query: stringSchema(), limit: numberSchema(), pool: numberSchema(),
  })),
  tool('memory_document_list', 'Page through documents in the optional document/chunk module.', objectSchema([], {
    namespace: stringSchema(), limit: numberSchema(), offset: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_document_retire', 'Retire a document so its chunks no longer participate in search.', objectSchema(['id'], {
    id: stringSchema(), reason: stringSchema(),
  })),
  tool('memory_maintenance_status', 'Show namespace capacity and module health without returning content.', objectSchema([], {
    namespace: stringSchema(),
  })),
] as const;

const toolActions: Record<string, string> = Object.fromEntries(
  tools.map((entry) => [entry.name, entry.name.replace(/^memory_/, '')]),
);

Deno.serve(async (request) => {
  const resourceUrl = RESOURCE_URL ?? request.url.split('?')[0];
  const metadataUrl = `${resourceUrl}?resource_metadata=1`;
  if (request.method === 'GET' && new URL(request.url).searchParams.get('resource_metadata') === '1') {
    if (!AUTHORIZATION_SERVER) return response({ error: 'mcp_authorization_server_not_configured' }, 503);
    return response({
      resource: resourceUrl,
      authorization_servers: [AUTHORIZATION_SERVER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['openid', 'memory:read', 'memory:write', 'memory:admin'],
    });
  }
  if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (!MEMORY_API_URL || !AUTHORIZATION_SERVER) return response({ error: 'mcp_server_not_configured' }, 503);

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return unauthorized(metadataUrl);
  let rpc: JsonRpcRequest;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 1_048_576) return response({ error: 'request_too_large' }, 413);
    rpc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request');

  const verified = await callMemory(authorization, { action: 'health' });
  if (verified.status === 401) return unauthorized(metadataUrl);
  if (!verified.ok) return jsonRpcError(rpc.id ?? null, -32603, 'Memory service unavailable');
  const identity = await safeJson(verified);
  if (!isOAuthIdentity(identity)) return unauthorized(metadataUrl);
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });

  if (rpc.method === 'initialize' || rpc.method === 'tools/list') {
    if (rpc.method === 'initialize') {
      return jsonRpcResult(rpc.id ?? null, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ai-memory-free-remote', version: RELEASE_VERSION },
      });
    }
    return jsonRpcResult(rpc.id ?? null, { tools });
  }

  // The handshake protocol requires a prompt, empty reply to a ping.
  if (rpc.method === 'ping') return jsonRpcResult(rpc.id ?? null, {});
  if (rpc.method !== 'tools/call') return jsonRpcError(rpc.id ?? null, -32601, 'Method not found');
  const name = typeof rpc.params?.name === 'string' ? rpc.params.name : '';
  const action = toolActions[name];
  if (!action) return jsonRpcError(rpc.id ?? null, -32602, 'Unknown tool');
  const args = isObject(rpc.params?.arguments) ? rpc.params?.arguments : {};
  let called = await callMemory(authorization, { action, ...args });
  if (called.status === 401) return unauthorized(metadataUrl);
  let data = await safeJson(called);
  // A long document is embedded a few chunks per request. Repeat the same call
  // until none is pending, so one tool call is a finished ingest.
  if (action === 'document_ingest' && called.ok) {
    const first = data;
    for (let calls = 1; Number(data.chunks_pending) > 0 && calls < 40; calls += 1) {
      const pendingBefore = Number(data.chunks_pending);
      called = await callMemory(authorization, { action, ...args });
      if (!called.ok) break;
      data = await safeJson(called);
      if (!(Number(data.chunks_pending) < pendingBefore)) break;
    }
    if (called.ok) {
      data = { ...data, created: first.created, reactivated: first.reactivated, retired: first.retired, chunks_created: first.chunks_created };
    }
  }
  return jsonRpcResult(rpc.id ?? null, {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError: !called.ok,
  });
});

// The memory worker can be killed for CPU time (546) or be mid-replacement
// (502/503). The next request gets a fresh worker, so a request that is safe to
// repeat is sent again; a secret write or an unkeyed event is not.
async function callMemory(authorization: string, body: Record<string, unknown>) {
  const retryable = body.action !== 'secret_store' && !(body.action === 'event_append' && !body.external_id);
  for (let attempt = 0; ; attempt += 1) {
    const result = await fetch(MEMORY_API_URL!, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol_version: '1', ...body }),
    });
    if (!retryable || attempt >= 2 || ![546, 502, 503].includes(result.status)) return result;
    await result.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
}

async function safeJson(result: Response): Promise<Record<string, unknown>> {
  try { return await result.json(); } catch { return { ok: false, error: `memory_http_${result.status}` }; }
}

function unauthorized(metadataUrl: string) {
  return response({ error: 'unauthorized' }, 401, {
    'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
  });
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return response({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return response({ jsonrpc: '2.0', id, error: { code, message } }, 400);
}

function response(body: unknown, status = 200, additional: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...additional,
    },
  });
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema };
}

function objectSchema(required: string[] = [], properties: Record<string, unknown> = {}) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}
function stringSchema() { return { type: 'string' }; }
function numberSchema() { return { type: 'number' }; }
function booleanSchema() { return { type: 'boolean' }; }
function arraySchema(items: unknown) { return { type: 'array', items }; }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
