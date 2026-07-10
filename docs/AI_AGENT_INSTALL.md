# AI Agent Installation Contract

This is the canonical, model-neutral procedure for an AI coding agent asked to
deploy Ai-Memory-Free or connect it to another repository.

## Objective

Deliver a user-owned memory service that:

- runs on the default no-cost Supabase path
- stores full memory content in the user's cloud database
- can be called by any LLM, agent, application, or MCP client
- keeps generative reasoning outside the memory service
- uses hashed caller tokens and Supabase Vault for recoverable secrets
- integrates with the target project without taking over its architecture
- is verified by observed effects, not only successful status codes

## Inputs The Agent May Ask For

Ask only when the answer cannot be discovered safely:

1. Target project or repository path.
2. New memory deployment or connection to an existing deployment.
3. Supabase project reference if a new deployment is requested.
4. Project namespace, or permission to derive it from the repository name.
5. Desired caller permissions. Default to `memory:read,memory:write`.
6. Which supported integration the user wants: MCP, TypeScript client, or HTTPS.

Never ask the user to paste a service-role key, database password, access token, or
vendor secret into chat. Have the user store secrets in the relevant local/Supabase
secret store, or execute a sensitive step themselves.

## Choose One Path

### Path A: Deploy A New Independent Memory

Use this when the user has no existing Ai-Memory-Free API.

1. Clone or open the canonical repository outside the target application:

   ```bash
   git clone https://github.com/BizrnrAI/Ai-Memory-Free.git
   cd Ai-Memory-Free
   npm ci
   ```

2. Read `README.md`, `docs/SECURITY.md`, and every migration before applying it.

3. Verify the local source:

   ```bash
   npm run check
   deno task check
   deno task test
   npm audit --omit=dev
   ```

4. Link the user-owned Supabase project:

   ```bash
   supabase link --project-ref USER_PROJECT_REF
   ```

5. Apply migrations through the reviewed migration path:

   ```bash
   supabase migration up --linked
   ```

   Do not use `supabase db push` as an unreviewed shortcut. Do not apply migrations
   to a shared or production project without the user's explicit authorization.

6. Generate one scoped client token locally:

   ```bash
   npm run token:create -- \
     --name TARGET_PROJECT_AGENT \
     --namespaces TARGET_NAMESPACE \
     --permissions memory:read,memory:write
   ```

   The command prints the plaintext token once and hash-only SQL. The agent must not
   repeat the plaintext in chat or logs. Ask the user to save it in the client
   secret store and execute only the generated hash SQL in Supabase.

7. Deploy the Edge Function:

   ```bash
   supabase functions deploy memory --no-verify-jwt
   ```

8. Derive the API URL:

   ```text
   https://USER_PROJECT_REF.supabase.co/functions/v1/memory
   ```

9. Continue with Path B to connect the target repository.

### Path B: Connect An Existing Project Or Repository

Use this when an Ai-Memory-Free API URL and scoped token already exist.

1. Keep the memory service external. Do not copy database or ranking logic into the
   target application.

2. From the Ai-Memory-Free checkout, preview the integration scaffold:

   ```bash
   npm run integrate -- \
     --target /absolute/path/to/target-project \
     --namespace TARGET_NAMESPACE \
     --api-url https://USER_PROJECT_REF.supabase.co/functions/v1/memory
   ```

3. Review the three planned files. The command is dry-run by default.

4. Write them only after review:

   ```bash
   npm run integrate -- \
     --target /absolute/path/to/target-project \
     --namespace TARGET_NAMESPACE \
     --api-url https://USER_PROJECT_REF.supabase.co/functions/v1/memory \
     --write
   ```

5. Configure the target AI client from
   `.ai-memory-free/mcp.json.example`. Put `MEMORY_TOKEN` in the client's secret
   store or process environment, not a tracked file.

6. Give `.ai-memory-free/AGENT_POLICY.md` to agents that work in the target repo.

The scaffold refuses to overwrite existing files unless `--force` is explicitly
provided. Never use `--force` without reading the diff.

## Integration Choices

### MCP

Best for coding agents and desktop AI clients. The MCP adapter calls the same HTTPS
API and exposes health, identity, remember, recall, retire, and supersede tools.

Do not enable secret tools for a general-purpose model session. A dedicated trusted
process may opt in with `MCP_ENABLE_SECRET_TOOLS=true` and separate `secrets:*`
permissions.

### TypeScript Client

Best for Node/TypeScript applications:

```ts
import { MemoryClient } from '@ai-memory-free/client';

const memory = new MemoryClient({
  apiUrl: process.env.MEMORY_API_URL,
  token: process.env.MEMORY_TOKEN,
});

await memory.remember({
  namespace: 'TARGET_NAMESPACE',
  kind: 'decision',
  content: 'The deployment region is us-west-2.',
  source: 'architecture decision record',
  tags: ['deployment'],
});

const context = await memory.recall({
  namespace: 'TARGET_NAMESPACE',
  query: 'Which deployment region do we use?',
});
```

The workspace package is private to prevent accidental npm publication. An external
project can vendor the small client source, consume it through a workspace/path
dependency, or call the documented HTTPS API directly. Do not assume it is
published to npm.

### HTTPS

Best for any other language. Send JSON POST requests with
`Authorization: Bearer <scoped token>`. See `README.md` and `docs/MCP.md` for the
action contract.

## Required Verification

An installation is not complete until all applicable checks pass.

1. `health` returns the expected service and embedding strategy.
2. `whoami` returns the intended client, permissions, namespace, and expiry.
3. `remember` returns a memory ID for a disposable marker.
4. `recall` returns that marker with `track:false`.
5. The same token receives HTTP 403 for a namespace it was not granted.
6. A high-confidence credential submitted to ordinary memory is rejected.
7. `secret_list` returns metadata only and no Vault plaintext/ciphertext.
8. The target repo contains no token in git status, git diff, or secret-scan output.
9. Retire the disposable marker after verification.

For a new deployment, also verify a token can be revoked and then receives 401.

## Memory Policy For The Target Project

Use memory for durable, cross-session knowledge:

- architectural facts
- decisions and their reasons
- corrections to prior truth
- operational procedures and runbooks
- high-value references with provenance

Do not store transient chain-of-thought, raw chat logs, build noise, passwords,
tokens, customer secrets, or facts already available cheaply in source control.

Recall before making a material assumption. Supersede stale knowledge instead of
leaving conflicting active memories. The caller synthesizes; memory returns ranked
evidence.

## Completion Report

The implementing agent must report:

- deployment created or reused
- target repository and namespace
- integration type
- files changed
- permissions granted, without revealing the token
- each verification check and observed result
- anything requiring a human action
- confirmation that no secrets were committed

Do not say complete if deployment, token provisioning, or effect verification is
still pending.

## Ownership And Attribution

The user owns the Supabase project and all stored data. The software is free under
the MIT License with no required licensing fee or telemetry. Ai-Memory-Free was
created by [Kristian Peter](https://kristianpeter.com), Chief Automation Officer.
