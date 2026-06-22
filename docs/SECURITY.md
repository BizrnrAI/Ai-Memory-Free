# Security

## Threat Model

The public attack surface is one Supabase Edge Function. The table is not exposed
directly to browser clients or anonymous PostgREST calls.

## Controls

- The Edge Function requires `Authorization: Bearer $MEMORY_TOKEN`.
- The Supabase service-role key is only used inside the Edge Function runtime.
- `public.memories` has RLS enabled and no public policies.
- Table privileges are revoked from `public`, `anon`, and `authenticated`.
- RPC execute privileges are revoked from `public`, `anon`, and `authenticated`.
- MCP is a local adapter and receives only `MEMORY_API_URL` plus `MEMORY_TOKEN`.
- No secrets belong in git.

## Token Rotation

```bash
supabase secrets set MEMORY_TOKEN="$(openssl rand -base64 48)"
supabase functions deploy memory --no-verify-jwt
```

Update MCP client config or local secret storage after rotation.

## Data Classification

This system can store sensitive project memory. Treat exported dumps and eval
fixtures as sensitive if they contain customer data, internal decisions, or private
operational context.

## Deletion

The default lifecycle operations retire or supersede rows instead of deleting them.
If you need hard deletion for privacy or compliance, add a reviewed RPC that deletes
by `id` and records the reason outside the memory store.
