import {
  averageNormalizedEmbeddings,
  bearerToken,
  chunkEmbeddingText,
  chunksPerText,
  containsLikelySecret,
  contentByteLimit,
  DEFAULT_EMBED_CHARS_PER_REQUEST,
  EMBED_CHUNK_CHARS,
  embedCharBudget,
  embeddingCost,
  hasPermission,
  isMemoryKind,
  MEMORY_KINDS,
  namespaceAllowed,
  resolveSupabaseServerKey,
  sha256Hex,
  timingSafeEqualHex,
  utf8ByteLength,
} from './lib.ts';
import { boundContext, contextCharacterBudget, isPortableResource, splitDocumentText } from './protocol.ts';

Deno.test('scoped permissions and namespaces fail closed', () => {
  assert(hasPermission(['memory:admin'], 'memory:read'));
  assert(!hasPermission(['memory:read'], 'memory:write'));
  assert(namespaceAllowed(['team-a'], 'team-a'));
  assert(!namespaceAllowed(['team-a'], 'team-b'));
  assert(namespaceAllowed(['*'], 'team-b'));
});

Deno.test('bearer tokens are parsed without accepting empty credentials', () => {
  assertEquals(bearerToken('Bearer abc'), 'abc');
  assertEquals(bearerToken('Bearer   '), null);
  assertEquals(bearerToken('Basic abc'), null);
});

Deno.test('access tokens hash deterministically', async () => {
  assertEquals(
    await sha256Hex('ai-memory-free'),
    '7d61906d92a37663a63224fb2d2283fd407dfc3233dc73d26a32c90b1bd45451',
  );
});

Deno.test('hashed access tokens use constant-time comparison', async () => {
  const first = await sha256Hex('client-token');
  const second = await sha256Hex('client-token');
  const wrong = await sha256Hex('wrong-token');
  assert(timingSafeEqualHex(first, second));
  assert(!timingSafeEqualHex(first, wrong));
});

Deno.test('long embeddings sample the entire document within the inference budget', () => {
  const text = Array.from({ length: 100 }, (_, index) => `paragraph-${index} ${'x'.repeat(100)}`).join(' ');
  const chunks = chunkEmbeddingText(text, 500, 4);
  assertEquals(chunks.length, 4);
  assert(chunks[0].includes('paragraph-0'));
  assert(chunks.at(-1)?.includes('paragraph-99'));
  assert(chunks.every((chunk) => chunk.length <= 500));
});

Deno.test('averaged embeddings are normalized', () => {
  const result = averageNormalizedEmbeddings([[1, 0], [0, 1]]);
  assertApprox(result[0], Math.SQRT1_2);
  assertApprox(result[1], Math.SQRT1_2);
});

Deno.test('high-confidence credential patterns are kept out of ordinary memory', () => {
  const fakeCredential = 'abcdefghijklmnopqrstuvwxyz' + '123456';
  assert(containsLikelySecret(`Authorization: Bearer ${fakeCredential}`));
  assert(!containsLikelySecret('The docs use Bearer YOUR_TOKEN as a placeholder.'));
});

