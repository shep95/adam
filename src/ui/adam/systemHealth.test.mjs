import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth, healthLine } from './systemHealth.js';

const snap = (id, feedState, extra = {}) => ({
  id,
  name: id,
  enabled: true,
  feedState,
  ...extra,
});

test('nominal when every enabled feed is nominal', () => {
  const h = assessHealth([snap('flights', 'nominal'), snap('x', 'off')]);
  assert.equal(h.level, 'nominal');
  assert.equal(h.faults, 0);
  assert.equal(healthLine(h), 'all enabled feeds nominal');
});

test('one stale layer is a watch, two faults pulse degraded', () => {
  assert.equal(assessHealth([snap('ais', 'stale')]).level, 'watch');
  const h = assessHealth([
    snap('ais', 'stale', { ageLabel: '12m' }),
    snap('cctv', 'unavailable'),
    snap('traffic', 'fallback'),
  ]);
  assert.equal(h.level, 'degraded');
  assert.deepEqual(
    h.down.map((r) => r.id),
    ['cctv'],
  );
  assert.equal(h.stale[0].age, '12m');
  assert.equal(h.fallback[0].id, 'traffic');
  assert.match(healthLine(h), /down: cctv · stale: ais · fallback: traffic/);
});

test('fallbacks alone never pulse', () => {
  const h = assessHealth([snap('a', 'fallback'), snap('b', 'partial')]);
  assert.equal(h.level, 'watch');
});

test('capabilities: offline degrades, missing 3D tiles is informational', () => {
  const h = assessHealth([], {
    online: false,
    photoreal: false,
    shepherd: { configured: 0 },
  });
  assert.equal(h.level, 'degraded');
  const ids = h.capabilities.filter((c) => !c.ok).map((c) => c.id);
  assert.deepEqual(ids, ['network', 'photoreal', 'shepherd']);
  assert.equal(
    assessHealth([], { photoreal: false, shepherd: null }).level,
    'nominal',
  );
});

test('disabled and malformed input is ignored', () => {
  assert.equal(assessHealth(null).level, 'nominal');
  assert.equal(
    assessHealth([{ id: 'x', enabled: false, feedState: 'unavailable' }])
      .faults,
    0,
  );
});
