# Portable Export And Import

The portable format is newline-delimited JSON with a checksummed header. It moves
durable user data between Ai-Memory-Free installations without copying provider
credentials or vector representations.

## Export

```bash
MEMORY_API_URL="https://PROJECT.supabase.co/functions/v1/memory" \
MEMORY_TOKEN="<from-client-secret-store>" \
npm run portable -- export --namespace my-project --output ./memory.ndjson
```

The first command is a dry run. Add `--write` to create a new file; existing files
are never overwritten.

## Import

```bash
MEMORY_API_URL="https://NEW_PROJECT.supabase.co/functions/v1/memory" \
MEMORY_TOKEN="<from-client-secret-store>" \
npm run portable -- import --namespace my-project --input ./memory.ndjson
```

Import validates format, namespace, record types, and SHA-256 payload checksum
without writing. Add `--write` after review. Records are imported in dependency
order, in batches sized from the destination's `health` limits so each request
stays inside its embedding budget (twenty records at most). IDs are retained where relationships require them;
duplicates are skipped safely.

## Included

- memories and lifecycle supersessions/retirements
- events
- sources and source-to-memory links
- evidence/contradiction links
- documents (chunks and embeddings are regenerated)

## Deliberately Excluded

- plaintext secrets and Vault ciphertext
- caller tokens and OAuth grants
- embeddings
- audit events and rate-limit buckets

Re-provision callers and Vault secrets in the destination. Encrypt the portable
file at rest because memory content may still be sensitive. A PostgreSQL backup is
still required for exact disaster recovery; portable export is the upgrade and
provider-mobility format.
