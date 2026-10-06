# Research Review

Comparison snapshot: 2026-06-22. Security and platform guidance refreshed:
2026-07-09.

Retrieval was measured on real data in 2026-10; the method, the numbers and the
alternatives considered are in [RETRIEVAL.md](RETRIEVAL.md).

This review compares Ai-Memory-Free against major open-source AI memory and
context projects. The goal is not to clone the biggest framework. The goal is to
extract the durable practices that fit a zero-cost, model-agnostic, reproducible
memory system.

## Comparison Set

| Project | Why It Matters | What We Borrow | What We Leave Out |
| --- | --- | --- | --- |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Widely adopted universal memory layer; Apache-2.0; about 59k stars in the snapshot. | Simple `add/search` product mental model, user-centric long-term memory, broad adapter mindset. | Default dependence on external LLM/provider workflows and more framework surface than a tiny free SSOT needs. |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Real-time temporal knowledge graphs for agents; Apache-2.0; about 27k stars. | Temporal/provenance thinking and the value of explicit relationships. | Full graph ingestion stack; Ai-Memory-Free keeps graph features optional. |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | Memory and context engine that can run locally; MIT; about 27k stars. | Product-grade API ergonomics and context portability across tools. | Cloudflare/app stack complexity in the default path. |
| [letta-ai/letta](https://github.com/letta-ai/letta) | Stateful agent platform with memory and self-improvement; Apache-2.0; about 23k stars. | Stateful-agent framing and long-lived memory discipline. | Agent runtime and orchestration. Ai-Memory-Free is memory only. |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Open-source AI memory platform with self-hosted knowledge graph engine; Apache-2.0; about 19k stars. | Knowledge graph as an optional advanced extension. | Multi-component graph platform as the baseline. |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | Memory tools for LangGraph/LangChain users; MIT; about 1.5k stars. | Evaluation and framework integration mindset. | LangChain/LangGraph coupling in the default implementation. |
| [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1) | Open Brain: shared memory layer on Supabase with MCP-oriented positioning; about 3.8k stars. | One database for many AI tools, Supabase as accessible substrate, MCP-first distribution. | Broader personal-infrastructure surface. Ai-Memory-Free keeps only the minimal memory core. |
| [karpathy/llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | Influential LLM Wiki pattern: raw sources, maintained wiki, schema file, compounding knowledge. | Durable source/provenance mindset, compounding knowledge, health checks. | LLM-maintained synthesis as a required default. Ai-Memory-Free returns raw ranked context and lets the caller synthesize. |
| [skyllwt/AutoSci](https://github.com/skyllwt/AutoSci) | Open-source implementation inspired by the LLM Wiki idea; MIT; about 1.4k stars. | Wiki-centric workflows can be a useful export or advanced layer. | Research-agent lifecycle platform. |
| [Bobby-cell-commits/open-brain-server](https://github.com/Bobby-cell-commits/open-brain-server) | Self-hostable MCP memory server with Supabase and pgvector; MIT; small but directly adjacent. | MCP memory tools, Supabase pgvector, staleness pruning. | Larger tool surface and ingestion pipelines in the default repo. |

Honorable mentions:

- [agiletec-inc/mindbase](https://github.com/agiletec-inc/mindbase) for local
  PostgreSQL, pgvector, and Ollama-oriented memory.
- [upstash/context7](https://github.com/upstash/context7) for MCP-native context
  distribution, though it is documentation/context rather than personal memory.

## Design Takeaways

1. The best systems make memory a separate layer, not a chat transcript hack.
2. MCP matters because the same memory should be available to many agents.
3. Graphs and wikis are valuable, but they are expensive defaults. They belong as
   optional exports or extensions.
4. Provenance and supersession are not luxuries. Without them, memory becomes stale
   folklore.
5. Eval gates are the difference between a memory system and a pile of embeddings.
6. Model agnosticism requires discipline: the memory retrieves; the caller reasons.
7. Free operation is easiest when the system has almost nothing to run.
8. Shared memory needs caller identity, namespace grants, revocation, and audit;
   one global token is a personal prototype, not a multi-agent security model.
9. Caller authentication and recoverable platform secrets are different products.
   Hash high-entropy caller tokens; encrypt recoverable credentials with a managed
   key and keep them out of semantic recall.

## Resulting Architecture Choice

Ai-Memory-Free implements the smallest useful A+ core:

- Supabase Postgres plus pgvector
- one primary `memories` table plus small security-control tables
- one Edge Function
- in-edge free embeddings
- hybrid vector plus FTS recall
- transparent ranking scores
- no generation
- MCP as a thin adapter
- eval fixtures
- hashed scoped clients, rate limits, and mutation audit
- an isolated Supabase Vault encrypted-secret store

This captures the useful lessons from the category leaders while avoiding the
pieces that would make the default system paid, provider-specific, or hard for an
agent to reproduce.
