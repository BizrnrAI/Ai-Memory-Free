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
};

export type RecallInput = {
  namespace?: string;
  query: string;
  limit?: number;
  pool?: number;
  track?: boolean;
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
      auth_mode: 'bootstrap' | 'scoped';
      embedding_model: string;
      embedding_dimensions: number;
      embedding_strategy: string;
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
        auth_mode: 'bootstrap' | 'scoped';
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
        body: JSON.stringify(body),
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
