import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DBZ_PALETTE,
  combineField,
  createStormSampler,
  dbzFromRgba,
  intensityFromDbz,
  offsetPoint,
  stormState,
  tileAndPixel,
} from './stormField.js';

test('palette colours decode to their dBZ; transparent is dry', () => {
  for (const [dbz, [r, g, b]] of DBZ_PALETTE)
    assert.equal(dbzFromRgba(r, g, b, 255), dbz);
  assert.equal(dbzFromRgba(250, 0, 0, 0), 0);
  assert.equal(dbzFromRgba(90, 90, 90, 255), 0, 'grey map ink is not rain');
  assert.equal(intensityFromDbz(10), 0);
  assert.equal(intensityFromDbz(55), 1);
});

test('an approaching cell ramps the field with distance, not a threshold', () => {
  const dry = { dbz: 0, cloud: 0, lightning: 0 };
  const at = (km) =>
    combineField(dry, [{ km, dbz: 50, cloud: 0.8, lightning: 0 }]);
  const far = at(25).approach;
  const mid = at(16).approach;
  const near = at(4).approach;
  assert.ok(far > 0 && far < mid && mid < near, `${far} ${mid} ${near}`);
  assert.equal(at(4).nearestKm, 4);
  assert.equal(combineField(dry, [{ km: 40, dbz: 60 }]).approach, 0);
});

test('altitude places the camera below, inside or above the storm', () => {
  const cell = combineField({ dbz: 50, cloud: 0.9, lightning: 0.5 }, []);
  const below = stormState(cell, 400);
  const inside = stormState(cell, 6000);
  const above = stormState(cell, 16_500);
  const orbit = stormState(cell, 40_000);
  assert.equal(below.layer, 'below');
  assert.ok(
    below.rain > 0.6 && below.visibilityM < 5000 && below.darkness > 0.4,
  );
  assert.equal(inside.layer, 'inside');
  assert.ok(inside.inCloud > 0.8 && inside.visibilityM < 1000);
  assert.ok(inside.rain < below.rain);
  assert.equal(above.layer, 'above');
  assert.equal(above.rain, 0);
  assert.equal(above.inCloud, 0);
  assert.ok(above.lightning > 0, 'lightning glows below the tops');
  assert.equal(orbit.layer, 'high');
  assert.equal(orbit.rain, 0);
});

test('clear air stays clear', () => {
  const s = stormState(
    combineField({ dbz: 0, cloud: 0, lightning: 0 }, []),
    300,
  );
  assert.deepEqual(
    [s.layer, s.rain, s.inCloud, s.darkness],
    ['clear', 0, 0, 0],
  );
});

test('tile addressing matches the proxy level-6 geographic grid', () => {
  const t = tileAndPixel(30.27, -97.74);
  const span = 180 / 64;
  assert.equal(t.x, Math.floor((-97.74 + 180) / span));
  assert.equal(t.y, Math.floor((90 - 30.27) / span));
  assert.ok(t.px >= 0 && t.px < 256 && t.py >= 0 && t.py < 256);
  const p = offsetPoint(30, -97, 10, 90);
  assert.ok(Math.abs(p.lat - 30) < 0.01 && p.lon > -97);
});

test('sampler reads radar pixels inside coverage and skips outside', async () => {
  const manifest = {
    schemaVersion: 1,
    latest: '2026-09-25T06:00:00.000Z',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
  };
  const red = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < red.length; i += 4) red.set([253, 0, 0, 255], i);
  const loaded = [];
  const sampler = createStormSampler({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        ...manifest,
        product: new URL(url, 'http://x').searchParams.get('product'),
      }),
    }),
    loadPixels: async (url) => {
      loaded.push(url);
      return url.includes('product=radar') ? red : null;
    },
  });
  const f = await sampler.fieldAt(35, -100);
  assert.equal(f.radarCovered, true);
  assert.equal(f.dbz, 50);
  assert.ok(f.here > 0.8);
  const outside = await sampler.fieldAt(51.5, 0);
  assert.equal(outside.radarCovered, false);
  assert.ok(loaded.length > 0);
});

test('moonlight lifts and silvers the night grade; no moon, no change', async () => {
  const { ambientGrade } = await import('./astronomy.js');
  const dark = ambientGrade(-40);
  const moonlit = ambientGrade(-40, 1);
  assert.ok(moonlit.exposure > dark.exposure + 0.2);
  assert.ok(moonlit.tint[2] >= dark.tint[2]);
  assert.deepEqual(ambientGrade(-40, 0), dark);
  assert.deepEqual(ambientGrade(30, 1), ambientGrade(30), 'daytime unaffected');
});

test('night-lights gain offsets the night-side shading', async () => {
  const m = await import('./nightLights.js');
  assert.ok(m.NIGHT_SIDE_GAIN * 0.3 >= 0.9);
  assert.match(m.CITY_LIGHTS_2012_URL, /VIIRS_CityLights_2012/);
});
