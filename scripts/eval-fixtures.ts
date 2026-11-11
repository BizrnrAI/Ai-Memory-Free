import { readFileSync } from 'node:fs';

type Fixture = {
  query: string;
  expected_ids: string[];
  namespace?: string;
  notes?: string;
  expected_absent_ids?: string[];
  expected_top_id?: string;
  minimum_final_score?: number;
  expect_empty?: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readFixtures(file: string, allowPlaceholders = false): Fixture[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${file} must contain at least one fixture`);
  }
  const queries = new Set<string>();
  for (const [index, fixture] of parsed.entries()) {
    const fail = (message: string): never => { throw new Error(`fixture ${index}: ${message}`); };
    if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) fail('expected an object');
    const query = typeof fixture.query === 'string' ? fixture.query.trim() : '';
    if (!query || query.length > 20_000) fail('query must have 1 to 20,000 characters');
    if (fixture.namespace !== undefined &&
        (typeof fixture.namespace !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(fixture.namespace))) {
      fail('invalid namespace');
    }
    const key = `${fixture.namespace ?? 'default'}\u0000${query}`;
    if (queries.has(key)) fail('duplicate query in namespace');
    queries.add(key);

    const validId = (id: unknown): id is string => typeof id === 'string' &&
      (uuid.test(id) || (allowPlaceholders && id.startsWith('replace-with-')));
    const validateIds = (ids: unknown, field: string) => {
      if (!Array.isArray(ids) || ids.length > 50 || !ids.every(validId) || new Set(ids).size !== ids.length) {
        fail(`${field} must contain up to 50 distinct UUIDs`);
      }
    };
    validateIds(fixture.expected_ids, 'expected_ids');
    if (fixture.expected_absent_ids !== undefined) validateIds(fixture.expected_absent_ids, 'expected_absent_ids');
    if (fixture.expected_ids.some((id: string) => fixture.expected_absent_ids?.includes(id))) {
      fail('an ID cannot be both expected and forbidden');
    }
    if (fixture.expected_top_id !== undefined &&
        (!validId(fixture.expected_top_id) || fixture.expected_absent_ids?.includes(fixture.expected_top_id))) {
      fail('expected_top_id must be a valid, non-forbidden ID');
    }
    if (fixture.minimum_final_score !== undefined &&
        (!Number.isFinite(fixture.minimum_final_score) || fixture.minimum_final_score < 0)) {
      fail('invalid minimum_final_score');
    }
    if (fixture.expect_empty !== undefined && typeof fixture.expect_empty !== 'boolean') fail('expect_empty must be boolean');
    if (fixture.expect_empty) {
      if (fixture.expected_ids.length || fixture.expected_top_id !== undefined || fixture.minimum_final_score !== undefined) {
        fail('an empty-result fixture cannot expect IDs or a minimum score');
      }
    } else if (!fixture.expected_ids.length) {
      fail('expected_ids is empty; use expect_empty for a negative control');
    }
  }
  return parsed as Fixture[];
}
