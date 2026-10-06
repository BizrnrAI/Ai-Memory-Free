export const RELEASE_VERSION = '1.4.0';
export const PROTOCOL_VERSION = '1';
export const PORTABLE_FORMAT = 'ai-memory-free-portable';
export const PORTABLE_VERSION = 1;

export const CORE_ACTIONS = [
  'health', 'whoami', 'remember', 'remember_batch', 'recall', 'list', 'context',
  'retire', 'supersede', 'portable_export', 'portable_import',
] as const;

export const MODULES = [
  {
    id: 'core', version: '1.3.0', optional: false,
    actions: CORE_ACTIONS,
  },
  {
    id: 'vault-secrets', version: '1.1.0', optional: true,
    actions: ['secret_store', 'secret_get', 'secret_list', 'secret_retire'],
  },
  {
    id: 'events', version: '1.0.0', optional: true,
    actions: ['event_append', 'event_list'],
  },
  {
    id: 'provenance', version: '1.0.0', optional: true,
    actions: ['source_upsert', 'source_link', 'source_list'],
  },
  {
    id: 'relationships', version: '1.0.0', optional: true,
    actions: ['link_create', 'link_list', 'link_resolve'],
  },
  {
    id: 'documents', version: '1.2.0', optional: true,
    actions: ['document_ingest', 'document_search', 'document_list', 'document_retire'],
  },
  {
    id: 'maintenance', version: '1.1.0', optional: true,
    actions: ['maintenance_status', 'embedding_reindex'],
  },
  {
    id: 'remote-mcp', version: '1.2.0', optional: true,
    actions: [],
  },
] as const;

export const ACTIONS = [...new Set(MODULES.flatMap((module) => [...module.actions]))];

export const PORTABLE_RESOURCES = [
  'memories', 'supersessions', 'events', 'sources', 'source_links', 'links', 'documents',
] as const;

export type PortableResource = typeof PORTABLE_RESOURCES[number];

export function isPortableResource(value: unknown): value is PortableResource {
  return typeof value === 'string' && (PORTABLE_RESOURCES as readonly string[]).includes(value);
}

export function splitDocumentText(text: string, maxChars = 1_800, overlap = 180) {
  const normalized = text.trim();
  if (!normalized) return [];
  if (maxChars < 200 || overlap < 0 || overlap >= maxChars) throw new Error('invalid_chunk_configuration');

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf('\n\n', end);
      const sentence = normalized.lastIndexOf('. ', end);
      const space = normalized.lastIndexOf(' ', end);
      const candidate = Math.max(paragraph, sentence, space);
      if (candidate >= start + Math.floor(maxChars * 0.65)) end = candidate + (candidate === sentence ? 1 : 0);
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function boundContext<T extends object>(rows: T[], maxChars: number) {
  const bounded: T[] = [];
  let used = 0;
  for (const row of rows) {
    const content = (row as { content?: unknown }).content;
    const size = typeof content === 'string' ? content.length : JSON.stringify(row).length;
    if (used + size > maxChars) {
      if (bounded.length === 0 && typeof content === 'string' && maxChars > 0) {
        bounded.push({ ...row, content: content.slice(0, maxChars), content_truncated: true } as T);
        used = maxChars;
      }
      break;
    }
    bounded.push(row);
    used += size;
  }
  return { rows: bounded, usedChars: used, truncated: bounded.length < rows.length };
}

/** List pages contain complete memories; callers can raise a too-small budget. */
export function boundList<T extends { content: string }>(rows: T[], maxChars: number) {
  const bounded: T[] = [];
  let usedChars = 0;
  for (const row of rows) {
    if (usedChars + row.content.length > maxChars) break;
    bounded.push(row);
    usedChars += row.content.length;
  }
  return {
    rows: bounded, usedChars, truncated: bounded.length < rows.length,
    requiredChars: bounded.length === 0 && rows.length > 0 ? rows[0].content.length : null,
  };
}

export function contextCharacterBudget(input: { max_chars?: unknown; max_characters?: unknown }) {
  const value = input.max_chars ?? input.max_characters ?? 20_000;
  if (!Number.isInteger(value) || Number(value) < 1_000 || Number(value) > 100_000) {
    throw new RangeError('invalid_context_budget');
  }
  return Number(value);
}
