import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryClient, MemoryRequestError } from '../packages/client/src/index.js';

// Opt-in integration regression test, restricted to a local disposable stack.
// Set MEMORY_TEST_API_URL, MEMORY_TEST_TOKEN and MEMORY_TEST_DB_CONTAINER.
const apiUrl = process.env.MEMORY_TEST_API_URL;
const token = process.env.MEMORY_TEST_TOKEN;
const container = process.env.MEMORY_TEST_DB_CONTAINER;

test('local service preserves whole lists, replacement searchability, and recall vectors', {
  skip: !apiUrl || !token || !container,
  timeout: 120_000,
}, async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl!).hostname), 'integration tests require a local URL');
  const namespace = `review-${randomUUID()}`;
  const vectorNamespace = `${namespace}-vectors`;
  const client = new MemoryClient({ apiUrl, token });
  const sql = (query: string) => execFileSync('docker', [
    'exec', '-i', container!, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query,
  ], { encoding: 'utf8' }).trim();
  try {
    const health = await client.health();
    assert.equal(health.version, '1.4.0');
    const content = 'Searchable standing deployment guidance. '.repeat(40).trim();
    await client.remember({ namespace, content, importance: 1 });
    await client.remember({ namespace, content: 'A short second fact.' });
    await assert.rejects(client.list({ namespace, max_chars: 1000 }), (error: unknown) => {
      assert(error instanceof MemoryRequestError);
      assert.equal(error.message, 'list_budget_too_small');
      assert.equal(error.body.required_chars, content.length);
      return true;
    });
    const all = await client.listAll({ namespace, max_chars: 1000 });
    assert.equal(all.length, 2);
    assert.equal(all.find((row) => row.content === content)?.content.length, content.length);
    const context = await client.context({ namespaces: [namespace], query: 'deployment', max_characters: 1000 });
    assert((context.budget as { used_chars: number }).used_chars <= 1000);
    await assert.rejects(client.context({ namespaces: [namespace], query: 'deployment', max_characters: 500 }), /invalid_context_budget/);

    const old = await client.ingestDocumentFully({ namespace, title: 'Runbook', content: 'Prior release runbook.' });
    const oldId = String(old.document.id);
    // Simulate a database chunk-write failure. The old searchable document must survive.
    sql(`create function public.review_fail_chunk() returns trigger language plpgsql as $$
      begin if new.namespace = '${namespace}' and new.content like 'FAIL_CHUNK%' then raise exception 'test chunk failure'; end if; return new; end $$;
      create trigger review_fail_chunk before insert on public.memory_document_chunks for each row execute function public.review_fail_chunk();`);
    const replacement = { namespace, title: 'Runbook', content: 'FAIL_CHUNK corrected runbook.', supersedes: oldId };
    await assert.rejects(client.ingestDocument(replacement), /document_chunk_write_failed/);
    assert.equal(sql(`select is_active from public.memory_documents where id = '${oldId}'`), 't');
    sql('drop trigger review_fail_chunk on public.memory_document_chunks; drop function public.review_fail_chunk();');
    const repaired = await client.ingestDocumentFully(replacement);
    assert.equal(repaired.chunks_created, 1);
    assert.equal(sql(`select is_active from public.memory_documents where id = '${oldId}'`), 'f');

    // Repair a partially populated document rather than skipping it forever.
    const largeContent = 'A durable document about release verification and operations. '.repeat(110);
    const large = await client.ingestDocumentFully({ namespace, title: 'Long runbook', content: largeContent });
    assert.equal(large.chunks_pending, 0);
    const largeId = String(large.document.id);
    const before = Number(sql(`select count(*) from public.memory_document_chunks where document_id = '${largeId}'`));
    sql(`delete from public.memory_document_chunks where document_id = '${largeId}' and chunk_index = 1`);
    const healed = await client.ingestDocumentFully({ namespace, title: 'Long runbook', content: largeContent });
    assert.equal(healed.chunks_created, 1);
    assert.equal(Number(sql(`select count(*) from public.memory_document_chunks where document_id = '${largeId}'`)), before);
    const concurrent = await Promise.all([client.ingestDocument(replacement), client.ingestDocument(replacement)]);
    assert(concurrent.every((result) => result.document.id === repaired.document.id));
    assert.equal(sql(`select count(*) from public.memory_document_chunks where document_id = '${repaired.document.id}'`), '1');

    if (health.embeddings === 'on') {
      const memory = await client.remember({ namespace: vectorNamespace, content: 'Authoritative vector reindex regression.' });
      const id = memory.memory!.id;
      sql(`update public.memories set embedding = null where id = '${id}'`);
      const reindexed = await client.reindexEmbeddings(vectorNamespace, 0, 1);
      assert.equal(reindexed.processed, 1);
      assert.equal(sql(`select embedding is not null from public.memories where id = '${id}'`), 't');
    }
    if (health.limits?.max_content_bytes) {
      await assert.rejects(client.portableImport({ namespace, resource: 'memories', records: [
        { content: 'x'.repeat(health.limits.max_content_bytes + 1) },
      ] }), /content_too_large/);
    }
    await assert.rejects(client.portableImport({ namespace, resource: 'memories', records: [null as unknown as Record<string, unknown>] }), /records_must_be_objects/);
  } finally {
    sql(`drop trigger if exists review_fail_chunk on public.memory_document_chunks;
      drop function if exists public.review_fail_chunk();
      delete from public.memory_documents where namespace = '${namespace}';
      delete from public.memories where namespace in ('${namespace}', '${vectorNamespace}');`);
  }
});
