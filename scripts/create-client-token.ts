import { createHash, randomBytes } from 'node:crypto';

const options = parseArgs(process.argv.slice(2));
const token = `amf_${randomBytes(36).toString('base64url')}`;
const tokenHash = createHash('sha256').update(token).digest('hex');
const tokenPrefix = token.slice(0, 12);

console.log('Store this token now. It cannot be recovered from the database.');
console.log(`token: ${token}`);
console.log(`token_hash: ${tokenHash}`);
console.log('');
console.log('Run this reviewed SQL in the Supabase SQL editor:');
console.log('');
console.log(`insert into public.memory_clients (`);
console.log(`  name, token_hash, token_prefix, allowed_namespaces, permissions, expires_at`);
console.log(`) values (`);
console.log(`  ${sqlString(options.name)},`);
console.log(`  ${sqlString(tokenHash)},`);
console.log(`  ${sqlString(tokenPrefix)},`);
console.log(`  ${sqlArray(options.namespaces)},`);
console.log(`  ${sqlArray(options.permissions)},`);
console.log(`  ${options.expiresAt ? `${sqlString(options.expiresAt)}::timestamptz` : 'null'}`);
console.log(`);`);

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    values.set(argument.slice(2), value);
    index += 1;
  }

  const name = values.get('name') ?? 'mcp-client';
  const namespaces = csv(values.get('namespaces') ?? 'default');
  const permissions = csv(values.get('permissions') ?? 'memory:read,memory:write');
  const expiresAt = values.get('expires') ?? null;

  if (name.length > 128) throw new Error('--name must be 128 characters or fewer');
  if (namespaces.length === 0 || permissions.length === 0) throw new Error('grants cannot be empty');
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error('--expires must be an ISO timestamp');
  return { name, namespaces, permissions, expiresAt };
}

function csv(value: string) {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlArray(values: string[]) {
  return `array[${values.map(sqlString).join(', ')}]::text[]`;
}
