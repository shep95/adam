import test from 'node:test';
import assert from 'node:assert/strict';
import { newlyEnabled, thinPositions } from './motionMath.js';

test('only layers that turned on announce themselves', () => {
  assert.deepEqual(newlyEnabled(new Set(['a']), new Set(['a', 'b', 'c'])), [
    'b',
    'c',
  ]);
  assert.deepEqual(newlyEnabled(new Set(['a', 'b']), new Set(['a'])), []);
});

test('trail thinning keeps both ends and caps the count', () => {
  const src = Array.from({ length: 1000 }, (_, i) => i);
  const out = thinPositions(src, 160);
  assert.equal(out.length, 160);
  assert.equal(out[0], 0);
  assert.equal(out.at(-1), 999);
  assert.deepEqual(thinPositions([1, 2, 3], 160), [1, 2, 3]);
});
