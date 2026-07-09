import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntegrationFiles, defaultNamespace } from '../scripts/scaffold-integration.js';

test('integration scaffold is model-neutral and never writes a credential', () => {
  const files = buildIntegrationFiles({
    target: '/tmp/example-project',
    namespace: 'example-project',
    apiUrl: 'https://project.supabase.co/functions/v1/memory',
    memoryRepo: '/opt/Ai-Memory-Free',
  });
  const combined = [...files.values()].join('\n');

  assert.match(combined, /example-project/);
  assert.match(combined, /memory_remember|remember/i);
  assert.match(combined, /<set-in-client-secret-store>/);
  assert.doesNotMatch(combined, /amf_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(combined, /OpenAI|Anthropic|Gemini API/);
});

test('integration scaffold rejects unsafe namespace syntax and protocols', () => {
  assert.throws(() => buildIntegrationFiles({
    target: '/tmp/example-project',
    namespace: '../escape',
    apiUrl: 'https://project.supabase.co/functions/v1/memory',
    memoryRepo: '/opt/Ai-Memory-Free',
  }), /namespace/);

  assert.throws(() => buildIntegrationFiles({
    target: '/tmp/example-project',
    namespace: 'safe',
    apiUrl: 'file:///tmp/memory',
    memoryRepo: '/opt/Ai-Memory-Free',
  }), /http or https/);

  assert.throws(() => buildIntegrationFiles({
    target: '/tmp/example-project',
    namespace: 'safe',
    apiUrl: 'https://token@example.com/functions/v1/memory',
    memoryRepo: '/opt/Ai-Memory-Free',
  }), /must not contain credentials/);
});

test('default namespace is derived from the target repository name', () => {
  assert.equal(defaultNamespace('/work/My Project'), 'My-Project');
});
