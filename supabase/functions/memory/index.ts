import { createClient } from '@supabase/supabase-js';
import {
  averageNormalizedEmbeddings,
  bearerToken,
  chunkEmbeddingText,
  containsLikelySecret,
  hasPermission,
  namespaceAllowed,
  readJsonBody,
  RequestInputError,
  sha256Hex,
  timingSafeEqualHex,
  type Permission,
} from './lib.ts';

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run: (input: string, options: { mean_pool: boolean; normalize: boolean }) => Promise<number[]>;
    };
  };
};

type MemoryKind = 'note' | 'fact' | 'decision' | 'correction' | 'reference' | 'procedure';

type RequestBody = {
  action?: string;
  namespace?: string;
  content?: string;
  query?: string;
  kind?: MemoryKind;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  supersedes?: string;
  limit?: number;
  pool?: number;
  track?: boolean;
  id?: string;
  reason?: string;
  old_id?: string;
  new_id?: string;
  name?: string;
  description?: string;
  secret?: string;
  include_retired?: boolean;
};

type Caller = {
  id: string | null;
  name: string;
  tokenPrefix: string;
  allowedNamespaces: string[];
  permissions: string[];
  expiresAt: string | null;
  authMode: 'bootstrap' | 'scoped';
};

type RequestContext = {
  request: Request;
  requestId: string;
  caller: Caller;
};

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const bootstrapToken = Deno.env.get('MEMORY_TOKEN');
const rejectLikelySecrets = Deno.env.get('MEMORY_REJECT_LIKELY_SECRETS') !== 'false';
const auditReads = Deno.env.get('MEMORY_AUDIT_READS') === 'true';
const allowedOrigins = (Deno.env.get('MEMORY_ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const db = createClient(supabaseUrl ?? '', serviceRoleKey ?? '', {
  auth: { persistSession: false },
});
const model = new Supabase.ai.Session('gte-small');

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    if (!originAllowed(request)) return json({ ok: false, error: 'origin_not_allowed' }, 403, request);
    return new Response(null, { status: 204, headers: responseHeaders(request) });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, request);
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: 'server_not_configured' }, 500, request);
  }
  if (!originAllowed(request)) {
    return json({ ok: false, error: 'origin_not_allowed' }, 403, request);
  }

  const caller = await authenticate(request.headers.get('authorization'));
  if (!caller) return json({ ok: false, error: 'unauthorized' }, 401, request);

  const context: RequestContext = { request, requestId: crypto.randomUUID(), caller };
  let body: RequestBody;
  try {
    body = await readJsonBody<RequestBody>(request);
  } catch (error) {
    if (error instanceof RequestInputError) {
      return json({ ok: false, error: error.code }, error.status, request);
    }
    return json({ ok: false, error: 'invalid_request' }, 400, request);
  }

  const action = body.action ?? 'health';
  if (typeof action !== 'string' || action.length < 1 || action.length > 64) {
    return json({ ok: false, error: 'invalid_action' }, 400, request);
  }

  try {
    await enforceRateLimit(context, action);
    switch (action) {
      case 'health':
        return handleHealth(context);
      case 'whoami':
        return handleWhoAmI(context);
      case 'remember':
        return await handleRemember(context, body);
      case 'recall':
        return await handleRecall(context, body);
      case 'retire':
        return await handleRetire(context, body);
      case 'supersede':
        return await handleSupersede(context, body);
      case 'secret_store':
        return await handleSecretStore(context, body);
      case 'secret_get':
        return await handleSecretGet(context, body);
      case 'secret_list':
        return await handleSecretList(context, body);
      case 'secret_retire':
        return await handleSecretRetire(context, body);
      default:
        throw new ApiError('unknown_action', 400);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      await audit(context, action, body.namespace, undefined, false, { error: error.code });
      return json({ ok: false, error: error.code }, error.status, request);
    }
    console.error('[ai-memory-free] request failed', {
      request_id: context.requestId,
      action,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await audit(context, action, body.namespace, undefined, false, { error: 'internal_error' });
    return json({ ok: false, error: 'internal_error', request_id: context.requestId }, 500, request);
  }
});

