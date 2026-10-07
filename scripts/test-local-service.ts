import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Requires a running local Supabase stack; never connects to a linked project.
const dir = mkdtempSync(join(tmpdir(), 'ai-memory-service-test-'));
const envFile = join(dir, '.env');
const token = randomBytes(40).toString('base64url');
writeFileSync(envFile, `MEMORY_TOKEN=${token}\nMEMORY_MAX_CONTENT_BYTES=4096\n`, { mode: 0o600 });
const runtime = spawn('supabase', ['functions', 'serve', '--no-verify-jwt', '--env-file', envFile], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
let exited = false;
runtime.on('exit', () => { exited = true; });
runtime.on('error', () => { exited = true; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !exited; attempt += 1) {
    try {
      const result = await fetch('http://127.0.0.1:54321/functions/v1/memory', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'health' }), signal: AbortSignal.timeout(2000),
      });
      await result.body?.cancel();
      if (result.ok) { ready = true; break; }
    } catch { /* The local runtime is still booting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('local memory runtime did not become ready; start Supabase first');
  // The local stack's publishable key (the legacy name is the anon key): the
  // OAuth test signs a throwaway user in with it.
  const status = spawnSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' });
  const keys = JSON.parse(status.stdout || '{}') as { PUBLISHABLE_KEY?: string; ANON_KEY?: string };
  const publishableKey = keys.PUBLISHABLE_KEY ?? keys.ANON_KEY;
  if (!publishableKey) throw new Error('supabase status did not report the local publishable key');
  const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/service.test.ts'], {
    stdio: 'inherit', env: {
      ...process.env, MEMORY_TEST_API_URL: 'http://127.0.0.1:54321/functions/v1/memory',
      MEMORY_TEST_TOKEN: token, MEMORY_TEST_DB_CONTAINER: 'supabase_db_ai-memory-free',
      MEMORY_TEST_PUBLISHABLE_KEY: publishableKey,
    },
  });
  process.exitCode = tests.status ?? 1;
} finally {
  runtime.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}
