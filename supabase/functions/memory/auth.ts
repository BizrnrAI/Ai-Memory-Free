import { bearerToken, sha256Hex, timingSafeEqualHex } from './lib.ts';

export type Caller = {
  id: string | null;
  name: string;
  tokenPrefix: string;
  allowedNamespaces: string[];
  permissions: string[];
  expiresAt: string | null;
  authMode: 'bootstrap' | 'scoped' | 'oauth';
  dbClientId: string | null;
};

// ── Authentication outcome ──────────────────────────────────────────────────
// A token is refused only on evidence: no credential in the request, a lookup
// that completed and found nothing, or a row that is revoked or expired. A
// lookup that could not be completed says nothing about the token. It is
// answered 503 `auth_unavailable`, which callers retry, and never 401, which
// they rightly do not: observed in a hosted deployment, a valid scoped token was
// answered 401 during a backend stall and worked again seconds later.
export type AuthFailure = 'unauthorized' | 'auth_unavailable';
export type AuthResult = { ok: true; caller: Caller } | { ok: false; error: AuthFailure };

export const AUTH_FAILURE_STATUS: Record<AuthFailure, number> = {
  unauthorized: 401,
  auth_unavailable: 503,
};

type QueryError = { code?: string | null };
type Lookup<Row> = { data: Row | null; error: QueryError | null };
type Written = { error: QueryError | null };

type CredentialRow = {
  id: string;
  name: string;
  allowed_namespaces: string[];
  permissions: string[];
  expires_at: string | null;
  revoked_at: string | null;
};
export type ClientRow = CredentialRow & { token_prefix: string };
export type GrantRow = CredentialRow;

/** The queries authentication needs. index.ts binds them to Supabase; tests bind them to fakes. */
export type AuthBackend = {
  findClient(tokenHash: string): PromiseLike<Lookup<ClientRow>>;
  recordClientUse(id: string): PromiseLike<Written>;
  getUser(token: string): PromiseLike<{ data: { user: { id: string } | null }; error: { status?: number } | null }>;
  findGrant(userId: string): PromiseLike<Lookup<GrantRow>>;
  recordGrantUse(id: string): PromiseLike<Written>;
};

// Postgres (42P01) and PostgREST (PGRST205) answer these when the table itself
// is not installed: an install that has not applied the migration creating it.
// No credential of that kind can exist there, so this reads as "no row", and a
// bootstrap-token install keeps answering 401 to a wrong token while it upgrades.
const TABLE_NOT_INSTALLED = ['42P01', 'PGRST205'];

/** What a credential lookup established: the row, that there is none, or nothing because it failed. */
export function lookupOutcome<Row>(result: Lookup<Row>):
  | { state: 'found'; row: Row }
  | { state: 'absent' }
  | { state: 'unavailable'; code: string | null } {
  if (result.error) {
    const code = result.error.code || null;
    return code && TABLE_NOT_INSTALLED.includes(code) ? { state: 'absent' } : { state: 'unavailable', code };
  }
  return result.data ? { state: 'found', row: result.data } : { state: 'absent' };
}

/** A credential row that is neither revoked nor past its expiry. */
export function credentialActive(row: { revoked_at: string | null; expires_at: string | null }, now = Date.now()) {
  return !row.revoked_at && (!row.expires_at || new Date(row.expires_at).getTime() > now);
}

/**
 * Whether a failed `getUser` means the auth server could not answer, rather
 * than that it refused the token. Only a 4xx reply is a refusal. No status (the
 * request never completed), a 5xx, a timeout or a rate limit is not about the
 * token.
 */
export function authServerUnavailable(error: { status?: number }) {
  const status = error.status;
  const refused = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  return !refused;
}

export function createAuthenticator(options: {
  bootstrapToken?: string | null;
  backend: AuthBackend;
  /** Told about backend failures. Receives database codes and statuses, never token material. */
  report?: (event: string, detail: Record<string, unknown>) => void;
}) {
  const { bootstrapToken, backend } = options;
  const report = options.report ??
    ((event, detail) => console.error(`[ai-memory-free] ${event}`, detail));

  function unavailable(source: string, detail: Record<string, unknown>): AuthResult {
    report('auth lookup failed', { source, ...detail });
    return { ok: false, error: 'auth_unavailable' };
  }

  // Recording last use is bookkeeping. A token that passed its lookup is valid
  // whether or not the write lands, so a failure here is reported and ignored.
  async function recordUse(source: string, write: () => PromiseLike<Written>) {
    try {
      const used = await write();
      if (used.error) report('auth last-use write failed', { source, database_code: used.error.code || null });
    } catch {
      report('auth last-use write failed', { source, database_code: null });
    }
  }

  return async function authenticate(header: string | null): Promise<AuthResult> {
    const token = bearerToken(header);
    if (!token) return { ok: false, error: 'unauthorized' };

    const tokenHash = await sha256Hex(token);
    if (bootstrapToken) {
      const bootstrapHash = await sha256Hex(bootstrapToken);
      if (timingSafeEqualHex(tokenHash, bootstrapHash)) {
        return {
          ok: true,
          caller: {
            id: null,
            name: 'bootstrap-admin',
            tokenPrefix: token.slice(0, 8),
            allowedNamespaces: ['*'],
            permissions: ['*'],
            expiresAt: null,
            authMode: 'bootstrap',
            dbClientId: null,
          },
        };
      }
    }

    const client = lookupOutcome(await backend.findClient(tokenHash));
    if (client.state === 'unavailable') return unavailable('memory_clients', { database_code: client.code });
    if (client.state === 'found') {
      // The hash matched a scoped client token, so its row is the whole answer.
      const row = client.row;
      if (!credentialActive(row)) return { ok: false, error: 'unauthorized' };
      await recordUse('memory_clients', () => backend.recordClientUse(row.id));
      return {
        ok: true,
        caller: {
          id: row.id,
          name: row.name,
          tokenPrefix: row.token_prefix,
          allowedNamespaces: row.allowed_namespaces,
          permissions: row.permissions,
          expiresAt: row.expires_at,
          authMode: 'scoped',
          dbClientId: row.id,
        },
      };
    }

    // Not a scoped client token: it may be an OAuth access token with a grant.
    const auth = await backend.getUser(token);
    if (auth.error && authServerUnavailable(auth.error)) {
      return unavailable('auth_server', { status: auth.error.status ?? null });
    }
    const user = auth.error ? null : auth.data.user;
    if (!user) return { ok: false, error: 'unauthorized' };

    const grant = lookupOutcome(await backend.findGrant(user.id));
    if (grant.state === 'unavailable') return unavailable('memory_oauth_grants', { database_code: grant.code });
    if (grant.state === 'absent' || !credentialActive(grant.row)) return { ok: false, error: 'unauthorized' };
    const row = grant.row;
    await recordUse('memory_oauth_grants', () => backend.recordGrantUse(row.id));
    return {
      ok: true,
      caller: {
        id: row.id,
        name: row.name,
        tokenPrefix: `oauth:${user.id.slice(0, 8)}`,
        allowedNamespaces: row.allowed_namespaces,
        permissions: row.permissions,
        expiresAt: row.expires_at,
        authMode: 'oauth',
        dbClientId: null,
      },
    };
  };
}
