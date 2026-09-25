import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sunPosition,
  moonIllumination,
  sunTimes,
  dayPhase,
  shadowGeometry,
  visibleStars,
  skyReading,
  compassPoint,
} from './astronomy.js';

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('sun at the June solstice noon over New York', () => {
  const p = sunPosition(new Date('2026-06-21T16:57:00Z'), 40.7128, -74.006);
  near(p.altitude, 72.7, 0.5, 'altitude');
  near(p.azimuth, 180, 3, 'azimuth');
});

test('sunrise and sunset in Austin on the equinox week', () => {
  const t = sunTimes(new Date('2026-09-24T05:00:00Z'), 30.27, -97.74);
  near(
    t.rise.getUTCHours() * 60 + t.rise.getUTCMinutes(),
    12 * 60 + 20,
    4,
    'rise',
  );
  near(
    t.set.getUTCHours() * 60 + t.set.getUTCMinutes(),
    25,
    4,
    'set (00:25 UTC next day)',
  );
});

test('polar day and polar night', () => {
  assert.equal(
    sunTimes(new Date('2026-06-21T00:00:00Z'), 78.2, 15.6).alwaysUp,
    true,
  );
  assert.equal(
    sunTimes(new Date('2026-12-21T00:00:00Z'), 78.2, 15.6).alwaysDown,
    true,
  );
});

test('moon phases', () => {
  const full = moonIllumination(new Date('2026-03-03T11:38:00Z'));
  assert.ok(full.fraction > 0.98);
  assert.equal(full.name, 'full moon');
  const fresh = moonIllumination(new Date('2026-03-19T01:23:00Z'));
  assert.ok(fresh.fraction < 0.02);
  assert.equal(fresh.name, 'new moon');
});

test('day phase, shadows and stars', () => {
  assert.equal(dayPhase(30), 'daylight');
  assert.equal(dayPhase(-3), 'civil twilight');
  assert.equal(dayPhase(-30), 'night');
  const s = shadowGeometry({ altitude: 45, azimuth: 200 });
  near(s.lengthRatio, 1, 1e-9, 'ratio');
  assert.equal(s.towardDeg, 20);
  assert.equal(shadowGeometry({ altitude: -5, azimuth: 0 }), null);
  const stars = visibleStars(new Date('2026-01-15T04:00:00Z'), 40.7, -74, {
    limit: 20,
  });
  assert.ok(stars.some((x) => x.name === 'polaris'));
  assert.ok(stars.some((x) => x.name === 'sirius'));
  assert.equal(compassPoint(359), 'n');
  const r = skyReading(new Date('2026-01-15T04:00:00Z'), 40.7, -74);
  assert.equal(r.phase, 'night');
  assert.ok(r.stars.length > 0);
});

test('terminator, subsolar point and ambient grade', async () => {
  const { subsolarPoint, sunAltitudeRing, ambientGrade } =
    await import('./astronomy.js');
  const d = new Date('2026-06-21T12:00:00Z');
  const ss = subsolarPoint(d);
  near(ss.lat, 23.44, 0.1, 'subsolar lat');
  near(ss.lon, 0.5, 0.5, 'subsolar lon');
  for (const [lon, lat] of sunAltitudeRing(d, -6, 24))
    near(sunPosition(d, lat, lon).altitude, -6, 0.05, 'ring altitude');
  assert.equal(ambientGrade(40).tintAmount, 0);
  assert.ok(ambientGrade(-30).exposure < ambientGrade(-3).exposure);
});

test('globe sky helpers and precipitation mapping', async () => {
  const { splitAtAntimeridian, destination, gradeStrengthForAltitude } =
    await import('./globeSky.js');
  const { precipitationFor } = await import('./weatherFx.js');
  assert.equal(
    splitAtAntimeridian([
      [170, 0],
      [179, 0],
      [-179, 0],
      [-170, 0],
    ]).length,
    2,
  );
  const p = destination(0, 0, 90, 111_195);
  near(p.lon, 1, 0.01, 'east 1 degree');
  assert.equal(gradeStrengthForAltitude(1000), 1);
  assert.equal(gradeStrengthForAltitude(2e7), 0);
  assert.equal(precipitationFor({ weatherCode: 75 }).kind, 'snow');
  assert.equal(precipitationFor({ weatherCode: 95 }).thunder, true);
  assert.equal(precipitationFor({ weatherCode: 0 }).kind, 'none');
  assert.equal(precipitationFor({ weatherCode: 45 }).kind, 'fog');
});
