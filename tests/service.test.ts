import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MemoryClient, MemoryRequestError } from '../packages/client/src/index.js';
import { RELEASE_VERSION } from '../supabase/functions/memory/protocol.js';

// Opt-in integration regression test, restricted to a local disposable stack.
// Set MEMORY_TEST_API_URL, MEMORY_TEST_TOKEN and MEMORY_TEST_DB_CONTAINER; the
// OAuth test also needs MEMORY_TEST_PUBLISHABLE_KEY, the local stack's own.
const apiUrl = process.env.MEMORY_TEST_API_URL;
const token = process.env.MEMORY_TEST_TOKEN;
const container = process.env.MEMORY_TEST_DB_CONTAINER;
const publishableKey = process.env.MEMORY_TEST_PUBLISHABLE_KEY;

const sql = (query: string) => execFileSync('docker', [
  'exec', '-i', container!, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query,
], { encoding: 'utf8' }).trim();

// Asserts a request failed with this stable code and HTTP status.
const failsWith = (code: string, status: number) => (error: unknown) => {
  assert(error instanceof MemoryRequestError);
  assert.equal(error.message, code);
  assert.equal(error.status, status);
  return true;
};

test('local service preserves whole lists, replacement searchability, and recall vectors', {
  skip: !apiUrl || !token || !container,
  timeout: 120_000,
}, async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl!).hostname), 'integration tests require a local URL');
  const namespace = `review-${randomUUID()}`;
  const vectorNamespace = `${namespace}-vectors`;
  const client = new MemoryClient({ apiUrl, token });
  try {
    const health = await client.health();
    assert.equal(health.version, RELEASE_VERSION);
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
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const caller = `test-caller-${randomUUID()}`;
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

test('a credential lookup that fails is a retryable 503; only a lookup that answers is a 401', {
  skip: !apiUrl || !token || !container,
  timeout: 120_000,
}, async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl!).hostname));
  const name = `auth-review-${randomUUID()}`;
  const caller = `test-caller-${randomUUID()}`;
  const callerHash = createHash('sha256').update(caller).digest('hex');
  let attempts = 0;
  const counting: typeof fetch = async (input, init) => { attempts += 1; return await fetch(input, init); };
  const admin = new MemoryClient({ apiUrl, token });
  const scoped = new MemoryClient({ apiUrl, token: caller, fetchImpl: counting });
  const unknown = new MemoryClient({ apiUrl, token: `unknown-${randomUUID()}`, fetchImpl: counting });
  const lastUsed = () => sql(`select last_used_at is not null from memory_clients where token_hash='${callerHash}'`);
  try {
    sql(`insert into memory_clients(name,token_hash,token_prefix,allowed_namespaces,permissions) values ('${name}','${callerHash}','test-only',array['${name}'],array['memory:read'])`);
    assert.equal((await scoped.whoAmI()).client.auth_mode, 'scoped');
    assert.equal(lastUsed(), 't');

    // Recording last use fails: the token is still valid, and the write is simply missing.
    sql(`update memory_clients set last_used_at=null where token_hash='${callerHash}';
      create function public.review_fail_last_use() returns trigger language plpgsql as $$
      begin raise exception 'test last-use failure'; end $$;
      create trigger review_fail_last_use before update on public.memory_clients for each row
      when (old.token_hash = '${callerHash}') execute function public.review_fail_last_use();`);
    assert.equal((await scoped.whoAmI()).client.name, name);
    assert.equal(lastUsed(), 'f');
    sql('drop trigger review_fail_last_use on public.memory_clients; drop function public.review_fail_last_use();');

    // The lookup itself fails. That says nothing about a token, valid or not:
    // both get a 503 the client retries, and the bootstrap token is unaffected.
    sql('revoke select on public.memory_clients from service_role');
    attempts = 0;
    await assert.rejects(scoped.whoAmI(), failsWith('auth_unavailable', 503));
    assert.equal(attempts, 3);
    await assert.rejects(unknown.whoAmI(), failsWith('auth_unavailable', 503));
    assert.equal((await admin.health()).auth_mode, 'bootstrap');
    sql('grant select on public.memory_clients to service_role');
    assert.equal((await scoped.whoAmI()).client.auth_mode, 'scoped');

    // A lookup that answers is a verdict, and a verdict is not retried.
    attempts = 0;
    await assert.rejects(unknown.whoAmI(), failsWith('unauthorized', 401));
    assert.equal(attempts, 1);
    for (const state of ["expires_at=now()-interval '1 second'", 'expires_at=null, revoked_at=now()']) {
      sql(`update memory_clients set ${state} where token_hash='${callerHash}'`);
      attempts = 0;
      await assert.rejects(scoped.whoAmI(), failsWith('unauthorized', 401));
      assert.equal(attempts, 1);
    }
  } finally {
    sql(`drop trigger if exists review_fail_last_use on public.memory_clients;
      drop function if exists public.review_fail_last_use();
      grant select on public.memory_clients to service_role;
      delete from memory_clients where token_hash='${callerHash}';`);
  }
});

