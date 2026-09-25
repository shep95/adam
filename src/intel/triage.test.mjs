import test from 'node:test';
import assert from 'node:assert/strict';
import { correlate } from './correlate.js';
import { missionWords, triage } from './triage.js';

const now = Date.UTC(2026, 8, 25, 12);

test('correlation: AIS dark near military aircraft, orbit over meeting, clusters', () => {
  const findings = [
    {
      kind: 'ais-dark',
      id: 'v1',
      label: 'RUNNER',
      lat: 26.5,
      lon: 56.3,
      since: now - 1800_000,
      confidence: 0.5,
    },
    {
      kind: 'orbit',
      id: 'a1',
      label: 'RCH01',
      lat: 26.6,
      lon: 56.4,
      since: now - 3600_000,
      confidence: 0.6,
    },
    {
      kind: 'meeting',
      id: 'v2|v3',
      label: 'A + B',
      lat: 26.55,
      lon: 56.35,
      since: now - 2400_000,
      confidence: 0.35,
    },
    {
      kind: 'orbit',
      id: 'far',
      label: 'FAR',
      lat: 0,
      lon: 0,
      since: now,
      confidence: 0.6,
    },
  ];
  const military = [
    { icao24: 'm1', lat: 26.8, lon: 56.5, onGround: false },
    { icao24: 'm2', lat: 40, lon: 10, onGround: false },
  ];
  const out = correlate(findings, { military, now });
  const kinds = out.map((c) => c.kind).sort();
  assert.deepEqual(kinds, [
    'dark-near-military',
    'orbit-over-dark',
    'orbit-over-meeting',
    'pattern-cluster',
  ]);
  const dark = out.find((c) => c.kind === 'dark-near-military');
  assert.deepEqual(dark.members, ['v1', 'm1']);
  assert.ok(out.every((c) => c.alternative));
});

test('triage ranks alerts and correlations above routine patterns, and explains', () => {
  const items = triage({
    trips: [
      {
        rule: {
          id: 'r1',
          label: 'hormuz mil',
          ring: [
            [56, 26],
            [57, 26],
            [57, 27],
          ],
        },
        result: { detail: '3 in zone' },
        trippedAt: now - 60_000,
      },
    ],
    correlations: [
      {
        kind: 'orbit-over-dark',
        title: 'ORBIT NEAR AIS-DARK VESSEL',
        label: 'x',
        lat: 26.5,
        lon: 56.3,
        since: now,
        confidence: 0.7,
        members: ['a', 'b'],
        alternative: 'patrol',
      },
    ],
    patterns: [
      {
        kind: 'jump',
        id: 'j',
        title: 'POSITION JUMP',
        label: 'y',
        detail: 'z',
        lat: 1,
        lon: 1,
        since: now,
        confidence: 0.5,
        alternative: 'glitch',
      },
    ],
    faults: [{ id: 'cctv', name: 'CCTV', state: 'unavailable' }],
    now,
  });
  assert.deepEqual(
    items.map((i) => i.kind),
    ['alert', 'orbit-over-dark', 'jump', 'fault'],
  );
  assert.ok(items[0].score > 90);
  assert.match(items[1].why, /or: patrol/);
});

test('mission focus lifts matching items', () => {
  const base = {
    patterns: [
      {
        kind: 'orbit',
        id: 'o',
        title: 'ORBIT',
        label: 'over hormuz',
        detail: '',
        lat: 26.5,
        lon: 56.3,
        since: now,
        confidence: 0.5,
        alternative: '',
      },
      {
        kind: 'jump',
        id: 'j',
        title: 'POSITION JUMP',
        label: 'baltic',
        detail: '',
        lat: 55,
        lon: 15,
        since: now,
        confidence: 0.5,
        alternative: '',
      },
    ],
    now,
  };
  const plain = triage(base);
  assert.equal(plain[0].score, plain[1].score);
  const focused = triage({
    ...base,
    mission: {
      words: missionWords('watch the Strait of Hormuz for orbits'),
      areas: [{ lat: 26.5, lon: 56.3, radiusKm: 150 }],
    },
  });
  assert.equal(focused[0].id, 'pattern:orbit:o');
  assert.ok(focused[0].score - focused[1].score >= 20);
  assert.match(focused[0].why, /matches mission/);
  assert.deepEqual(missionWords('Watch the port of Rotterdam today'), [
    'port',
    'rotterdam',
  ]);
});
