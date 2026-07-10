import { createClient } from '@supabase/supabase-js';
import {
  bearerToken,
  containsLikelySecret,
  hasPermission,
  namespaceAllowed,
  readJsonBody,
  RequestInputError,
  sha256Hex,
  timingSafeEqualHex,
  type Permission,
} from './lib.ts';
import { createGteSmallAdapter, GTE_SMALL_PROFILE } from './embedding.ts';
import {
  ACTIONS,
  boundContext,
  isPortableResource,
  MODULES,
  PORTABLE_FORMAT,
  PORTABLE_RESOURCES,
  PORTABLE_VERSION,
  PROTOCOL_VERSION,
  RELEASE_VERSION,
  splitDocumentText,
  type PortableResource,
} from './protocol.ts';

declare const Supabase: {
  ai: {
    Session: new (model: string) => {
      run: (input: string, options: { mean_pool: boolean; normalize: boolean }) => Promise<number[]>;
    };
  };
};

type MemoryKind = 'note' | 'fact' | 'decision' | 'correction' | 'reference' | 'procedure';

type RequestBody = {
  protocol_version?: string;
  action?: string;
  namespace?: string;
  namespaces?: string[];
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
  items?: RequestBody[];
  source_system?: string;
  external_id?: string;
  event_type?: string;
  summary?: string;
  agent_id?: string;
  session_id?: string;
  tool_name?: string;
  payload?: Record<string, unknown>;
  occurred_at?: string;
  uri?: string;
  source_type?: string;
  title?: string;
  checksum?: string;
  confidence?: number;
  observed_at?: string;
  valid_from?: string;
  valid_until?: string;
  last_verified_at?: string;
  source_id?: string;
  memory_id?: string;
  relation?: string;
  note?: string;
  link_id?: string;
  source_uri?: string;
  media_type?: string;
  max_chars?: number;
  per_namespace_limit?: number;
  include_events?: boolean;
  resource?: string;
  offset?: number;
  records?: Record<string, unknown>[];
  profile?: string;
};

type Caller = {
  id: string | null;
  name: string;
  tokenPrefix: string;
  allowedNamespaces: string[];
  permissions: string[];
  expiresAt: string | null;
  authMode: 'bootstrap' | 'scoped' | 'oauth';
  dbClientId: string | null;
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
const embeddingAdapter = createGteSmallAdapter(model);
type ActionHandler = (context: RequestContext, input: RequestBody) => Response | Promise<Response>;
const actionHandlers: Record<string, ActionHandler> = {
  health: (context) => handleHealth(context),
  whoami: (context) => handleWhoAmI(context),
  remember: handleRemember,
  remember_batch: handleRememberBatch,
  recall: handleRecall,
  context: handleContext,
  retire: handleRetire,
  supersede: handleSupersede,
  secret_store: handleSecretStore,
  secret_get: handleSecretGet,
  secret_list: handleSecretList,
  secret_retire: handleSecretRetire,
  event_append: handleEventAppend,
  event_list: handleEventList,
  source_upsert: handleSourceUpsert,
  source_link: handleSourceLink,
  source_list: handleSourceList,
  link_create: handleLinkCreate,
  link_list: handleLinkList,
  link_resolve: handleLinkResolve,
  document_ingest: handleDocumentIngest,
  document_search: handleDocumentSearch,
  document_list: handleDocumentList,
  maintenance_status: handleMaintenanceStatus,
  embedding_reindex: handleEmbeddingReindex,
  portable_export: handlePortableExport,
  portable_import: handlePortableImport,
};

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
    if (body.protocol_version && body.protocol_version !== PROTOCOL_VERSION) {
      throw new ApiError('unsupported_protocol_version', 409);
    }
    await enforceRateLimit(context, action);
    const handler = actionHandlers[action];
    if (!handler) throw new ApiError('unknown_action', 400);
    return await handler(context, body);
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
    version: RELEASE_VERSION,
    protocol_version: PROTOCOL_VERSION,
    portable_format_version: PORTABLE_VERSION,
    embedding_profile: GTE_SMALL_PROFILE.id,
    embedding_model: GTE_SMALL_PROFILE.model,
    embedding_dimensions: GTE_SMALL_PROFILE.dimensions,
    embedding_strategy: GTE_SMALL_PROFILE.strategy,
    auth_mode: context.caller.authMode,
    actions: ACTIONS,
    modules: MODULES,
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
      protocol_version: PROTOCOL_VERSION,
    },
  }, 200, context.request);
}

