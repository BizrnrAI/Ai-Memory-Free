import { createClient } from '@supabase/supabase-js';

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run: (input: string, options: { mean_pool: boolean; normalize: boolean }) => Promise<number[]>;
    };
  };
};

type MemoryKind = 'note' | 'fact' | 'decision' | 'correction' | 'reference' | 'procedure';

type RememberInput = {
  action: 'remember';
  namespace?: string;
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  supersedes?: string;
};

type RecallInput = {
  action: 'recall';
  namespace?: string;
  query?: string;
  limit?: number;
  pool?: number;
  track?: boolean;
};

type RetireInput = {
  action: 'retire';
  id?: string;
  reason?: string;
};

type SupersedeInput = {
  action: 'supersede';
  old_id?: string;
  new_id?: string;
};

type HealthInput = {
  action?: 'health';
};

type RequestBody = RememberInput | RecallInput | RetireInput | SupersedeInput | HealthInput;

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const memoryToken = Deno.env.get('MEMORY_TOKEN');

const db = createClient(supabaseUrl ?? '', serviceRoleKey ?? '', {
  auth: { persistSession: false },
});

const model = new Supabase.ai.Session('gte-small');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (!supabaseUrl || !serviceRoleKey || !memoryToken) {
    return json({ ok: false, error: 'server_not_configured' }, 500);
  }

  const auth = req.headers.get('authorization') ?? '';
  if (!(await authorized(auth, memoryToken))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  try {
    switch (body.action ?? 'health') {
      case 'health':
        return handleHealth();
      case 'remember':
        return await handleRemember(body as RememberInput);
      case 'recall':
        return await handleRecall(body as RecallInput);
      case 'retire':
        return await handleRetire(body as RetireInput);
      case 'supersede':
        return await handleSupersede(body as SupersedeInput);
      default:
        return json({ ok: false, error: 'unknown_action' }, 400);
    }
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

function handleHealth() {
  return json({
    ok: true,
    service: 'ai-memory-free',
    embedding_model: 'gte-small',
    embedding_dimensions: 384,
    actions: ['health', 'remember', 'recall', 'retire', 'supersede'],
  });
}

async function handleRemember(input: RememberInput) {
  const content = requiredString(input.content, 'content', 1, 100_000);
  const namespace = cleanNamespace(input.namespace);
  const kind = cleanKind(input.kind);
  const importance = clampNumber(input.importance ?? 0.5, 0, 1);
  const tags = Array.isArray(input.tags) ? input.tags.map(cleanTag).filter(Boolean) : [];
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const embedding = await embed(content);

  const { data, error } = await db.from('memories').upsert({
    namespace,
    content,
    kind,
    importance,
    base_importance: importance,
    source: trimOptional(input.source, 2048),
    tags,
    metadata,
    embedding,
  }, {
    onConflict: 'namespace,content_hash',
  }).select('id, namespace, content_hash, created_at, updated_at').single();

  if (error) return json({ ok: false, error: error.message }, 500);

  if (input.supersedes && data?.id) {
    const supersede = await db.rpc('supersede_memory', {
      old_id: input.supersedes,
      new_id: data.id,
    });
    if (supersede.error) {
      return json({ ok: false, id: data.id, error: supersede.error.message }, 500);
    }
  }

  return json({ ok: true, memory: data });
}

async function handleRecall(input: RecallInput) {
  const query = requiredString(input.query, 'query', 1, 20_000);
  const namespace = cleanNamespace(input.namespace);
  const limit = Math.trunc(clampNumber(input.limit ?? 8, 1, 50));
  const pool = Math.trunc(clampNumber(input.pool ?? 200, 10, 1000));
  const embedding = await embed(query);

  const { data, error } = await db.rpc('recall', {
    query_embedding: embedding,
    query_text: query,
    match_limit: limit,
    pool,
    memory_namespace: namespace,
  });

  if (error) return json({ ok: false, error: error.message }, 500);

  if (input.track !== false && data?.length) {
    const ids = data.map((row: { id: string }) => row.id);
    const bump = await db.rpc('bump_access', { ids });
    if (bump.error) return json({ ok: false, error: bump.error.message }, 500);
  }

  return json({ ok: true, results: data ?? [] });
}

async function handleRetire(input: RetireInput) {
  const id = requiredString(input.id, 'id', 1, 128);
  const reason = trimOptional(input.reason, 2048) ?? 'not specified';
  const { error } = await db.rpc('retire_memory', { memory_id: id, reason });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, id });
}

async function handleSupersede(input: SupersedeInput) {
  const oldId = requiredString(input.old_id, 'old_id', 1, 128);
  const newId = requiredString(input.new_id, 'new_id', 1, 128);
  const { error } = await db.rpc('supersede_memory', { old_id: oldId, new_id: newId });
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, old_id: oldId, new_id: newId });
}

async function embed(text: string) {
  return await model.run(text, { mean_pool: true, normalize: true });
}

async function authorized(header: string, token: string) {
  if (!header.startsWith('Bearer ')) return false;
  const supplied = header.slice('Bearer '.length);
  const [a, b] = await Promise.all([sha256(supplied), sha256(token)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function cleanNamespace(value: unknown) {
  const namespace = typeof value === 'string' && value.trim() ? value.trim() : 'default';
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(namespace)) {
    throw new Error('namespace must be 1-128 chars: letters, numbers, underscore, dot, colon, or dash');
  }
  return namespace;
}

function cleanKind(value: unknown): MemoryKind {
  const allowed = new Set(['note', 'fact', 'decision', 'correction', 'reference', 'procedure']);
  if (typeof value === 'string' && allowed.has(value)) return value as MemoryKind;
  return 'note';
}

function cleanTag(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 64);
}

function trimOptional(value: unknown, max: number) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function requiredString(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw new Error(`${field} is required`);
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} chars`);
  return trimmed;
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
