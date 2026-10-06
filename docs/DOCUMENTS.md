# Optional Document Memory

Documents use separate `memory_documents` and `memory_document_chunks` tables so
large source material does not dilute curated memory. Raw text remains intact;
bounded overlapping chunks receive the free default embedding and full-text index.

Supported local ingestion formats are `.txt`, Markdown, JSON, CSV, TSV, and YAML:

```bash
MEMORY_API_URL="$MEMORY_API_URL" MEMORY_TOKEN="$MEMORY_TOKEN" \
npm run document:ingest -- --file ./RUNBOOK.md --namespace platform
```

The local ingester accepts regular UTF-8 text files up to 100,000 bytes. It does
not execute content, fetch URLs, unpack archives, or accept binaries. Convert PDF,
office, image, or audio files to reviewed text with a tool you trust before
ingestion.

A document usually holds more text than one request can embed (see
[ACTIONS.md](ACTIONS.md#limits)). Ingestion therefore writes every chunk first —
full-text search finds it immediately — and embeds the chunks in steps. The
ingester repeats the call until none is pending; a direct API caller sends the
same `document_ingest` again until `chunks_pending` is 0, or an administrator
runs `embedding_reindex` with `target:"document_chunks"`.

`document_search` uses its own hybrid chunk RPC. Document results never replace or
silently enter core memory; an agent may store a durable conclusion separately and
link it to a registered source.

A corrected document replaces its predecessor in the same call: pass
`replace_same_title: true` (retire every other active document with that
title) or `supersedes: <document id>`. Without either, the earlier version stays
active and the two compete in search; `document_retire` stands one down
afterwards. Retirement is soft: the document remains
portable and auditable, while its chunks immediately stop participating in search.
Use `document_list` with `limit` and `offset` until `next_offset` is `null` to
reconcile the full active corpus without direct database credentials.

Ingest writes all text chunks before retiring a predecessor. Retrying also fills
any missing chunks, and concurrent identical ingests do not delete each other’s
rows or overwrite completed vectors. Embedding can continue after retirement
because the replacement is already searchable by full text.
