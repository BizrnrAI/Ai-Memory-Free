import { isOAuthIdentity } from './lib.ts';

Deno.test('remote MCP accepts only the OAuth memory auth mode', () => {
  if (!isOAuthIdentity({ auth_mode: 'oauth' })) throw new Error('oauth identity rejected');
  if (isOAuthIdentity({ auth_mode: 'scoped' })) throw new Error('scoped token accepted remotely');
  if (isOAuthIdentity({ auth_mode: 'bootstrap' })) throw new Error('bootstrap token accepted remotely');
  if (isOAuthIdentity(null)) throw new Error('invalid identity accepted remotely');
});


import { createRemoteMcpHandler } from './handler.ts';
import { RELEASE_VERSION } from '../memory/protocol.ts';

function assert(value: unknown, message = 'assertion failed'): asserts value {
  if (!value) throw new Error(message);
}

function fixture(authMode = 'oauth', failAction?: string) {
  const calls: Record<string, unknown>[] = [];
  const handler = createRemoteMcpHandler({
    memoryApiUrl: 'https://memory.example.test', authorizationServer: 'https://auth.example.test',
    resourceUrl: 'https://mcp.example.test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      assert((init?.headers as Record<string, string>).authorization === 'Bearer test-oauth');
      if (body.action === failAction) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (body.action === 'health') return Response.json({ ok: true, auth_mode: authMode });
      if (body.action === 'document_ingest') {
        const n = calls.filter((c) => c.action === 'document_ingest').length;
        return Response.json({ ok: true, document: { id: 'd' }, created: n === 1, chunks_created: n === 1 ? 4 : 0, chunks_embedded: 2, chunks_pending: Math.max(0, 4 - n * 2) });
      }
      return Response.json({ ok: true, results: [] });
    },
  });
  return { handler, calls };
}

function request(method: string, params: Record<string, unknown> = {}, modern = true, version = '2026-07-28') {
  return new Request('https://mcp.example.test', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-oauth', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(modern ? { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': String(params.name) } : {}) } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {
      ...params,
      ...(modern ? { _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } : {}),
    } }),
  });
}

async function rpcBody(response: Response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    assert(data, `missing SSE result: ${text}`);
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}

Deno.test('remote MCP serves modern discovery, cache hints, and legacy initialization through the SDK', async () => {
  const { handler } = fixture();
  const discover = await rpcBody(await handler(request('server/discover')));
  assert(discover.result.resultType === 'complete' && discover.result.supportedVersions.includes('2026-07-28'), JSON.stringify(discover));
  const listing = await rpcBody(await handler(request('tools/list')));
  assert(listing.result.resultType === 'complete', JSON.stringify(listing));
  assert(listing.result.ttlMs === 0 && listing.result.cacheScope === 'private');
  assert(!listing.result.tools.some((tool: { name: string }) => tool.name.includes('secret')));
  const legacy = await rpcBody(await handler(request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old-client', version: '1' },
  }, false)));
  assert(legacy.result.protocolVersion === '2025-06-18', JSON.stringify(legacy));
  assert(legacy.result.serverInfo.version === RELEASE_VERSION);
});

Deno.test('remote MCP rejects scoped tokens and advertises OAuth metadata', async () => {
  const { handler, calls } = fixture('scoped');
  const result = await handler(request('tools/list'));
  assert(result.status === 401);
  assert(result.headers.get('www-authenticate')?.includes('resource_metadata'));
  await result.body?.cancel();
  assert(calls.length === 1);
  const metadata = await handler(new Request('https://mcp.example.test?resource_metadata=1'));
  assert((await metadata.json()).authorization_servers[0] === 'https://auth.example.test');
});

Deno.test('remote MCP validates protocol versions, headers, and tool inputs before forwarding', async () => {
  const { handler, calls } = fixture();
  const wrongVersion = await rpcBody(await handler(request('tools/list', {}, true, '2099-01-01')));
  assert(wrongVersion.error.code === -32022, JSON.stringify(wrongVersion));
  const missingHeader = request('tools/list');
  missingHeader.headers.delete('Mcp-Method');
  const headerResult = await handler(missingHeader);
  assert(headerResult.status === 400);
  await headerResult.body?.cancel();
  const injected = await rpcBody(await handler(request('tools/call', { name: 'memory_recall', arguments: { query: 'q', action: 'secret_get' } })));
  assert(injected.result?.isError || injected.error, JSON.stringify(injected));
  assert(calls.every((call) => call.action === 'health'));
});

Deno.test('remote MCP finishes resumable documents and keeps metadata objects usable', async () => {
  const { handler, calls } = fixture();
  const result = await rpcBody(await handler(request('tools/call', {
    name: 'memory_document_ingest', arguments: { title: 'T', content: 'C', metadata: { project: 'p' } },
  })));
  assert(!result.result.isError, JSON.stringify(result));
  const data = JSON.parse(result.result.content[0].text);
  assert(data.created && data.chunks_created === 4 && data.chunks_pending === 0);
  assert(calls.filter((c) => c.action === 'document_ingest').length === 2);
});

Deno.test('remote MCP returns an OAuth challenge when authorization expires during a tool call', async () => {
  const { handler } = fixture('oauth', 'recall');
  const result = await handler(request('tools/call', { name: 'memory_recall', arguments: { query: 'q' } }));
  assert(result.status === 401);
  await result.body?.cancel();
});

Deno.test('remote MCP answers 503, not an OAuth challenge, when the token could not be checked', async () => {
  let calls = 0;
  const handler = createRemoteMcpHandler({
    memoryApiUrl: 'https://memory.example.test', authorizationServer: 'https://auth.example.test',
    resourceUrl: 'https://mcp.example.test',
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ ok: false, error: 'auth_unavailable' }, { status: 503 });
    },
  });
  const result = await handler(request('tools/list'));
  assert(result.status === 503);
  // A challenge would make the client discard a token that is still good.
  assert(!result.headers.has('www-authenticate'));
  assert((await result.json()).error === 'memory_service_unavailable');
  assert(calls === 3);
});

Deno.test('remote MCP bounds long ingests and reports remaining work for the next tool call', async () => {
  let calls = 0;
  const handler = createRemoteMcpHandler({
    memoryApiUrl: 'https://memory.example.test', authorizationServer: 'https://auth.example.test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'health') return Response.json({ auth_mode: 'oauth' });
      calls += 1;
      return Response.json({ document: { id: 'd' }, chunks_pending: 64 - calls * 2 });
    },
  });
  const result = await rpcBody(await handler(request('tools/call', {
    name: 'memory_document_ingest', arguments: { title: 'T', content: 'C' },
  })));
  assert(calls === 24);
  assert(JSON.parse(result.result.content[0].text).chunks_pending === 16);
});
