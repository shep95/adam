import test from 'node:test';
import assert from 'node:assert/strict';
import { circleRing } from './geoMeasure.js';
import { pointInPolygon } from './geo.js';
import {
  closestApproach,
  etaToZone,
  formatMinutes,
  predictTrack,
  predictionSentence,
} from './predict.js';
import { recommendActions } from './recommend.js';

test('dead reckoning: 12 kt due east covers ~22 km an hour, band grows', () => {
  const t = predictTrack(
    { lat: 26, lon: 56, speedKts: 12, headingDeg: 90, domain: 'vessel' },
    { horizonMin: 120, stepMin: 60 },
  );
  assert.equal(t.length, 3);
  assert.ok(
    Math.abs(t[1].lon - 56 - 22.2 / (111.32 * Math.cos((26 * Math.PI) / 180))) <
      0.01,
  );
  assert.ok(t[2].radiusKm > t[1].radiusKm);
  assert.deepEqual(
    predictTrack({ lat: 0, lon: 0, speedKts: 0.1, headingDeg: 0 }),
    [],
  );
});

test('ETA to a zone, refined between steps, with a sentence', () => {
  const track = predictTrack(
    { lat: 26, lon: 56, speedKts: 12, headingDeg: 90, domain: 'vessel' },
    { horizonMin: 600, stepMin: 30 },
  );
  const zone = circleRing({ lat: 26, lon: 57 }, 20);
  const eta = etaToZone(track, zone);
  // 100 km to the centre, 20 km radius → ~80 km at 22.2 km/h ≈ 216 min
  assert.ok(Math.abs(eta.minutes - 216) < 6, `${eta.minutes}`);
  assert.match(
    predictionSentence('RUNNER', eta, 'the exclusion zone'),
    /enters the exclusion zone in 3 h 3\d m/,
  );
  assert.equal(etaToZone(track, circleRing({ lat: 40, lon: 0 }, 10)), null);
  assert.equal(formatMinutes(252), '4 h 12 m');
  const cpa = closestApproach(track, { lat: 26.2, lon: 57 });
  assert.ok(cpa.km < 25);
});

test('recommendations: arm uncovered items, camera for vessels, fix faults', () => {
  const items = [
    {
      id: 'c',
      kind: 'dark-near-military',
      title: 'AIS DARK NEAR MILITARY AIR',
      label: 'x',
      lat: 26.5,
      lon: 56.3,
      score: 80,
      why: 'w',
    },
    {
      id: 'o',
      kind: 'orbit',
      title: 'ORBIT',
      label: 'y',
      lat: 40,
      lon: 10,
      score: 55,
      why: 'w',
    },
    {
      id: 'f',
      kind: 'fault',
      title: 'FEED UNAVAILABLE · CCTV',
      label: '',
      lat: null,
      lon: null,
      score: 30,
      why: 'w',
    },
  ];
  const recs = recommendActions(items, {
    alertRings: [circleRing({ lat: 40, lon: 10 }, 50)],
    pointInPolygon,
    mission: {
      areas: [{ lat: 12, lon: 44, radiusKm: 100, label: 'Bab el-Mandeb' }],
    },
  });
  const types = recs.map((r) => r.action.type);
  assert.equal(types[0], 'arm-alert');
  assert.ok(types.includes('cctv'));
  assert.ok(types.includes('track'));
  assert.ok(
    !recs.some((r) => r.action.type === 'arm-alert' && r.action.lat === 40),
    'orbit already covered',
  );
  assert.ok(recs.some((r) => /Bab el-Mandeb/.test(r.title)));
  assert.ok(recs.every((r) => r.why));
});
