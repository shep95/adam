import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestIndex, packSnapshot, unpackRows } from './trackArchive.js';

test('snapshots pack compactly and skip records without a position or id', () => {
  const snap = packSnapshot(
    {
      flights: [
        { icao24: 'abc123', lat: 51.47123456, lon: -0.4543 },
        { icao24: 'nopos' },
        { lat: 1, lon: 1 },
      ],
      'ais-live-vessels': [{ mmsi: 211000000, lat: 53.5, lon: 9.9 }],
    },
    1000,
  );
  assert.equal(snap.t, 1000);
  assert.deepEqual(snap.rows, [
    ['flights', 'abc123', 51.4712, -0.4543],
    ['ais-live-vessels', '211000000', 53.5, 9.9],
  ]);
  assert.deepEqual(unpackRows(snap)[0], {
    layerKey: 'flights',
    id: 'abc123',
    lat: 51.4712,
    lon: -0.4543,
  });
});

test('nearest snapshot by time', () => {
  const t = [100, 200, 300, 400];
  assert.equal(nearestIndex(t, 90), 0);
  assert.equal(nearestIndex(t, 240), 1);
  assert.equal(nearestIndex(t, 260), 2);
  assert.equal(nearestIndex(t, 999), 3);
  assert.equal(nearestIndex([], 5), -1);
});
