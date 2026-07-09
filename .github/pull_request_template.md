## Problem

What user or agent problem does this solve?

## Change

What changed, and why is this the smallest useful design?

## Default-path guarantees

- [ ] No required paid API or hosted LLM dependency
- [ ] No generative-model coupling in storage/retrieval
- [ ] MCP remains an adapter over the HTTPS API
- [ ] No credential, customer data, or private fixture is included

## Security and migration

Describe auth, namespaces, RLS/grants, Vault, secrets, schema, compatibility, and
rollout impact. Write “none” only after checking.

## Verification

- [ ] `npm run check`
- [ ] `deno task check`
- [ ] `deno task test`
- [ ] `npm audit --omit=dev`
- [ ] Observed effect verified where applicable

## Documentation

- [ ] User and AI-agent docs updated
- [ ] Retrieval changes include eval updates or a decision record
