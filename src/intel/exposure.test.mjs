import test from 'node:test';
import assert from 'node:assert/strict';
import { assessExposure, quakeReachKm } from './exposure.js';

test('quake reach grows with magnitude and ignores small events', () => {
  assert.equal(quakeReachKm(4.4), 0);
  assert.equal(quakeReachKm(5), 40);
  assert.equal(quakeReachKm(6.8), 250);
  assert.equal(quakeReachKm(8.1), 500);
});

test('assets inside a hazard reach are listed nearest first', () => {
  const now = Date.UTC(2026, 8, 25);
  const layers = {
    earthquakes: [
      {
        magnitude: 6.2,
        lat: 35.0,
        lon: 139.0,
        timeMs: now - 3600_000,
        place: 'near Tokyo',
      },
      { magnitude: 7.0, lat: 0, lon: 0, timeMs: now - 5 * 86_400_000 },
      { magnitude: 3.0, lat: 35.0, lon: 139.0, timeMs: now },
    ],
    'local-datacenters': [
      { name: 'DC-A', lat: 35.6, lon: 139.7 },
      { name: 'DC-far', lat: 40, lon: 139 },
    ],
    'local-dams': [{ name: 'Dam-1', lat: 35.2, lon: 138.9 }],
    'local-firms': [
      { frp: 400, lat: 35.21, lon: 138.9 },
      { frp: 10, lat: 35.6, lon: 139.7 },
    ],
  };
  const out = assessExposure((k) => layers[k] || [], { now });
  assert.equal(out.length, 2);
  const quake = out.find((e) => e.hazard.kind === 'quake');
  assert.deepEqual(quake.counts, { 'local-datacenters': 1, 'local-dams': 1 });
  assert.equal(quake.assets[0].name, 'Dam-1');
  assert.match(
    quake.statement,
    /1 dam, 1 datacentre within 100 km of M6\.2 quake near Tokyo — nearest Dam-1/,
  );
  const fire = out.find((e) => e.hazard.kind === 'fire');
  assert.equal(fire.assets[0].name, 'Dam-1');
});

test('no assets on means nothing to assess', () => {
  assert.deepEqual(
    assessExposure((k) =>
      k === 'earthquakes' ? [{ magnitude: 7, lat: 0, lon: 0 }] : [],
    ),
    [],
  );
});
