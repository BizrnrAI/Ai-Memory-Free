# Protocol v1

Every HTTPS request is a JSON object with an `action`. v1.2 clients also send
`"protocol_version":"1"`; omitted versions retain v0.2 compatibility. Responses
are ordinary JSON and never contain model-specific prompt instructions.

Discover the live contract with `health`. It returns release version, protocol,
portable format, embedding profile, modules, and actions. The canonical request,
module, and portable header schemas are in `schemas/`.

## Core Extension Rules

- Add optional actions without changing existing action meanings.
- Fail closed on an explicit unknown protocol version.
- Keep one permission and namespace check before every resource access.
- Bound request sizes, lists, batches, context characters, and document chunks.
- Return stable public error codes rather than database messages.
- Never implement different ranking behavior in an adapter.

## Idempotent Ingestion

`remember` and each `remember_batch` item may include `source_system` and
`external_id`. Both must be supplied together. The pair is unique inside a
namespace, so callers can retry after a timeout without creating duplicate truth.

## Context Bundles

`context` accepts one to eight explicit namespaces, a query, per-namespace limit,
and character budget. The token must hold `memory:read` for every requested
namespace. Results are merged deterministically by the existing final score and
then truncated to the character budget. Wildcards are never inferred.
