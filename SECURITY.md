# Security Policy

## Report A Vulnerability Privately

Do not open a public issue containing a vulnerability, exploit, token, database URL,
secret, customer data, or unredacted logs.

Use GitHub private vulnerability reporting for this repository. If that is
unavailable, contact the maintainer through
[KristianPeter.com/contact](https://kristianpeter.com/contact) and include only a
high-level description until a private channel is established.

Please include:

- affected commit or version
- affected component and action
- reproduction steps using synthetic data
- expected and observed behavior
- impact and suggested mitigation

Never include a live credential. Revoke any credential used during testing.

## Scope

Security-sensitive surfaces include Edge authentication, namespace authorization,
Supabase Vault RPCs, RLS and grants, MCP tools, token generation, CORS, rate limits,
audit integrity, backup guidance, and secret scanning.

The detailed architecture and operator threat model are in
[docs/SECURITY.md](docs/SECURITY.md).

## Supported Versions

| Version | Supported |
| --- | --- |
| 1.2.x | yes |
| 0.2.x | security fixes during the v1.2 upgrade window |
| earlier | no |
