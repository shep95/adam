import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOsmPlaces, osmPlaceQuery } from './placeDossierModel.js';

test('osm query asks for named features around the point', () => {
  const q = osmPlaceQuery(51.5, -0.12, 200);
  assert.match(q, /nwr\["name"\]\(around:200,51\.5,-0\.12\)/);
  assert.match(q, /^\[out:json\]/);
});

test('named places keep landmarks and drop private homes', () => {
  const places = normalizeOsmPlaces({
    elements: [
      {
        tags: {
          name: 'Big Ben',
          tourism: 'attraction',
          wikipedia: 'en:Big Ben',
        },
      },
      { tags: { name: 'Rose Cottage', building: 'house' } },
      { tags: { name: 'Old Hall', building: 'house', historic: 'manor' } },
      { tags: { name: 'Big Ben', historic: 'monument' } },
      { tags: { building: 'yes' } },
      {
        tags: {
          name: 'Tower',
          building: 'office',
          'building:levels': '12',
          website: 'https://x.example',
        },
      },
    ],
  });
  assert.deepEqual(
    places.map((p) => p.name),
    ['Big Ben', 'Old Hall', 'Tower'],
  );
  assert.equal(places[0].kind, 'tourism · attraction');
  assert.equal(places[2].kind, 'office');
  assert.equal(places[2].levels, '12');
  assert.equal(places[2].website, 'https://x.example');
  assert.deepEqual(normalizeOsmPlaces(null), []);
});
