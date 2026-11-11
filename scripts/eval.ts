import { MemoryClient } from '@ai-memory-free/client';
import { readFixtures } from './eval-fixtures.js';

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const limit = Number(process.env.MEMORY_EVAL_LIMIT ?? '8');
const threshold = Number(process.env.MEMORY_EVAL_THRESHOLD ?? '0.9');
const mode = process.env.MEMORY_EVAL_SEARCH_MODE;

if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
  throw new Error('MEMORY_EVAL_LIMIT must be an integer from 1 to 50');
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  throw new Error('MEMORY_EVAL_THRESHOLD must be between 0 and 1');
}
if (mode !== undefined && mode !== 'auto' && mode !== 'keyword') {
  throw new Error('MEMORY_EVAL_SEARCH_MODE must be auto or keyword');
}
const fixtures = readFixtures(file);
if (fixtures.some((fixture) => fixture.expected_ids.length > limit)) {
  throw new Error('MEMORY_EVAL_LIMIT must fit every fixture’s expected IDs');
}
const client = new MemoryClient();

let passed = 0;
let safetyFailures = 0;
let positiveQueries = 0;
let recallTotal = 0;
let reciprocalRankTotal = 0;
let precisionTotal = 0;
const appliedModes = new Set<string>();

for (const fixture of fixtures) {
  const response = await client.recall({
    namespace: fixture.namespace,
    query: fixture.query,
    limit,
    track: false,
    search_mode: mode,
  });
  if (mode === 'keyword' && response.search_mode !== 'keyword') {
    throw new Error('The memory service did not confirm keyword mode. Upgrade the memory function before comparing modes.');
  }
  appliedModes.add(response.search_mode ?? 'unreported');
  const rankedIds = response.results.map((row) => row.id);
  const forbidden = (fixture.expected_absent_ids ?? []).filter((id) => rankedIds.includes(id));
  const safe = forbidden.length === 0 && (!fixture.expect_empty || rankedIds.length === 0);
  const topOk = !fixture.expected_top_id || rankedIds[0] === fixture.expected_top_id;
  const scoreOk = fixture.minimum_final_score === undefined ||
    (rankedIds.length > 0 && Number(response.results[0].final_score) >= fixture.minimum_final_score);
  const ranks = fixture.expected_ids.map((id) => rankedIds.indexOf(id) + 1).filter((rank) => rank > 0);
  const ok = safe && topOk && scoreOk && ranks.length === fixture.expected_ids.length;
  if (ok) passed += 1;
  if (!safe) safetyFailures += 1;
  if (fixture.expected_ids.length > 0) {
    positiveQueries += 1;
    recallTotal += ranks.length / fixture.expected_ids.length;
    if (ranks.length > 0) reciprocalRankTotal += 1 / Math.min(...ranks);
    precisionTotal += ranks.length / limit;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${fixture.query}`);
  if (!ok) {
    console.log(`  expected: ${fixture.expect_empty ? '(no results)' : fixture.expected_ids.join(', ')}`);
    console.log(`  received: ${rankedIds.join(', ')}`);
    if (forbidden.length > 0) console.log(`  forbidden ids returned: ${forbidden.join(', ')}`);
    if (!topOk) console.log(`  expected top id: ${fixture.expected_top_id}`);
    if (!scoreOk) console.log(`  top score below: ${fixture.minimum_final_score}`);
  }
}

const passRate = passed / fixtures.length;
console.log(`search mode: ${[...appliedModes].join(', ')}`);
console.log(`pass rate = ${(passRate * 100).toFixed(1)}% (${passed}/${fixtures.length})`);
if (positiveQueries > 0) {
  console.log(`recall@${limit} = ${(recallTotal / positiveQueries).toFixed(3)}`);
  console.log(`mrr@${limit} = ${(reciprocalRankTotal / positiveQueries).toFixed(3)}`);
  console.log(`precision@${limit} = ${(precisionTotal / positiveQueries).toFixed(3)}`);
}
if (safetyFailures > 0) console.log(`forbidden-ID or empty-result failures: ${safetyFailures}`);
if (passRate < threshold || safetyFailures > 0) process.exitCode = 1;
