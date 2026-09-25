import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circleRing,
  corridorRing,
  destination,
  formatArea,
  formatBearing,
  formatDistance,
  greatCircleKm,
  greatCirclePath,
  initialBearingDeg,
  measurePath,
  polygonAreaKm2,
  rhumb,
  rhumbPath,
} from './geoMeasure.js';

const JFK = { lat: 40.6413, lon: -73.7781 };
const LHR = { lat: 51.47, lon: -0.4543 };

test('great circle vs rhumb, JFK → LHR', () => {
  const gc = greatCircleKm(JFK, LHR);
  assert.ok(Math.abs(gc - 5555) < 15, `gc ${gc}`);
  const rh = rhumb(JFK, LHR);
  assert.ok(rh.km > gc, 'rhumb is longer');
  assert.ok(Math.abs(initialBearingDeg(JFK, LHR) - 51) < 2);
  assert.ok(Math.abs(rh.bearingDeg - 78) < 3);
  const path = greatCirclePath(JFK, LHR, 20);
  assert.equal(path.length, 21);
  assert.ok(
    path.some((p) => p.lat > 52),
    'great circle bows north',
  );
  const rp = rhumbPath(JFK, LHR, 10);
  assert.ok(rp.every((p) => p.lat <= 51.48));
});

test('destination round-trips distance and bearing', () => {
  const p = destination(JFK, 1000, 45);
  assert.ok(Math.abs(greatCircleKm(JFK, p) - 1000) < 0.01);
  assert.ok(Math.abs(initialBearingDeg(JFK, p) - 45) < 0.01);
});

test('area: a 1°×1° cell at the equator is about 12,364 km²', () => {
  const a = polygonAreaKm2([
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ]);
  assert.ok(Math.abs(a - 12364) < 60, `${a}`);
  const ring = circleRing({ lat: 10, lon: 10 }, 50);
  const circ = polygonAreaKm2(ring.map(([lon, lat]) => ({ lat, lon })));
  assert.ok(Math.abs(circ - Math.PI * 2500) / (Math.PI * 2500) < 0.01);
});

test('corridor is a closed band around the line', () => {
  const ring = corridorRing(
    [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
    ],
    10,
  );
  assert.equal(ring.length, 4);
  const lats = ring.map(([, lat]) => lat);
  assert.ok(Math.max(...lats) > 0.08 && Math.min(...lats) < -0.08);
});

test('path and formatting', () => {
  const m = measurePath([JFK, LHR, { lat: 48.85, lon: 2.35 }]);
  assert.equal(m.legs.length, 2);
  assert.ok(m.totalKm > 5555);
  assert.equal(formatDistance(1.852, 'nm'), '1.00 nm');
  assert.equal(formatDistance(5555.4), '5,555 km');
  assert.equal(formatBearing(5.4), '005°');
  assert.equal(formatArea(3.429904, 'nm'), '1 nm²');
});
