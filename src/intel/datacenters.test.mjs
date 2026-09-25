import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIP_FABS,
  MATERIALS,
  classifyDataCentre,
  classifyWater,
  dataCentreQuery,
  normalizeDataCentres,
  normalizePower,
  parsePowerMW,
  powerFuel,
  predictSiting,
  supplyLinks,
} from './datacenters.js';

test('data centres classify by tags, operator and name', () => {
  assert.equal(
    classifyDataCentre({ operator: 'Amazon Web Services' }),
    'hyperscale',
  );
  assert.equal(
    classifyDataCentre({ name: 'CoreWeave AI cluster' }),
    'ai_training',
  );
  assert.equal(
    classifyDataCentre({ name: 'DoD National Defense DC' }),
    'government',
  );
  assert.equal(
    classifyDataCentre({ name: 'Riot Bitcoin mining farm' }),
    'crypto',
  );
  assert.equal(
    classifyDataCentre({ operator: 'Equinix', name: 'DC12' }),
    'colocation',
  );
  assert.equal(classifyDataCentre({ telecom: 'data_center' }), 'unknown');
  assert.match(dataCentreQuery([1, 2, 3, 4]), /telecom.*data_center/);
  const dc = normalizeDataCentres({
    elements: [
      {
        type: 'way',
        id: 5,
        center: { lat: 39, lon: -77 },
        tags: { telecom: 'data_center', operator: 'Google' },
      },
      { type: 'node', id: 6, tags: { building: 'data_center' } },
    ],
  });
  assert.equal(dc.length, 1);
  assert.equal(dc[0].fn, 'hyperscale');
  assert.equal(dc[0].id, 'way/5');
});

test('power fuel, MW parsing and 230kV filter', () => {
  assert.equal(powerFuel({ 'plant:source': 'nuclear' }), 'nuclear');
  assert.equal(powerFuel({ source: 'wind turbine' }), 'wind');
  assert.equal(powerFuel({}), 'other');
  assert.equal(parsePowerMW('1.5 GW'), 1500);
  assert.equal(parsePowerMW('800 kW'), 0.8);
  assert.equal(parsePowerMW('nonsense'), null);
  const p = normalizePower({
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 40,
        lon: -80,
        tags: {
          power: 'plant',
          'plant:source': 'nuclear',
          'plant:output:electricity': '2000 MW',
        },
      },
      {
        type: 'node',
        id: 2,
        lat: 40,
        lon: -80,
        tags: { power: 'substation', voltage: '345000' },
      },
      {
        type: 'node',
        id: 3,
        lat: 40,
        lon: -80,
        tags: { power: 'substation', voltage: '69000' },
      },
      {
        type: 'way',
        id: 4,
        tags: { power: 'line', voltage: '500000' },
        geometry: [
          { lat: 40, lon: -80 },
          { lat: 41, lon: -81 },
        ],
      },
    ],
  });
  assert.equal(p.plants[0].mw, 2000);
  assert.equal(p.substations.length, 1);
  assert.equal(p.substations[0].kv, 345);
  assert.equal(p.lines[0].kv, 500);
  assert.deepEqual(p.lines[0].coords[0], [-80, 40]);
});

test('curated fabs and materials are well-formed', () => {
  assert.ok(CHIP_FABS.length >= 10);
  assert.ok(CHIP_FABS.every((f) => Number.isFinite(f.lat) && f.kind && f.node));
  assert.ok(MATERIALS.some((m) => /quartz/.test(m.material)));
  assert.ok(MATERIALS.every((m) => Number.isFinite(m.lon) && m.role));
});

test('prediction scores cells, ranks them, and marks drivers', () => {
  const cells = predictSiting({
    box: [38, -80, 40, -78],
    substations: [{ lat: 39, lon: -79 }],
    dataCentres: [{ lat: 39.05, lon: -79.05 }],
    cells: 8,
  });
  assert.ok(cells.length > 0);
  assert.ok(cells[0].score >= cells[cells.length - 1].score);
  assert.ok(cells[0].score <= 1 && cells[0].score >= 0);
  assert.ok('power' in cells[0].drivers);
  // The hottest cell should be near the substation + existing cluster.
  assert.ok(Math.abs(cells[0].lat - 39) < 0.4);
});

test('supply links tag confirmed vs inferred and never rank exposure', () => {
  const links = supplyLinks({
    dataCentres: [{ lat: 39, lon: -79, name: 'DC1' }],
    substations: [{ lat: 39.005, lon: -79.005, kv: 345 }],
    water: [{ lat: 39.12, lon: -79.12, kind: 'works' }],
    plants: [{ lat: 39.01, lon: -79.01, fuel: 'gas' }],
  });
  const power = links.find((l) => l.kind === 'power');
  assert.equal(power.confidence, 'confirmed');
  const water = links.find((l) => l.kind === 'water');
  assert.equal(water.confidence, 'inferred');
  assert.match(power.label, /345 kV/);
  // Links carry no severity/exposure score.
  assert.ok(links.every((l) => !('exposure' in l) && !('severity' in l)));
  assert.equal(classifyWater({ man_made: 'wastewater_plant' }), 'wastewater');
});