test('an OAuth grant follows the same rule: a failed grants query is 503, a missing or revoked grant is 401', {
  skip: !apiUrl || !token || !container || !publishableKey,
  timeout: 120_000,
}, async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiUrl!).hostname));
  const name = `oauth-review-${randomUUID()}`;
  // A throwaway user in the local stack's own Auth server, removed below.
  const signup = await fetch(new URL('/auth/v1/signup', apiUrl), {
    method: 'POST', headers: { apikey: publishableKey!, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: randomUUID() }),
  });
  const session = await signup.json() as { access_token?: string; user?: { id?: string } };
  const userId = session.user?.id;
  assert(session.access_token && userId && /^[0-9a-f-]{36}$/.test(userId), `local sign-up returned ${signup.status} without a session`);
  let attempts = 0;
  const counting: typeof fetch = async (input, init) => { attempts += 1; return await fetch(input, init); };
  const oauth = new MemoryClient({ apiUrl, token: session.access_token, fetchImpl: counting });
  const lastUsed = () => sql(`select last_used_at is not null from memory_oauth_grants where user_id='${userId}'`);
  try {
    // Signed in, but nothing granted: the grants query answered, so this is a verdict.
    await assert.rejects(oauth.health(), failsWith('unauthorized', 401));
    assert.equal(attempts, 1);
    sql(`insert into memory_oauth_grants(user_id,name,allowed_namespaces,permissions) values ('${userId}','${name}',array['${name}'],array['memory:read'])`);
    assert.equal((await oauth.health()).auth_mode, 'oauth');
    assert.equal(lastUsed(), 't');

    sql(`update memory_oauth_grants set last_used_at=null where user_id='${userId}';
      create function public.review_fail_grant_use() returns trigger language plpgsql as $$
      begin raise exception 'test last-use failure'; end $$;
      create trigger review_fail_grant_use before update on public.memory_oauth_grants for each row
      when (old.user_id = '${userId}') execute function public.review_fail_grant_use();`);
    assert.equal((await oauth.whoAmI()).client.name, name);
    assert.equal(lastUsed(), 'f');
    sql('drop trigger review_fail_grant_use on public.memory_oauth_grants; drop function public.review_fail_grant_use();');

    sql('revoke select on public.memory_oauth_grants from service_role');
    attempts = 0;
    await assert.rejects(oauth.health(), failsWith('auth_unavailable', 503));
    assert.equal(attempts, 3);
    sql('grant select on public.memory_oauth_grants to service_role');
    assert.equal((await oauth.health()).auth_mode, 'oauth');

    sql(`update memory_oauth_grants set revoked_at=now() where user_id='${userId}'`);
    attempts = 0;
    await assert.rejects(oauth.health(), failsWith('unauthorized', 401));
    assert.equal(attempts, 1);
  } finally {
    sql(`drop trigger if exists review_fail_grant_use on public.memory_oauth_grants;
      drop function if exists public.review_fail_grant_use();
      grant select on public.memory_oauth_grants to service_role;
      delete from auth.users where id='${userId}';`);
  }
});
