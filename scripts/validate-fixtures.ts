import { readFileSync } from 'node:fs';

type Fixture = {
  query: string;
  expected_ids: string[];
  notes?: string;
};

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const raw = readFileSync(file, 'utf8');
const fixtures = JSON.parse(raw) as Fixture[];

if (!Array.isArray(fixtures) || fixtures.length === 0) {
  throw new Error(`${file} must contain at least one fixture`);
}

for (const [index, fixture] of fixtures.entries()) {
  if (!fixture.query || typeof fixture.query !== 'string') {
    throw new Error(`fixture ${index} is missing query`);
  }
  if (!Array.isArray(fixture.expected_ids) || fixture.expected_ids.length === 0) {
    throw new Error(`fixture ${index} is missing expected_ids`);
  }
  for (const id of fixture.expected_ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`fixture ${index} has an invalid expected id`);
    }
  }
}

console.log(`validated ${fixtures.length} eval fixture(s) from ${file}`);