async function handleRemember(context: RequestContext, input: RequestBody) {
  const result = await rememberOne(context, input);
  return json({ ok: true, ...result }, 200, context.request);
}

async function handleRememberBatch(context: RequestContext, input: RequestBody) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) {
    throw new ApiError('items_must_contain_1_to_50_records', 400);
  }
  const results = [];
  for (const item of input.items) results.push(await rememberOne(context, item));
  return json({ ok: true, results }, 200, context.request);
}

async function rememberOne(context: RequestContext, input: RequestBody) {
  const content = requiredString(input.content, 'content', 1, 100_000);
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:write', namespace);

  const importance = clampNumber(input.importance ?? 0.5, 0, 1);
  const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map(cleanTag).filter(Boolean))].slice(0, 64) : [];
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const source = trimOptional(input.source, 2048);
  const sourceSystem = cleanOptionalIdentifier(input.source_system, 'source_system');
  const externalId = trimOptional(input.external_id, 512);
  if ((sourceSystem && !externalId) || (!sourceSystem && externalId)) {
    throw new ApiError('source_system_and_external_id_required_together', 400);
  }
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
    source_system: sourceSystem,
    external_id: externalId,
  };

  let created = true;
  let { data, error } = await db.from('memories')
    .insert(payload)
    .select('id, namespace, content_hash, created_at, updated_at')
    .single();

  if (error?.code === '23505') {
    created = false;
    let existingQuery = db.from('memories')
      .select('id, namespace, content_hash, created_at, updated_at')
      .eq('namespace', namespace);
    existingQuery = sourceSystem && externalId
      ? existingQuery.eq('source_system', sourceSystem).eq('external_id', externalId)
      : existingQuery.eq('content_hash', contentHash);
    const existing = await existingQuery.single();
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

  const profileWrite = await db.from('memory_embeddings').upsert({
    memory_id: data.id,
    profile: embeddingAdapter.profile.id,
    model: embeddingAdapter.profile.model,
    dimensions: embeddingAdapter.profile.dimensions,
    strategy: embeddingAdapter.profile.strategy,
    embedding,
    is_active: true,
  }, { onConflict: 'memory_id,profile' });
  if (profileWrite.error && !['42P01', 'PGRST205'].includes(profileWrite.error.code ?? '')) {
    throw new ApiError('embedding_profile_write_failed', 500);
  }

  await audit(context, 'remember', namespace, data.id, true, { created, kind: payload.kind });
  return { created, memory: data };
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

async function handleContext(context: RequestContext, input: RequestBody) {
  const query = requiredString(input.query, 'query', 1, 20_000);
  const namespaces = cleanNamespaces(input.namespaces ?? (input.namespace ? [input.namespace] : ['default']));
  for (const namespace of namespaces) requireAccess(context.caller, 'memory:read', namespace);
  const perNamespaceLimit = Math.trunc(clampNumber(input.per_namespace_limit ?? 8, 1, 20));
  const maxChars = Math.trunc(clampNumber(input.max_chars ?? 20_000, 1_000, 100_000));
  const embedding = await embed(query);
  const recalled = await Promise.all(namespaces.map(async (namespace) => {
    const { data, error } = await db.rpc('recall', {
      query_embedding: embedding,
      query_text: query,
      match_limit: perNamespaceLimit,
      pool: Math.max(100, perNamespaceLimit * 20),
      memory_namespace: namespace,
    });
    if (error) throw new ApiError('memory_recall_failed', 500);
    return data ?? [];
  }));
  const ranked = recalled.flat().sort((a, b) => Number(b.final_score) - Number(a.final_score));
  const bounded = boundContext(ranked, maxChars);
  const memoryIds = bounded.rows.map((row: { id: string }) => row.id);

  let sources: unknown[] = [];
  let relationships: unknown[] = [];
  if (memoryIds.length > 0) {
    const [sourceResult, linkResult] = await Promise.all([
      db.from('memory_source_links')
        .select('memory_id, relation, source:memory_sources(id, uri, source_type, title, confidence, observed_at, valid_from, valid_until, last_verified_at)')
        .in('memory_id', memoryIds),
      db.from('memory_links')
        .select('id, namespace, source_memory_id, target_memory_id, relation, note, created_at')
        .eq('is_active', true)
        .or(`source_memory_id.in.(${memoryIds.join(',')}),target_memory_id.in.(${memoryIds.join(',')})`),
    ]);
    if (!sourceResult.error) sources = sourceResult.data ?? [];
    if (!linkResult.error) relationships = linkResult.data ?? [];
  }

  const events: unknown[] = [];
  if (input.include_events) {
    for (const namespace of namespaces) {
      const result = await db.from('memory_events')
        .select('id, namespace, event_type, summary, agent_id, session_id, tool_name, source_system, occurred_at')
        .eq('namespace', namespace)
        .order('occurred_at', { ascending: false })
        .limit(5);
      if (!result.error) events.push(...(result.data ?? []));
    }
  }
  const remaining = Math.max(0, maxChars - bounded.usedChars);
  const evidence = boundContext([
    ...sources.map((value) => ({ bundle_type: 'source', value })),
    ...relationships.map((value) => ({ bundle_type: 'relationship', value })),
    ...events.map((value) => ({ bundle_type: 'event', value })),
  ], remaining);
  sources = evidence.rows.filter((entry) => entry.bundle_type === 'source').map((entry) => entry.value);
  relationships = evidence.rows.filter((entry) => entry.bundle_type === 'relationship').map((entry) => entry.value);
  const boundedEvents = evidence.rows.filter((entry) => entry.bundle_type === 'event').map((entry) => entry.value);
  return json({
    ok: true,
    protocol_version: PROTOCOL_VERSION,
    query,
    namespaces,
    memories: bounded.rows,
    sources,
    relationships,
    recent_events: boundedEvents,
    budget: {
      max_chars: maxChars,
      used_chars: bounded.usedChars + evidence.usedChars,
      truncated: bounded.truncated || evidence.truncated,
    },
  }, 200, context.request);
}

async function handleEventAppend(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:write', namespace);
  const eventType = cleanIdentifier(input.event_type, 'event_type');
  const summary = requiredString(input.summary, 'summary', 1, 20_000);
  const sourceSystem = cleanOptionalIdentifier(input.source_system, 'source_system') ?? 'manual';
  const payload = isPlainObject(input.payload) ? input.payload : {};
  assertNoSecretMaterial({ summary, payload });
  const row = {
    namespace,
    event_type: eventType,
    summary,
    agent_id: trimOptional(input.agent_id, 256),
    session_id: trimOptional(input.session_id, 256),
    tool_name: trimOptional(input.tool_name, 256),
    source_system: sourceSystem,
    external_id: trimOptional(input.external_id, 512),
    payload,
    occurred_at: cleanTimestamp(input.occurred_at, 'occurred_at') ?? new Date().toISOString(),
    created_by_type: context.caller.authMode,
    created_by_id: context.caller.id,
  };
  let result = await db.from('memory_events').insert(row).select().single();
  let created = true;
  if (result.error?.code === '23505' && row.external_id) {
    created = false;
    result = await db.from('memory_events').select().eq('namespace', namespace)
      .eq('source_system', sourceSystem).eq('external_id', row.external_id).single();
  }
  if (result.error || !result.data) throw new ApiError('event_write_failed', 500);
  await audit(context, 'event_append', namespace, result.data.id, true, { created, event_type: eventType });
  return json({ ok: true, created, event: result.data }, 200, context.request);
}

async function handleEventList(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  const limit = Math.trunc(clampNumber(input.limit ?? 50, 1, 200));
  const { data, error } = await db.from('memory_events').select()
    .eq('namespace', namespace).order('occurred_at', { ascending: false }).limit(limit);
  if (error) throw new ApiError('event_list_failed', 500);
  return json({ ok: true, events: data ?? [] }, 200, context.request);
}

async function handleSourceUpsert(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:write', namespace);
  const uri = requiredString(input.uri, 'uri', 1, 2048);
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  assertNoSecretMaterial({ uri, title: input.title, metadata });
  const row = {
    namespace,
    uri,
    source_type: cleanOptionalIdentifier(input.source_type, 'source_type') ?? 'other',
    title: trimOptional(input.title, 512),
    checksum: trimOptional(input.checksum, 256),
    confidence: clampNumber(input.confidence ?? 0.8, 0, 1),
    observed_at: cleanTimestamp(input.observed_at, 'observed_at'),
    valid_from: cleanTimestamp(input.valid_from, 'valid_from'),
    valid_until: cleanTimestamp(input.valid_until, 'valid_until'),
    last_verified_at: cleanTimestamp(input.last_verified_at, 'last_verified_at'),
    metadata,
    created_by_type: context.caller.authMode,
    created_by_id: context.caller.id,
  };
  const { data, error } = await db.from('memory_sources').upsert(row, { onConflict: 'namespace,uri' }).select().single();
  if (error || !data) throw new ApiError('source_write_failed', 500);
  await audit(context, 'source_upsert', namespace, data.id, true, { source_type: row.source_type });
  return json({ ok: true, source: data }, 200, context.request);
}

async function handleSourceLink(context: RequestContext, input: RequestBody) {
  const sourceId = requiredUuid(input.source_id, 'source_id');
  const memoryId = requiredUuid(input.memory_id, 'memory_id');
  const memory = await requireMemory(context.caller, memoryId, 'memory:write');
  const source = await db.from('memory_sources').select('id, namespace').eq('id', sourceId).maybeSingle();
  if (source.error || !source.data) throw new ApiError('source_not_found', 404);
  if (source.data.namespace !== memory.namespace) throw new ApiError('namespace_mismatch', 409);
  const relation = cleanEnum(input.relation, ['supports', 'derived_from', 'verifies'], 'supports', 'relation');
  const { error } = await db.from('memory_source_links').upsert({ source_id: sourceId, memory_id: memoryId, relation });
  if (error) throw new ApiError('source_link_failed', 500);
  return json({ ok: true, source_id: sourceId, memory_id: memoryId, relation }, 200, context.request);
}

async function handleSourceList(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  const limit = Math.trunc(clampNumber(input.limit ?? 100, 1, 500));
  const { data, error } = await db.from('memory_sources').select()
    .eq('namespace', namespace).order('updated_at', { ascending: false }).limit(limit);
  if (error) throw new ApiError('source_list_failed', 500);
  return json({ ok: true, sources: data ?? [] }, 200, context.request);
}

async function handleLinkCreate(context: RequestContext, input: RequestBody) {
  const sourceId = requiredUuid(input.old_id ?? input.source_id, 'source_id');
  const targetId = requiredUuid(input.new_id ?? input.memory_id, 'target_id');
  const namespace = await requireMemoryPair(context.caller, sourceId, targetId);
  const relation = cleanEnum(input.relation, ['supports', 'contradicts', 'derived_from', 'related_to'], 'related_to', 'relation');
  const note = trimOptional(input.note, 2048);
  assertNoSecretMaterial({ note });
  const row = {
    namespace, source_memory_id: sourceId, target_memory_id: targetId, relation, note,
    created_by_type: context.caller.authMode, created_by_id: context.caller.id,
  };
  const { data, error } = await db.from('memory_links').upsert(row, {
    onConflict: 'source_memory_id,target_memory_id,relation',
  }).select().single();
  if (error || !data) throw new ApiError('link_write_failed', 500);
  await audit(context, 'link_create', namespace, data.id, true, { relation });
  return json({ ok: true, link: data }, 200, context.request);
}

async function handleLinkList(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  let query = db.from('memory_links').select().eq('namespace', namespace)
    .order('created_at', { ascending: false }).limit(Math.trunc(clampNumber(input.limit ?? 100, 1, 500)));
  if (!input.include_retired) query = query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw new ApiError('link_list_failed', 500);
  return json({ ok: true, links: data ?? [] }, 200, context.request);
}

async function handleLinkResolve(context: RequestContext, input: RequestBody) {
  const id = requiredUuid(input.link_id ?? input.id, 'link_id');
  const existing = await db.from('memory_links').select('id, namespace').eq('id', id).maybeSingle();
  if (existing.error || !existing.data) throw new ApiError('link_not_found', 404);
  requireAccess(context.caller, 'memory:write', existing.data.namespace);
  const note = trimOptional(input.note ?? input.reason, 2048);
  assertNoSecretMaterial({ note });
  const { error } = await db.from('memory_links').update({
    is_active: false, resolved_at: new Date().toISOString(), note,
  }).eq('id', id);
  if (error) throw new ApiError('link_resolve_failed', 500);
  return json({ ok: true, id }, 200, context.request);
}

async function handleDocumentIngest(context: RequestContext, input: RequestBody) {
  const result = await ingestDocument(context, input);
  return json({ ok: true, ...result }, 200, context.request);
}

async function ingestDocument(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:write', namespace);
  const title = requiredString(input.title, 'title', 1, 512);
  const content = requiredString(input.content, 'content', 1, 100_000);
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  assertNoSecretMaterial({ title, content, source_uri: input.source_uri, metadata });
  const chunks = splitDocumentText(content);
  if (chunks.length > 64) throw new ApiError('document_has_too_many_chunks', 413);
  const row = {
    namespace,
    title,
    source_uri: trimOptional(input.source_uri, 2048),
    media_type: trimOptional(input.media_type, 128) ?? 'text/plain',
    content,
    metadata,
    created_by_type: context.caller.authMode,
    created_by_id: context.caller.id,
  };
  let document = await db.from('memory_documents').insert(row).select().single();
  let created = true;
  if (document.error?.code === '23505') {
    created = false;
    const hash = await sha256Hex(content);
    document = await db.from('memory_documents').select().eq('namespace', namespace).eq('content_hash', hash).single();
  }
  if (document.error || !document.data) throw new ApiError('document_write_failed', 500);
  if (!created) return { created, document: document.data, chunks_created: 0 };

  const embeddings: number[][] = [];
  for (const chunk of chunks) embeddings.push(await embed(chunk));
  const chunkRows = chunks.map((chunk, index) => ({
    document_id: document.data.id,
    namespace,
    chunk_index: index,
    content: chunk,
    embedding: embeddings[index],
  }));
  const chunkWrite = await db.from('memory_document_chunks').insert(chunkRows);
  if (chunkWrite.error) {
    await db.from('memory_documents').delete().eq('id', document.data.id);
    throw new ApiError('document_chunk_write_failed', 500);
  }
  await audit(context, 'document_ingest', namespace, document.data.id, true, { chunks: chunks.length });
  return { created, document: document.data, chunks_created: chunks.length };
}

async function handleDocumentSearch(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  const query = requiredString(input.query, 'query', 1, 20_000);
  const embedding = await embed(query);
  const { data, error } = await db.rpc('recall_document_chunks', {
    query_embedding: embedding,
    query_text: query,
    match_limit: Math.trunc(clampNumber(input.limit ?? 8, 1, 50)),
    pool: Math.trunc(clampNumber(input.pool ?? 100, 10, 500)),
    memory_namespace: namespace,
  });
  if (error) throw new ApiError('document_search_failed', 500);
  return json({ ok: true, results: data ?? [] }, 200, context.request);
}

async function handleDocumentList(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  const { data, error } = await db.from('memory_documents')
    .select('id, namespace, title, source_uri, media_type, content_hash, metadata, created_at, updated_at')
    .eq('namespace', namespace).eq('is_active', true)
    .order('updated_at', { ascending: false }).limit(Math.trunc(clampNumber(input.limit ?? 100, 1, 500)));
  if (error) throw new ApiError('document_list_failed', 500);
  return json({ ok: true, documents: data ?? [] }, 200, context.request);
}

async function handleMaintenanceStatus(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:read', namespace);
  const tables = ['memories', 'memory_events', 'memory_sources', 'memory_links', 'memory_documents'];
  const counts: Record<string, number | null> = {};
  for (const table of tables) {
    const result = await db.from(table).select('*', { count: 'exact', head: true }).eq('namespace', namespace);
    counts[table] = result.error ? null : result.count;
  }
  const inactive = await db.from('memories').select('*', { count: 'exact', head: true })
    .eq('namespace', namespace).eq('is_active', false);
  const unverified = await db.from('memory_sources').select('*', { count: 'exact', head: true })
    .eq('namespace', namespace).is('last_verified_at', null);
  let databaseSizeBytes: number | null = null;
  if (hasPermission(context.caller.permissions, 'memory:admin')) {
    const size = await db.rpc('memory_database_size_bytes');
    if (!size.error) databaseSizeBytes = Number(size.data);
  }
  return json({
    ok: true,
    namespace,
    counts,
    inactive_memories: inactive.error ? null : inactive.count,
    unverified_sources: unverified.error ? null : unverified.count,
    database_size_bytes: databaseSizeBytes,
    embedding_profile: embeddingAdapter.profile,
    modules: MODULES,
  }, 200, context.request);
}

async function handleEmbeddingReindex(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:admin', namespace);
  const profile = input.profile ?? embeddingAdapter.profile.id;
  if (profile !== embeddingAdapter.profile.id) throw new ApiError('embedding_profile_not_available', 409);
  const limit = Math.trunc(clampNumber(input.limit ?? 25, 1, 50));
  const offset = Math.trunc(clampNumber(input.offset ?? 0, 0, 1_000_000));
  const { data, error } = await db.from('memories').select('id, content')
    .eq('namespace', namespace).eq('is_active', true).order('id').range(offset, offset + limit - 1);
  if (error) throw new ApiError('embedding_reindex_read_failed', 500);
  for (const memory of data ?? []) {
    const embedding = await embed(memory.content);
    const write = await db.from('memory_embeddings').upsert({
      memory_id: memory.id,
      profile,
      model: embeddingAdapter.profile.model,
      dimensions: embeddingAdapter.profile.dimensions,
      strategy: embeddingAdapter.profile.strategy,
      embedding,
      is_active: true,
    }, { onConflict: 'memory_id,profile' });
    if (write.error) throw new ApiError('embedding_reindex_write_failed', 500);
  }
  return json({ ok: true, profile, processed: data?.length ?? 0, next_offset: offset + (data?.length ?? 0) }, 200, context.request);
}

async function handlePortableExport(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:admin', namespace);
  if (!isPortableResource(input.resource)) throw new ApiError('invalid_portable_resource', 400);
  const offset = Math.trunc(clampNumber(input.offset ?? 0, 0, 1_000_000));
  const limit = Math.trunc(clampNumber(input.limit ?? 100, 1, 200));
  let data: unknown[] | null;
  let error: { code?: string } | null;
  if (input.resource === 'source_links') {
    const result = await db.from('memory_source_links')
      .select('source_id, memory_id, relation, created_at, source:memory_sources!inner(namespace)')
      .eq('source.namespace', namespace).order('created_at').range(offset, offset + limit - 1);
    data = result.data;
    error = result.error;
  } else if (input.resource === 'supersessions') {
    const result = await db.from('memories')
      .select('id, namespace, is_active, superseded_by, metadata, updated_at')
      .eq('namespace', namespace)
      .or('superseded_by.not.is.null,is_active.eq.false')
      .order('updated_at').range(offset, offset + limit - 1);
    data = result.data;
    error = result.error;
  } else {
    const { table, columns } = portableTable(input.resource);
    const result = await db.from(table).select(columns).eq('namespace', namespace)
      .order('created_at').range(offset, offset + limit - 1);
    data = result.data;
    error = result.error;
  }
  if (error) throw new ApiError('portable_export_failed', 500);
  const records = (data ?? []).map((record) => {
    if (input.resource === 'source_links' && isPlainObject(record)) {
      const clean = { ...record };
      delete clean.source;
      return clean;
    }
    return record;
  });
  return json({
    ok: true,
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    resource: input.resource,
    namespace,
    offset,
    next_offset: records.length === limit ? offset + records.length : null,
    records,
    excluded: ['secrets', 'vault_ciphertext', 'credentials', 'embeddings', 'audit_log', 'rate_limits'],
  }, 200, context.request);
}

async function handlePortableImport(context: RequestContext, input: RequestBody) {
  const namespace = cleanNamespace(input.namespace);
  requireAccess(context.caller, 'memory:admin', namespace);
  if (!isPortableResource(input.resource)) throw new ApiError('invalid_portable_resource', 400);
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > 20) {
    throw new ApiError('records_must_contain_1_to_20_items', 400);
  }
  let imported = 0;
  let skipped = 0;
  for (const record of input.records) {
    const recordNamespace = typeof record.namespace === 'string' ? cleanNamespace(record.namespace) : namespace;
    if (recordNamespace !== namespace && input.resource !== 'source_links') throw new ApiError('namespace_mismatch', 409);
    const didImport = await importPortableRecord(context, input.resource, namespace, record);
    didImport ? imported += 1 : skipped += 1;
  }
  await audit(context, 'portable_import', namespace, undefined, true, { resource: input.resource, imported, skipped });
  return json({ ok: true, resource: input.resource, namespace, imported, skipped }, 200, context.request);
}

