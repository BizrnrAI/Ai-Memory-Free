import { readFileSync } from 'node:fs';

type Fixture = {
  query: string;
  expected_ids: string[];
  namespace?: string;
  notes?: string;
};

const file = process.env.MEMORY_EVAL_FIXTURES ?? 'eval/fixtures.example.json';
const raw = readFileSync(file, 'utf8');
const fixtures = JSON.parse(raw) as Fixture[];
const isExample = file.endsWith('.example.json');

if (!Array.isArray(fixtures) || fixtures.length === 0) {
  throw new Error(`${file} must contain at least one fixture`);
}

const seenQueries = new Set<string>();
let placeholders = 0;

for (const [index, fixture] of fixtures.entries()) {
  if (!fixture.query || typeof fixture.query !== 'string' || fixture.query.trim().length > 20_000) {
    throw new Error(`fixture ${index} is missing query`);
  }
  if (fixture.namespace && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(fixture.namespace)) {
    throw new Error(`fixture ${index} has an invalid namespace`);
  }
  const queryKey = `${fixture.namespace ?? 'default'}\u0000${fixture.query.trim()}`;
  if (seenQueries.has(queryKey)) throw new Error(`fixture ${index} duplicates an earlier query`);
  seenQueries.add(queryKey);

  if (!Array.isArray(fixture.expected_ids) || fixture.expected_ids.length === 0 || fixture.expected_ids.length > 50) {
    throw new Error(`fixture ${index} is missing expected_ids`);
  }
  const seenIds = new Set<string>();
  for (const id of fixture.expected_ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`fixture ${index} has an invalid expected id`);
    }
    if (id.startsWith('replace-with-')) {
      if (!isExample) throw new Error(`fixture ${index} contains a placeholder id`);
      placeholders += 1;
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`fixture ${index} expected id is not a UUID`);
    }
    if (seenIds.has(id)) throw new Error(`fixture ${index} repeats expected id ${id}`);
    seenIds.add(id);
  }
}

console.log(`validated ${fixtures.length} eval fixture(s) from ${file}`);
if (placeholders > 0) {
  console.log(`example contains ${placeholders} placeholder id(s); copy it to an ignored local file before live eval`);
}
