export function isOAuthIdentity(value: unknown): value is Record<string, unknown> & { auth_mode: 'oauth' } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).auth_mode === 'oauth';
}
