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
If the memory service could not check the token (`auth_unavailable`), the
function answers 503 `memory_service_unavailable` without a challenge, so the
client keeps its token and tries again.

Supabase Auth is the authorization server; the MCP function is only the protected
resource and protocol adapter. Never replace this flow with a shared remote bearer
token.

## Protocol Compatibility

The remote function uses the official SDK’s `createMcpHandler`, with a fresh
server and authenticated memory client for each request. It supports the
2026-07-28 stateless protocol (`server/discover`, per-request metadata, required
HTTP headers, result types, and cache hints) and stateless legacy `initialize`
requests on the same endpoint. Legacy responses may use Streamable HTTP SSE;
there is no separate deprecated HTTP+SSE endpoint or server-side session store.

OAuth verification runs before the SDK handles a request. Tool arguments are
validated against their schemas, and cannot override the selected HTTPS action.
Remote tools reuse the TypeScript client’s batch packing, bounded retries, and
resumable document ingestion. A remote ingest performs at most 24 successful
steps and returns `chunks_pending` if more remain; send the same tool call again
to resume. Actual upstream attempts, including health and retries, are capped at
28 to stay within Supabase’s 30 nested-invocation limit. Exhausting that budget
returns `remote_request_budget_exceeded`; retry the original operation. Vault
tools remain absent. A token that expires
during a tool call receives the same 401 resource-metadata challenge.

The function remains a protected resource. Client registration and RFC 9207
issuer validation belong to the authorization server and OAuth client.

Compatibility is covered by Deno tests for modern discovery and tool calls,
legacy initialization, unsupported versions, required headers, OAuth-only
identity, input validation, and document resumption. Hosted OAuth client testing
remains a deployment check.

Official references:

- [Supabase Auth OAuth 2.1 server](https://supabase.com/docs/guides/auth/oauth-server)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