// All fixtures below are synthetic. Each is built by concatenation so that no
// literal in this file can be mistaken for — or grep as — a real credential.
Deno.test('credential detection covers provider families this deployment handles', () => {
  const A = 'A'.repeat(64);
  const a = 'a'.repeat(64);
  const hex = '0'.repeat(48);
  const cases: Record<string, string> = {
    anthropic: 'sk-ant-' + 'api03-' + A,
    openaiProject: 'sk-proj-' + A,
    openaiClassic: 'sk-' + A,
    supabasePat: 'sbp_' + hex,
    memoryToken: 'amf_' + A,
    githubFineGrained: 'github_pat_' + A,
    gitlab: 'glpat-' + 'A'.repeat(24),
    npm: 'npm_' + 'A'.repeat(36),
    googleApiKey: 'AIza' + 'A'.repeat(35),
    awsTemp: 'ASIA' + 'A'.repeat(16),
    nsec: 'nsec1' + 'a'.repeat(58),
    ncryptsec: 'ncryptsec1' + 'a'.repeat(100),
    ageIdentity: 'AGE-SECRET-KEY-1' + 'A'.repeat(58),
    pemKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    pemPlainKey: '-----BEGIN PRIVATE KEY-----',
    postgresUri: 'postgresql://buzz:' + a.slice(0, 24) + '@db.example.supabase.co:5432/postgres',
    redisUri: 'rediss://default:' + a.slice(0, 24) + '@cache.example.com:6379',
    slackWebhook: 'https://hooks.slack.com/services/T00000000/B00000000/' + A.slice(0, 24),
  };
  for (const [name, sample] of Object.entries(cases)) {
    assert(containsLikelySecret(sample), `expected ${name} to be detected`);
    assert(
      containsLikelySecret(`the value is ${sample} — do not commit`),
      `expected ${name} to be detected in surrounding prose`,
    );
  }
});

Deno.test('credential detection does not fire on ordinary technical content', () => {
  const benign = [
    'Relay upgraded from sha-ac4fa13 to sha-027a74a with no migrations.',
    'Commit 1f0eada7c3b19d4e5f6a8b9c0d1e2f3a4b5c6d7e touched two files.',
    'Community id 3f7c1a92-5b2e-4d18-9a6f-0c8e2b4d7a15 was provisioned.',
    'sha256 digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'Set the header to Bearer YOUR_TOKEN before calling the endpoint.',
    'The docs reference sk-... and AKIA... as redacted placeholders.',
    'postgresql://localhost:5432/buzz needs no password in trust mode.',
    'Base64 payload SGVsbG8gd29ybGQsIHRoaXMgaXMgbm90IGEgc2VjcmV0IGF0IGFsbA==',
    'Namespaces are main, bizrnr, legal, iowa, ahs, shared.',
  ];
  for (const sample of benign) {
    assert(!containsLikelySecret(sample), `false positive on: ${sample}`);
  }
});

Deno.test('document chunking is deterministic, bounded, and overlapping', () => {
  const text = Array.from({ length: 80 }, (_, index) => `sentence ${index}.`).join(' ');
  const first = splitDocumentText(text, 240, 24);
  const second = splitDocumentText(text, 240, 24);
  assertEquals(JSON.stringify(first), JSON.stringify(second));
  assert(first.length > 1);
  assert(first.every((chunk) => chunk.length <= 240));
});

Deno.test('context budgets preserve the best first result and report truncation', () => {
  const result = boundContext([{ content: 'a'.repeat(20) }, { content: 'b'.repeat(20) }], 25);
  assertEquals(result.rows.length, 1);
  assertEquals(result.usedChars, 20);
  assert(result.truncated);
  const oversized = boundContext([{ content: 'x'.repeat(100) }], 12);
  assertEquals(oversized.rows[0].content, 'x'.repeat(12));
  assertEquals(oversized.usedChars, 12);
});

Deno.test('context budgets accept the documented field and the legacy long-form alias', () => {
  assertEquals(contextCharacterBudget({ max_chars: 2_500 }), 2_500);
  assertEquals(contextCharacterBudget({ max_characters: 2_500 }), 2_500);
  assertEquals(contextCharacterBudget({ max_chars: 3_000, max_characters: 2_500 }), 3_000);
  assertThrows(() => contextCharacterBudget({ max_characters: 500 }), 'invalid_context_budget');
});

Deno.test('portable resources are an explicit allowlist', () => {
  assert(isPortableResource('memories'));
  assert(isPortableResource('source_links'));
  assert(!isPortableResource('secrets'));
  assert(!isPortableResource('memory_audit_log'));
});

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message ? `assertion failed: ${message}` : 'assertion failed');
}

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}

function assertApprox(actual: number, expected: number) {
  if (Math.abs(actual - expected) > 1e-10) {
    throw new Error(`expected approximately ${expected}, received ${actual}`);
  }
}

