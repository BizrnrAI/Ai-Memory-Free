export type MemoryKind = 'note' | 'fact' | 'decision' | 'correction' | 'reference' | 'procedure';

export type RememberInput = {
  namespace?: string;
  content: string;
  kind?: MemoryKind;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  supersedes?: string;
  source_system?: string;
  external_id?: string;
};

export type RecallInput = {
  namespace?: string;
  query: string;
  limit?: number;
  pool?: number;
  track?: boolean;
};

export type ContextInput = {
  query: string;
  namespaces?: string[];
  max_chars?: number;
  /** @deprecated Use max_chars. Retained for compatibility with early adapters. */
  max_characters?: number;
  per_namespace_limit?: number;
  include_events?: boolean;
};

export type ListInput = {
  namespace?: string;
  kinds?: MemoryKind[];
  /** Memories carrying any of these tags. */
  tags?: string[];
  /** `importance` (default) puts the most important first; `recent` the most recently updated. */
  order?: 'importance' | 'recent';
  limit?: number;
  offset?: number;
  max_chars?: number;
  include_retired?: boolean;
};

/** What one request can carry. Returned by `health`; use it to size writes. */
export type ServiceLimits = {
  max_content_chars: number;
  max_content_bytes: number | null;
  /** null when the service runs with embeddings off. */
  embed_chars_per_request: number | null;
  embed_chunk_chars: number;
  embed_chunks_per_text: number;
  remember_batch_items: number;
  portable_import_records: number;
  document_chunks: number;
};

export type DocumentIngestResult = {
  ok: boolean;
  created: boolean;
  reactivated: boolean;
  document: Record<string, unknown>;
  chunks_created: number;
  chunks_embedded: number;
  /** Chunks still waiting for a vector. Send the same document again to embed more. */
  chunks_pending: number;
};

export type DocumentListInput = {
  namespace?: string;
  limit?: number;
  offset?: number;
  include_retired?: boolean;
};

export type SecretStoreInput = {
  namespace?: string;
  name: string;
  secret: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export type SecretGetInput = {
  namespace?: string;
  name: string;
};

export type EncryptedSecretMetadata = {
  id: string;
  namespace: string;
  name: string;
  description: string | null;
  version: number;
  metadata: Record<string, unknown>;
  is_active?: boolean;
  access_count?: number;
  last_accessed_at?: string | null;
  created_at: string;
  updated_at?: string;
  retired_at?: string | null;
};

export type DecryptedSecret = EncryptedSecretMetadata & {
  secret: string;
};

export type MemoryRow = {
  id: string;
  namespace: string;
  content: string;
  kind: MemoryKind;
  source: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  base_importance: number;
  access_count: number;
  effective_score: number;
  rrf_norm: number;
  final_score: number;
  created_at: string;
  last_accessed_at: string | null;
  source_system?: string | null;
  external_id?: string | null;
};

export type MemoryClientOptions = {
  apiUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Extra attempts after an HTTP 546. Hosted Supabase answers 546 when the
   * worker serving the request ran out of CPU; the next request gets a fresh
   * worker, so trying again is the documented remedy. Default 2.
   */
  retries?: number;
};

/** A failed request. `error` is the stable code; `body` carries any details the service sent with it. */
export class MemoryRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MemoryRequestError';
  }
}

// Actions that are not safe to send twice: a second copy would add a second
// event (when it has no external_id) or a second secret version.
const NOT_RETRYABLE = new Set(['secret_store']);

