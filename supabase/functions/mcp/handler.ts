import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { MemoryClient, MemoryRequestError } from '../../../packages/client/src/index.ts';
import { isOAuthIdentity } from './lib.ts';
import { tools } from './tools.ts';
import { RELEASE_VERSION } from '../memory/protocol.ts';

export type RemoteMcpOptions = {
  memoryApiUrl?: string;
  authorizationServer?: string;
  resourceUrl?: string;
  fetchImpl?: typeof fetch;
  allowInsecureHttp?: boolean;
};

const validator = new CfWorkerJsonSchemaValidator();
const schemas = new Map(tools.map((tool) => [
  tool.name, fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType, validator),
]));

/** OAuth verification remains outside the SDK; each request gets its own client. */
export function createRemoteMcpHandler(options: RemoteMcpOptions) {
  return async (request: Request): Promise<Response> => {
    const resourceUrl = options.resourceUrl ?? request.url.split('?')[0];
    const metadataUrl = `${resourceUrl}?resource_metadata=1`;
    if (request.method === 'GET' && new URL(request.url).searchParams.get('resource_metadata') === '1') {
      if (!options.authorizationServer) return response({ error: 'mcp_authorization_server_not_configured' }, 503);
      return response({
        resource: resourceUrl,
        authorization_servers: [options.authorizationServer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'memory:read', 'memory:write', 'memory:admin'],
      });
    }
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
    if (!options.memoryApiUrl || !options.authorizationServer) return response({ error: 'mcp_server_not_configured' }, 503);
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || !authorization.slice(7).trim()) return unauthorized(metadataUrl);
    let upstreamCalls = 0;
    const upstreamFetch = options.fetchImpl ?? fetch;
    let client: MemoryClient;
    try {
      client = new MemoryClient({
        apiUrl: options.memoryApiUrl, token: authorization.slice(7).trim(), allowInsecureHttp: options.allowInsecureHttp,
        fetchImpl: async (url, init) => {
          // Hosted Supabase allows 30 nested invocations per trace. Count actual
          // attempts, including retries and health, and leave room for the MCP call.
          if (upstreamCalls >= 28) return Response.json({ error: 'remote_request_budget_exceeded' }, { status: 429 });
          upstreamCalls += 1;
          return await upstreamFetch(url, init);
        },
      });
    } catch {
      return response({ error: 'mcp_server_not_configured' }, 503);
    }
    try {
      const identity = await client.health();
      if (!isOAuthIdentity(identity)) return unauthorized(metadataUrl);
    } catch (error) {
      if (error instanceof MemoryRequestError && error.status === 401) return unauthorized(metadataUrl);
      return response({ error: 'memory_service_unavailable' }, 503);
    }

    let authExpired = false;
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'ai-memory-free-remote', version: RELEASE_VERSION });
      for (const tool of tools) {
        const action = tool.name.replace(/^memory_/, '');
        server.registerTool(tool.name, {
          description: tool.description,
          inputSchema: schemas.get(tool.name)!,
        }, async (args) => {
          try {
            // Reuse the client's budget packing and resumable ingest, with the
            // authenticated caller's bearer. No tool can select another action.
            const data = action === 'remember_batch'
              ? { ok: true, results: await client.rememberMany(args.items as Parameters<MemoryClient['rememberMany']>[0], args.namespace as string | undefined) }
              : action === 'document_ingest'
              ? await client.ingestDocumentFully(args, 24)
              : await client.call(action, args);
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
          } catch (error) {
            if (error instanceof MemoryRequestError && error.status === 401) authExpired = true;
            const data = error instanceof MemoryRequestError
              ? { ok: false, error: error.message, ...error.body }
              : { ok: false, error: 'memory_service_unavailable' };
            return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], isError: true };
          }
        });
      }
      return server;
    }, { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: 1_048_576 });
    try {
      const result = await handler.fetch(request);
      if (authExpired) {
        await result.body?.cancel();
        return unauthorized(metadataUrl);
      }
      return result;
    } finally {
      await handler.close();
    }
  };
}

function unauthorized(metadataUrl: string) {
  return response({ error: 'unauthorized' }, 401, {
    'www-authenticate': `Bearer resource_metadata="${metadataUrl}"`,
  });
}
function response(body: unknown, status = 200, additional: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...additional,
    },
  });
}
