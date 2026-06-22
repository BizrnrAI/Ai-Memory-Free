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
};

export class MemoryClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemoryClientOptions = {}) {
    this.apiUrl = required(options.apiUrl ?? process.env.MEMORY_API_URL, 'MEMORY_API_URL');
    this.token = required(options.token ?? process.env.MEMORY_TOKEN, 'MEMORY_TOKEN');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health() {
    return await this.request<{ ok: boolean; service: string; actions: string[] }>({ action: 'health' });
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

  private async request<T>(body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : `memory request failed: ${response.status}`);
    }
    return data as T;
  }
}

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
