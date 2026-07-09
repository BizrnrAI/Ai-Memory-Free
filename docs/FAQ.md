# Frequently Asked Questions

## Is Ai-Memory-Free really free?

The source is MIT licensed and has no licensing fee, required subscription, or paid
LLM API. The default deployment targets Supabase Free Plan allowances. Supabase may
change its quotas, pause inactive free projects, or charge if you voluntarily
upgrade or exceed a paid-plan allowance.

## Does Kristian Peter or BizRnR receive my data?

No. You deploy into your own Supabase project. The repository contains no telemetry
or callback to KristianPeter.com or BizRnR. Your API URL, tokens, memories, and Vault
secrets remain under your account and access controls.

## Which AI models can use it?

Any model or non-model application that can call MCP or HTTPS can use it. The memory
response is ordinary JSON and contains no OpenAI-, Anthropic-, Gemini-, or
framework-specific prompt format.

## Why does an LLM-agnostic system have an embedding model?

LLM agnosticism means the caller that reasons and writes answers is interchangeable.
Semantic retrieval still needs one consistent embedding space. The default uses the
free Supabase Edge Runtime `gte-small` model; changing it requires re-embedding and
re-running retrieval evals.

## Can I use it in an existing repository?

Yes. Keep the memory backend separate and connect the target repository through MCP,
the TypeScript client, or HTTPS. See [AI_AGENT_INSTALL.md](AI_AGENT_INSTALL.md) or run
the safe `npm run integrate` scaffold from the Ai-Memory-Free checkout.

## Does the integration scaffold change my application?

Only when you pass `--write`. It creates three files under `.ai-memory-free/` and
does not edit source code, package files, existing agent instructions, or secrets.
It refuses overwrites unless `--force` is explicitly provided.

## Why is the root package marked private?

The `private` package field prevents accidental publication to npm; it does not
restrict cloning, self-hosting, modification, or commercial use under MIT. The
TypeScript client is available as source, a workspace/path dependency, or the same
functionality can be used from any language through HTTPS.

## Are API keys hashed or encrypted?

Caller access tokens are high-entropy credentials stored as SHA-256 hashes because
the original token never needs recovery. Recoverable platform/API secrets use
Supabase Vault authenticated encryption and a separate `secrets:read` permission.

## Can a normal memory search return a secret?

No. Vault secrets live outside the semantic memory table. Ordinary memory also
rejects high-confidence credential patterns by default. Secret tools are disabled
in MCP unless explicitly enabled for a dedicated trusted process.

## Is this a hosted SaaS?

No. This repository is a self-deployed reference implementation. There is no
Ai-Memory-Free account, hosted control plane, or vendor lock-in beyond the default
Supabase deployment choice.

## Can I self-host Supabase?

The underlying components are open source, but self-hosting changes the operational
and Vault-key-management assumptions. The documented, tested default is a user-owned
hosted Supabase project because it is the simplest no-cost path.

## Is it production ready?

It has scoped credentials, RLS, Vault encryption, rate limits, audit events, tests,
and backup guidance. It does not provide an SLA, managed incident response, or free
managed backups. Production operators remain responsible for capacity, recovery,
compliance, and vendor-plan decisions.

## May I modify or sell software built with it?

Yes. The MIT License permits use, modification, distribution, sublicensing, and
commercial use subject to preserving the license notice. Attribution to
[Kristian Peter](https://kristianpeter.com) is appreciated but no fee is required.
