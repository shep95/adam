import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDP,
  classifySite,
  formatValue,
  indicatorsFor,
  normalizeSites,
  rankResource,
  siteQuery,
  wbValues,
} from './resources.js';

const wb = (rows) => [
  {},
  rows.map(([iso3, value, id = iso3.slice(0, 2)]) => ({
    countryiso3code: iso3,
    value,
    date: '2021',
    country: { id, value: `name-${iso3}` },
  })),
];

test('world bank rows drop aggregates and nulls', () => {
  const v = wbValues(
    wb([
      ['SAU', 23.4],
      ['WLD', 2, '1W'],
      ['JPN', null],
      ['', 5],
    ]),
  );
  assert.deepEqual(Object.keys(v), ['SAU']);
  assert.equal(v.SAU.year, 2021);
  assert.deepEqual(wbValues(null), {});
});

test('rent types rank in dollars with share of gdp', () => {
  assert.deepEqual(indicatorsFor('oil'), ['NY.GDP.PETR.RT.ZS', GDP]);
  const maps = {
    'NY.GDP.PETR.RT.ZS': wbValues(
      wb([
        ['SAU', 20],
        ['NOR', 5],
        ['JPN', 0],
      ]),
    ),
    [GDP]: wbValues(
      wb([
        ['SAU', 1e12],
        ['NOR', 5e11],
        ['JPN', 4e12],
      ]),
    ),
  };
  const r = rankResource('oil', maps);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].iso3, 'SAU');
  assert.equal(r.rows[0].value, 2e11);
  assert.equal(r.rows[0].share, 20);
  assert.equal(r.rows[0].worldShare, 88.9);
  assert.equal(r.rows[1].rank, 2);
});

test('gold is total minus reserves excluding gold', () => {
  assert.deepEqual(indicatorsFor('gold'), ['FI.RES.TOTL.CD', 'FI.RES.XGLD.CD']);
  const r = rankResource('gold', {
    'FI.RES.TOTL.CD': wbValues(
      wb([
        ['USA', 700e9],
        ['CHN', 3.4e12],
      ]),
    ),
    'FI.RES.XGLD.CD': wbValues(
      wb([
        ['USA', 240e9],
        ['CHN', 3.2e12],
      ]),
    ),
  });
  assert.deepEqual(
    r.rows.map((x) => x.iso3),
    ['USA', 'CHN'],
  );
  assert.equal(formatValue(r.rows[0].value, 'usd'), '$460.0 billion');
  const water = rankResource(
    'water',
    {
      'ER.H2O.INTR.K3': wbValues(
        wb([
          ['BRA', 5661],
          ['RUS', 4312],
        ]),
      ),
    },
    { limit: 1 },
  );
  assert.equal(water.rows.length, 1);
  assert.equal(water.count, 2);
  assert.equal(formatValue(5661, 'km3'), '5,661 km³ a year');
  assert.equal(formatValue(1.2e12, 'usd'), '$1.20 trillion');
  assert.equal(rankResource('nonsense', {}).type, 'total');
});

test('sites classify from osm tags', () => {
  assert.equal(classifySite({ power: 'plant' }), 'power');
  assert.equal(classifySite({ industrial: 'refinery' }), 'refinery');
  assert.equal(
    classifySite({ man_made: 'storage_tank', content: 'lng' }),
    'lng',
  );
  assert.equal(classifySite({ man_made: 'petroleum_well' }), 'well');
  assert.equal(classifySite({ industrial: 'tank_farm' }), 'storage');
  assert.equal(classifySite({ landuse: 'quarry' }), 'mine');
  assert.equal(classifySite({ amenity: 'cafe' }), null);
  const s = normalizeSites({
    elements: [
      {
        type: 'node',
        lat: 1,
        lon: 2,
        tags: { power: 'plant', name: 'A', 'plant:source': 'coal' },
      },
      {
        type: 'way',
        center: { lat: 3, lon: 4 },
        tags: { landuse: 'quarry', resource: 'granite' },
      },
      { type: 'node', lat: 5, lon: 6, tags: { shop: 'x' } },
    ],
  });
  assert.equal(s.length, 2);
  assert.equal(s[0].detail, 'coal');
  assert.equal(s[1].lat, 3);
  assert.match(siteQuery([1, 2, 3, 4]), /\(1,2,3,4\)/);
});