function handleHealth(context: RequestContext) {
  return json({
    ok: true,
    service: 'ai-memory-free',
    embedding_model: 'gte-small',
    embedding_dimensions: 384,
    embedding_strategy: 'bounded-chunk-average',
    auth_mode: context.caller.authMode,
    actions: [
      'health', 'whoami', 'remember', 'recall', 'retire', 'supersede',
      'secret_store', 'secret_get', 'secret_list', 'secret_retire',
    ],
  }, 200, context.request);
}

function handleWhoAmI(context: RequestContext) {
  return json({
    ok: true,
    client: {
      id: context.caller.id,
      name: context.caller.name,
      token_prefix: context.caller.tokenPrefix,
      allowed_namespaces: context.caller.allowedNamespaces,
      permissions: context.caller.permissions,
      expires_at: context.caller.expiresAt,
      auth_mode: context.caller.authMode,
    },
  }, 200, context.request);
}

async function handleRemember(context: RequestContext, input: RequestBody) {
  const content = requiredString(input.content, 'content', 1, 100_000);
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:write', namespace);

  const importance = clampNumber(input.importance ?? 0.5, 0, 1);
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map(cleanTag).filter(Boolean))].slice(0, 64) : [];
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const source = trimOptional(input.source, 2048);
  assertNoSecretMaterial({ content, source, tags, metadata });
  const embedding = await embed(content);
  const contentHash = await sha256Hex(content);
  const payload = {
    namespace,
    content,
    kind: cleanKind(input.kind),
    importance,
    base_importance: importance,
    source,
    tags,
    metadata,
    embedding,
  };

  let created = true;
  let { data, error } = await db.from('memories')
    .insert(payload)
    .select('id, namespace, content_hash, created_at, updated_at')
    .single();

  if (error?.code === '23505') {
    created = false;
    const existing = await db.from('memories')
      .select('id, namespace, content_hash, created_at, updated_at')
      .eq('namespace', namespace)
      .eq('content_hash', contentHash)
      .single();
    data = existing.data;
    error = existing.error;
  }
  if (error || !data) throw new ApiError('memory_write_failed', 500);

  if (input.supersedes) {
    const oldId = requiredUuid(input.supersedes, 'supersedes');
    await requireMemoryPair(context.caller, oldId, data.id);
    const supersede = await db.rpc('supersede_memory', { old_id: oldId, new_id: data.id });
    if (supersede.error) throw new ApiError('memory_supersede_failed', 409);
  }

  await audit(context, 'remember', namespace, data.id, true, { created, kind: payload.kind });
  return json({ ok: true, created, memory: data }, 200, context.request);
}

async function handleRecall(context: RequestContext, input: RequestBody) {
  const query = requiredString(input.query, 'query', 1, 20_000);
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
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
  if (error) throw new ApiError('memory_recall_failed', 500);

  if (input.track !== false && data?.length) {
    const ids = data.map((row: { id: string }) => row.id);
    const bump = await db.rpc('bump_access', { ids });
    if (bump.error) throw new ApiError('memory_tracking_failed', 500);
  }
  if (auditReads) await audit(context, 'recall', namespace, undefined, true, { result_count: data?.length ?? 0 });
  return json({ ok: true, results: data ?? [] }, 200, context.request);
}

async function handleRetire(context: RequestContext, input: RequestBody) {
  const id = requiredUuid(input.id, 'id');
  const row = await requireMemory(context.caller, id, 'memory:write');
  const reason = trimOptional(input.reason, 2048) ?? 'not specified';
  const { error } = await db.rpc('retire_memory', { memory_id: id, reason });
  if (error) throw new ApiError('memory_retire_failed', 500);
  await audit(context, 'retire', row.namespace, id, true, { reason_provided: Boolean(input.reason) });
  return json({ ok: true, id }, 200, context.request);
}

async function handleSupersede(context: RequestContext, input: RequestBody) {
  const oldId = requiredUuid(input.old_id, 'old_id');
  const newId = requiredUuid(input.new_id, 'new_id');
  const namespace = await requireMemoryPair(context.caller, oldId, newId);
  requireAccess(context.caller, 'memory:write', namespace);
  const { error } = await db.rpc('supersede_memory', { old_id: oldId, new_id: newId });
  if (error) throw new ApiError('memory_supersede_failed', 409);
  await audit(context, 'supersede', namespace, oldId, true, { replacement_id: newId });
  return json({ ok: true, old_id: oldId, new_id: newId }, 200, context.request);
}

