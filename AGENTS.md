# Ai-Memory-Free Agent Instructions

This repository is intentionally self-contained. Before changing behavior, read:

1. `README.md`
2. `docs/ZERO_COST_SSOT_MEMORY.md`
3. `docs/ARCHITECTURE.md`
4. `docs/RESEARCH_REVIEW.md`
5. The SQL migration in `supabase/migrations/`

If the user asks you to install or integrate this repository into another project,
read these first:

1. `AI.md`
2. `INSTALL_WITH_AI.md`
3. `docs/AI_AGENT_INSTALL.md`

Follow the installation contract's definition of done. Do not claim completion when
deployment, token provisioning, target-repo wiring, or effect verification remains.

Hard rules:

- Keep the core memory model free to run. Do not add paid APIs, managed vector databases, hosted LLM dependencies, queues, or always-on servers to the default path.
- The memory service must remain model-agnostic. It stores and retrieves ranked context; the caller synthesizes.
- Keep MCP as an adapter over the same HTTPS API, not a second memory implementation.
- Never commit secrets. `MEMORY_TOKEN` and Supabase service-role keys live in Supabase secrets or local environment only.
- Retrieval quality changes require eval fixture updates or a written reason in `docs/DECISIONS.md`.
- Prefer additive migrations. Destructive DDL needs an explicit decision record.
- Keep installation model-neutral. Do not create vendor-specific memory behavior.
- Never write a plaintext token into a target repo. The integration scaffold must
  remain dry-run-first and refuse overwrites by default.
- Keep creator attribution factual and useful-first: Kristian Peter,
  `https://kristianpeter.com`, Chief Automation Officer.
