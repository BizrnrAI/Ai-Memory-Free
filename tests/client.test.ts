import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryClient, MemoryRequestError, packByEmbedBudget, formatSecretName } from '../packages/client/src/index.js';

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

test('client retries a request the host cut off for CPU time, and no other failure', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('', { status: 546 });
    return new Response(JSON.stringify({ ok: true, created: true, memory: { id: 'm1' } }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  const stored = await client.remember({ content: 'retry me' });
  assert.equal(stored.ok, true);
  assert.equal(calls, 3);

  let refused = 0;
  const refusing: typeof fetch = async () => {
    refused += 1;
    return new Response(JSON.stringify({ ok: false, error: 'embedding_budget_exceeded', max_embed_cost: 6000 }), { status: 413 });
  };
  const strict = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl: refusing });
  await assert.rejects(strict.rememberBatch([{ content: 'x' }]), (error: unknown) => {
    assert.ok(error instanceof MemoryRequestError);
    assert.equal(error.message, 'embedding_budget_exceeded');
    assert.equal(error.status, 413);
    assert.equal(error.body.max_embed_cost, 6000);
    return true;
  });
  assert.equal(refused, 1);
});

test('client never repeats a write that is not safe to send twice', async () => {
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)).action);
    return new Response('', { status: 546 });
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  await assert.rejects(client.storeSecret({ name: 'k', secret: 'v' }));
  await assert.rejects(client.appendEvent({ event_type: 'task.done', summary: 'no external id' }));
  assert.deepEqual(seen, ['secret_store', 'event_append']);
  seen.length = 0;
  await assert.rejects(client.appendEvent({ event_type: 'task.done', summary: 'keyed', source_system: 's', external_id: 'e1' }));
  assert.equal(seen.length, 3);
  // A worker being replaced answers 502 or 503: the same rule applies.
  let attempts = 0;
  const flaky: typeof fetch = async () => {
    attempts += 1;
    return attempts === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ ok: true, results: [] }));
  };
  await new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl: flaky }).recall({ query: 'q' });
  assert.equal(attempts, 2);
});

test('batches are packed to the embedding budget the service reports', () => {
  const limits = { embed_chunk_chars: 1800, embed_chunks_per_text: 2, embed_cost_per_request: 6000, embed_cost_per_run: 1200 };
  const items = ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000), 'd'.repeat(50_000), 'e'.repeat(10)];
  const batches = packByEmbedBudget(items, (text) => text, limits, 50);
  // Each 1,000-character text costs 2,200 (its characters plus one run): two fit in 6,000.
  // The 50,000-character text is sampled to two chunks and costs the whole budget.
  assert.deepEqual(batches.map((batch) => batch.map((text) => text[0])), [['a', 'b'], ['c'], ['d'], ['e']]);
  // Short texts are limited by the price of a run, not by their length: 4 fit, the 5th does not.
  const tiny = Array.from({ length: 20 }, (_, index) => `note ${index}`);
  assert.deepEqual(packByEmbedBudget(tiny, (text) => text, limits, 50).map((batch) => batch.length), [4, 4, 4, 4, 4]);
  // Embeddings off: only the item limit applies.
  assert.deepEqual(packByEmbedBudget(items, (text) => text, { ...limits, embed_cost_per_request: null }, 2).map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(packByEmbedBudget([], (text: string) => text, limits, 50), []);
});

