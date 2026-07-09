import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryClient } from '../packages/client/src/index.js';

test('client sends bearer auth without exposing it in the request body', async () => {
  let seen: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen = init;
    return new Response(JSON.stringify({ ok: true, results: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'top-secret', fetchImpl });

  await client.recall({ query: 'deployment process', track: false });

  assert.equal((seen?.headers as Record<string, string>).authorization, 'Bearer top-secret');
  assert.doesNotMatch(String(seen?.body), /top-secret/);
});

test('client exposes an explicit encrypted-secret read operation', async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      ok: true,
      secret: {
        id: '00000000-0000-4000-8000-000000000001',
        namespace: 'platform',
        name: 'stripe',
        version: 1,
        metadata: {},
        created_at: '2026-07-09T00:00:00Z',
        secret: 'decrypted-by-vault',
      },
    }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'client-token', fetchImpl });

  const result = await client.getSecret({ namespace: 'platform', name: 'stripe' });

  assert.equal(result.secret.secret, 'decrypted-by-vault');
  assert.deepEqual(requests[0], {
    action: 'secret_get',
    namespace: 'platform',
    name: 'stripe',
  });
});

test('client converts non-JSON failures into a bounded error', async () => {
  const fetchImpl: typeof fetch = async () => new Response('proxy exploded', { status: 502 });
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'client-token', fetchImpl });

  await assert.rejects(() => client.health(), /memory request failed: 502/);
});
