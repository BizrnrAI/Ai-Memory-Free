export const MAX_REQUEST_BYTES = 1_048_576;

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
    /\bsb(?:p|s)_[A-Za-z0-9_-]{30,}\b/, // Supabase publishable/secret keys
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