export class MemoryClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private limits: ServiceLimits | null | undefined;

  constructor(options: MemoryClientOptions = {}) {
    this.apiUrl = required(options.apiUrl ?? process.env.MEMORY_API_URL, 'MEMORY_API_URL');
    this.token = required(options.token ?? process.env.MEMORY_TOKEN, 'MEMORY_TOKEN');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = Math.max(0, Math.trunc(options.retries ?? 2));
  }

  async health() {
    return await this.request<{
      ok: boolean;
      service: string;
      actions: string[];
      version: string;
      protocol_version: string;
      auth_mode: 'bootstrap' | 'scoped' | 'oauth';
      embedding_model: string;
      embedding_dimensions: number;
      embedding_strategy: string;
      embedding_profile: string;
      /** Absent on services older than 1.4.0. */
      embeddings?: 'on' | 'off';
      limits?: ServiceLimits;
      server_key?: 'secret_keys' | 'service_role' | null;
      modules: Array<{ id: string; version: string; optional: boolean; actions: string[] }>;
    }>({ action: 'health' });
  }

  async whoAmI() {
    return await this.request<{
      ok: boolean;
      client: {
        id: string | null;
        name: string;
        token_prefix: string;
        allowed_namespaces: string[];
        permissions: string[];
        expires_at: string | null;
        auth_mode: 'bootstrap' | 'scoped' | 'oauth';
      };
    }>({ action: 'whoami' });
  }

  async remember(input: RememberInput) {
    return await this.request<{ ok: boolean; memory?: { id: string }; error?: string }>({
      action: 'remember',
      ...input,
    });
  }

  async recall(input: RecallInput) {
    return await this.request<{ ok: boolean; results: MemoryRow[]; error?: string }>({
      action: 'recall',
      ...input,
    });
  }

  /** One page of a namespace in a fixed order. Follow `next_offset` until it is null. */
  async list(input: ListInput = {}) {
    return await this.request<{
      ok: boolean;
      namespace: string;
      order: 'importance' | 'recent';
      memories: MemoryRow[];
      next_offset: number | null;
      budget: { max_chars: number; used_chars: number; truncated: boolean };
    }>({ action: 'list', ...input });
  }

  /** Every memory that matches, read page by page. For a namespace small enough to load whole. */
  async listAll(input: Omit<ListInput, 'offset'> = {}) {
    const memories: MemoryRow[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.list({ limit: 200, max_chars: 100_000, ...input, offset });
      memories.push(...page.memories);
      offset = page.memories.length > 0 ? page.next_offset : null;
    }
    return memories;
  }

  /**
   * Stores any number of memories, split into batches the service can embed in
   * one request each. Use this instead of `rememberBatch` unless you have
   * already sized the batch yourself.
   */
  async rememberMany(items: RememberInput[], namespace?: string) {
    const limits = await this.serviceLimits();
    const results: Array<{ created: boolean; memory: Record<string, unknown> }> = [];
    for (const batch of packByEmbedBudget(items, (item) => item.content, limits, limits?.remember_batch_items ?? 50)) {
      const stored = await this.request<{ ok: boolean; results: typeof results }>({
        action: 'remember_batch',
        namespace,
        items: batch,
      });
      results.push(...stored.results);
    }
    return results;
  }

  /** The service's limits, fetched once. null for a service older than 1.4.0. */
  async serviceLimits(): Promise<ServiceLimits | null> {
    if (this.limits === undefined) this.limits = (await this.health()).limits ?? null;
    return this.limits;
  }

  async rememberBatch(items: RememberInput[]) {
    return await this.call<{ ok: boolean; results: Array<{ created: boolean; memory: { id: string } }> }>(
      'remember_batch', { items },
    );
  }

  async context(input: ContextInput) {
    return await this.call<Record<string, unknown>>('context', input);
  }

  async appendEvent(input: Record<string, unknown>) {
    return await this.call<Record<string, unknown>>('event_append', input);
  }

  async listEvents(namespace?: string, limit?: number) {
    return await this.call<Record<string, unknown>>('event_list', { namespace, limit });
  }

  async upsertSource(input: Record<string, unknown>) {
    return await this.call<Record<string, unknown>>('source_upsert', input);
  }

  async linkSource(input: { source_id: string; memory_id: string; relation?: string }) {
    return await this.call<Record<string, unknown>>('source_link', input);
  }

  async createLink(input: Record<string, unknown>) {
    return await this.call<Record<string, unknown>>('link_create', input);
  }

  async listLinks(namespace?: string, limit?: number) {
    return await this.call<Record<string, unknown>>('link_list', { namespace, limit });
  }

  async resolveLink(linkId: string, note?: string) {
    return await this.call<Record<string, unknown>>('link_resolve', { link_id: linkId, note });
  }

  /**
   * One ingest call. A document longer than one request can embed comes back
   * with `chunks_pending` above 0; its text is already searchable, and sending
   * it again embeds the next chunks. `ingestDocumentFully` does that for you.
   */
  async ingestDocument(input: Record<string, unknown>) {
    return await this.call<DocumentIngestResult>('document_ingest', input);
  }

  /** Ingests a document and repeats the call until every chunk has its vector. */
  async ingestDocumentFully(input: Record<string, unknown>, maxCalls = 80) {
    let result = await this.ingestDocument(input);
    const first = result;
    for (let calls = 1; result.chunks_pending > 0 && calls < maxCalls; calls += 1) {
      const pendingBefore = result.chunks_pending;
      result = await this.ingestDocument(input);
      if (result.chunks_pending >= pendingBefore) break; // no progress: stop rather than loop
    }
    return { ...result, created: first.created, reactivated: first.reactivated, chunks_created: first.chunks_created };
  }

  async searchDocuments(input: Record<string, unknown>) {
    return await this.call<Record<string, unknown>>('document_search', input);
  }

  async listDocuments(input: DocumentListInput = {}) {
    return await this.call<Record<string, unknown>>('document_list', input);
  }

  async retireDocument(id: string, reason?: string) {
    return await this.call<Record<string, unknown>>('document_retire', { id, reason });
  }

  async maintenanceStatus(namespace?: string) {
    return await this.call<Record<string, unknown>>('maintenance_status', { namespace });
  }

  async reindexEmbeddings(namespace?: string, offset?: number, limit?: number) {
    return await this.call<Record<string, unknown>>('embedding_reindex', { namespace, offset, limit });
  }

  /** Embeds document chunks that are still waiting for a vector, until none remain. Needs memory:admin. */
  async embedPendingDocumentChunks(namespace?: string, maxCalls = 200) {
    let processed = 0;
    for (let calls = 0; calls < maxCalls; calls += 1) {
      const step = await this.call<{ processed: number; remaining: number }>('embedding_reindex', {
        namespace, target: 'document_chunks',
      });
      processed += step.processed;
      if (step.remaining === 0 || step.processed === 0) return { processed, remaining: step.remaining };
    }
    return { processed, remaining: -1 };
  }

  async portableExport(input: { namespace: string; resource: string; offset?: number; limit?: number }) {
    return await this.call<{
      ok: boolean; resource: string; next_offset: number | null; records: Record<string, unknown>[];
    }>('portable_export', input);
  }

  async portableImport(input: { namespace: string; resource: string; records: Record<string, unknown>[] }) {
    return await this.call<Record<string, unknown>>('portable_import', input);
  }

  async retire(id: string, reason?: string) {
    return await this.request<{ ok: boolean; id: string; error?: string }>({
      action: 'retire',
      id,
      reason,
    });
  }

  async supersede(oldId: string, newId: string) {
    return await this.request<{ ok: boolean; old_id: string; new_id: string; error?: string }>({
      action: 'supersede',
      old_id: oldId,
      new_id: newId,
    });
  }

  async storeSecret(input: SecretStoreInput) {
    return await this.request<{ ok: boolean; secret: EncryptedSecretMetadata }>({
      action: 'secret_store',
      ...input,
    });
  }

  async getSecret(input: SecretGetInput) {
    return await this.request<{ ok: boolean; secret: DecryptedSecret }>({
      action: 'secret_get',
      ...input,
    });
  }

  async listSecrets(namespace?: string, includeRetired = false) {
    return await this.request<{ ok: boolean; secrets: EncryptedSecretMetadata[] }>({
      action: 'secret_list',
      namespace,
      include_retired: includeRetired,
    });
  }

  async retireSecret(name: string, namespace?: string) {
    return await this.request<{ ok: boolean; namespace: string; name: string }>({
      action: 'secret_retire',
      namespace,
      name,
    });
  }

  async call<T>(action: string, input: Record<string, unknown> = {}): Promise<T> {
    return await this.request<T>({ action, ...input });
  }

  private async request<T>(body: Record<string, unknown>): Promise<T> {
    const action = typeof body.action === 'string' ? body.action : '';
    const retryable = !NOT_RETRYABLE.has(action) && !(action === 'event_append' && !body.external_id);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce<T>(body);
      } catch (error) {
        const outOfCpu = error instanceof MemoryRequestError && error.status === 546;
        if (!outOfCpu || !retryable || attempt >= this.retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  private async requestOnce<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ protocol_version: '1', ...body }),
        signal: controller.signal,
      });

      const text = await response.text();
      let data: unknown = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (!response.ok) throw new MemoryRequestError(`memory request failed: ${response.status}`, response.status);
        throw new Error('memory service returned invalid JSON');
      }
      if (!response.ok) {
        const error = isObject(data) && typeof data.error === 'string'
          ? data.error
          : `memory request failed: ${response.status}`;
        throw new MemoryRequestError(error, response.status, isObject(data) ? data : {});
      }
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Splits items into batches whose embedding cost fits one request. The cost of
 * a text is what the service will actually read of it: its length, capped at
 * the chunks it samples. One item always fits on its own.
 */
export function packByEmbedBudget<T>(
  items: T[],
  textOf: (item: T) => string,
  limits: Pick<ServiceLimits, 'embed_chars_per_request' | 'embed_chunk_chars' | 'embed_chunks_per_text'> | null,
  maxItems: number,
): T[][] {
  // A service older than 1.4.0 reports no limits; assume the hosted default.
  const budget = limits ? limits.embed_chars_per_request : 3_600;
  const perText = limits ? limits.embed_chunks_per_text * limits.embed_chunk_chars : 3_600;
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = budget === null ? 0 : Math.min(textOf(item).trim().length, perText);
    if (current.length > 0 && (current.length >= maxItems || (budget !== null && used + cost > budget))) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
