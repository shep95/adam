import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectionLine,
  formatAltitude,
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
  assert.equal(imageryLine(627, 0.23, 7.1), 'GSD: 0.23M  NIIRS: 7.1');
  assert.equal(imageryLine(400_000, 150, 0), 'GSD: 150.00M  SCALE: REGIONAL');
  assert.equal(imageryLine(95_631_700, 35861.88, 0), 'SCALE: GLOBAL');
  assert.equal(formatAltitude(627), '627m');
  assert.equal(formatAltitude(95_631_700), '95,632km');
});

test('collection context and AIS follow the view', () => {
  assert.match(collectionLine(600, 'KH11-4152', 'OPS-4129'), /EO SURFACE$/);
  assert.equal(
    collectionLine(9e7, 'KH11-4152', 'OPS-4129'),
    'GLOBAL WATCH · OPS-4129',
  );
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