async function handleSecretStore(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  const name = cleanIdentifier(input.name, 'name');
  const secret = requiredString(input.secret, 'secret', 1, 16_384, false);
  requireAccess(context.caller, 'secrets:write', namespace);
  const description = trimOptional(input.description, 2048) ?? '';
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  assertNoSecretMaterial({ description, metadata });

  const { data, error } = await db.rpc('store_encrypted_secret', {
    p_namespace: namespace,
    p_name: name,
    p_description: description,
    p_secret: secret,
    p_metadata: metadata,
    p_client_id: context.caller.id,
    p_request_id: context.requestId,
  });
  if (error || !data?.[0]) throw new ApiError('secret_store_failed', 500);

  const stored = data[0];
  return json({ ok: true, secret: stored }, 200, context.request);
}

async function handleSecretGet(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  const name = cleanIdentifier(input.name, 'name');
  requireAccess(context.caller, 'secrets:read', namespace);

  const { data, error } = await db.rpc('get_encrypted_secret', {
    p_namespace: namespace,
    p_name: name,
    p_client_id: context.caller.id,
    p_request_id: context.requestId,
  });
  if (error || !data?.[0]) throw new ApiError('secret_not_found', 404);

  const decrypted = data[0];
  return json({ ok: true, secret: decrypted }, 200, context.request);
}

async function handleSecretList(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'secrets:list', namespace);
  if (input.include_retired) requireAccess(context.caller, 'secrets:admin', namespace);

  let query = db.from('memory_secrets')
    .select('id, namespace, name, description, version, metadata, is_active, access_count, last_accessed_at, created_at, updated_at, retired_at')
    .eq('namespace', namespace)
    .order('name')
    .order('version', { ascending: false })
    .limit(500);
  if (!input.include_retired) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw new ApiError('secret_list_failed', 500);

  await audit(context, 'secret_list', namespace, undefined, true, { result_count: data?.length ?? 0 });
  return json({ ok: true, secrets: data ?? [] }, 200, context.request);
}

async function handleSecretRetire(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  const name = cleanIdentifier(input.name, 'name');
  requireAccess(context.caller, 'secrets:admin', namespace);
  const { error } = await db.rpc('retire_encrypted_secret', {
    p_namespace: namespace,
    p_name: name,
    p_client_id: context.caller.id,
    p_request_id: context.requestId,
  });
  if (error) throw new ApiError('secret_retire_failed', 500);

  return json({ ok: true, namespace, name }, 200, context.request);
}