async function importPortableRecord(
  context: RequestContext,
  resource: PortableResource,
  namespace: string,
  record: Record<string, unknown>,
) {
  assertNoSecretMaterial(record);
  if (resource === 'memories') {
    const content = requiredString(record.content, 'content', 1, 100_000);
    const embedding = await embed(content);
    const row = {
      id: optionalUuid(record.id),
      namespace,
      content,
      kind: cleanKind(record.kind),
      importance: clampNumber(typeof record.importance === 'number' ? record.importance : 0.5, 0, 1),
      base_importance: clampNumber(typeof record.base_importance === 'number' ? record.base_importance : 0.5, 0, 1),
      source: trimOptional(record.source, 2048),
      tags: Array.isArray(record.tags) ? record.tags.map(cleanTag).filter(Boolean).slice(0, 64) : [],
      metadata: isPlainObject(record.metadata) ? record.metadata : {},
      source_system: cleanOptionalIdentifier(record.source_system, 'source_system'),
      external_id: trimOptional(record.external_id, 512),
      embedding,
      created_at: cleanTimestamp(record.created_at, 'created_at'),
      updated_at: cleanTimestamp(record.updated_at, 'updated_at'),
    };
    const result = await db.from('memories').insert(row).select('id').single();
    if (result.error?.code === '23505') return false;
    if (result.error || !result.data) throw new ApiError('portable_import_memory_failed', 500);
    const profile = await db.from('memory_embeddings').upsert({
      memory_id: result.data.id,
      profile: embeddingAdapter.profile.id,
      model: embeddingAdapter.profile.model,
      dimensions: embeddingAdapter.profile.dimensions,
      strategy: embeddingAdapter.profile.strategy,
      embedding,
    }, { onConflict: 'memory_id,profile' });
    if (profile.error) throw new ApiError('portable_import_embedding_failed', 500);
    return true;
  }
  if (resource === 'supersessions') {
    const id = requiredUuid(record.id, 'id');
    const existing = await requireMemory(context.caller, id, 'memory:admin');
    if (existing.namespace !== namespace) throw new ApiError('namespace_mismatch', 409);
    const supersededBy = record.superseded_by ? requiredUuid(record.superseded_by, 'superseded_by') : null;
    if (supersededBy) {
      const target = await requireMemory(context.caller, supersededBy, 'memory:admin');
      if (target.namespace !== namespace) throw new ApiError('namespace_mismatch', 409);
    }
    const result = await db.from('memories').update({
      is_active: record.is_active !== false,
      superseded_by: supersededBy,
      metadata: isPlainObject(record.metadata) ? record.metadata : {},
    }).eq('id', id);
    if (result.error) throw new ApiError('portable_import_supersession_failed', 500);
    return true;
  }
  if (resource === 'events') {
    const row = {
      id: optionalUuid(record.id), namespace,
      event_type: cleanIdentifier(record.event_type, 'event_type'),
      summary: requiredString(record.summary, 'summary', 1, 20_000),
      agent_id: trimOptional(record.agent_id, 256), session_id: trimOptional(record.session_id, 256),
      tool_name: trimOptional(record.tool_name, 256),
      source_system: cleanOptionalIdentifier(record.source_system, 'source_system') ?? 'portable-import',
      external_id: trimOptional(record.external_id, 512),
      payload: isPlainObject(record.payload) ? record.payload : {},
      occurred_at: cleanTimestamp(record.occurred_at, 'occurred_at') ?? new Date().toISOString(),
      created_by_type: context.caller.authMode, created_by_id: context.caller.id,
    };
    const result = await db.from('memory_events').insert(row);
    if (result.error?.code === '23505') return false;
    if (result.error) throw new ApiError('portable_import_event_failed', 500);
    return true;
  }
  if (resource === 'sources') {
    const row = {
      id: optionalUuid(record.id), namespace,
      uri: requiredString(record.uri, 'uri', 1, 2048),
      source_type: cleanOptionalIdentifier(record.source_type, 'source_type') ?? 'other',
      title: trimOptional(record.title, 512), checksum: trimOptional(record.checksum, 256),
      confidence: clampNumber(typeof record.confidence === 'number' ? record.confidence : 0.8, 0, 1),
      observed_at: cleanTimestamp(record.observed_at, 'observed_at'),
      valid_from: cleanTimestamp(record.valid_from, 'valid_from'),
      valid_until: cleanTimestamp(record.valid_until, 'valid_until'),
      last_verified_at: cleanTimestamp(record.last_verified_at, 'last_verified_at'),
      metadata: isPlainObject(record.metadata) ? record.metadata : {},
      created_by_type: context.caller.authMode, created_by_id: context.caller.id,
    };
    const result = await db.from('memory_sources').insert(row);
    if (result.error?.code === '23505') return false;
    if (result.error) throw new ApiError('portable_import_source_failed', 500);
    return true;
  }
  if (resource === 'source_links') {
    const sourceId = requiredUuid(record.source_id, 'source_id');
    const memoryId = requiredUuid(record.memory_id, 'memory_id');
    await requireMemory(context.caller, memoryId, 'memory:admin');
    const source = await db.from('memory_sources').select('namespace').eq('id', sourceId).maybeSingle();
    if (source.error || source.data?.namespace !== namespace) throw new ApiError('source_not_found', 404);
    const result = await db.from('memory_source_links').insert({
      source_id: sourceId, memory_id: memoryId,
      relation: cleanEnum(record.relation, ['supports', 'derived_from', 'verifies'], 'supports', 'relation'),
    });
    if (result.error?.code === '23505') return false;
    if (result.error) throw new ApiError('portable_import_source_link_failed', 500);
    return true;
  }
  if (resource === 'links') {
    const sourceId = requiredUuid(record.source_memory_id, 'source_memory_id');
    const targetId = requiredUuid(record.target_memory_id, 'target_memory_id');
    const pairNamespace = await requireMemoryPair(context.caller, sourceId, targetId);
    if (pairNamespace !== namespace) throw new ApiError('namespace_mismatch', 409);
    const result = await db.from('memory_links').insert({
      id: optionalUuid(record.id), namespace, source_memory_id: sourceId, target_memory_id: targetId,
      relation: cleanEnum(record.relation, ['supports', 'contradicts', 'derived_from', 'related_to'], 'related_to', 'relation'),
      is_active: record.is_active !== false, note: trimOptional(record.note, 2048),
      created_by_type: context.caller.authMode, created_by_id: context.caller.id,
    });
    if (result.error?.code === '23505') return false;
    if (result.error) throw new ApiError('portable_import_link_failed', 500);
    return true;
  }
  const result = await ingestDocument(context, {
    namespace,
    title: String(record.title ?? ''),
    content: String(record.content ?? ''),
    source_uri: typeof record.source_uri === 'string' ? record.source_uri : undefined,
    media_type: typeof record.media_type === 'string' ? record.media_type : undefined,
    metadata: isPlainObject(record.metadata) ? record.metadata : {},
  });
  return result.created;
}

