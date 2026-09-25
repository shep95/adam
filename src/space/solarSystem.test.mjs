import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asteroidBelt,
  diameterKm,
  impactEffects,
  normalizeCloseApproaches,
  orbitPath,
  planetPositions,
  PLANETS,
} from './solarSystem.js';

const at = (iso) => planetPositions(new Date(iso));
const find = (list, name) => list.find((p) => p.name === name);

test('Mars at its October 2020 opposition was ~0.42 AU away', () => {
  const mars = find(at('2020-10-13T23:00:00Z'), 'mars');
  assert.ok(
    Math.abs(mars.earthDistanceAu - 0.4149) < 0.01,
    mars.earthDistanceAu,
  );
});

test('Jupiter and Saturn met in the sky on 2020-12-21', () => {
  const list = at('2020-12-21T18:00:00Z');
  const j = find(list, 'jupiter');
  const s = find(list, 'saturn');
  const sep = Math.hypot(
    (j.raDeg - s.raDeg) * Math.cos((j.decDeg * Math.PI) / 180),
    j.decDeg - s.decDeg,
  );
  assert.ok(sep < 0.3, `separation ${sep}°`);
});

test('Earth sits at ~1 AU, orbits close, the belt keeps its gaps', () => {
  const e = find(at('2026-01-03T00:00:00Z'), 'earth');
  assert.ok(e.sunDistanceAu > 0.98 && e.sunDistanceAu < 0.99); // perihelion
  const path = orbitPath(PLANETS[3], new Date());
  assert.ok(Math.hypot(...path[0]) - Math.hypot(...path.at(-1)) < 1e-9);
  const belt = asteroidBelt(400);
  assert.equal(belt.length, 400);
  assert.ok(
    belt.every(([x, y]) => Math.hypot(x, y) > 1.7 && Math.hypot(x, y) < 3.6),
  );
});

test('impact energy: Chelyabinsk-sized rock is ~0.4 Mt', () => {
  const hit = impactEffects(19, 19);
  assert.ok(hit.energyMt > 0.3 && hit.energyMt < 0.6, hit.energyMt);
  assert.equal(hit.reachesGround, false);
  assert.ok(impactEffects(1000, 20).craterKm > 5);
  assert.ok(Math.abs(diameterKm(22) - 0.14) < 0.02);
});

test('close-approach rows normalise with lunar distance and an if-it-hit estimate', () => {
  const rows = normalizeCloseApproaches({
    fields: ['des', 'cd', 'dist', 'v_rel', 'h', 'fullname'],
    data: [
      [
        '2024 XY',
        '2026-Oct-01 12:00',
        '0.00257',
        '10.5',
        '26',
        '     (2024 XY)',
      ],
    ],
  });
  assert.equal(rows[0].name, '(2024 XY)');
  assert.equal(rows[0].distanceLunar, 1);
  assert.ok(rows[0].diameterM > 15 && rows[0].diameterM < 40);
  assert.ok(rows[0].ifItHit.energyMt > 0);
});
