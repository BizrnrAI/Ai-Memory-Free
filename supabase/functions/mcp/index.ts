import { createRemoteMcpHandler } from './handler.ts';

Deno.serve(createRemoteMcpHandler({
  memoryApiUrl: Deno.env.get('MEMORY_API_URL'),
  authorizationServer: Deno.env.get('MCP_AUTHORIZATION_SERVER'),
  resourceUrl: Deno.env.get('MCP_RESOURCE_URL'),
  allowInsecureHttp: Deno.env.get('MEMORY_ALLOW_INSECURE_HTTP') === 'true',
}));
