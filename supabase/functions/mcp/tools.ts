export const tools = [
  tool('memory_health', 'Service version, modules, capabilities, and embedding profile.', objectSchema()),
  tool('memory_whoami', 'Authenticated identity, permissions, and namespace grants.', objectSchema()),
  tool('memory_remember', 'Store durable semantic memory.', objectSchema(['content'], {
    content: stringSchema(), namespace: stringSchema(), kind: stringSchema(), importance: numberSchema(),
    source: stringSchema(), tags: arraySchema(stringSchema()), metadata: { type: 'object' },
    source_system: stringSchema(), external_id: stringSchema(), supersedes: stringSchema(),
  })),
  tool('memory_remember_batch', 'Store up to 50 idempotent memories.', objectSchema(['items'], {
    namespace: stringSchema(), items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object' } },
  })),
  tool('memory_recall', 'Recall ranked evidence from one namespace.', objectSchema(['query'], {
    query: stringSchema(), namespace: stringSchema(), limit: numberSchema(), pool: numberSchema(), track: booleanSchema(),
  })),
  tool('memory_list', 'Read a namespace in a fixed order, a page at a time; follow next_offset until it is null.', objectSchema([], {
    namespace: stringSchema(), kinds: arraySchema(stringSchema()), tags: arraySchema(stringSchema()), order: stringSchema(),
    limit: numberSchema(), offset: numberSchema(), max_chars: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_context', 'Build a deterministic, budgeted context bundle across authorized namespaces.', objectSchema(['query'], {
    query: stringSchema(), namespaces: arraySchema(stringSchema()), max_chars: numberSchema(),
    max_characters: numberSchema(),
    per_namespace_limit: numberSchema(), include_events: booleanSchema(),
  })),
  tool('memory_event_append', 'Append a durable agent/tool activity event without chain-of-thought.', objectSchema(['event_type', 'summary'], {
    namespace: stringSchema(), event_type: stringSchema(), summary: stringSchema(), agent_id: stringSchema(),
    session_id: stringSchema(), tool_name: stringSchema(), source_system: stringSchema(), external_id: stringSchema(),
    payload: { type: 'object' }, occurred_at: stringSchema(),
  })),
  tool('memory_event_list', 'List recent activity events.', objectSchema([], { namespace: stringSchema(), limit: numberSchema() })),
  tool('memory_source_upsert', 'Register or refresh provenance and freshness metadata.', objectSchema(['uri'], {
    namespace: stringSchema(), uri: stringSchema(), source_type: stringSchema(), title: stringSchema(),
    checksum: stringSchema(), confidence: numberSchema(), observed_at: stringSchema(), valid_from: stringSchema(),
    valid_until: stringSchema(), last_verified_at: stringSchema(), metadata: { type: 'object' },
  })),
  tool('memory_source_link', 'Link a registered source to a memory.', objectSchema(['source_id', 'memory_id'], {
    source_id: stringSchema(), memory_id: stringSchema(), relation: stringSchema(),
  })),
  tool('memory_link_create', 'Create supports/contradicts/derived-from/related evidence links.', objectSchema(['source_id', 'memory_id'], {
    source_id: stringSchema(), memory_id: stringSchema(), relation: stringSchema(), note: stringSchema(),
  })),
  tool('memory_link_list', 'List evidence and contradiction links.', objectSchema([], {
    namespace: stringSchema(), limit: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_link_resolve', 'Resolve a relationship without changing memory lifecycle.', objectSchema(['link_id'], {
    link_id: stringSchema(), note: stringSchema(),
  })),
  tool('memory_document_ingest', 'Ingest a bounded text document into an optional chunk index. To replace an earlier version, pass supersedes (its id) or replace_same_title.', objectSchema(['title', 'content'], {
    namespace: stringSchema(), title: stringSchema(), content: stringSchema(), source_uri: stringSchema(),
    media_type: stringSchema(), metadata: { type: 'object' }, supersedes: stringSchema(), replace_same_title: booleanSchema(),
  })),
  tool('memory_document_search', 'Search document chunks with hybrid retrieval.', objectSchema(['query'], {
    namespace: stringSchema(), query: stringSchema(), limit: numberSchema(), pool: numberSchema(),
  })),
  tool('memory_document_list', 'Page through documents in the optional document/chunk module.', objectSchema([], {
    namespace: stringSchema(), limit: numberSchema(), offset: numberSchema(), include_retired: booleanSchema(),
  })),
  tool('memory_document_retire', 'Retire a document so its chunks no longer participate in search.', objectSchema(['id'], {
    id: stringSchema(), reason: stringSchema(),
  })),
  tool('memory_maintenance_status', 'Show namespace capacity and module health without returning content.', objectSchema([], {
    namespace: stringSchema(),
  })),
] as const;

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema };
}

function objectSchema(required: string[] = [], properties: Record<string, unknown> = {}) {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}
function stringSchema() { return { type: 'string' }; }
function numberSchema() { return { type: 'number' }; }
function booleanSchema() { return { type: 'boolean' }; }
function arraySchema(items: unknown) { return { type: 'array', items }; }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
