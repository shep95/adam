import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  describeNation,
  findNation,
  governmentQuery,
  institutionKind,
  institutionsFromOverpass,
} from './nationProfile.js';
import { SUMMITS, orderedSummits, summitStatus } from './summits.js';
import { sanitizeOverpassBody } from '../../server/providers/overpass/query.js';

const nations = JSON.parse(
  readFileSync(
    new URL('../data/local_data/nations/nations.json', import.meta.url),
    'utf8',
  ),
);

test('nation lookup by name, alias and ISO code', () => {
  assert.ok(nations.length > 240);
  assert.equal(findNation(nations, 'france').a3, 'FRA');
  assert.equal(findNation(nations, 'uk').a3, 'GBR');
  assert.equal(findNation(nations, 'JPN').n, 'Japan');
  assert.equal(findNation(nations, 'korea').a3, 'KOR');
  assert.equal(findNation(nations, 'zzzz'), null);
  const d = describeNation(findNation(nations, 'germany'));
  assert.equal(d.capital, 'Berlin');
  assert.ok(d.landBorders.includes('FRA'));
});

test('government query passes the overpass guard and classifies institutions', () => {
  const q = governmentQuery(48.8566, 2.3522);
  assert.equal(sanitizeOverpassBody(`data=${encodeURIComponent(q)}`).ok, true);
  assert.equal(institutionKind({ building: 'parliament' }), 'legislature');
  assert.equal(
    institutionKind({ amenity: 'embassy', name: 'Embassy of Japan' }),
    'embassy',
  );
  assert.equal(
    institutionKind({ office: 'government', name: 'Ministry of Finance' }),
    'ministry',
  );
  assert.equal(
    institutionKind({ office: 'government', name: 'Office' }),
    'government office',
  );
  const nodes = institutionsFromOverpass({
    elements: [
      {
        type: 'way',
        id: 1,
        center: { lat: 48.86, lon: 2.31 },
        tags: { name: 'Assemblée nationale', building: 'parliament' },
      },
      {
        type: 'node',
        id: 2,
        lat: 48.87,
        lon: 2.3,
        tags: { name: 'Embassy X', amenity: 'embassy' },
      },
      {
        type: 'node',
        id: 3,
        lat: 48.87,
        lon: 2.3,
        tags: { office: 'government' },
      },
    ],
  });
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ['legislature', 'embassy'],
  );
});

test('summits are ordered live, upcoming, held and have valid venues', () => {
  for (const s of SUMMITS) {
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180, s.id);
    assert.ok(s.start <= s.end, s.id);
  }
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.equal(
    summitStatus(
      SUMMITS.find((s) => s.id === 'unga-81'),
      now,
    ),
    'live',
  );
  const list = orderedSummits(now);
  assert.equal(list[0].status, 'live');
  assert.equal(list.at(-1).status, 'held');
  assert.ok(
    list.findIndex((s) => s.status === 'upcoming') <
      list.findIndex((s) => s.status === 'held'),
  );
});
