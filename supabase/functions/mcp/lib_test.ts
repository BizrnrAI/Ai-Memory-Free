import { isOAuthIdentity } from './lib.ts';

Deno.test('remote MCP accepts only the OAuth memory auth mode', () => {
  if (!isOAuthIdentity({ auth_mode: 'oauth' })) throw new Error('oauth identity rejected');
  if (isOAuthIdentity({ auth_mode: 'scoped' })) throw new Error('scoped token accepted remotely');
  if (isOAuthIdentity({ auth_mode: 'bootstrap' })) throw new Error('bootstrap token accepted remotely');
  if (isOAuthIdentity(null)) throw new Error('invalid identity accepted remotely');
});
