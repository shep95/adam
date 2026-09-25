import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSceneLink,
  encodeSceneLink,
  sceneLinkUrl,
  scenePayloadFromHash,
} from './sceneLink.js';

test('scene documents round-trip through a compact link', async () => {
  const doc = JSON.stringify({
    version: 6,
    scenes: [
      {
        id: 's1',
        name: 'Strait watch',
        shots: Array(40).fill({ camera: [1, 2, 3] }),
      },
    ],
  });
  const payload = await encodeSceneLink(doc);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.ok(payload.length < doc.length);
  assert.equal(await decodeSceneLink(payload), doc);
  const url = sceneLinkUrl(payload, {
    origin: 'https://adam.example',
    pathname: '/',
  });
  assert.equal(scenePayloadFromHash(new URL(url).hash), payload);
});

test('malformed or absent payloads are refused', async () => {
  assert.equal(scenePayloadFromHash('#other=1'), null);
  await assert.rejects(decodeSceneLink('not base64!'), /malformed/);
});
