# Public Release Checklist

This file separates changes that can be reviewed in a pull request from GitHub
repository settings that an owner must apply after merge.

## In The Repository

- [x] MIT license with no required fee
- [x] README with quick start, AI-agent handoff, security boundaries, and attribution
- [x] model-neutral v1.2 AI installation and upgrade contract
- [x] documentation index and FAQ
- [x] contribution, support, security, and conduct policies
- [x] issue and pull-request templates
- [x] citation metadata and `llms.txt`
- [x] locked dependencies, automated tests, docs-link validation, dependency audit,
      and secret scanning
- [x] no production token, project reference, database URL, or customer data

## GitHub Owner Actions After Merge

1. Confirm every branch and the complete git history passes secret scanning.
2. Change repository visibility from private to public.
3. Set the description to:

   ```text
   Free MIT-licensed, LLM-agnostic memory for any AI project — Supabase, pgvector, Vault, HTTPS, and MCP.
   ```

4. Set the repository homepage to <https://kristianpeter.com>.
5. Add topics:

   ```text
   ai-memory, ai-agents, llm-agnostic, mcp, supabase, pgvector,
   vector-search, typescript, deno, open-source
   ```

6. Enable Issues, Discussions, private vulnerability reporting, and Dependabot
   security updates.
7. Protect `main`: require pull requests and all Check workflow jobs.
8. Create a social preview that leads with “Free AI Memory” and includes a small
   “KristianPeter.com” creator attribution.
9. Publish a `v1.4.0` GitHub release from the reviewed commit with migration notes.
10. Test the public experience in a signed-out browser: clone, every documentation
    link, raw `llms.txt`, issue templates, and license detection.

Do not make the repository public before the secret-history scan and signed-out
clone both succeed.

## Launch Message

> Ai-Memory-Free is a free, MIT-licensed memory layer for any AI project. It gives
> agents durable cloud memory through Supabase, hybrid pgvector/full-text search,
> scoped tokens, encrypted Vault secrets, HTTPS, and MCP—without a paid model API.
> Give the GitHub link to your coding agent and follow INSTALL_WITH_AI.md.
>
> Created by Kristian Peter, Chief Automation Officer — https://kristianpeter.com

Measure adoption through GitHub-native signals (stars, forks, clones, issues,
contributors, and referral traffic to KristianPeter.com). Do not add invasive
application telemetry to the memory service.