function assertThrows(operation: () => unknown, expected: string) {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message === expected) return;
    throw error;
  }
  throw new Error(`expected ${expected} to be thrown`);
}

Deno.test('the embedding budget defaults to what hosted Supabase can always afford', () => {
  assertEquals(embedCharBudget(undefined), DEFAULT_EMBED_CHARS_PER_REQUEST);
  assertEquals(embedCharBudget(''), DEFAULT_EMBED_CHARS_PER_REQUEST);
  assertEquals(embedCharBudget('not a number'), DEFAULT_EMBED_CHARS_PER_REQUEST);
  assertEquals(embedCharBudget('100'), EMBED_CHUNK_CHARS);
  assertEquals(embedCharBudget('14400'), 14_400);
  assertEquals(chunksPerText(DEFAULT_EMBED_CHARS_PER_REQUEST), 2);
  assertEquals(chunksPerText(EMBED_CHUNK_CHARS), 1);
  assertEquals(chunksPerText(1_000_000), 8);
});

Deno.test('a text never costs more than the chunks it is sampled down to', () => {
  const short = 'a short memory';
  assertEquals(embeddingCost(short, 2), short.length);
  const long = 'word '.repeat(20_000);
  assert(embeddingCost(long, 2) <= 2 * EMBED_CHUNK_CHARS);
  assert(embeddingCost(long, 1) <= EMBED_CHUNK_CHARS);
  assertEquals(chunkEmbeddingText(long, EMBED_CHUNK_CHARS, 1).length, 1);
  assertEquals(chunkEmbeddingText(long, EMBED_CHUNK_CHARS, 2).length, 2);
});

Deno.test('the optional content cap is measured in UTF-8 bytes', () => {
  assertEquals(contentByteLimit(undefined), null);
  assertEquals(contentByteLimit(''), null);
  assertEquals(contentByteLimit('5000'), 5_000);
  assertEquals(contentByteLimit('1'), 256);
  assertEquals(utf8ByteLength('abc'), 3);
  assertEquals(utf8ByteLength('é'), 2);
});

Deno.test('memory kinds are an explicit list', () => {
  assertEquals(MEMORY_KINDS.length, 6);
  assert(isMemoryKind('decision'));
  assert(!isMemoryKind('banana'));
  assert(!isMemoryKind(undefined));
});

Deno.test('the server key prefers the new Supabase secret keys and falls back to the legacy one', () => {
  const secretKeys = JSON.stringify({ default: 'sb_secret_default', memory: 'sb_secret_named' });
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys, serviceRoleKey: 'legacy' })), JSON.stringify({ key: 'sb_secret_default', source: 'secret_keys' }));
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys, keyName: 'memory', serviceRoleKey: 'legacy' })), JSON.stringify({ key: 'sb_secret_named', source: 'secret_keys' }));
  // A name that is not in the dictionary, an empty dictionary, or text that is not JSON: use the legacy key.
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys, keyName: 'absent', serviceRoleKey: 'legacy' })), JSON.stringify({ key: 'legacy', source: 'service_role' }));
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys: '{}', serviceRoleKey: 'legacy' })), JSON.stringify({ key: 'legacy', source: 'service_role' }));
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys: 'not json', serviceRoleKey: 'legacy' })), JSON.stringify({ key: 'legacy', source: 'service_role' }));
  assertEquals(JSON.stringify(resolveSupabaseServerKey({ secretKeys: '["a"]', serviceRoleKey: ' ' })), JSON.stringify(null));
  assertEquals(JSON.stringify(resolveSupabaseServerKey({})), JSON.stringify(null));
});

Deno.test('a Supabase secret API key is caught, a publishable one is not', () => {
  assert(containsLikelySecret('key: sb_secret_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'));
  assert(!containsLikelySecret('key: sb_publishable_' + 'A1b2C3d4E5f6G7h8I9j0K1l2'));
});
