import { readFixtures } from './eval-fixtures.js';

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const fixtures = readFixtures(file, file.endsWith('.example.json'));
const placeholders = fixtures.flatMap((fixture) => fixture.expected_ids).filter((id) => id.startsWith('replace-with-')).length;

console.log(`validated ${fixtures.length} eval fixture(s) from ${file}`);
if (placeholders > 0) {
  console.log(`example contains ${placeholders} placeholder id(s); copy it to an ignored local file before live eval`);
}
