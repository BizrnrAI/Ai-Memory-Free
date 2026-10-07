import {
  AUTH_FAILURE_STATUS,
  authServerUnavailable,
  createAuthenticator,
  credentialActive,
  lookupOutcome,
  type AuthBackend,
  type ClientRow,
  type GrantRow,
} from './auth.ts';

const client: ClientRow = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'test-client',
  token_prefix: 'test-only',
  allowed_namespaces: ['team-a'],
  permissions: ['memory:read'],
  expires_at: null,
  revoked_at: null,
};
const grant: GrantRow = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'test-grant',
  allowed_namespaces: ['team-b'],
  permissions: ['memory:read', 'memory:write'],
  expires_at: null,
  revoked_at: null,
};
const user = { id: '33333333-3333-4333-8333-333333333333' };
const past = '2000-01-01T00:00:00Z';
const refused = { data: { user: null }, error: { status: 403 } };

// A healthy backend with no credentials in it; each test replaces what it needs.
function fixture(overrides: Partial<AuthBackend> = {}, bootstrapToken?: string) {
  const calls: string[] = [];
  const reports: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const backend: AuthBackend = {
    findClient: () => Promise.resolve({ data: null, error: null }),
    recordClientUse: () => Promise.resolve({ error: null }),
    getUser: () => Promise.resolve(refused),
    findGrant: () => Promise.resolve({ data: null, error: null }),
    recordGrantUse: () => Promise.resolve({ error: null }),
    ...overrides,
  };
  const counted = Object.fromEntries(Object.entries(backend).map(([name, call]) => [
    name,
    (argument: string) => {
      calls.push(name);
      return (call as (argument: string) => unknown)(argument);
    },
  ])) as AuthBackend;
  const authenticate = createAuthenticator({
    bootstrapToken,
    backend: counted,
    report: (event, detail) => reports.push({ event, detail }),
  });
  return {
    authenticate: (token: string) => authenticate(`Bearer ${token}`),
    authenticateHeader: authenticate,
    calls,
    reports,
  };
}

Deno.test('a lookup that fails is not a lookup that finds nothing', () => {
  assertEquals(lookupOutcome({ data: client, error: null }).state, 'found');
  assertEquals(lookupOutcome({ data: null, error: null }).state, 'absent');
  const timedOut = lookupOutcome({ data: null, error: { code: '57014' } });
  assertEquals(timedOut.state, 'unavailable');
  assert(timedOut.state === 'unavailable' && timedOut.code === '57014');
  // supabase-js reports a request that never completed with an empty code.
  const unreachable = lookupOutcome({ data: null, error: { code: '' } });
  assert(unreachable.state === 'unavailable' && unreachable.code === null);
  assertEquals(lookupOutcome({ data: null, error: {} }).state, 'unavailable');
  // A table that is not installed holds no credentials.
  assertEquals(lookupOutcome({ data: null, error: { code: '42P01' } }).state, 'absent');
  assertEquals(lookupOutcome({ data: null, error: { code: 'PGRST205' } }).state, 'absent');
});

Deno.test('a credential is active until it is revoked or expires', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert(credentialActive({ revoked_at: null, expires_at: null }, now));
  assert(credentialActive({ revoked_at: null, expires_at: '2026-01-01T00:00:01Z' }, now));
  assert(!credentialActive({ revoked_at: null, expires_at: '2026-01-01T00:00:00Z' }, now));
  assert(!credentialActive({ revoked_at: past, expires_at: null }, now));
  assert(!credentialActive({ revoked_at: past, expires_at: '2027-01-01T00:00:00Z' }, now));
  assert(!credentialActive({ revoked_at: null, expires_at: 'not a date' }, now));
});

Deno.test('only a 4xx reply from the auth server is a verdict on the token', () => {
  for (const status of [400, 401, 403, 404]) assert(!authServerUnavailable({ status }), String(status));
  for (const status of [0, 408, 429, 500, 502, 503, 504]) assert(authServerUnavailable({ status }), String(status));
  assert(authServerUnavailable({}));
});

