import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySymbols,
  cityBox,
  footprintShape,
  starJunctions,
  symbolQuery,
  summarizeSymbols,
} from './symbolScan.js';

// Local metres → lat/lon near (48, 2).
const ring = (pts) =>
  pts.map(([x, y]) => ({
    lat: 48 + y / 111320,
    lon: 2 + x / (111320 * Math.cos((48 * Math.PI) / 180)),
  }));
const cross = ring([
  [-10, 30],
  [10, 30],
  [10, 10],
  [30, 10],
  [30, -10],
  [10, -10],
  [10, -50],
  [-10, -50],
  [-10, -10],
  [-30, -10],
  [-30, 10],
  [-10, 10],
]);
const star = ring(
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 40 : 100;
    const a = (i / 10) * 2 * Math.PI;
    return [r * Math.cos(a), r * Math.sin(a)];
  }),
);
const pentagon = ring(
  Array.from({ length: 5 }, (_, i) => [
    60 * Math.cos((i / 5) * 2 * Math.PI),
    60 * Math.sin((i / 5) * 2 * Math.PI),
  ]),
);
const circle = ring(
  Array.from({ length: 36 }, (_, i) => [
    40 * Math.cos((i / 36) * 2 * Math.PI),
    40 * Math.sin((i / 36) * 2 * Math.PI),
  ]),
);

test('footprint shapes read from above', () => {
  assert.equal(footprintShape(cross), 'cruciform');
  assert.equal(footprintShape(star), 'star');
  assert.equal(footprintShape(pentagon), 'pentagon');
  assert.equal(footprintShape(circle), 'circle');
  assert.equal(
    footprintShape(
      ring([
        [0, 0],
        [40, 0],
        [40, 30],
        [0, 30],
      ]),
    ),
    null,
  );
});

test('sites classify by tag and name; forts only when star-shaped', () => {
  const sites = classifySymbols({
    elements: [
      {
        type: 'way',
        id: 1,
        tags: {
          amenity: 'place_of_worship',
          religion: 'christian',
          denomination: 'roman_catholic',
          name: 'St Mary',
        },
        geometry: cross,
      },
      {
        type: 'node',
        id: 2,
        lat: 48.1,
        lon: 2.1,
        tags: { man_made: 'obelisk', name: 'Luxor Obelisk' },
      },
      {
        type: 'node',
        id: 3,
        lat: 48.2,
        lon: 2.2,
        tags: { amenity: 'social_centre', name: 'Grand Lodge of Scotland' },
      },
      {
        type: 'way',
        id: 4,
        tags: { historic: 'fort', name: 'Star fort' },
        geometry: star,
      },
      {
        type: 'way',
        id: 5,
        tags: { historic: 'fort', name: 'Square fort' },
        geometry: ring([
          [0, 0],
          [90, 0],
          [90, 90],
          [0, 90],
        ]),
      },
      {
        type: 'node',
        id: 6,
        lat: 48.3,
        lon: 2.3,
        tags: { amenity: 'place_of_worship', religion: 'jewish' },
      },
      { type: 'node', id: 7, lat: 48.3, lon: 2.3, tags: { amenity: 'cafe' } },
    ],
  });
  const byName = Object.fromEntries(sites.map((s) => [s.name || s.id, s]));
  assert.equal(byName['St Mary'].shape, 'cruciform');
  assert.equal(byName['St Mary'].kind, 'christian · roman catholic');
  assert.equal(byName['Luxor Obelisk'].category, 'esoteric');
  assert.equal(byName['Grand Lodge of Scotland'].kind, 'lodge');
  assert.equal(byName['Star fort'].kind, 'star fort');
  assert.ok(!byName['Square fort']);
  assert.equal(byName['node/6'].religion, 'jewish');
  assert.equal(sites.length, 5);
  const s = summarizeSymbols(sites);
  assert.equal(s.byCategory.sacred, 2);
  assert.equal(s.shapes.length, 2);
});

test('star junctions count the streets meeting a roundabout', () => {
  const j = starJunctions({
    elements: [
      {
        type: 'way',
        id: 10,
        tags: { junction: 'roundabout', name: 'Place Charles de Gaulle' },
        nodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        geometry: [
          { lat: 48.8738, lon: 2.295 },
          { lat: 48.874, lon: 2.2952 },
        ],
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        type: 'way',
        id: 100 + i,
        tags: { highway: 'primary', name: `Avenue ${i}` },
        nodes: [i + 1, 900 + i],
      })),
      {
        type: 'way',
        id: 11,
        tags: { junction: 'roundabout' },
        nodes: [50, 51],
        geometry: [{ lat: 1, lon: 1 }],
      },
      {
        type: 'way',
        id: 200,
        tags: { highway: 'residential' },
        nodes: [50, 70],
      },
    ],
  });
  assert.equal(j.length, 1);
  assert.equal(j[0].spokes, 12);
  assert.match(j[0].kind, /12 streets/);
});

test('queries stay at city scale', () => {
  const box = cityBox(48.85, 2.35, 50);
  assert.ok(box[2] - box[0] < 0.3);
  assert.match(symbolQuery(box), /place_of_worship/);
});

test('faith counts cover sacred sites only', () => {
  const s = summarizeSymbols([
    { category: 'sacred', religion: 'christian' },
    { category: 'sacred', religion: null },
    { category: 'esoteric' },
  ]);
  assert.deepEqual(s.byReligion, { christian: 1, unspecified: 1 });
});
