import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('retrieval eval measures partial recall and fails forbidden results even at a zero threshold', async () => {
  const expected = '00000000-0000-4000-8000-000000000001';
  const missed = '00000000-0000-4000-8000-000000000002';
  const forbidden = '00000000-0000-4000-8000-000000000003';
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    const results = body.query === 'match' ? [{ id: expected }, { id: forbidden }] : [];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, search_mode: 'keyword', results }));
  });

  const dir = await mkdtemp(join(tmpdir(), 'amf-eval-test-'));
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const fixturePath = join(dir, 'fixtures.json');
    await writeFile(fixturePath, JSON.stringify([
      { query: 'match', expected_ids: [expected, missed], expected_absent_ids: [forbidden] },
      { query: 'empty', namespace: 'empty-project', expected_ids: [], expect_empty: true },
    ]));
    const result = await new Promise<{ status: number | string | undefined; stdout: string }>((resolve, reject) => {
      execFile(process.execPath, ['--import', 'tsx', 'scripts/eval.ts'], {
        env: {
          ...process.env,
          MEMORY_API_URL: `http://127.0.0.1:${address.port}/memory`,
          MEMORY_TOKEN: 'test-only',
          MEMORY_EVAL_FIXTURES: fixturePath,
          MEMORY_EVAL_LIMIT: '2',
          MEMORY_EVAL_THRESHOLD: '0',
          MEMORY_EVAL_SEARCH_MODE: 'keyword',
        },
      }, (error, stdout, stderr) => {
        if (stderr) reject(new Error(stderr));
        else resolve({ status: error?.code ?? 0, stdout });
      });
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /pass rate = 50\.0%/);
    assert.match(result.stdout, /recall@2 = 0\.500/);
    assert.match(result.stdout, /forbidden-ID or empty-result failures: 1/);
    assert.equal(bodies.length, 2);
    assert(bodies.every((body) => body.action === 'recall' && body.search_mode === 'keyword' && body.track === false));
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
