import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectGame,
  getConfiguredChatProviders,
  parseBuildResponse,
  redactSecrets,
  slugify,
  validateRobloxAction
} from './game-builder.js';

const manuals = [
  { id: 'roblox', aliases: ['roblox', 'roblox studio'] },
  { id: 'fortnite', aliases: ['fortnite', 'uefn', 'verse'] }
];

test('detects games from user conversation without matching assistant text', () => {
  assert.equal(detectGame([
    { role: 'assistant', text: 'Roblox uses Luau.' },
    { role: 'user', text: 'Fortnite, help me make a race track.' }
  ], manuals).id, 'fortnite');
  assert.equal(detectGame([{ role: 'user', text: 'Help me make an obby.' }], manuals), null);
  assert.equal(detectGame([
    { role: 'user', text: 'Fortnite, help me make a race track.' },
    { role: 'user', text: 'Actually Roblox.' }
  ], manuals).id, 'roblox');
});

test('parses only complete build response objects', () => {
  const result = parseBuildResponse(JSON.stringify({
    message: 'Here is the build.',
    diagnosis: '',
    buildSheet: ['1. Create a script.'],
    language: 'Luau',
    placement: 'ServerScriptService > Script',
    code: 'print("hello")',
    assetList: []
  }));
  assert.equal(result.language, 'Luau');
  assert.throws(() => parseBuildResponse('not JSON'));
  assert.throws(() => parseBuildResponse('{"message":"missing sections"}'));
});

test('redacts common credential formats and labeled secrets', () => {
  const output = redactSecrets('api_key=abc123 ghp_123456789012345678901234567890');
  assert.doesNotMatch(output, /abc123|ghp_123456789012345678901234567890/);
  assert.match(output, /\[redacted/);
});

test('uses xAI first when configured, then falls back to Groq and OpenRouter', () => {
  const xaiKey = 'xai-test-secret';
  const providers = getConfiguredChatProviders({
    XAI_API_KEY: xaiKey,
    GROQ_API_KEY: 'groq-test-secret',
    OPENROUTER_API_KEY: 'optional-openrouter-fallback'
  });
  assert.equal(providers[0].provider, 'xai');
  assert.equal(providers[0].baseUrl, 'https://api.x.ai/v1');
  assert.equal(providers[0].model, 'grok-4.20-0309-non-reasoning');
  assert.equal(providers[0].apiKey, xaiKey);
  assert.equal(providers[1].provider, 'groq');
  assert.equal(providers[2].provider, 'openrouter');
  assert.deepEqual(getConfiguredChatProviders({}), []);
});

test('prefers Groq over OpenRouter when xAI is not configured', () => {
  const secret = 'groq-test-secret';
  const providers = getConfiguredChatProviders({
    GROQ_API_KEY: secret,
    OPENROUTER_API_KEY: 'optional-openrouter-fallback'
  });
  assert.equal(providers[0].provider, 'groq');
  assert.equal(providers[0].baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(providers[0].model, 'qwen/qwen3.8-27b');
  assert.equal(providers[0].apiKey, secret);
  assert.equal(providers[1].provider, 'openrouter');
});

test('creates safe project slugs', () => {
  assert.equal(slugify('../../Double Jump!'), 'double-jump');
  assert.equal(slugify('***'), 'game-build');
});

test('validates Roblox read and write payloads before API use', () => {
  assert.deepEqual(validateRobloxAction({
    type: 'read_datastore',
    universeId: '12345',
    datastoreName: 'PlayerData',
    entryKey: 'player-1'
  }), {
    type: 'read_datastore',
    universeId: '12345',
    datastoreName: 'PlayerData',
    entryKey: 'player-1'
  });
  assert.equal(validateRobloxAction({
    type: 'announcement',
    universeId: 'not-an-id',
    topic: 'News',
    message: 'Hello'
  }), null);
});
