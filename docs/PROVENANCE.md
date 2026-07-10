# Provenance, Freshness, And Relationships

Sources are first-class records with a namespace, URI, type, optional checksum,
confidence, observation time, validity window, last verification time, and safe
metadata. A source may support, verify, or be the origin of many memories.

Memory relationships are separate evidence edges:

- `supports`
- `contradicts`
- `derived_from`
- `related_to`

Resolving an edge never retires a memory. Memory lifecycle remains exclusively
`is_active` plus `superseded_by`, avoiding the competing-status failure mode.

`context` returns source and relationship evidence alongside ranked memories so
the calling agent can identify stale, weak, or contradictory information. The
memory service does not ask an LLM to resolve a contradiction automatically.
