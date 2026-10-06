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

test('local Vault keeps secrets encrypted, scoped, discoverable and coherent during rotation', {
  skip: !apiUrl || !token || !container,
  timeout: 120_000,
}, async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl!).hostname));
  const namespace = `vault-review-${randomUUID()}`;
  const secondNamespace = `${namespace}:part`;
  const client = new MemoryClient({ apiUrl, token });
  const sql = (query: string) => execFileSync('docker', ['exec', '-i', container!, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim();
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const caller = `test-caller-${randomUUID()}`;
  const { createHash } = await import('node:crypto');
  const callerHash = createHash('sha256').update(caller).digest('hex');
  const scoped = new MemoryClient({ apiUrl, token: caller });
  try {
    sql(`insert into memory_clients(name,token_hash,token_prefix,allowed_namespaces,permissions) values (${quote(namespace)},'${callerHash}','test-only',array['${namespace}'],array['secrets:list']);`);
    const original = `  credential-${randomUUID()}\n`;
    const first = await client.storeSecret({ namespace, name: 'github_api', secret: original, metadata: { service: 'github', environment: 'test' } });
    assert(!JSON.stringify(first).includes(original.trim()), 'store must not return plaintext');
    assert.equal((await client.getSecret({ namespace, name: 'github_api' })).secret.secret, original);
    assert.equal(sql(`select v.secret = ${quote(original)} from vault.secrets v join memory_secrets s on s.vault_secret_id=v.id where s.id='${first.secret.id}'`), 'f');
    assert.equal(sql(`select count(*) from memory_audit_log where namespace='${namespace}' and details::text like ${quote('%'+original.trim()+'%')}`), '0');
    await client.storeSecret({ namespace, name: 'githubXapi', secret: 'separate-test-value' });
    await client.storeSecret({ namespace, name: 'stripe.token', secret: 'stripe-test-value' });
    const prefix = await scoped.listAllSecrets({ namespace, name_prefix: 'github_', limit: 1 });
    assert.deepEqual(prefix.map((entry) => entry.name), ['github_api'], 'underscore prefix must be literal');
    const listed = await scoped.listAllSecrets({ namespace, limit: 1 });
    assert.equal(listed.length, 3);
    assert(!JSON.stringify(listed).includes(original.trim()));
    await assert.rejects(scoped.getSecret({ namespace, name: 'github_api' }), /forbidden/);
    await assert.rejects(scoped.listSecrets(secondNamespace), /forbidden/);
    await assert.rejects(scoped.listSecrets({ namespace, include_retired: true }), /forbidden/);
    sql(`update memory_clients set permissions=array['secrets:list','secrets:read'] where token_hash='${callerHash}'`);
    const selected = await scoped.getSecrets({ namespace, names: ['github_api', 'stripe.token'] });
    assert.equal(selected.secrets.length, 2);
    assert.equal(selected.secrets[0].secret, original);

    const identity = { service: 'payments', environment: 'production', credential_type: 'refresh_token' };
    await client.storeCredential({ ...identity, namespace, secret: 'private-value-search-marker', description: 'Payment gateway integration' });
    assert.equal((await scoped.getCredential({ ...identity, namespace })).secret.secret, 'private-value-search-marker');
    const found = await scoped.listAllSecrets({ namespace, query: 'payments production refresh token', limit: 1 });
    assert.deepEqual(found.map((entry) => entry.name), ['payments.production.refresh_token']);
    assert.deepEqual((await scoped.listAllSecrets({ namespace, query: 'gateway' })).map((entry) => entry.name), ['payments.production.refresh_token']);
    assert.deepEqual(await scoped.listAllSecrets({ namespace, query: 'private-value-search-marker' }), [], 'secret values must not be indexed');
    assert.deepEqual((await scoped.listAllSecrets({ namespace, query: 'github test' })).map((entry) => entry.name), ['github_api'], 'legacy names and metadata remain indexed');
    await assert.rejects(client.storeSecret({ namespace, name: 'wrong.name', secret: 'test-only', metadata: identity }), /secret_name_identity_mismatch/);
    await assert.rejects(client.storeSecret({ namespace, name: 'wrong.name', secret: 'test-only', metadata: { ...identity, service: 'Payments' } }), /invalid_secret_identity/);
    assert.equal(sql("select count(*) from pg_indexes where tablename='memory_secrets' and indexname in ('memory_secrets_discovery_fts','memory_secrets_name_prefix')"), '2');

    // These two valid namespace/name pairs collided under colon concatenation.
    await client.storeSecret({ namespace: secondNamespace, name: 'api_key', secret: 'value-one' });
    await client.storeSecret({ namespace, name: 'part:api_key', secret: 'value-two' });
    assert.equal((await client.getSecret({ namespace: secondNamespace, name: 'api_key' })).secret.secret, 'value-one');
    assert.equal((await client.getSecret({ namespace, name: 'part:api_key' })).secret.secret, 'value-two');

    // Parallel first stores serialize into one registry row and two versions.
    await Promise.all([1, 2].map(() => client.storeSecret({ namespace, name: 'concurrent', secret: 'version-1' })));
    assert.equal(sql(`select version from memory_secrets where namespace='${namespace}' and name='concurrent'`), '2');
    const reads = await Promise.all([
      client.storeSecret({ namespace, name: 'concurrent', secret: 'version-3' }),
      client.getSecret({ namespace, name: 'concurrent' }),
    ]);
    const read = reads[1].secret;
    assert.equal(read.secret, read.version === 3 ? 'version-3' : 'version-1');
    await client.retireSecret('github_api', namespace);
    await assert.rejects(client.getSecret({ namespace, name: 'github_api' }), /secret_not_found/);
    const retired = await client.listAllSecrets({ namespace, include_retired: true });
    assert(retired.some((entry) => entry.name === 'github_api' && entry.is_active === false));
    await client.storeSecret({ namespace, name: 'github_api', secret: 'reactivated-value' });
    assert.equal((await client.getSecret({ namespace, name: 'github_api' })).secret.version, 2);
    sql(`update memory_clients set expires_at=now()-interval '1 second' where token_hash='${callerHash}'`);
    await assert.rejects(scoped.listSecrets(namespace), /unauthorized/);
    sql(`update memory_clients set expires_at=null, revoked_at=now() where token_hash='${callerHash}'`);
    await assert.rejects(scoped.getSecret({ namespace, name: 'github_api' }), /unauthorized/);
    const recall = await client.recall({ namespace, query: 'credential github stripe', track: false });
    assert.equal(recall.results.length, 0, 'Vault contents must not enter semantic recall');
    await assert.rejects(client.portableExport({ namespace, resource: 'secrets' }));
    assert.equal(sql("select has_table_privilege('anon','vault.secrets','select') or has_table_privilege('authenticated','vault.decrypted_secrets','select')"), 'f');
    assert.equal(sql("select has_function_privilege('anon','get_encrypted_secret(text,text,uuid,uuid)','execute')"), 'f');
  } finally {
    sql(`delete from vault.secrets where id in (select vault_secret_id from memory_secrets where namespace in ('${namespace}','${secondNamespace}'));
      delete from memory_secrets where namespace in ('${namespace}','${secondNamespace}');
      delete from memory_clients where token_hash='${callerHash}';`);
  }
});
