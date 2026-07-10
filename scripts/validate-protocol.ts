import { readFileSync } from 'node:fs';
import { ACTIONS, MODULES, PORTABLE_RESOURCES, PROTOCOL_VERSION, RELEASE_VERSION } from '../supabase/functions/memory/protocol.js';

if (RELEASE_VERSION !== '1.2.0') throw new Error('release version must be 1.2.0');
if (PROTOCOL_VERSION !== '1') throw new Error('protocol version must remain backwards-compatible v1');
if (new Set(ACTIONS).size !== ACTIONS.length) throw new Error('actions must be unique');
if (new Set(MODULES.map((module) => module.id)).size !== MODULES.length) throw new Error('module ids must be unique');
if ((PORTABLE_RESOURCES as readonly string[]).some((resource) => /secret|audit|rate/i.test(resource))) {
  throw new Error('portable resources must not include security state');
}
const edgeSource = readFileSync('supabase/functions/memory/index.ts', 'utf8');
for (const action of ACTIONS) {
  if (!edgeSource.includes(`  ${action}:`)) throw new Error(`action ${action} is advertised but not registered`);
}
for (const path of ['schemas/request-v1.schema.json', 'schemas/module-manifest.schema.json', 'schemas/portable-v1.schema.json']) {
  JSON.parse(readFileSync(path, 'utf8'));
}
for (const path of ['package.json', 'packages/client/package.json', 'packages/mcp-server/package.json']) {
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
  if (pkg.version !== RELEASE_VERSION) throw new Error(`${path} version is not ${RELEASE_VERSION}`);
}
console.log(`validated protocol v${PROTOCOL_VERSION}, release ${RELEASE_VERSION}, ${MODULES.length} modules, and ${ACTIONS.length} actions`);
