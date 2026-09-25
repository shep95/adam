import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTABLE_VOLCANOES,
  findVolcanoes,
  hazardRings,
  normalizeGvp,
  normalizeHans,
} from './volcanoes.js';

test('notable set: land and undersea, valid coordinates and VEI', () => {
  assert.ok(NOTABLE_VOLCANOES.length > 60);
  assert.ok(NOTABLE_VOLCANOES.filter((v) => v.submarine).length >= 15);
  for (const v of NOTABLE_VOLCANOES) {
    assert.ok(Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180, v.name);
    assert.ok(v.vei >= 0 && v.vei <= 8, v.name);
  }
  assert.equal(findVolcanoes(NOTABLE_VOLCANOES, 'hunga')[0].submarine, true);
  assert.equal(findVolcanoes(NOTABLE_VOLCANOES, 'etna')[0].country, 'Italy');
  assert.ok(findVolcanoes(NOTABLE_VOLCANOES, 'iceland').length >= 4);
});

test('hazard rings grow with VEI and note undersea effects', () => {
  const small = hazardRings(1);
  const big = hazardRings(6, { submarine: true });
  assert.ok(small.rings.some((r) => r.kind === 'lava'));
  assert.ok(big.rings[0].km > small.rings[0].km);
  assert.ok(big.rings.some((r) => r.kind === 'flows' && r.km === 40));
  assert.match(big.notes[0], /tsunami/);
  assert.equal(hazardRings(99).vei, 8);
});

test('live feeds normalise', () => {
  const g = normalizeGvp({
    features: [
      {
        geometry: { coordinates: [-175.385, -20.55] },
        properties: {
          Volcano_Name: 'Hunga Tonga',
          Primary_Volcano_Type: 'Submarine',
          Elevation: -114,
          Country: 'Tonga',
        },
      },
      {
        geometry: { coordinates: [15, 37.7] },
        properties: {
          Volcano_Name: 'Etna',
          Primary_Volcano_Type: 'Stratovolcano(es)',
          Elevation: 3357,
        },
      },
    ],
  });
  assert.equal(g[0].submarine, true);
  assert.equal(g[1].submarine, false);
  const h = normalizeHans([
    {
      volcano_name: 'Kilauea',
      latitude: 19.4,
      longitude: -155.3,
      color_code: 'orange',
      alert_level: 'watch',
    },
  ]);
  assert.equal(h[0].color, 'ORANGE');
});
