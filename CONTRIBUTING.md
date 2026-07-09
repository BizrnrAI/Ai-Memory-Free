# Contributing

Thank you for improving Ai-Memory-Free. The project succeeds when it stays useful,
secure, understandable, no-cost by default, and independent of any generative model.

## Before Opening A Pull Request

1. Read [AGENTS.md](AGENTS.md) and [docs/DECISIONS.md](docs/DECISIONS.md).
2. Search existing issues and pull requests.
3. Keep changes focused. Optional paid/provider integrations must never enter the
   default path.
4. Add or update tests for behavior changes.
5. Update documentation and eval fixtures when contracts or retrieval change.
6. Never include a real URL token, service-role key, database password, secret,
   customer record, or private eval fixture.

Run:

```bash
npm ci
npm run check
deno task check
deno task test
npm audit --omit=dev
```

If Docker is available, run the documented migration and secret-scan checks from
[docs/AUDIT.md](docs/AUDIT.md).

## Design Requirements

- The caller synthesizes; memory returns ranked evidence.
- MCP stays an adapter over the HTTPS API.
- New public tables enable RLS and revoke public/user privileges.
- New functions pin `search_path` and receive explicit execute grants.
- Secrets stay out of memory, logs, audits, fixtures, and issue reports.
- Migrations are additive unless a decision record explains a destructive change.
- Default operation does not require a paid LLM API or always-on custom server.

## Pull Request Description

Explain the user problem, design, security impact, migration impact, tests, and any
remaining operator action. A green status code is not proof; include observed
effects where applicable.

## License

By contributing, you agree that your contribution may be distributed under the
repository [MIT License](LICENSE).