Deno.test('authentication failures map to 401 and a retryable 503', () => {
  assertEquals(AUTH_FAILURE_STATUS.unauthorized, 401);
  assertEquals(AUTH_FAILURE_STATUS.auth_unavailable, 503);
});

Deno.test('a failed client lookup is answered auth_unavailable, not unauthorized', async () => {
  const { authenticate, calls, reports } = fixture({
    findClient: () => Promise.resolve({ data: null, error: { code: '57014' } }),
  });
  const result = await authenticate('scoped-test-token');
  assert(!result.ok && result.error === 'auth_unavailable', JSON.stringify(result));
  // It must not go on to ask the auth server about a token it could not look up.
  assertEquals(calls.join(','), 'findClient');
  assertEquals(reports.length, 1);
  assertEquals(JSON.stringify(reports[0]), JSON.stringify({
    event: 'auth lookup failed', detail: { source: 'memory_clients', database_code: '57014' },
  }));
});

Deno.test('a valid scoped token stays valid when recording its last use fails', async () => {
  for (const recordClientUse of [
    () => Promise.resolve({ error: { code: '57014' } }),
    () => Promise.reject(new Error('connection reset')),
  ]) {
    const { authenticate, calls, reports } = fixture({
      findClient: () => Promise.resolve({ data: client, error: null }),
      recordClientUse,
    });
    const result = await authenticate('scoped-test-token');
    assert(result.ok, JSON.stringify(result));
    assertEquals(result.caller.authMode, 'scoped');
    assertEquals(result.caller.id, client.id);
    assertEquals(result.caller.dbClientId, client.id);
    assertEquals(result.caller.tokenPrefix, 'test-only');
    assertEquals(result.caller.allowedNamespaces.join(','), 'team-a');
    assertEquals(calls.join(','), 'findClient,recordClientUse');
    assertEquals(reports.length, 1);
    assertEquals(reports[0].event, 'auth last-use write failed');
  }
});

Deno.test('a revoked or expired scoped token is unauthorized on its row alone', async () => {
  for (const row of [{ ...client, revoked_at: past }, { ...client, expires_at: past }]) {
    const { authenticate, calls, reports } = fixture({ findClient: () => Promise.resolve({ data: row, error: null }) });
    const result = await authenticate('scoped-test-token');
    assert(!result.ok && result.error === 'unauthorized', JSON.stringify(result));
    assertEquals(calls.join(','), 'findClient');
    assertEquals(reports.length, 0);
  }
});

Deno.test('an unknown token is unauthorized once every lookup has answered', async () => {
  const unknown = fixture();
  const result = await unknown.authenticate('wrong-token');
  assert(!result.ok && result.error === 'unauthorized', JSON.stringify(result));
  assertEquals(unknown.calls.join(','), 'findClient,getUser');
  assertEquals(unknown.reports.length, 0);

  // An install without the scoped-client table still refuses a wrong token.
  const legacy = fixture({ findClient: () => Promise.resolve({ data: null, error: { code: 'PGRST205' } }) });
  const refusedLegacy = await legacy.authenticate('wrong-token');
  assert(!refusedLegacy.ok && refusedLegacy.error === 'unauthorized', JSON.stringify(refusedLegacy));

  for (const header of [null, 'Bearer   ', 'Basic abc']) {
    const absent = fixture();
    const noCredential = await absent.authenticateHeader(header);
    assert(!noCredential.ok && noCredential.error === 'unauthorized');
    assertEquals(absent.calls.length, 0);
  }
});

Deno.test('the bootstrap token never depends on a lookup', async () => {
  const broken = { data: null, error: { code: '57014' } };
  const { authenticate, calls } = fixture({
    findClient: () => Promise.resolve(broken),
    findGrant: () => Promise.resolve(broken),
  }, 'bootstrap-test-token');
  const result = await authenticate('bootstrap-test-token');
  assert(result.ok && result.caller.authMode === 'bootstrap', JSON.stringify(result));
  assertEquals(calls.length, 0);
  const other = await authenticate('scoped-test-token');
  assert(!other.ok && other.error === 'auth_unavailable');
});

