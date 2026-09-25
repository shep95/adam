import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODIES,
  bodyEquatorial,
  bodyLines,
  chartLines,
  dayNumber,
  gmstDegrees,
  localToUtc,
} from './astrocartography.js';

test('day number and sidereal time match known values at J2000', () => {
  const d = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
  assert.ok(Math.abs(dayNumber(d) - 1.5) < 1e-9);
  // GMST at 2000-01-01 12:00 UT is 18h41m50s ≈ 280.46°.
  assert.ok(Math.abs(gmstDegrees(d) - 280.46) < 0.2, gmstDegrees(d));
});

test('the Sun sits where ephemerides put it at J2000', () => {
  const d = dayNumber(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)));
  const { ra, dec } = bodyEquatorial('sun', d);
  assert.ok(Math.abs(ra - 281.3) < 1, `ra ${ra}`);
  assert.ok(Math.abs(dec + 23.0) < 1, `dec ${dec}`);
});

test('planets and the Moon are in plausible declination range', () => {
  const d = dayNumber(new Date(Date.UTC(2024, 5, 21, 0, 0, 0)));
  for (const b of BODIES) {
    const { ra, dec } = bodyEquatorial(b, d);
    assert.ok(ra >= 0 && ra < 360, `${b} ra ${ra}`);
    assert.ok(dec >= -30 && dec <= 30, `${b} dec ${dec}`);
  }
  // Around the June solstice the Sun is near its most northern declination.
  const sun = bodyEquatorial('sun', d);
  assert.ok(sun.dec > 22 && sun.dec < 24, `sun dec ${sun.dec}`);
});

test('a body yields MC/IC meridians and AC/DC curves', () => {
  const lines = bodyLines('sun', new Date(Date.UTC(2024, 5, 21, 12, 0, 0)));
  const mc = lines.lines.find((l) => l.angle === 'MC');
  const ic = lines.lines.find((l) => l.angle === 'IC');
  // MC/IC are single meridians (constant longitude).
  assert.equal(mc.segments.length, 1);
  assert.ok(mc.segments[0].every((p) => Math.abs(p[0] - mc.lon) < 1e-9));
  assert.ok(Math.abs(Math.abs(mc.lon - ic.lon) - 180) < 1e-6);
  const ac = lines.lines.find((l) => l.angle === 'AC');
  assert.ok(ac.segments.length >= 1);
  assert.ok(ac.segments[0].length > 5);
  // AC and DC differ (rising vs setting) at a shared latitude.
  const dc = lines.lines.find((l) => l.angle === 'DC');
  assert.notEqual(ac.segments[0][0][0], dc.segments[0][0][0]);
});

test('chartLines covers every body; localToUtc applies the offset', () => {
  const all = chartLines(new Date(Date.UTC(2020, 0, 1)));
  assert.equal(all.length, BODIES.length);
  assert.ok(all.every((c) => c.lines.length === 4));
  // 1990-05-04 09:30 in New York (UTC-4, daylight) → 13:30 UTC.
  const utc = localToUtc(
    { year: 1990, month: 5, day: 4, hour: 9, minute: 30 },
    -4,
  );
  assert.equal(utc.toISOString(), '1990-05-04T13:30:00.000Z');
});
