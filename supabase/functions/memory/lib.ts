export const MAX_REQUEST_BYTES = 1_048_576;

export const MEMORY_KINDS = [
  'note', 'fact', 'decision', 'correction', 'reference', 'procedure',
] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

// ── Embedding budget ────────────────────────────────────────────────────────
// The built-in gte-small model runs inside the Edge Function worker, and hosted
// Supabase gives a worker about 2 seconds of CPU before it is killed and the
// caller gets HTTP 546. A worker serves several requests and stops taking new
// ones at a lower "soft" limit, so a request can arrive with only part of the 2
// seconds left. Measured against a hosted project (2026-10), full 1,800-character
// chunks embedded in one request, repeated back to back:
//
//     1 chunk   0 of 12 failed        4 chunks  2 of 14 failed
//     2 chunks  0 of 12 failed        5 chunks  2 of 14 failed
//     3 chunks  1 of 14 failed        7 chunks  always failed
//
// So one request embeds at most two chunks by default. A longer text is
// represented by two evenly spaced windows; Postgres full-text search still
// indexes every word of it, and that is what finds most memories anyway (see
// migration 0013). A 546 is safe to retry — the next request gets a fresh
// worker — and the bundled client does. Self-hosted runtimes without the CPU cap
// can raise the budget with MEMORY_EMBED_CHARS_PER_REQUEST.
//
// Characters are not the whole cost. Every run of the model has a fixed price
// before it reads a word, so thirty one-line memories are far dearer than one
// memory thirty lines long: in a local run, a batch of thirty 40-character
// texts killed the worker at the twenty-fourth. Cost is therefore counted per
// chunk as its characters plus EMBED_RUN_OVERHEAD, set on the high side of what
// was measured, and a request may spend what two full chunks cost.
export const EMBED_CHUNK_CHARS = 1_800;
// What one run of the model costs before it reads any text, in the same unit as
// a character of text.
export const EMBED_RUN_OVERHEAD = 600;
export const DEFAULT_EMBED_CHARS_PER_REQUEST = 3_600;
export const MIN_EMBED_CHARS_PER_REQUEST = EMBED_CHUNK_CHARS;
export const MAX_EMBED_CHARS_PER_REQUEST = 1_000_000;
// One text is represented by at most this many averaged chunks, whatever the budget.
export const MAX_CHUNKS_PER_TEXT = 8;

/** The per-request embedding budget in characters, from MEMORY_EMBED_CHARS_PER_REQUEST. */
export function embedCharBudget(raw: string | null | undefined) {
  const value = Number(raw);
  if (raw === null || raw === undefined || raw.trim() === '' || !Number.isFinite(value)) {
    return DEFAULT_EMBED_CHARS_PER_REQUEST;
  }
  return Math.trunc(Math.max(MIN_EMBED_CHARS_PER_REQUEST, Math.min(MAX_EMBED_CHARS_PER_REQUEST, value)));
}

/** How many chunks one text may be averaged from under a given budget. */
export function chunksPerText(budgetChars: number) {
  return Math.max(1, Math.min(MAX_CHUNKS_PER_TEXT, Math.floor(budgetChars / EMBED_CHUNK_CHARS)));
}

/** What embedding this text costs: for each chunk the model reads, its characters plus the fixed price of a run. */
export function embeddingCost(text: string, maxChunks: number) {
  return chunkEmbeddingText(text, EMBED_CHUNK_CHARS, maxChunks)
    .reduce((sum, chunk) => sum + EMBED_RUN_OVERHEAD + chunk.length, 0);
}

/** What one request may spend on embedding: the cost of as many full chunks as the character budget holds. */
export function embedCostBudget(budgetChars: number) {
  return Math.max(1, Math.floor(budgetChars / EMBED_CHUNK_CHARS)) * (EMBED_CHUNK_CHARS + EMBED_RUN_OVERHEAD);
}

/**
 * How much of a text its vector represents: `full` when every chunk was
 * embedded, `sampled` when the text needed more chunks than one request may
 * embed and evenly spaced windows stand in for it.
 */
export function vectorCoverage(text: string, maxChunks: number): 'full' | 'sampled' {
  return chunkEmbeddingText(text, EMBED_CHUNK_CHARS, Number.MAX_SAFE_INTEGER).length > maxChunks ? 'sampled' : 'full';
}

/** An optional operator cap on memory content, in UTF-8 bytes (MEMORY_MAX_CONTENT_BYTES). */
export function contentByteLimit(raw: string | null | undefined) {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(Math.max(256, Math.min(400_000, value)));
}

// ── Supabase server key ─────────────────────────────────────────────────────
// Supabase is retiring the JWT `service_role` key (end of 2026). The Edge
// runtime now injects the replacement secret keys as SUPABASE_SECRET_KEYS, a
// JSON dictionary keyed by key name; SUPABASE_SERVICE_ROLE_KEY still exists but
// carries the legacy key. Prefer the new key when the runtime provides it, so a
// project keeps working after its legacy keys are disabled.
export type ServerKey = { key: string; source: 'secret_keys' | 'service_role' };

export function resolveSupabaseServerKey(env: {
  secretKeys?: string | null;
  keyName?: string | null;
  serviceRoleKey?: string | null;
}): ServerKey | null {
  const name = env.keyName?.trim() || 'default';
  if (env.secretKeys) {
    try {
      const parsed: unknown = JSON.parse(env.secretKeys);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const candidate = (parsed as Record<string, unknown>)[name];
        if (typeof candidate === 'string' && candidate.trim()) {
          return { key: candidate.trim(), source: 'secret_keys' };
        }
      }
    } catch {
      // Not JSON: fall through to the legacy variable rather than guess.
    }
  }
  const legacy = env.serviceRoleKey?.trim();
  return legacy ? { key: legacy, source: 'service_role' } : null;
}

