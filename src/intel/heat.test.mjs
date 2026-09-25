import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCountryIndex, topoFeatures } from './countryLookup.js';
import { heatByCountry, hotCells } from './heat.js';

const topo = JSON.parse(
  readFileSync(
    new URL('../data/local_data/countries/countries-50m.json', import.meta.url),
    'utf8',
  ),
);
const { lookup } = buildCountryIndex(topoFeatures(topo, 'countries'));

test('outlines place points in the right country, offshore to the nearest coast', () => {
  assert.equal(lookup(48.85, 2.35), 'France');
  assert.equal(lookup(-33.87, 151.21), 'Australia');
  assert.equal(lookup(30.04, 31.24), 'Egypt');
  assert.equal(lookup(35.68, 139.69), 'Japan');
  assert.equal(lookup(0, -30), null); // mid-Atlantic
  assert.equal(lookup(29.3, 48.2), 'Kuwait'); // just offshore
});

test('heat sums by country and ranks the hottest cells', () => {
  const fires = [
    { lat: -10.3, lon: -55.2, frp: 100 },
    { lat: -10.4, lon: -55.1, frp: 50 },
    { lat: 48.85, lon: 2.35, frp: 10 },
    { lat: 0, lon: -30, frp: 5 },
  ];
  const h = heatByCountry(fires, lookup);
  assert.equal(h.countries[0].country, 'Brazil');
  assert.equal(h.countries[0].frpMw, 150);
  assert.equal(h.countries[0].detections, 2);
  assert.equal(h.countries[0].share, 93.8);
  assert.equal(h.unassigned, 1);
  const cells = hotCells(fires, lookup);
  assert.equal(cells[0].country, 'Brazil');
  assert.equal(cells[0].frpMw, 150);
  assert.equal(cells.at(-1).country, 'open water');
});