function portableTable(resource: PortableResource) {
  switch (resource) {
    case 'memories':
      return { table: 'memories', columns: 'id, namespace, content, kind, importance, base_importance, is_active, superseded_by, source, tags, metadata, source_system, external_id, created_at, updated_at' };
    case 'events':
      return { table: 'memory_events', columns: 'id, namespace, event_type, summary, agent_id, session_id, tool_name, source_system, external_id, payload, occurred_at, created_at' };
    case 'supersessions':
      return { table: 'memories', columns: 'id, namespace, is_active, superseded_by, metadata, updated_at' };
    case 'sources':
      return { table: 'memory_sources', columns: 'id, namespace, uri, source_type, title, checksum, confidence, observed_at, valid_from, valid_until, last_verified_at, metadata, created_at, updated_at' };
    case 'source_links':
      return { table: 'memory_source_links', columns: 'source_id, memory_id, relation, created_at' };
    case 'links':
      return { table: 'memory_links', columns: 'id, namespace, source_memory_id, target_memory_id, relation, is_active, note, created_at, resolved_at' };
    case 'documents':
      return { table: 'memory_documents', columns: 'id, namespace, title, source_uri, media_type, content, metadata, is_active, created_at, updated_at' };
  }
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
    p_client_id: context.caller.dbClientId,
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
    p_client_id: context.caller.dbClientId,
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
    p_client_id: context.caller.dbClientId,
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
        dbClientId: null,
      };
    }
  }

  const { data, error } = await db.from('memory_clients')
    .select('id, name, token_prefix, allowed_namespaces, permissions, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (!error && data && !data.revoked_at && (!data.expires_at || new Date(data.expires_at).getTime() > Date.now())) {
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
      dbClientId: data.id,
    };
  }

  const auth = await db.auth.getUser(token);
  if (auth.error || !auth.data.user) return null;
  const grant = await db.from('memory_oauth_grants')
    .select('id, name, allowed_namespaces, permissions, expires_at, revoked_at')
    .eq('user_id', auth.data.user.id).maybeSingle();
  if (grant.error || !grant.data || grant.data.revoked_at) return null;
  if (grant.data.expires_at && new Date(grant.data.expires_at).getTime() <= Date.now()) return null;
  const used = await db.from('memory_oauth_grants').update({ last_used_at: new Date().toISOString() }).eq('id', grant.data.id);
  if (used.error) return null;
  return {
    id: grant.data.id,
    name: grant.data.name,
    tokenPrefix: `oauth:${auth.data.user.id.slice(0, 8)}`,
    allowedNamespaces: grant.data.allowed_namespaces,
    permissions: grant.data.permissions,
    expiresAt: grant.data.expires_at,
    authMode: 'oauth',
    dbClientId: null,
  };
}

async function embed(text: string) {
  return await embeddingAdapter.embed(text);
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
    client_id: context.caller.dbClientId,
    actor_type: context.caller.authMode,
    actor_id: context.caller.id,
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

function cleanOptionalIdentifier(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  return cleanIdentifier(value, field);
}

function cleanNamespaces(values: unknown[]) {
  if (values.length < 1 || values.length > 8) throw new ApiError('namespaces_must_contain_1_to_8_items', 400);
  return [...new Set(values.map(cleanNamespace))];
}

function cleanTimestamp(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ApiError(`invalid_${field}`, 400);
  return new Date(value).toISOString();
}

function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ApiError(`invalid_${field}`, 400);
  return value as T;
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

function optionalUuid(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredUuid(value, 'id');
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