export type Permission =
  | '*'
  | 'memory:read'
  | 'memory:write'
  | 'memory:admin'
  | 'secrets:list'
  | 'secrets:read'
  | 'secrets:write'
  | 'secrets:admin';

const permissionImplications: Partial<Record<Permission, Permission[]>> = {
  'memory:admin': ['memory:read', 'memory:write'],
  'secrets:admin': ['secrets:list', 'secrets:read', 'secrets:write'],
};

export function hasPermission(permissions: string[], required: Permission) {
  if (permissions.includes('*') || permissions.includes(required)) return true;
  return permissions.some((permission) =>
    (permissionImplications[permission as Permission] ?? []).includes(required)
  );
}

export function namespaceAllowed(allowedNamespaces: string[], namespace: string) {
  return allowedNamespaces.includes('*') || allowedNamespaces.includes(namespace);
}

export function bearerToken(header: string | null) {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

export async function readJsonBody<T>(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<T> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestInputError('request_too_large', 413);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new RequestInputError('request_too_large', 413);

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new RequestInputError('invalid_json', 400);
  }
}

export class RequestInputError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function timingSafeEqualHex(left: string, right: string) {
  if (left.length !== right.length || left.length % 2 !== 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 2) {
    diff |= Number.parseInt(left.slice(i, i + 2), 16) ^ Number.parseInt(right.slice(i, i + 2), 16);
  }
  return diff === 0;
}

export function chunkEmbeddingText(text: string, maxChars = 1_800, maxChunks = 8) {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const breakAt = normalized.lastIndexOf(' ', end);
      if (breakAt >= start + Math.floor(maxChars * 0.7)) end = breakAt;
    }
    chunks.push(normalized.slice(start, end).trim());
    start = end;
    while (normalized[start] === ' ') start += 1;
  }

  if (chunks.length <= maxChunks) return chunks;
  if (maxChunks <= 1) return [chunks[0]];
  const selected = new Set<number>();
  for (let i = 0; i < maxChunks; i += 1) {
    selected.add(Math.round(i * (chunks.length - 1) / (maxChunks - 1)));
  }
  return [...selected].sort((a, b) => a - b).map((index) => chunks[index]);
}

export function averageNormalizedEmbeddings(embeddings: number[][]) {
  if (embeddings.length === 0) throw new Error('embedding_empty');
  const dimensions = embeddings[0].length;
  if (dimensions === 0 || embeddings.some((embedding) => embedding.length !== dimensions)) {
    throw new Error('embedding_dimensions_mismatch');
  }

  const averaged = new Array<number>(dimensions).fill(0);
  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i += 1) averaged[i] += embedding[i] / embeddings.length;
  }
  const magnitude = Math.sqrt(averaged.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) throw new Error('embedding_zero_vector');
  return averaged.map((value) => value / magnitude);
}

// Every pattern here is prefix-anchored and length-bounded on purpose. Entropy
// heuristics were considered and rejected: they misfire on hashes, UUIDs, base64
// payloads, and git SHAs that legitimately belong in memory, and a detector that
// blocks ordinary notes gets disabled by whoever it annoys first.
export function containsLikelySecret(value: string) {
  const patterns = [
    // Payments / cloud
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, // Stripe
    /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
    /\bASIA[0-9A-Z]{16}\b/, // AWS temporary access key id
    /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key

    // Source control / packaging
    /\bgh[opusr]_[A-Za-z0-9]{20,}\b/, // GitHub classic PAT / OAuth
    /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, // GitHub fine-grained PAT
    /\bglpat-[A-Za-z0-9_-]{20,}\b/, // GitLab PAT
    /\bnpm_[A-Za-z0-9]{36}\b/, // npm automation token

    // Messaging
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, // Slack
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]{20,}/, // Slack webhook

    // LLM providers — the ones this deployment actually handles
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, // Anthropic
    /\bsk-proj-[A-Za-z0-9_-]{20,}\b/, // OpenAI project key
    /\bsk-[A-Za-z0-9]{32,}\b/, // OpenAI classic
    /\bAIzaSy[A-Za-z0-9_-]{30,}\b/, // Google AI Studio

    // Supabase — including this deployment's own credentials
    /\bsbp_[a-f0-9]{40,}\b/, // Supabase personal access token
    /\bsb(?:p|s)_[A-Za-z0-9_-]{30,}\b/, // Supabase sbp_/sbs_ prefixed tokens
    /\bsb_secret_[A-Za-z0-9_-]{16,}\b/, // Supabase secret API key (publishable keys are public by design)
    /\bamf_[A-Za-z0-9_-]{40,}\b/, // Ai-Memory-Free scoped client token

    // Nostr / Buzz identity
    /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/, // NIP-19 secret key
    /\bncryptsec1[023456789acdefghjklmnpqrstuvwxyz]{100,}\b/, // NIP-49 encrypted key

    // Key material and connection strings
    /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/, // PEM private key of any flavour
    /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/, // age identity
    /\b(?:postgres(?:ql)?|redis[s]?|mongodb(?:\+srv)?|mysql|amqps?):\/\/[^\s:@/]+:[^\s@/]{6,}@/, // URI with inline password

    // Generic transport
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
    /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Canonical credential identity, when all three identity fields are supplied. */
export function canonicalSecretName(identity: { service?: unknown; environment?: unknown; credential_type?: unknown }) {
  const values = [identity.service, identity.environment, identity.credential_type];
  if (values.some((value) => value === undefined)) return null; // legacy metadata remains compatible
  if (values.some((value) => typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value))) {
    throw new Error('invalid_secret_identity');
  }
  return values.join('.');
}