async function authenticate(header: string | null): Promise<Caller | null> {
  const token = bearerToken(header);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  if (bootstrapToken) {
    const bootstrapHash = await sha256Hex(bootstrapToken);
    if (timingSafeEqualHex(tokenHash, bootstrapHash)) {
      return {
        id: null,
        name: 'bootstrap-admin',
        tokenPrefix: token.slice(0, 8),
        allowedNamespaces: ['*'],
        permissions: ['*'],
        expiresAt: null,
        authMode: 'bootstrap',
      };
    }
  }

  const { data, error } = await db.from('memory_clients')
    .select('id, name, token_prefix, allowed_namespaces, permissions, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;

  const used = await db.from('memory_clients').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  if (used.error) return null;
  return {
    id: data.id,
    name: data.name,
    tokenPrefix: data.token_prefix,
    allowedNamespaces: data.allowed_namespaces,
    permissions: data.permissions,
    expiresAt: data.expires_at,
    authMode: 'scoped',
  };
}

async function embed(text: string) {
  const chunks = chunkEmbeddingText(text);
  const embeddings = await Promise.all(
    chunks.map((chunk) => model.run(chunk, { mean_pool: true, normalize: true })),
  );
  return embeddings.length === 1 ? embeddings[0] : averageNormalizedEmbeddings(embeddings);
}

async function requireMemory(caller: Caller, id: string, permission: Permission) {
  const { data, error } = await db.from('memories').select('id, namespace').eq('id', id).maybeSingle();
  if (error || !data) throw new ApiError('memory_not_found', 404);
  requireAccess(caller, permission, data.namespace);
  return data;
}

async function requireMemoryPair(caller: Caller, oldId: string, newId: string) {
  const { data, error } = await db.from('memories')
    .select('id, namespace')
    .in('id', [oldId, newId]);
  if (error || data?.length !== 2) throw new ApiError('memory_not_found', 404);
  const namespaces = new Set(data.map((row: { namespace: string }) => row.namespace));
  if (namespaces.size !== 1) throw new ApiError('namespace_mismatch', 409);
  const namespace = data[0].namespace;
  requireAccess(caller, 'memory:write', namespace);
  return namespace;
}

function requireAccess(caller: Caller, permission: Permission, namespace?: string) {
  if (!hasPermission(caller.permissions, permission)) throw new ApiError('forbidden', 403);
  if (namespace && !namespaceAllowed(caller.allowedNamespaces, namespace)) {
    throw new ApiError('forbidden', 403);
  }
}

async function audit(
  context: RequestContext,
  action: string,
  namespace: string | undefined,
  resourceId: string | undefined,
  success: boolean,
  details: Record<string, unknown>,
) {
  const result = await db.from('memory_audit_log').insert({
    request_id: context.requestId,
    client_id: context.caller.id,
    action,
    namespace: namespace ?? null,
    resource_type: action.startsWith('secret_') ? 'encrypted_secret' : 'memory',
    resource_id: resourceId ?? null,
    success,
    details,
  });
  if (result.error && result.error.code !== '42P01') {
    console.error('[ai-memory-free] audit write failed', {
      request_id: context.requestId,
      action,
      database_code: result.error.code,
    });
  }
}

async function enforceRateLimit(context: RequestContext, action: string) {
  const [limit, windowSeconds] = action === 'secret_get'
    ? [30, 60]
    : action === 'recall' || action === 'remember'
    ? [60, 60]
    : [120, 60];
  const clientKey = context.caller.id ?? `bootstrap:${context.caller.tokenPrefix}`;
  const result = await db.rpc('check_memory_rate_limit', {
    p_client_key: clientKey,
    p_action: action,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (result.error) {
    // Preserve upgrade compatibility for a bootstrap-token install until 0004 is
    // applied. Scoped clients cannot exist without the migration.
    if (context.caller.authMode === 'bootstrap' && ['42883', 'PGRST202'].includes(result.error.code ?? '')) return;
    throw new ApiError('rate_limit_unavailable', 503);
  }
  if (result.data !== true) throw new ApiError('rate_limited', 429);
}

function responseHeaders(request: Request) {
  const headers: Record<string, string> = {
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'vary': 'origin',
  };
  const origin = request.headers.get('origin');
  if (origin && originAllowed(request)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function originAllowed(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function json(value: unknown, status: number, request: Request) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: responseHeaders(request),
  });
}

function cleanNamespace(value: unknown) {
  const namespace = typeof value === 'string' && value.trim() ? value.trim() : 'default';
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(namespace)) {
    throw new ApiError('invalid_namespace', 400);
  }
  return namespace;
}

function cleanIdentifier(value: unknown, field: string) {
  const identifier = requiredString(value, field, 1, 128);
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(identifier)) throw new ApiError(`invalid_${field}`, 400);
  return identifier;
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

function requiredString(value: unknown, field: string, min: number, max: number, trim = true) {
  if (typeof value !== 'string') throw new ApiError(`${field}_required`, 400);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min) throw new ApiError(`${field}_required`, 400);
  if (normalized.length > max) throw new ApiError(`${field}_too_large`, 400);
  return normalized;
}

function requiredUuid(value: unknown, field: string) {
  const id = requiredString(value, field, 1, 128);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(`invalid_${field}`, 400);
  }
  return id;
}

function clampNumber(value: number, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoSecretMaterial(value: unknown) {
  if (!rejectLikelySecrets) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ApiError('invalid_metadata', 400);
  }
  if (containsLikelySecret(serialized)) throw new ApiError('likely_secret_use_secret_store', 400);
}

class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}
