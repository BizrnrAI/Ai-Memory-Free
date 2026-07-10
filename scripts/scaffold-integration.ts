import {
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type IntegrationOptions = {
  target: string;
  namespace: string;
  apiUrl: string;
  memoryRepo: string;
};

export function buildIntegrationFiles(options: IntegrationOptions) {
  const target = resolve(options.target);
  const memoryRepo = resolve(options.memoryRepo);
  const namespace = validateNamespace(options.namespace);
  const apiUrl = validateApiUrl(options.apiUrl);
  const directory = resolve(target, '.ai-memory-free');

  return new Map<string, string>([
    [resolve(directory, 'README.md'), integrationReadme(namespace, apiUrl, memoryRepo)],
    [resolve(directory, 'mcp.json.example'), mcpExample(apiUrl, memoryRepo)],
    [resolve(directory, 'AGENT_POLICY.md'), agentPolicy(namespace)],
  ]);
}

export function defaultNamespace(target: string) {
  const cleaned = basename(resolve(target)).replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolve(required(args, 'target'));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`target directory does not exist: ${target}`);
  }

  const files = buildIntegrationFiles({
    target,
    namespace: args.get('namespace') ?? defaultNamespace(target),
    apiUrl: required(args, 'api-url'),
    memoryRepo: args.get('memory-repo') ?? process.cwd(),
  });
  const write = args.has('write');
  const force = args.has('force');

  if (write && !force) {
    const conflicts = [...files.keys()].filter((path) => existsSync(path));
    if (conflicts.length > 0) {
      throw new Error(`refusing to overwrite existing integration files:\n- ${conflicts.join('\n- ')}\nPass --force only after reviewing every file.`);
    }
  }

  console.log(write ? 'Writing Ai-Memory-Free integration files:' : 'Dry run. Files that would be written:');
  for (const [path, content] of files) {
    console.log(`- ${path}`);
    if (!write) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  }

  if (!write) {
    console.log('No files changed. Re-run with --write after reviewing the plan.');
  } else {
    console.log('Integration scaffold created. No token or secret was written.');
  }
}

function parseArgs(args: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === 'write' || key === 'force') {
      parsed.set(key, 'true');
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    parsed.set(key, value);
    index += 1;
  }
  return parsed;
}

function required(args: Map<string, string>, key: string) {
  const value = args.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function validateNamespace(value: string) {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error('namespace must be 1-128 characters using letters, numbers, underscore, dot, colon, or dash');
  }
  return value;
}

function validateApiUrl(value: string) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('api URL must use http or https');
  if (parsed.username || parsed.password) throw new Error('api URL must not contain credentials');
  if (parsed.hash) throw new Error('api URL must not contain a fragment');
  return parsed.toString().replace(/\/$/, '');
}

function mcpExample(apiUrl: string, memoryRepo: string) {
  return `${JSON.stringify({
    mcpServers: {
      'ai-memory-free': {
        command: 'npm',
        args: ['--prefix', memoryRepo, 'run', 'mcp'],
        env: {
          MEMORY_API_URL: apiUrl,
          MEMORY_TOKEN: '<set-in-client-secret-store>',
        },
      },
    },
  }, null, 2)}\n`;
}

function integrationReadme(namespace: string, apiUrl: string, memoryRepo: string) {
  return `# Ai-Memory-Free integration

This repository uses [Ai-Memory-Free](https://github.com/BizrnrAI/Ai-Memory-Free) as an external, LLM-agnostic memory service.

## Connection

- Namespace: \`${namespace}\`
- API URL: \`${apiUrl}\`
- Local adapter repository: \`${memoryRepo}\`
- Token: supplied by the MCP client secret store as \`MEMORY_TOKEN\`; never commit it

Copy \`mcp.json.example\` into the configuration format used by your AI client, then replace the token placeholder through that client secret store or process environment.

## Agent behavior

Give \`AGENT_POLICY.md\` to any AI agent working in this repository. It defines when to recall, remember, retire, and supersede knowledge without coupling the project to a particular model.
`;
}

function agentPolicy(namespace: string) {
  return `# Shared memory policy

Use the Ai-Memory-Free namespace \`${namespace}\` for durable knowledge about this project.

1. Recall before making assumptions about architecture, deployment, decisions, runbooks, or prior corrections.
2. Store only durable facts, decisions, corrections, references, and procedures that will help a future session.
3. Include useful provenance in \`source\`, narrow tags, and a calibrated importance score.
4. Supersede an outdated memory instead of creating conflicting active truth.
5. Use \`track: false\` for tests, health checks, and automated evaluation.
6. Never store passwords, API keys, bearer tokens, private keys, or customer secrets as semantic memory.
7. Use secret tools only from a dedicated trusted process with an explicit \`secrets:*\` grant.
8. The memory returns ranked evidence. The calling model remains responsible for reasoning and should identify uncertainty or contradictions.
`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
