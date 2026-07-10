import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryClient } from '@ai-memory-free/client';

const resources = ['memories', 'supersessions', 'events', 'sources', 'source_links', 'links', 'documents'] as const;
const args = parseArgs(process.argv.slice(2));
const command = args.positionals[0];
const namespace = required(args.values.get('namespace'), '--namespace');
const file = resolve(required(args.values.get(command === 'export' ? 'output' : 'input'), command === 'export' ? '--output' : '--input'));
const client = new MemoryClient();

if (command === 'export') await exportPortable();
else if (command === 'import') await importPortable();
else throw new Error('usage: npm run portable -- export|import --namespace NAME --output|--input FILE [--write]');

async function exportPortable() {
  const records: Array<{ resource: string; data: Record<string, unknown> }> = [];
  for (const resource of resources) {
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await client.portableExport({ namespace, resource, offset, limit: 100 });
      records.push(...page.records.map((data) => ({ resource, data })));
      offset = page.next_offset;
    }
  }
  const payload = records.map((record) => JSON.stringify(record)).join('\n');
  const header = {
    format: 'ai-memory-free-portable', version: 1, release: '1.2.0', namespace,
    generated_at: new Date().toISOString(), resources, record_count: records.length,
    payload_sha256: sha256(payload),
    excluded: ['secrets', 'vault_ciphertext', 'credentials', 'embeddings', 'audit_log', 'rate_limits'],
  };
  if (!args.flags.has('write')) {
    console.log(JSON.stringify({ dry_run: true, output: file, ...header }, null, 2));
    console.log('No file written. Re-run with --write.');
    return;
  }
  writeFileSync(file, `${JSON.stringify(header)}\n${payload}${payload ? '\n' : ''}`, { encoding: 'utf8', flag: 'wx' });
  console.log(`exported ${records.length} records to ${file}; no secrets or embeddings included`);
}

async function importPortable() {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 1) throw new Error('portable file is empty');
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  if (header.format !== 'ai-memory-free-portable' || header.version !== 1) throw new Error('unsupported portable format');
  if (header.namespace !== namespace) throw new Error('portable namespace does not match --namespace');
  const payload = lines.slice(1).join('\n');
  if (header.payload_sha256 !== sha256(payload)) throw new Error('portable payload checksum mismatch');
  const records = lines.slice(1).map((line) => JSON.parse(line) as { resource: string; data: Record<string, unknown> });
  for (const record of records) {
    if (!(resources as readonly string[]).includes(record.resource)) throw new Error(`unsupported resource: ${record.resource}`);
  }
  if (!args.flags.has('write')) {
    console.log(JSON.stringify({ dry_run: true, input: file, namespace, record_count: records.length }, null, 2));
    console.log('Checksum and format are valid. Re-run with --write to import.');
    return;
  }
  let imported = 0;
  let skipped = 0;
  for (const resource of resources) {
    const selected = records.filter((record) => record.resource === resource).map((record) => record.data);
    for (let index = 0; index < selected.length; index += 20) {
      const result = await client.portableImport({ namespace, resource, records: selected.slice(index, index + 20) }) as {
        imported?: number; skipped?: number;
      };
      imported += result.imported ?? 0;
      skipped += result.skipped ?? 0;
    }
  }
  console.log(`portable import complete: imported=${imported} skipped=${skipped}`);
}

function parseArgs(input: string[]) {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    if (!current.startsWith('--')) { positionals.push(current); continue; }
    const key = current.slice(2);
    if (key === 'write') { flags.add(key); continue; }
    const value = input[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${current} requires a value`);
    values.set(key, value);
    index += 1;
  }
  return { positionals, values, flags };
}
function required(value: string | undefined, name: string) { if (!value) throw new Error(`${name} is required`); return value; }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