Deno.test('an OAuth token is granted by its grant, and refused only on evidence', async () => {
  const granted = fixture({
    getUser: () => Promise.resolve({ data: { user }, error: null }),
    findGrant: () => Promise.resolve({ data: grant, error: null }),
  });
  const result = await granted.authenticate('oauth-test-token');
  assert(result.ok, JSON.stringify(result));
  assertEquals(result.caller.authMode, 'oauth');
  assertEquals(result.caller.id, grant.id);
  assertEquals(result.caller.dbClientId, null);
  assertEquals(result.caller.tokenPrefix, 'oauth:33333333');
  assertEquals(granted.calls.join(','), 'findClient,getUser,findGrant,recordGrantUse');

  for (const data of [null, { ...grant, revoked_at: past }, { ...grant, expires_at: past }]) {
    const { authenticate, calls } = fixture({
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      findGrant: () => Promise.resolve({ data, error: null }),
    });
    const refusedGrant = await authenticate('oauth-test-token');
    assert(!refusedGrant.ok && refusedGrant.error === 'unauthorized', JSON.stringify(refusedGrant));
    assertEquals(calls.join(','), 'findClient,getUser,findGrant');
  }
});

Deno.test('a failed grants query or an unreachable auth server is auth_unavailable', async () => {
  const grants = fixture({
    getUser: () => Promise.resolve({ data: { user }, error: null }),
    findGrant: () => Promise.resolve({ data: null, error: { code: 'PGRST002' } }),
  });
  const failedGrants = await grants.authenticate('oauth-test-token');
  assert(!failedGrants.ok && failedGrants.error === 'auth_unavailable', JSON.stringify(failedGrants));
  assertEquals(grants.calls.join(','), 'findClient,getUser,findGrant');
  assertEquals(JSON.stringify(grants.reports[0].detail), JSON.stringify({ source: 'memory_oauth_grants', database_code: 'PGRST002' }));

  for (const status of [undefined, 0, 503]) {
    const { authenticate, calls, reports } = fixture({
      getUser: () => Promise.resolve({ data: { user: null }, error: { status } }),
    });
    const unreachable = await authenticate('oauth-test-token');
    assert(!unreachable.ok && unreachable.error === 'auth_unavailable', JSON.stringify(unreachable));
    assertEquals(calls.join(','), 'findClient,getUser');
    assertEquals(reports[0].detail.source, 'auth_server');
  }
});

Deno.test('a valid OAuth grant stays valid when recording its last use fails', async () => {
  const { authenticate, reports } = fixture({
    getUser: () => Promise.resolve({ data: { user }, error: null }),
    findGrant: () => Promise.resolve({ data: grant, error: null }),
    recordGrantUse: () => Promise.resolve({ error: { code: '57014' } }),
  });
  const result = await authenticate('oauth-test-token');
  assert(result.ok && result.caller.authMode === 'oauth', JSON.stringify(result));
  assertEquals(JSON.stringify(reports), JSON.stringify([{
    event: 'auth last-use write failed', detail: { source: 'memory_oauth_grants', database_code: '57014' },
  }]));
});

Deno.test('authentication reports never carry the token', async () => {
  const token = 'never-log-this-test-token';
  const { authenticate, reports } = fixture({
    findClient: () => Promise.resolve({ data: null, error: { code: '57014' } }),
  });
  await authenticate(token);
  const again = fixture({ getUser: () => Promise.resolve({ data: { user: null }, error: { status: 502 } }) });
  await again.authenticate(token);
  assertEquals(reports.length + again.reports.length, 2);
  assert(!JSON.stringify([reports, again.reports]).includes(token));
});

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message ? `assertion failed: ${message}` : 'assertion failed');
}

function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
}
