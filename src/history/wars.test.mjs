import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ERAS,
  WARS,
  battleQuery,
  battlesUpTo,
  eraOf,
  formatYear,
  normalizeBattles,
  warsAt,
} from './wars.js';

test('every war is well formed and its battles fall inside it', () => {
  assert.ok(WARS.length >= 45);
  for (const w of WARS) {
    assert.ok(w.start <= (w.end ?? 2100), w.name);
    assert.ok(w.battles.length >= 1, w.name);
    assert.ok(w.strategies.length > 30, w.name);
    for (const b of w.battles) {
      assert.ok(
        Math.abs(b.lat) <= 90 && Math.abs(b.lon) <= 180,
        `${w.name} · ${b.name}`,
      );
      assert.ok(
        b.year >= w.start && b.year <= (w.end ?? 2100),
        `${w.name} · ${b.name} ${b.year}`,
      );
    }
  }
  const eraIds = new Set(ERAS.map((e) => e.id));
  assert.ok(WARS.every((w) => eraIds.has(w.era)));
});

test('the timeline answers what was being fought when', () => {
  const names = (y) => warsAt(y, 2026).map((w) => w.name);
  assert.ok(names(1944).includes('World War II'));
  assert.ok(names(-480).includes('Greco-Persian Wars'));
  assert.ok(names(2026).includes('Russo-Ukrainian War'));
  assert.ok(!names(1950).includes('World War II'));
  assert.ok(battlesUpTo(1944, 1).some((b) => b.name === 'Normandy'));
  assert.equal(eraOf(1916).id, 'world-wars');
  assert.equal(formatYear(-216), '216 BC');
});

test('wikidata battles query and parse', () => {
  assert.match(battleQuery(-500, -450), /"-0500-01-01T00:00:00Z"/);
  const b = normalizeBattles({
    results: {
      bindings: [
        {
          battle: { value: 'http://www.wikidata.org/entity/Q1' },
          battleLabel: { value: 'Battle of X' },
          date: { value: '1916-07-01T00:00:00Z' },
          coord: { value: 'Point(2.7 50.0)' },
          warLabel: { value: 'World War I' },
        },
        {
          battle: { value: 'http://www.wikidata.org/entity/Q1' },
          battleLabel: { value: 'dup' },
          date: { value: '1916-07-01T00:00:00Z' },
          coord: { value: 'Point(2.7 50.0)' },
        },
        {
          battle: { value: 'http://www.wikidata.org/entity/Q2' },
          battleLabel: { value: 'Marathon' },
          date: { value: '-0490-09-12T00:00:00Z' },
          coord: { value: 'Point(23.97 38.11)' },
        },
      ],
    },
  });
  assert.equal(b.length, 2);
  assert.equal(b[0].lat, 50);
  assert.equal(b[1].year, -490);
  assert.match(b[0].url, /wikidata\.org\/wiki\/Q1/);
});
