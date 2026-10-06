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
};

export type MemoryClientOptions = {
  apiUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class MemoryClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MemoryClientOptions = {}) {
    this.apiUrl = required(options.apiUrl ?? process.env.MEMORY_API_URL, 'MEMORY_API_URL');
    this.token = required(options.token ?? process.env.MEMORY_TOKEN, 'MEMORY_TOKEN');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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

  async ingestDocument(input: Record<string, unknown>) {
    return await this.call<Record<string, unknown>>('document_ingest', input);
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
        if (!response.ok) throw new Error(`memory request failed: ${response.status}`);
        throw new Error('memory service returned invalid JSON');
      }
      if (!response.ok) {
        const error = isObject(data) && typeof data.error === 'string'
          ? data.error
          : `memory request failed: ${response.status}`;
        throw new Error(error);
      }
      return data as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
