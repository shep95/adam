import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, applyScenario } from './scenarios.js';

const LAYER_IDS =
  'airspace-firs airspace-restricted ais-live-vessels alpr-cameras bikeshare cctv directions earthquakes fire-perimeters flights infra-border-crossings infra-chokepoints infra-ixps infra-pipelines infra-power-lines local-dams local-datacenters local-firms maritime-zones military military-awareness military-installations radio recent-imagery rocket-launches satellites telegeography-submarine-cables traffic transit weather-cyclones weather-lightning weather-radar weather-satellite wind'.split(
    ' ',
  );

test('every scenario names only real layers', () => {
  for (const s of SCENARIOS)
    for (const l of s.layers) assert.ok(LAYER_IDS.includes(l), `${s.id}: ${l}`);
});

test('apply replaces the picture and sets the mission', async () => {
  const enabled = new Set(['transit', 'flights']);
  const dm = {
    getAll: () => LAYER_IDS.map((id) => ({ id, enabled: enabled.has(id) })),
    setEnabled: async (id, on) => (on ? enabled.add(id) : enabled.delete(id)),
  };
  let mission = null;
  const intel = { setMission: (m) => (mission = m), getMission: () => null };
  const r = await applyScenario(dm, 'port-watch', { intel });
  assert.equal(r.ok, true);
  assert.deepEqual(r.off.sort(), ['flights', 'transit']);
  assert.ok(enabled.has('ais-live-vessels') && enabled.has('cctv'));
  assert.ok(!enabled.has('transit'));
  assert.match(mission.text, /port/);
  const add = await applyScenario(dm, 'space', { replace: false, intel });
  assert.deepEqual(add.off, []);
  assert.ok(enabled.has('cctv') && enabled.has('satellites'));
  assert.equal((await applyScenario(dm, 'nope')).ok, false);
});
