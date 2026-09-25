import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateText,
  formatAltitude,
  provenanceLine,
  toDMS,
  imageryLine,
  showAisField,
  viewModeFor,
} from './hudViewMode.js';
import { elapsedLabel, layerOutOfScale } from './ui/adam/hudPolicy.js';

test('view mode follows camera altitude', () => {
  assert.equal(viewModeFor(627).label, 'SURFACE');
  assert.equal(viewModeFor(400_000).label, 'NEAR-SPACE');
  assert.equal(viewModeFor(95_631_700).label, 'ORBITAL');
});

test('imagery metrics are suppressed where they zero out', () => {
  assert.equal(imageryLine(627, 0.23), '~0.23 m per pixel');
  assert.equal(imageryLine(400_000, 150), '');
  assert.equal(imageryLine(95_631_700, 35861.88), '');
  assert.equal(formatAltitude(627), '627m');
  assert.equal(formatAltitude(95_631_700), '95,632km');
});

test('collection context and AIS follow the view', () => {
  assert.equal(provenanceLine(3), 'public data · 3 live feeds');
  assert.equal(provenanceLine(0), 'public data · no feeds on');
  assert.equal(
    provenanceLine(1, 'stale cctv'),
    'public data · 1 live feed · stale cctv',
  );
  assert.equal(coordinateText(29.9999, -97, 18_000_000), '30.0°N 97.0°W');
  assert.equal(coordinateText(29.99991, -97.25, 400_000), '30.000°N 97.250°W');
  assert.equal(toDMS(29.99999999, 'lat'), '30°00\'00.00"N', 'seconds carry');
  assert.equal(toDMS(-97.5, 'lon'), '097°30\'00.00"W');
  assert.equal(showAisField(600, 'AIS: --'), false);
  assert.equal(showAisField(600, 'AIS: MAERSK X · 12 KT'), true);
  assert.equal(showAisField(9e7, 'AIS: MAERSK X · 12 KT'), false);
});

test('recording elapsed and layer scale', () => {
  assert.equal(elapsedLabel(138_000), '+00:02:18');
  assert.equal(layerOutOfScale('flights', 9e7), true);
  assert.equal(layerOutOfScale('flights', 5_000), false);
  assert.equal(layerOutOfScale('earthquakes', 9e7), false);
});

test('cockpit compact threshold and preset profiles', async () => {
  const { cockpitCompact } = await import('./ui/adam/hudPolicy.js');
  assert.equal(cockpitCompact(1366, 768), false);
  assert.equal(cockpitCompact(1080, 640), true);
  assert.equal(cockpitCompact(900, 900), true);
});
