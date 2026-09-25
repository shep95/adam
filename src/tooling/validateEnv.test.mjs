import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEnv, parseDotenv } from '../../scripts/validate-env.mjs';

test('dotenv parsing handles comments, export and quotes', () => {
  assert.deepEqual(parseDotenv('# c\nexport A=1\nB="two"\nC=\nbad line'), {
    A: '1',
    B: 'two',
    C: '',
  });
});

test('a public host without the access gate is a blocking error', () => {
  const r = assessEnv({ VERCEL: '1', ANTHROPIC_API_KEY: 'x' });
  assert.ok(r.errors.some((e) => e.includes('ADAM_ACCESS_TOKEN')));
  const ok = assessEnv({ VERCEL: '1', ADAM_ACCESS_TOKEN: 'a'.repeat(40) });
  assert.equal(ok.errors.length, 0);
  assert.ok(ok.warnings.some((w) => w.includes('Shepherd')));
});

test('VITE_-prefixed secrets are flagged and values are never echoed', () => {
  const r = assessEnv({ VITE_OPENAI_API_KEY: 'sk-secret-value' });
  assert.ok(r.errors.some((e) => e.startsWith('VITE_OPENAI_API_KEY')));
  assert.ok(!JSON.stringify(r).includes('sk-secret-value'));
});
