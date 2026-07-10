import {
  averageNormalizedEmbeddings,
  bearerToken,
  chunkEmbeddingText,
  containsLikelySecret,
  hasPermission,
  namespaceAllowed,
  sha256Hex,
  timingSafeEqualHex,
} from './lib.ts';
import { boundContext, isPortableResource, splitDocumentText } from './protocol.ts';

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

Deno.test('portable resources are an explicit allowlist', () => {
  assert(isPortableResource('memories'));
  assert(isPortableResource('source_links'));
  assert(!isPortableResource('secrets'));
  assert(!isPortableResource('memory_audit_log'));
});

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed');
}

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}

function assertApprox(actual: number, expected: number) {
  if (Math.abs(actual - expected) > 1e-10) {
    throw new Error(`expected approximately ${expected}, received ${actual}`);
  }
}
