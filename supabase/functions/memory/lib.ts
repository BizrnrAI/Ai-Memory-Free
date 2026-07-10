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

export function containsLikelySecret(value: string) {
  const patterns = [
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
    /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
