import test from 'node:test';
import assert from 'node:assert/strict';

import * as mod from './captureMath.js';

test('file names carry a local timestamp', () => {
  assert.equal(
    mod.stampName('adam', 'png', new Date(2026, 8, 25, 7, 4, 9)),
    'adam-20260925-070409.png',
  );
});

test('recorder prefers mp4, then webm, then nothing', () => {
  assert.equal(
    mod.pickRecorderType((t) => t.startsWith('video/webm')),
    'video/webm;codecs=vp9',
  );
  assert.equal(
    mod.pickRecorderType((t) => t === 'video/mp4'),
    'video/mp4',
  );
  assert.equal(
    mod.pickRecorderType(() => false),
    '',
  );
});

test('scale snaps to the offered steps', () => {
  assert.equal(mod.clampScale(1.27), 1.3);
  assert.equal(mod.clampScale('0.5'), 0.8);
  assert.equal(mod.clampScale('junk'), 1);
  assert.deepEqual([...mod.UI_SCALES], [0.8, 0.9, 1, 1.15, 1.3, 1.4]);
});
