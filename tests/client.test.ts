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
  assert.equal(JSON.parse(String(seen?.body)).protocol_version, '1');
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
    protocol_version: '1',
    action: 'secret_get',
    namespace: 'platform',
    name: 'stripe',
  });
});

test('client exposes modular v1.2 actions through typed helpers and generic call', async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'client-token', fetchImpl });
  await client.context({ query: 'deployment state', namespaces: ['platform', 'operations'] });
  await client.appendEvent({ namespace: 'platform', event_type: 'deploy.completed', summary: 'Deployed.' });
  await client.call('maintenance_status', { namespace: 'platform' });
  assert.deepEqual(requests.map((request) => request.action), ['context', 'event_append', 'maintenance_status']);
  assert(requests.every((request) => request.protocol_version === '1'));
});

test('client exposes document lifecycle and paginated listing helpers', async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'client-token', fetchImpl });

  await client.listDocuments({ namespace: 'platform', limit: 50, offset: 100 });
  await client.retireDocument('00000000-0000-4000-8000-000000000001', 'superseded');

  assert.deepEqual(requests.map((request) => request.action), ['document_list', 'document_retire']);
  assert.equal(requests[0].offset, 100);
});

test('client converts non-JSON failures into a bounded error', async () => {
  const fetchImpl: typeof fetch = async () => new Response('proxy exploded', { status: 502 });
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'client-token', fetchImpl });

  await assert.rejects(() => client.health(), /memory request failed: 502/);
});
