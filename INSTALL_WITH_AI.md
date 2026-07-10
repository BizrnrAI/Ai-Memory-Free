# Install Ai-Memory-Free with any AI coding agent

Give your agent this repository URL:

<https://github.com/BizrnrAI/Ai-Memory-Free>

Then paste this prompt:

> Implement Ai-Memory-Free for the project I am currently working in. Read the
> repository AGENTS.md, AI.md, and docs/AI_AGENT_INSTALL.md before changing
> anything. Use a user-owned Supabase project and keep the default path free of
> paid model APIs. Ask me only for non-secret choices you cannot discover, and
> never ask me to paste a token or service-role key into chat. Keep the memory
> service external to my application, connect this project through MCP or the
> TypeScript client, use a project-specific namespace, and preserve existing code.
> Run the documented checks and prove whoami, idempotent remember/batch, recall,
> forbidden namespace, event retry safety, source and contradiction links,
> document search, context budgeting, portable restore, and secret isolation before
> reporting completion. Use optional remote MCP only with Supabase OAuth 2.1.

The agent should follow the complete contract in
[docs/AI_AGENT_INSTALL.md](docs/AI_AGENT_INSTALL.md). The contract works with
Codex, Claude, Gemini, Copilot-style coding agents, local models, and future agents
that can read a repository and run ordinary development tools.

## What you need

- a free Supabase account and project
- Node.js 22 or newer
- Deno 2
- the Supabase CLI
- permission for the agent to edit your local target repository

You do not need an OpenAI, Anthropic, Gemini, or other generative-model API key for
the memory service itself.

## What remains yours

The database, memories, Vault secrets, tokens, and deployment live in your Supabase
project. Ai-Memory-Free does not send telemetry to KristianPeter.com or BizRnR.

Created and maintained as a free MIT-licensed project by
[Kristian Peter](https://kristianpeter.com).
