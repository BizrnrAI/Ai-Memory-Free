# Retrieval

How Ai-Memory-Free finds a memory, what that was measured against, and how to
choose between its modes. Measurements are from 2026-10.

## Two Ways To Read

- **`list`** returns a namespace in a fixed order, a page at a time. Nothing is
  ranked, so nothing can be missed. Use it when the namespace fits in your
  model's context — `maintenance_status` gives the counts — and at the start of
  a session, when you need every standing decision and procedure rather than
  the few most similar to a prompt.
- **`recall`** ranks. Use it to find one thing in a namespace too large to read,
  or to check whether something is already known before writing it.

## How Recall Ranks

`recall` builds three ranked lists and fuses them with Reciprocal Rank Fusion:

1. **Nearest vectors.** The query and every memory are embedded with `gte-small`
   (384 dimensions). Finds memories that mean the same thing in different words.
2. **Full-text, every word.** Memories containing all of the query's words.
   Precise for identifiers, error codes and names.
3. **Full-text, any word.** Memories sharing at least one word with the query,
   best match first. This is the list that answers a question written in the
   asker's own words, where list 2 is almost always empty.

The fused rank is then blended with a small, transparent score from the memory's
importance, use and age (see [ARCHITECTURE.md](ARCHITECTURE.md#retrieval)).

## What Was Measured

**Corpus:** 227 memories from one real software project — its live memory
records plus its decision log, architecture notes and planning document cut into
record-sized pieces (median 764 characters). One project means every record is
about the same subject, which is the hard case for retrieval.

**Queries:** 36, each with the records that answer it identified in advance. 20
are questions in plain language that avoid the record's own wording; 16 are
keyword or identifier lookups.

**Result:** position of the first correct record.

| Method | First result correct | In the top 5 | Not in the top 20 |
| --- | --- | --- | --- |
| Embeddings only | 14 of 36 | 28 | 3 |
| Full-text, every word, only | 14 of 36 | 15 | 21 |
| v1.3 recall: embeddings + every-word | 23 of 36 | 34 | 1 |
| Keyword-only mode: every-word + any-word, no embeddings | 24 of 36 | 30 | 3 |
| **v1.4 recall: all three lists** | **28 of 36** | **35** | **1** |

Split by kind of query, first result correct:

| Method | 20 questions | 16 lookups |
| --- | --- | --- |
| Embeddings only | 7 | 7 |
| Full-text, every word, only | 2 | 12 |
| v1.3 recall | 8 | 15 |
| Keyword-only mode | 10 | 14 |
| v1.4 recall | 13 | 15 |

What this shows:

- **Embeddings alone are the weakest single method.** They missed identifiers
  outright and ranked the right record first for a third of questions.
- **Every-word full-text is excellent for lookups and useless for questions**: it
  found nothing for 17 of the 20. So v1.3 recall was, for questions, embeddings
  alone.
- **Any-word full-text does most of the work** and costs nothing to run.
- **All three together are best**, and the embeddings still earn their place:
  they lift "in the top 5" from 30 to 35.

Limits of the test: one project, 36 queries, English. It is enough to choose
between methods that differ this much, not to tune weights. Run your own with
`npm run eval` and a fixture file built from your data before changing ranking,
chunking or the embedding model.

## The Embedding Budget

Embeddings are the only part of the service that can fail under load, and the
reason is CPU. The built-in model runs inside the Edge Function worker, and
hosted Supabase ends a worker that uses about 2 seconds of CPU; the caller gets
HTTP 546. A worker serves several requests and stops taking new ones at a lower
soft limit, so a request can arrive with only part of the 2 seconds left.

Measured against a hosted project, full 1,800-character chunks embedded in one
request, repeated back to back:

| Chunks in one request | Failed |
| --- | --- |
| 1 | 0 of 12 |
| 2 | 0 of 12 |
| 3 | 1 of 14 |
| 4 | 2 of 14 |
| 5 | 2 of 14 |
| 7 | every time |

So one request embeds at most two chunks — 3,600 characters — by default
(`MEMORY_EMBED_CHARS_PER_REQUEST`).

Length is not the whole cost. Every run of the model has a fixed price before it
reads a word, so many short texts cost far more than one long one: in a local
run, a batch of thirty 40-character memories killed the worker at the
twenty-fourth. The budget therefore charges each chunk its characters plus a
fixed 600, and a request may spend 4,800 — two full chunks. That is about seven
one-line memories, or three of typical length, per request.

What follows from that:

- A memory of any allowed length is **stored and keyword-searchable**. Its
  vector is not unlimited: a long memory is represented by two evenly spaced
  1,800-character windows, and `remember` says so (`vector:"sampled"`). If
  every part of a long text must be findable by meaning, store it as several
  memories or as a document, whose chunks each get their own vector.
- A memory that is already stored is recognised before anything is embedded, so
  retries are free.
- A batch or an import page that would embed more than the budget is refused
  before anything is written, with the sizes, so the caller can split it.
- A document is embedded in steps (see [DOCUMENTS.md](DOCUMENTS.md)).
- An occasional 546 is still possible under concurrency. It is safe to retry,
  and the bundled client does.

The built-in model itself has not changed: `gte-small`, English, 512 tokens per
inference, and no larger built-in model is offered. The size of memory it can
take is set by this CPU limit, not by the vector index.

## Choosing A Mode

| Situation | Setting |
| --- | --- |
| Hosted Supabase, the default | Leave everything as it is |
| 546 errors are frequent, or reliability matters more than the last few matches | `MEMORY_EMBEDDINGS=off` (keyword-only) |
| Self-hosted runtime without the CPU limit | Raise `MEMORY_EMBED_CHARS_PER_REQUEST`, up to `14400` for an eight-chunk average |
| Memories are not in English | Keyword-only is not enough either: Postgres full-text here is configured for English, and so is `gte-small`. Plan a different embedding profile |

Switching embeddings off and on again is safe. Memories written while they were
off have no vector and are found by full-text only. After switching back on, an
administrator runs `embedding_reindex` with `target:"missing"` until `remaining`
is 0; `maintenance_status` reports how many are waiting as
`memories_without_vector`.

## Writing Memories That Can Be Found

Ranking can only work with what was written.

- **One fact, decision or procedure per memory, and say what it is about.** A
  record that names the thing — the function, the page, the vendor, the error
  code — is found by the words someone will search with.
- **Keep it short enough to read whole.** Most useful memories are under 2,000
  characters. Longer material is a document, not a memory.
- **Use `kind`.** `decision`, `procedure` and `correction` are what an agent
  wants at the start of work; `list` can return exactly those.
- **Put activity in events.** "X was deployed", "Y was measured" belong in
  `event_append`. Stored as memories they crowd out the standing knowledge.
- **Correct by superseding.** Write the new memory and `supersede` the old one,
  so recall never returns both.

## Considered And Not Adopted

- **A stronger embedding model.** `gte-small` scores 49.5 on the MTEB retrieval
  benchmark; the best models its size score about 52 (`bge-small-en-v1.5` 51.7,
  `snowflake-arctic-embed-s` 52.0), and hosted APIs score higher. None runs
  inside the Edge runtime, so each needs an API key, a network call per write and
  per query, and a cost. The gain available from fixing full-text was larger and
  free. The `EmbeddingAdapter` profile mechanism is there for a deployment that
  wants one.
- **A reranking model.** Published results show reranking helps; it is also a
  model call per query. The caller's own model is the reranker here: ask for more
  results (`limit` up to 50) and let it choose.
- **BM25 through an extension.** A variant that weighted rare words more scored
  the same as plain `ts_rank` on this test (23 against 23 first results when
  fused with embeddings), so the built-in ranking stays.
- **No retrieval at all.** For a small namespace this is the right answer, and
  `list` is how to do it.

## Sources

- [Anthropic: Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) —
  embeddings plus lexical search beat embeddings alone; a knowledge base under
  200,000 tokens can simply be included whole
- [Letta: Benchmarking AI Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory) —
  agents with plain files scored above a specialised memory tool
- [gte-small model card](https://huggingface.co/thenlper/gte-small) — sizes,
  limits and benchmark scores
- [Supabase: Edge Function limits](https://supabase.com/docs/guides/functions/limits) and
  [CPU limits](https://supabase.com/docs/guides/troubleshooting/edge-function-cpu-limits)
- [Supabase: AI models in Edge Functions](https://supabase.com/docs/guides/functions/ai-models)