test('listAll follows next_offset to the end of a namespace', async () => {
  const offsets: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { offset: number };
    offsets.push(body.offset);
    const page = body.offset === 0 ? { memories: [{ id: 'a' }, { id: 'b' }], next_offset: 2 } : { memories: [{ id: 'c' }], next_offset: null };
    return new Response(JSON.stringify({ ok: true, namespace: 'p', order: 'importance', budget: {}, ...page }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  const all = await client.listAll({ namespace: 'p', kinds: ['decision'] });
  assert.deepEqual(all.map((memory) => memory.id), ['a', 'b', 'c']);
  assert.deepEqual(offsets, [0, 2]);
});

test('ingestDocumentFully repeats the call until no chunk is pending', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const pending = Math.max(0, 5 - calls * 2);
    return new Response(JSON.stringify({ ok: true, created: calls === 1, reactivated: false, document: { id: 'd' }, chunks_created: calls === 1 ? 5 : 0, chunks_embedded: 2, chunks_pending: pending }));
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  const result = await client.ingestDocumentFully({ title: 'T', content: 'C' });
  assert.equal(calls, 3);
  assert.equal(result.chunks_pending, 0);
  assert.equal(result.created, true);
  assert.equal(result.chunks_created, 5);
});

test('listAll retries an oversized row with enough budget without skipping it', async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.max_chars < 1500) return Response.json({ error: 'list_budget_too_small', required_chars: 1500 }, { status: 413 });
    return Response.json({ memories: [{ id: 'long', content: 'a'.repeat(1500) }], next_offset: null });
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  const rows = await client.listAll({ max_chars: 1000 });
  assert.equal(rows[0].content.length, 1500);
  assert.deepEqual(requests.map((r) => [r.offset, r.max_chars]), [[0, 1000], [0, 1500]]);
});

test('unknown actions are never retried and generic input cannot override the selected action', async () => {
  const actions: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    actions.push(JSON.parse(String(init?.body)).action);
    return new Response('', { status: 503 });
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  await assert.rejects(client.call('custom_write', { action: 'health' }));
  assert.deepEqual(actions, ['custom_write']);
});

test('secret discovery follows name cursors and selected retrieval decrypts only named entries', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    if (body.action === 'secret_list') return Response.json({ secrets: [{ name: body.cursor ? 'github.token' : 'github.api_key' }], next_cursor: body.cursor ? null : 'github.api_key' });
    return Response.json({ secret: { name: body.name, secret: 'test-value' } });
  };
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 't', fetchImpl });
  const list = await client.listAllSecrets({ namespace: 'p', name_prefix: 'github.', limit: 1 });
  assert.deepEqual(list.map((entry) => entry.name), ['github.api_key', 'github.token']);
  const selected = await client.getSecrets({ namespace: 'p', names: ['github.token', 'github.token'] });
  assert.deepEqual(selected.secrets.map((entry) => entry.name), ['github.token']);
  assert.deepEqual(bodies.filter((body) => body.action === 'secret_get').map((body) => body.name), ['github.token']);
  await assert.rejects(client.getSecrets({ names: [] }));
  await client.listSecrets('p', true); // prior signature remains supported
  assert.equal(bodies.at(-1)?.include_retired, true);
});

test('clients protect credentials with HTTPS and disallow URL credentials and fragments', () => {
  for (const apiUrl of ['http://memory.example.test', 'ftp://memory.example.test', 'https://user:password@memory.example.test', 'https://memory.example.test/#fragment']) {
    assert.throws(() => new MemoryClient({ apiUrl, token: 't' }));
  }
  for (const apiUrl of ['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321', 'https://memory.example.test']) {
    assert.doesNotThrow(() => new MemoryClient({ apiUrl, token: 't' }));
  }
  assert.doesNotThrow(() => new MemoryClient({ apiUrl: 'http://private-service', token: 't', allowInsecureHttp: true }));
});


test('credential identity gives storage and retrieval the same validated canonical name', async () => {
  const identity = { service: 'github', environment: 'production', credential_type: 'api_token' };
  assert.equal(formatSecretName(identity), 'github.production.api_token');
  for (const service of ['GitHub', '', 'github.com', 'a'.repeat(41)]) {
    assert.throws(() => formatSecretName({ ...identity, service }));
  }
  const requests: Record<string, unknown>[] = [];
  const client = new MemoryClient({ apiUrl: 'https://memory.example.test', token: 'test', fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, secrets: [], next_cursor: null });
  } });
  await client.storeCredential({ ...identity, namespace: 'platform', secret: 'test-value', metadata: { service: 'wrong', owner: 'operations' } });
  await client.getCredential({ ...identity, namespace: 'platform' });
  await client.listAllSecrets({ namespace: 'platform', query: 'github production api token' });
  assert.equal(requests[0].name, 'github.production.api_token');
  assert.deepEqual(requests[0].metadata, { ...identity, owner: 'operations' });
  assert.equal(requests[1].name, requests[0].name);
  assert.equal(requests[2].query, 'github production api token');
});
