# Optional Remote MCP With Supabase OAuth 2.1

The default MCP transport remains local stdio. v1.2 also includes a sessionless
Streamable HTTP Edge Function for services that require remote MCP. It is optional
and never exposes secret tools.

## Authorization Architecture

1. Enable the Supabase Auth OAuth 2.1 server and register the MCP client.
2. The client completes authorization code + PKCE with Supabase Auth.
3. The remote MCP resource advertises protected-resource metadata.
4. The memory API validates the access token with Supabase Auth.
5. `memory_oauth_grants` maps that user to explicit namespaces and permissions.

The adapter verifies `health.auth_mode` is exactly `oauth` before every JSON-RPC
operation. A normal `amf_` scoped token is valid for HTTPS/stdio but is rejected by
the remote MCP boundary.

Create a grant through reviewed SQL; never expose a public grant-creation action:

```sql
insert into public.memory_oauth_grants (
  user_id, name, allowed_namespaces, permissions
) values (
  'AUTH_USER_UUID',
  'remote-coding-agent',
  array['my-project'],
  array['memory:read', 'memory:write']
);
```

Configure non-secret function settings:

```text
MEMORY_API_URL=https://PROJECT.supabase.co/functions/v1/memory
MCP_RESOURCE_URL=https://PROJECT.supabase.co/functions/v1/mcp
MCP_AUTHORIZATION_SERVER=https://PROJECT.supabase.co/auth/v1
```

Deploy with `supabase functions deploy mcp --no-verify-jwt`. Custom validation is
required because the function must return MCP authorization discovery responses.
An absent, invalid, expired, revoked, or ungranted OAuth token receives 401.

Supabase Auth is the authorization server; the MCP function is only the protected
resource and protocol adapter. Never replace this flow with a shared remote bearer
token.

## 2026-07-28 Specification Posture

The MCP 2026-07-28 revision was audited against this function on 2026-08-19:

- **No SSE exposure.** The function is a sessionless JSON POST endpoint; it never
  offered the deprecated HTTP+SSE transport, so that deprecation requires no change.
- **No Dynamic Client Registration surface.** The 2026-07-28 move from DCR to Client
  ID Metadata Documents (CIMD) is an authorization-server and client concern. This
  function is a protected resource only; client registration happens with Supabase
  Auth, so register clients there using whichever mechanism it currently supports.
- **RFC 9207 issuer validation** is performed by the OAuth client during the
  authorization flow, not by the resource. This function already advertises
  `authorization_servers` in its protected-resource metadata, which is the resource's
  half of the mix-up defense.
- **Wire protocol** remains 2025-06-18. Clients on newer revisions negotiate down
  automatically; the 2026-era stateless request/response model matches this
  function's existing sessionless design and can be adopted later without
  architectural change.

Official references:

- [Supabase Auth OAuth 2.1 server](https://supabase.com/docs/guides/auth/oauth-server)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
