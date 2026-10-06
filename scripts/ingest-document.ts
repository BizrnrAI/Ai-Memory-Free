import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { MemoryClient } from '@ai-memory-free/client';

const values = parseArgs(process.argv.slice(2));
const path = resolve(required(values.get('file'), '--file'));
const namespace = values.get('namespace') ?? 'default';
const allowed = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml']);
if (!allowed.has(extname(path).toLowerCase())) throw new Error(`unsupported text extension: ${extname(path)}`);
if (!statSync(path).isFile()) throw new Error('--file must refer to a regular file');
if (statSync(path).size > 100_000) throw new Error('document exceeds the 100000-byte safe ingestion limit');
const content = readFileSync(path, 'utf8');
if (content.includes('\0')) throw new Error('binary content is not supported');
const sourceUri = values.get('source-uri') ?? `file:${basename(path)}`;
const client = new MemoryClient();
// A document longer than one request can embed is finished over several calls.
const result = await client.ingestDocumentFully({
  namespace,
  title: values.get('title') ?? basename(path),
  content,
  source_uri: sourceUri,
  media_type: mediaType(extname(path)),
  metadata: { ingested_by: 'ai-memory-free-local-text-ingester' },
});
console.log(JSON.stringify(result, null, 2));

function parseArgs(input: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < input.length; index += 2) {
    const key = input[index]; const value = input[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('arguments use --name value pairs');
    parsed.set(key.slice(2), value);
  }
  return parsed;
}
function required(value: string | undefined, name: string) { if (!value) throw new Error(`${name} is required`); return value; }
function mediaType(extension: string) {
  if (extension === '.json') return 'application/json';
  if (extension === '.csv') return 'text/csv';
  if (extension === '.tsv') return 'text/tab-separated-values';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  return 'text/plain';
}
