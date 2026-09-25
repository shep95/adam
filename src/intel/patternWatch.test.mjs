import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternWatch, cumulativeTurnDeg } from './patternWatch.js';

const MIN = 60_000;

function run(watch, frames) {
  for (const { t, layers } of frames)
    watch.sample((key) => layers[key] || [], t);
}

test('cumulative turn counts full circles', () => {
  const pts = [];
  for (let i = 0; i <= 16; i += 1)
    pts.push({ lat: 0, lon: 0, heading: i * 45 });
  assert.equal(Math.round(cumulativeTurnDeg(pts)), 720);
});

test('an aircraft circling a point is an orbit; a straight track is not', () => {
  const watch = createPatternWatch();
  const frames = [];
  for (let i = 0; i < 40; i += 1) {
    const a = (i * 40 * Math.PI) / 180;
    const t = i * 30_000;
    frames.push({
      t,
      layers: {
        flights: [
          {
            icao24: 'abc123',
            callsign: 'ORBIT1',
            lat: 50 + 0.1 * Math.sin(a),
            lon: 8 + 0.15 * Math.cos(a),
            heading: (i * 40 + 90) % 360,
            speedMps: 120,
            lastSeenMs: t,
          },
          {
            icao24: 'def456',
            lat: 40 + i * 0.02,
            lon: 0,
            heading: 0,
            speedMps: 230,
            lastSeenMs: t,
          },
        ],
      },
    });
  }
  run(watch, frames);
  const orbits = watch.findings({ kind: 'orbit' });
  assert.equal(orbits.length, 1);
  assert.equal(orbits[0].id, 'abc123');
  assert.equal(orbits[0].title, 'ORBIT');
  assert.match(orbits[0].alternative, /holding/);
});

test('a vessel under way that stops reporting goes AIS dark', () => {
  const watch = createPatternWatch();
  const frames = [];
  for (let i = 0; i < 5; i += 1)
    frames.push({
      t: i * MIN,
      layers: {
        'ais-live-vessels': [
          {
            mmsi: '111',
            name: 'RUNNER',
            lat: 26 + i * 0.01,
            lon: 56,
            speedKts: 12,
            courseDeg: 0,
            lastSeenMs: i * MIN,
          },
        ],
      },
    });
  run(watch, frames);
  assert.equal(watch.findings({ kind: 'ais-dark' }).length, 0);
  run(watch, [{ t: 30 * MIN, layers: {} }]);
  const dark = watch.findings({ kind: 'ais-dark' });
  assert.equal(dark.length, 1);
  assert.equal(dark[0].label, 'RUNNER');
});

test('two slow vessels together for 20 min in open water is a meeting', () => {
  const watch = createPatternWatch();
  const pair = (t) => [
    { mmsi: '201', name: 'A', lat: 10, lon: 60, speedKts: 0.5, lastSeenMs: t },
    {
      mmsi: '202',
      name: 'B',
      lat: 10.002,
      lon: 60.001,
      speedKts: 1,
      lastSeenMs: t,
    },
  ];
  const frames = [];
  for (let i = 0; i <= 25; i += 1)
    frames.push({ t: i * MIN, layers: { 'ais-live-vessels': pair(i * MIN) } });
  run(watch, frames);
  const m = watch.findings({ kind: 'meeting' });
  assert.equal(m.length, 1);
  assert.equal(m[0].label, 'A + B');
  assert.ok(m[0].confidence < 0.5);
});

test('an impossible jump is flagged', () => {
  const watch = createPatternWatch();
  run(watch, [
    {
      t: 0,
      layers: {
        'ais-live-vessels': [
          { mmsi: '9', lat: 0, lon: 0, speedKts: 10, lastSeenMs: 0 },
        ],
      },
    },
    {
      t: MIN,
      layers: {
        'ais-live-vessels': [
          { mmsi: '9', lat: 1, lon: 0, speedKts: 10, lastSeenMs: MIN },
        ],
      },
    },
  ]);
  assert.equal(watch.findings({ kind: 'jump' }).length, 1);
});

test('sampling is decimated', () => {
  const watch = createPatternWatch();
  assert.equal(
    watch.sample(() => [], 0),
    true,
  );
  assert.equal(
    watch.sample(() => [], 5000),
    false,
  );
});

test('snapshotAt interpolates held tracks for rewind', () => {
  const watch = createPatternWatch({ sampleEveryMs: 0 });
  for (let i = 0; i < 3; i += 1)
    watch.sample(
      (key) =>
        key === 'flights'
          ? [
              {
                icao24: 'a1',
                lat: i,
                lon: 179.5 + i * 0.5,
                lastSeenMs: i * MIN,
              },
            ]
          : [],
      i * MIN,
    );
  assert.deepEqual(watch.range(), { from: 0, to: 2 * MIN });
  const mid = watch.snapshotAt(MIN / 2);
  assert.equal(mid.length, 1);
  assert.ok(Math.abs(mid[0].lat - 0.5) < 1e-9);
  assert.ok(Math.abs(mid[0].lon - 179.75) < 1e-9);
  const wrapped = watch.snapshotAt(1.5 * MIN);
  assert.ok(
    Math.abs(wrapped[0].lon - -179.75) < 1e-9,
    'crosses the antimeridian',
  );
  assert.equal(watch.snapshotAt(20 * MIN).length, 0);
  assert.equal(watch.trackOf('flights', 'a1').length, 3);
});
