import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aheadPlan,
  distanceKm,
  formatDuration,
  greatCircle,
  speedKts,
} from './contactAheadModel.js';

test('great circle ends at both airports and bends north over the atlantic', () => {
  const p = greatCircle(40.64, -73.78, 51.47, -0.45, 20); // JFK → LHR
  assert.equal(p.length, 21);
  assert.ok(
    Math.abs(p[0].lat - 40.64) < 1e-6 && Math.abs(p.at(-1).lon + 0.45) < 1e-6,
  );
  assert.ok(Math.max(...p.map((x) => x.lat)) > 51.5);
  assert.ok(Math.abs(distanceKm(40.64, -73.78, 51.47, -0.45) - 5540) < 30);
});

test('route plan gives distance and ETA; no destination falls back to dead reckoning', () => {
  const plan = aheadPlan(
    { lat: 50, lon: -30, speedMps: 250 },
    {
      origin: { code: 'JFK' },
      destination: { code: 'LHR', name: 'London', lat: 51.47, lon: -0.45 },
    },
    { nowMs: Date.parse('2026-09-25T10:00:00Z') },
  );
  assert.equal(plan.mode, 'route');
  assert.equal(plan.to, 'LHR');
  assert.ok(plan.distanceKm > 2000 && plan.distanceKm < 2200);
  assert.ok(plan.etaMin > 130 && plan.etaMin < 150);
  assert.match(plan.etaUtc, /^12:/);
  assert.equal(
    aheadPlan({ lat: 1, lon: 2, speedKts: 12 }, null).mode,
    'dead-reckoning',
  );
  assert.equal(aheadPlan({}, null), null);
  assert.equal(speedKts({ speedMps: 100 }).toFixed(1), '194.4');
  assert.equal(formatDuration(135), '2 h 15 min');
  assert.equal(formatDuration(4), '4 min');
});
