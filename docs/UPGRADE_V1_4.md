# Upgrade From v1.3 To v1.4

v1.4 keeps protocol v1. Existing tokens, memories, vectors and Vault secrets are
untouched; nothing needs re-embedding.

## Steps

1. Apply the migration **first**. The v1.4 function relies on it.

   ```bash
   supabase migration up --linked
   ```

   `0013` recreates `recall` and replaces `recall_document_chunks`. It is safe to
   apply more than once. If your deployment added its own migrations numbered
   `0009`–`0012`, keep them: those numbers are intentionally unused upstream.

2. Deploy the functions.

   ```bash
   supabase functions deploy memory --no-verify-jwt
   supabase functions deploy mcp --no-verify-jwt   # only if you use remote MCP
   ```

3. Check `health`. It should report `"version": "1.4.0"`, a `limits` object, and
   `"server_key"`. Then run the write-and-recall smoke test in
   [OPERATIONS.md](OPERATIONS.md#smoke-test-the-effect).

4. If you plan to disable Supabase's legacy API keys, confirm `server_key` is
   `secret_keys` first ([OPERATIONS.md](OPERATIONS.md#supabase-api-keys)).

## What Callers Will Notice

- **A reused `source_system` + `external_id` with different content is now a
  409** (`external_id_content_conflict`). It used to return the old row and drop
  the new content. Callers that update by re-sending under the same key must
  write a new memory and `supersede` the old one.
- **An unknown `kind` is now a 400** (`invalid_kind`). It used to become a `note`.
- **`remember_batch` and `portable_import` can answer 413**
  (`embedding_budget_exceeded`, with `embed_cost` and `max_embed_cost`) when a
  batch is too large to embed in one request. Short items count too: about
  seven one-line memories fit. On hosted Supabase those batches already failed, with an HTTP 546 and
  no explanation. Split the batch, or use the client's `rememberMany` and
  `npm run portable`, which size their requests from `health`.
- **Batch items without a `namespace` go to the batch's `namespace`**, not
  `default`.
- **A long memory's vector covers a sample of it**, and `remember` says so with
  `vector:"sampled"`. The whole text is still stored and keyword-searchable.
- **`document_ingest` may return `chunks_pending` above 0.** The document is
  searchable; send it again, or use `ingestDocumentFully`, to finish its vectors.
- **Recall returns different, better-ranked results** for questions, and each row
  carries `source_system` and `external_id`.

## Optional Settings

See [OPERATIONS.md](OPERATIONS.md#settings): the embedding budget, keyword-only
mode, and a cap on memory size.

## Rolling Back

Redeploy the v1.3 function. Migration `0013` can stay: the v1.3 function works
with the new `recall` and ignores the extra columns.
