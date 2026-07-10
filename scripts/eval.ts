import { readFileSync } from 'node:fs';
import { MemoryClient } from '@ai-memory-free/client';

type Fixture = {
  query: string;
  expected_ids: string[];
  namespace?: string;
  expected_absent_ids?: string[];
  expected_top_id?: string;
  minimum_final_score?: number;
};

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const limit = Number(process.env.MEMORY_EVAL_LIMIT ?? '8');
const threshold = Number(process.env.MEMORY_EVAL_THRESHOLD ?? '0.9');
const fixtures = JSON.parse(readFileSync(file, 'utf8')) as Fixture[];
const client = new MemoryClient();

if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
  throw new Error('MEMORY_EVAL_LIMIT must be an integer from 1 to 50');
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  throw new Error('MEMORY_EVAL_THRESHOLD must be between 0 and 1');
}
if (!Array.isArray(fixtures) || fixtures.length === 0) {
  throw new Error(`${file} must contain at least one fixture`);
}

let passed = 0;
let reciprocalRankTotal = 0;
let precisionTotal = 0;

for (const fixture of fixtures) {
  const response = await client.recall({
    namespace: fixture.namespace,
    query: fixture.query,
    limit,
    track: false,
  });
  const rankedIds = response.results.map((row) => row.id);
  const ids = new Set(rankedIds);
  const absentOk = (fixture.expected_absent_ids ?? []).every((id) => !ids.has(id));
  const topOk = !fixture.expected_top_id || rankedIds[0] === fixture.expected_top_id;
  const scoreOk = fixture.minimum_final_score === undefined ||
    Number(response.results[0]?.final_score ?? 0) >= fixture.minimum_final_score;
  const ok = fixture.expected_ids.every((id) => ids.has(id)) && absentOk && topOk && scoreOk;
  if (ok) passed += 1;
  const ranks = fixture.expected_ids
    .map((id) => rankedIds.indexOf(id) + 1)
    .filter((rank) => rank > 0);
  if (ranks.length > 0) reciprocalRankTotal += 1 / Math.min(...ranks);
  precisionTotal += ranks.length / limit;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fixture.query}`);
  if (!ok) {
    console.log(`  expected: ${fixture.expected_ids.join(', ')}`);
    console.log(`  received: ${response.results.map((row) => row.id).join(', ')}`);
    if (!absentOk) console.log(`  forbidden ids returned: ${fixture.expected_absent_ids?.filter((id) => ids.has(id)).join(', ')}`);
    if (!topOk) console.log(`  expected top id: ${fixture.expected_top_id ?? ''}`);
    if (!scoreOk) console.log(`  top score below: ${fixture.minimum_final_score}`);
  }
}

const recallAtK = passed / fixtures.length;
const meanReciprocalRank = reciprocalRankTotal / fixtures.length;
const precisionAtK = precisionTotal / fixtures.length;
console.log(`recall@${limit} = ${(recallAtK * 100).toFixed(1)}% (${passed}/${fixtures.length})`);
console.log(`mrr@${limit} = ${meanReciprocalRank.toFixed(3)}`);
console.log(`precision@${limit} = ${precisionAtK.toFixed(3)}`);

if (recallAtK < threshold) {
  process.exitCode = 1;
}
