# Encrypted API Keys And Tokens

Use the Vault module for recoverable API keys, bearer tokens, OAuth refresh tokens,
passwords, and other credential values. Supabase Vault provides authenticated
at-rest encryption; this service exposes named, scoped retrieval over HTTPS.
Secrets remain separate from semantic memory, document search, and portable exports.

## Find And Retrieve Credentials

Use a namespace for the project and canonical names of the form
`service.environment.credential_type`, such as `github.production.api_token` or
`payments.production.refresh_token`. Each component is 1..40 lowercase letters,
digits, underscores or hyphens, starting with a letter or digit. Use consistent
environments (`development`, `staging`, `production`) and credential types
(`api_key`, `api_token`, `refresh_token`, `password`). Separate multiple accounts
with distinct service identifiers or namespaces.

`storeCredential` builds the name and identity metadata automatically;
`getCredential` builds the same exact lookup. Raw `secret_store` validates the name
when all three identity fields are supplied. Legacy names remain valid and are
indexed without renaming or decrypting existing entries. Names, descriptions and
safe service/environment/type metadata have a full-text index; a separate name
prefix index supports exact discovery. Secret values are never indexed. Keep
credential values in the `secret` field only.

A credential client needs the namespace grant and `secrets:list` for discovery,
`secrets:read` for decryption, or `secrets:write` for storage/rotation. Provision a
scoped client with the existing token command:

```bash
npm run token:create -- --name credential-reader --namespaces platform --permissions secrets:list,secrets:read
```

Save its displayed token in the client secret store and apply the emitted hash-only
SQL. In a trusted backend, pass that token through the process environment:

```typescript
import { MemoryClient } from '@ai-memory-free/client';

const credentials = new MemoryClient(); // MEMORY_API_URL and MEMORY_TOKEN
const registry = await credentials.listAllSecrets({
  namespace: 'platform', query: 'payments production refresh token',
}); // names and safe metadata, without decryption

const key = await credentials.getCredential({
  namespace: 'platform', service: 'payments',
  environment: 'production', credential_type: 'refresh_token',
});
const selected = await credentials.getSecrets({
  namespace: 'platform', names: ['payments.production.api_key', 'payments.production.refresh_token'],
}); // at most 10 explicit names; each read has its own authorization and audit
// Pass key.secret.secret or selected.secrets to the backend that needs them.
```

Direct HTTPS callers use `secret_list` with `limit`, `cursor`, and optional
`name_prefix` and `query` (words from names or safe metadata). Follow `next_cursor` until it is null, then call `secret_get` with
one exact namespace/name. Listing never decrypts values. Prefixes are literal,
including underscores. See [ACTIONS.md](ACTIONS.md).

The stdio MCP adapter exposes `memory_secret_list`, `memory_secret_get`, and
`memory_secret_get_many` when `MCP_ENABLE_SECRET_TOOLS=true`. Decrypted values
are returned to that trusted MCP client; the remote MCP endpoint excludes these
tools. Permissions still apply independently of tool visibility.

## Rotation And Retirement

Store a new value under the same namespace/name to rotate it. The Vault UUID stays
stable and the registry version increments. Concurrent first stores and rotations
serialize per credential; retrieval locks its registry row so the value, version
and audit entry describe the same state. Missing descriptions work, and secret
whitespace is preserved exactly.

`secret_retire` requires `secrets:admin` and disables named retrieval while keeping
the encrypted Vault value. Storing again reactivates it. Administrative inventory
can include retired entries with `include_retired:true`.

## The Token That Authenticates To This Memory Service

Ai-Memory-Free caller tokens are generated with 288 bits of randomness and stored
only as SHA-256 hashes for authentication. They cannot be recovered from the hash.
Keep the original in your client secret store; generate and provision a replacement
if it is lost. Third-party API tokens that must be recovered belong in Vault.

## Transport And Upgrade

The TypeScript client requires HTTPS, permits HTTP loopback for local development,
and refuses HTTP redirects and response caching. An explicit `allowInsecureHttp`
option (or `MEMORY_ALLOW_INSECURE_HTTP=true` for MCP adapters) permits a trusted
private HTTP deployment. Public endpoints should use HTTPS.

Apply all migrations before deploying the updated function. The additive
`vault_secret_access_hardening` migration preserves existing encrypted values and
Vault UUIDs; it indexes all registry rows and updates the wrapper functions without changing the encryption
algorithm. Existing rows gain the unambiguous internal Vault name on their next
rotation. No secret re-entry or bulk decryption is required.
