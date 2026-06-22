import { readFileSync } from 'node:fs';
import { MemoryClient } from '@ai-memory-free/client';

type Fixture = {
  query: string;
  expected_ids: string[];
  namespace?: string;
};

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const limit = Number(process.env.MEMORY_EVAL_LIMIT ?? '8');
const threshold = Number(process.env.MEMORY_EVAL_THRESHOLD ?? '0.9');
const fixtures = JSON.parse(readFileSync(file, 'utf8')) as Fixture[];
const client = new MemoryClient();

let passed = 0;

for (const fixture of fixtures) {
  const response = await client.recall({
    namespace: fixture.namespace,
    query: fixture.query,
    limit,
    track: false,
  });
  const ids = new Set(response.results.map((row) => row.id));
  const ok = fixture.expected_ids.every((id) => ids.has(id));
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fixture.query}`);
  if (!ok) {
    console.log(`  expected: ${fixture.expected_ids.join(', ')}`);
    console.log(`  received: ${response.results.map((row) => row.id).join(', ')}`);
  }
}

const recallAtK = passed / fixtures.length;
console.log(`recall@${limit} = ${(recallAtK * 100).toFixed(1)}% (${passed}/${fixtures.length})`);

if (recallAtK < threshold) {
  process.exitCode = 1;
}
