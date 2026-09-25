import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adminAreasQuery,
  normalizeAdminChain,
  normalizeOfficeholders,
  normalizeSubdivisions,
  officeholdersQuery,
  subdivisionsQuery,
} from './leadership.js';

test('admin chain from overpass areas, nation first', () => {
  assert.match(
    adminAreasQuery(40.7128, -74.006),
    /is_in\(40\.71280,-74\.00600\)/,
  );
  const chain = normalizeAdminChain({
    elements: [
      { tags: { admin_level: '8', name: 'City of New York', wikidata: 'Q60' } },
      { tags: { admin_level: '4', name: 'New York', wikidata: 'Q1384' } },
      { tags: { admin_level: '2', name: 'United States', wikidata: 'Q30' } },
      {
        tags: {
          admin_level: '6',
          name: 'New York County',
          wikidata: 'Q500416',
        },
      },
      { tags: { admin_level: '10', name: 'x', wikidata: 'Q1' } },
      { tags: { admin_level: '5', name: 'no wikidata' } },
    ],
  });
  assert.deepEqual(
    chain.map((c) => c.wikidata),
    ['Q30', 'Q1384', 'Q500416', 'Q60'],
  );
  assert.equal(chain[1].levelName, 'state / province');
});

const uri = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
const lit = (value) => ({ value });

test('officeholders: current, latest start wins, merged roles', () => {
  assert.match(
    officeholdersQuery(['Q30', 'Q1384']),
    /VALUES \?area \{ wd:Q30 wd:Q1384 \}/,
  );
  assert.match(officeholdersQuery(['Q30']), /pq:P582/);
  const r = normalizeOfficeholders({
    results: {
      bindings: [
        {
          area: uri('Q30'),
          role: lit('head of state'),
          person: uri('Q1'),
          personLabel: lit('A'),
          officeLabel: lit('President of the United States'),
          start: lit('2025-01-20T00:00:00Z'),
          partyLabel: lit('P1'),
        },
        {
          area: uri('Q30'),
          role: lit('head of government'),
          person: uri('Q1'),
          personLabel: lit('A'),
          start: lit('2025-01-20T00:00:00Z'),
        },
        {
          area: uri('Q1384'),
          role: lit('head of government'),
          person: uri('Q2'),
          personLabel: lit('B'),
          start: lit('2021-08-24T00:00:00Z'),
          legislatureLabel: lit('New York State Legislature'),
        },
        {
          area: uri('Q1384'),
          role: lit('head of government'),
          person: uri('Q3'),
          personLabel: lit('C'),
          start: lit('2011-01-01T00:00:00Z'),
        },
      ],
    },
  });
  assert.equal(r.Q30.holders.length, 1);
  assert.equal(r.Q30.holders[0].role, 'head of state and government');
  assert.deepEqual(r.Q30.holders[0].parties, ['P1']);
  assert.equal(r.Q1384.holders[0].name, 'B');
  assert.equal(r.Q1384.holders[0].start, '2021-08-24');
  assert.equal(r.Q1384.legislature, 'New York State Legislature');
});

test('subdivisions list with their head of government', () => {
  assert.match(subdivisionsQuery('Q30'), /wd:Q30 wdt:P150 \?sub/);
  const s = normalizeSubdivisions({
    results: {
      bindings: [
        {
          sub: uri('Q99'),
          subLabel: lit('California'),
          coord: lit('Point(-119 37)'),
          person: uri('Q5'),
          personLabel: lit('G'),
          officeLabel: lit('Governor of California'),
        },
        { sub: uri('Q1384'), subLabel: lit('New York') },
        { sub: uri('Q7'), subLabel: lit('Q7') },
      ],
    },
  });
  assert.deepEqual(
    s.map((x) => x.name),
    ['California', 'New York'],
  );
  assert.deepEqual(s[0].coords, [-119, 37]);
  assert.equal(s[0].holder.name, 'G');
  assert.equal(s[1].holder, null);
});
