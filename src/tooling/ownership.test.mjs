import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOwnership,
  ownershipQuery,
  partyClass,
  parsePoint,
  summarizeOwnership,
} from '../../server/providers/ownership.js';

test('the query excludes people as owners and operators', () => {
  const q = ownershipQuery('FR', 'ports');
  assert.match(q, /wdt:P297 "FR"/);
  assert.equal(
    (q.match(/FILTER NOT EXISTS \{ \?(owner|operator) wdt:P31 wd:Q5 \}/g) || [])
      .length,
    2,
  );
  assert.match(q, /wd:Q44782/);
});

test('parties classify as state, foreign state, foreign or private', () => {
  assert.equal(partyClass({ state: true, country: 'FR' }, 'FR'), 'state');
  assert.equal(
    partyClass({ state: true, country: 'CN' }, 'GR'),
    'foreign-state',
  );
  assert.equal(partyClass({ state: false, country: 'DK' }, 'FR'), 'foreign');
  assert.equal(partyClass({ state: false, country: null }, 'FR'), 'private');
  assert.deepEqual(parsePoint('Point(23.6 37.94)'), [23.6, 37.94]);
});

test('bindings fold into one feature per site with its strongest control', () => {
  const b = (o) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
  const fc = normalizeOwnership(
    {
      results: {
        bindings: [
          b({
            item: 'http://www.wikidata.org/entity/Q1',
            itemLabel: 'Port of Piraeus',
            coord: 'Point(23.6 37.94)',
            owner: 'http://www.wikidata.org/entity/Q2',
            ownerLabel: 'COSCO Shipping',
            ownerCountry: 'CN',
            ownerState: 'true',
          }),
          b({
            item: 'http://www.wikidata.org/entity/Q1',
            itemLabel: 'Port of Piraeus',
            coord: 'Point(23.6 37.94)',
            operator: 'http://www.wikidata.org/entity/Q3',
            operatorLabel: 'Piraeus Port Authority',
            operatorCountry: 'GR',
            operatorState: 'false',
          }),
          b({
            item: 'http://www.wikidata.org/entity/Q4',
            itemLabel: 'Q4',
            coord: 'Point(22 38)',
            owner: 'http://www.wikidata.org/entity/Q5',
            ownerLabel: 'Hellenic Republic',
            ownerCountry: 'GR',
            ownerState: 'true',
          }),
        ],
      },
    },
    'GR',
  );
  assert.equal(fc.features.length, 2);
  const piraeus = fc.features[0].properties;
  assert.equal(piraeus.control, 'foreign-state');
  assert.equal(piraeus.owners, 'COSCO Shipping (CN)');
  assert.equal(piraeus.operators, 'Piraeus Port Authority');
  assert.equal(fc.features[1].properties.name, null);
  const s = summarizeOwnership(fc, 'GR');
  assert.deepEqual(s.byControl, {
    state: 1,
    'foreign-state': 1,
    foreign: 0,
    private: 0,
  });
  assert.deepEqual(s.byOwnerCountry, { CN: 1 });
});
