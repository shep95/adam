import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficFlowSnapshot } from './index.js';

test('traffic snapshot ranks closures then the slowest roads', () => {
  const road = (level, closure = false, type = 'primary') => ({
    type,
    coordinates: [[-97.74, 30.27], [-97.73, 30.27], [-97.72, 30.27]],
    flow: level === null ? null : { level, closure },
  });
  const snap = trafficFlowSnapshot(
    { _roads: [road(0.9), road(0.3, false, 'motorway'), road(0, true), road(null)], _flowCoveragePct: 66 },
    { limit: 2 },
  );
  assert.equal(snap.live, true);
  assert.equal(snap.roadsWithFlow, 3);
  assert.equal(snap.mostCongested[0].closed, true);
  assert.equal(snap.mostCongested[1].roadClass, 'motorway');
  assert.equal(snap.mostCongested[1].flowRatio, 0.3);
  assert.ok(snap.mostCongested[1].lengthKm > 1.5 && snap.mostCongested[1].lengthKm < 2.5);
  assert.equal(trafficFlowSnapshot({ _roads: [] }).live, false);
});
