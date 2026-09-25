import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_KEYS_HEADER,
  clearUserKeys,
  maskKey,
  readUserKeys,
  saveUserKey,
  userKeyHeaders,
} from './userKeys.js';
import {
  envForRequest,
  parseUserKeys,
} from '../../server/shepherd/userKeys.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('keys save locally, validate, mask and clear', () => {
  const s = memoryStorage();
  assert.deepEqual(readUserKeys(s), {});
  assert.deepEqual(userKeyHeaders(s), {});
  assert.equal(
    saveUserKey('anthropic', 'sk-ant-api03-abcdef123456', s).ok,
    true,
  );
  assert.equal(saveUserKey('anthropic', 'short', s).ok, false);
  assert.equal(saveUserKey('nope', 'sk-whatever-123456', s).ok, false);
  assert.equal(saveUserKey('gemini', '  AIzaSyExample123456  ', s).ok, true);
  assert.deepEqual(readUserKeys(s), {
    anthropic: 'sk-ant-api03-abcdef123456',
    gemini: 'AIzaSyExample123456',
  });
  assert.equal(maskKey('sk-ant-api03-abcdef123456'), 'sk-ant…3456');
  saveUserKey('gemini', '', s);
  assert.deepEqual(Object.keys(readUserKeys(s)), ['anthropic']);
  clearUserKeys(s);
  assert.deepEqual(readUserKeys(s), {});
});

test('the header round-trips and replaces the server keys for that request', () => {
  const s = memoryStorage();
  saveUserKey('openai', 'sk-proj-userkey-0001', s);
  const headers = userKeyHeaders(s);
  const req = {
    headers: { [USER_KEYS_HEADER.toLowerCase()]: headers[USER_KEYS_HEADER] },
  };
  assert.deepEqual(parseUserKeys(req), { openai: 'sk-proj-userkey-0001' });
  const server = {
    ANTHROPIC_API_KEY: 'server-anthropic-key',
    OPENAI_API_KEY: 'server-openai-key',
    GOOGLE_AI_API_KEY: 'server-google',
    OPENAI_CHAT_MODEL: 'gpt-x',
  };
  const { env, userKeys } = envForRequest(req, server);
  assert.equal(userKeys, true);
  assert.equal(env.OPENAI_API_KEY, 'sk-proj-userkey-0001');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GOOGLE_AI_API_KEY, undefined);
  assert.equal(env.OPENAI_CHAT_MODEL, 'gpt-x');
  assert.equal(envForRequest({ headers: {} }, server).env, server);
  for (const bad of [
    '%%%',
    Buffer.from('[1]').toString('base64'),
    'x'.repeat(5000),
  ])
    assert.deepEqual(
      parseUserKeys({ headers: { 'x-adam-provider-keys': bad } }),
      {},
    );
});

test('the standalone key map matches the provider registry', async () => {
  const { PROVIDERS } = await import('../../server/shepherd/providers.js');
  const { USER_KEY_ENVS } = await import('../../server/shepherd/userKeys.js');
  assert.deepEqual(
    USER_KEY_ENVS,
    Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.keyEnv])),
  );
});
