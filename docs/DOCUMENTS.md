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

`document_search` uses its own hybrid chunk RPC. Document results never replace or
silently enter core memory; an agent may store a durable conclusion separately and
link it to a registered source.
