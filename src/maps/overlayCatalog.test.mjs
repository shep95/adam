import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_GROUPS,
  OVERLAY_SOURCES,
  SEA_LEVEL_PRESETS,
  clampRise,
  floodColor,
  floodPixels,
  gibsDate,
  noaaSlrUrl,
  parseCustomSource,
  restoreStack,
  riseToFeet,
  serializeStack,
  terrariumElevation,
} from './overlayCatalog.js';

test('every source has a unique id, a known group, https and a credit', () => {
  const ids = new Set();
  const groups = new Set(OVERLAY_GROUPS.map((g) => g.id));
  for (const s of OVERLAY_SOURCES) {
    assert.ok(!ids.has(s.id), s.id);
    ids.add(s.id);
    assert.ok(groups.has(s.group), s.id);
    assert.ok(s.credit, s.id);
    if (s.url) assert.match(s.url, /^https:\/\//, s.id);
  }
  assert.ok(ids.has('sea-level') && ids.has('noaa-slr'));
});

test('terrarium decodes and floods only new land under the rise', () => {
  assert.equal(terrariumElevation(128, 0, 0), 0);
  assert.equal(terrariumElevation(128, 10, 128), 10.5);
  assert.equal(floodColor(0.5, 1)[3] > 0, true);
  assert.deepEqual(floodColor(-3, 1), [0, 0, 0, 0]); // already sea
  assert.deepEqual(floodColor(2, 1), [0, 0, 0, 0]); // stays dry
  assert.deepEqual(floodColor(0.5, 0), [0, 0, 0, 0]); // today
  // deeper water is darker and more opaque
  assert.ok(floodColor(0.1, 5)[3] > floodColor(4.9, 5)[3]);
  const px = new Uint8ClampedArray([128, 1, 0, 255, 128, 50, 0, 255]);
  floodPixels(px, 2);
  assert.ok(px[3] > 0);
  assert.equal(px[7], 0);
});

test('rise helpers clamp and convert', () => {
  assert.equal(clampRise(-1), 0);
  assert.equal(clampRise(500), 100);
  assert.equal(clampRise('x'), 0);
  assert.equal(riseToFeet(0.77), 3);
  assert.equal(riseToFeet(70), 10);
  assert.match(noaaSlrUrl(1), /slr_3ft\/MapServer$/);
  assert.equal(gibsDate(new Date('2026-09-25T10:00:00Z')), '2026-09-24');
  const rises = SEA_LEVEL_PRESETS.map((p) => p.rise);
  assert.deepEqual(
    [...rises].sort((a, b) => a - b),
    rises,
  );
});

test('import parses xyz, wmts, arcgis and wms; refuses http and junk', () => {
  const xyz = parseCustomSource(
    'https://{s}.tiles.example.com/{z}/{x}/{-y}.png',
    'Mine',
  );
  assert.equal(xyz.source.kind, 'xyz');
  assert.equal(
    xyz.source.url,
    'https://{s}.tiles.example.com/{z}/{x}/{reverseY}.png',
  );
  assert.equal(xyz.source.subdomains, 'abc');
  assert.equal(xyz.source.label, 'Mine');
  const wmts = parseCustomSource(
    'https://x.example/wmts/L/default/{TileMatrix}/{TileRow}/{TileCol}.png',
  );
  assert.equal(
    wmts.source.url,
    'https://x.example/wmts/L/default/{z}/{y}/{x}.png',
  );
  const arc = parseCustomSource(
    'https://gis.example.gov/arcgis/rest/services/Flood/MapServer/',
  );
  assert.equal(arc.source.kind, 'arcgis');
  assert.equal(
    arc.source.url,
    'https://gis.example.gov/arcgis/rest/services/Flood/MapServer',
  );
  const wms = parseCustomSource(
    'https://maps.example.org/geoserver/wms?SERVICE=WMS&LAYERS=roads',
  );
  assert.equal(wms.source.kind, 'wms');
  assert.equal(wms.source.layers, 'roads');
  assert.match(
    parseCustomSource('https://maps.example.org/wms').error,
    /layers/,
  );
  assert.match(
    parseCustomSource('http://a.example/{z}/{x}/{y}.png').error,
    /https/,
  );
  assert.ok(parseCustomSource('nonsense').error);
  assert.ok(parseCustomSource('https://example.com/page.html').error);
});

test('stack round-trips through storage, dropping unknowns', () => {
  const custom = parseCustomSource('https://t.example/{z}/{x}/{-y}.png').source;
  const saved = serializeStack(
    [
      {
        source: OVERLAY_SOURCES.find((s) => s.id === 'esri-topo'),
        alpha: 0.4,
        show: true,
      },
      { source: custom, alpha: 1, show: false },
    ],
    0.77,
  );
  const json = JSON.parse(JSON.stringify(saved));
  json.layers.push({ id: 'nope' });
  const back = restoreStack(json);
  assert.equal(back.rise, 0.77);
  assert.deepEqual(
    back.layers.map((l) => l.source.id),
    ['esri-topo', custom.id],
  );
  assert.equal(back.layers[0].alpha, 0.4);
  assert.equal(back.layers[1].show, false);
  assert.equal(back.layers[1].source.url, custom.url);
  assert.deepEqual(restoreStack(null), { rise: 0, layers: [] });
});

test('heat ramp: dark stays clear, bright lights run hot', async () => {
  const { heatPixels, ironbow } = await import('./overlayCatalog.js');
  assert.deepEqual(ironbow(0), [0, 0, 0]);
  assert.deepEqual(ironbow(1), [255, 255, 255]);
  const px = new Uint8ClampedArray([5, 5, 5, 255, 250, 250, 250, 255]);
  heatPixels(px);
  assert.equal(px[3], 0);
  assert.ok(px[7] > 200);
  assert.ok(px[4] >= 250);
});
