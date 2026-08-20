import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = process.cwd();
const required = [
  'README.md',
  'AI.md',
  'INSTALL_WITH_AI.md',
  'AGENTS.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'CITATION.cff',
  'llms.txt',
  'docs/INDEX.md',
  'docs/AI_AGENT_INSTALL.md',
  'docs/FAQ.md',
  'docs/PUBLIC_RELEASE.md',
  'docs/MODULES.md',
  'docs/PROTOCOL.md',
  'docs/PORTABILITY.md',
  'docs/EVENTS.md',
  'docs/PROVENANCE.md',
  'docs/DOCUMENTS.md',
  'docs/REMOTE_MCP.md',
  'docs/UPGRADE_V1_2.md',
  'schemas/request-v1.schema.json',
  'schemas/module-manifest.schema.json',
  'schemas/portable-v1.schema.json',
];

const errors: string[] = [];
for (const path of required) {
  if (!existsSync(resolve(root, path))) errors.push(`missing required public file: ${path}`);
}

const markdownFiles = [
  ...walkMarkdown(root),
].filter((path) => !path.includes('/node_modules/') && !path.includes('/.git/'));

for (const file of markdownFiles) validateLinks(file);

const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const aiEntry = readFileSync(resolve(root, 'AI.md'), 'utf8');
const aiInstall = readFileSync(resolve(root, 'docs/AI_AGENT_INSTALL.md'), 'utf8');
const license = readFileSync(resolve(root, 'LICENSE'), 'utf8');
const llms = readFileSync(resolve(root, 'llms.txt'), 'utf8');

requireText(readme, 'https://kristianpeter.com', 'README creator attribution');
requireText(readme, 'https://github.com/BizrnrAI/Ai-Memory-Free', 'README canonical repository URL');
requireText(readme, 'v1.3.0', 'README release version');
requireText(readme, 'Modular Capabilities', 'README module guidance');
requireText(aiEntry, 'docs/AI_AGENT_INSTALL.md', 'AI entry install routing');
requireText(aiInstall, 'Required Verification', 'AI install verification contract');
requireText(aiInstall, 'Never ask the user to paste', 'AI install secret-handling rule');
requireText(aiInstall, 'portable export', 'AI install portability verification');
requireText(license, 'Permission is hereby granted, free of charge', 'MIT grant text');
requireText(llms, 'LLM-agnostic', 'llms.txt model-neutral description');
requireText(llms, 'https://kristianpeter.com', 'llms.txt creator attribution');
requireText(readFileSync(resolve(root, 'docs/PORTABILITY.md'), 'utf8'), 'Deliberately Excluded', 'portable security exclusions');
requireText(readFileSync(resolve(root, 'docs/REMOTE_MCP.md'), 'utf8'), 'OAuth 2.1', 'remote MCP authorization');

if (errors.length > 0) {
  throw new Error(`documentation validation failed:\n- ${errors.join('\n- ')}`);
}

console.log(`validated ${markdownFiles.length} Markdown files and ${required.length} public-release requirements`);

function walkMarkdown(directory: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = resolve(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) results.push(...walkMarkdown(path));
    else if (extname(path) === '.md') results.push(path);
  }
  return results;
}

function validateLinks(file: string) {
  const content = readFileSync(file, 'utf8');
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (!rawTarget || rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const targetWithoutTitle = rawTarget.split(/\s+["']/)[0];
    const [relativePath, anchor] = targetWithoutTitle.split('#');
    if (!relativePath || relativePath.startsWith('/')) continue;
    const target = resolve(dirname(file), decodeURIComponent(relativePath));
    if (!existsSync(target)) {
      errors.push(`${relative(root, file)} links to missing ${rawTarget}`);
      continue;
    }
    if (anchor && extname(target) === '.md' && !hasHeadingAnchor(target, anchor)) {
      errors.push(`${relative(root, file)} links to missing heading ${rawTarget}`);
    }
  }
}

function hasHeadingAnchor(file: string, expected: string) {
  const headings = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => slug(line.replace(/^#{1,6}\s+/, '')));
  return headings.includes(expected.toLowerCase());
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function requireText(content: string, expected: string, label: string) {
  if (!content.includes(expected)) errors.push(`${label} is missing`);
}

function relative(base: string, path: string) {
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}
