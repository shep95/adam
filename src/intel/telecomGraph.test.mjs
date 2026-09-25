import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildTelecomGraph,
  countryConnectivity,
  landingCountry,
  makeCountryResolver,
} from './telecomGraph.js';

const read = (p) =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const nations = read('../data/local_data/nations/nations.json');
const dir = '../data/local_data/telegeography_submarine_cables/';

test('landing names resolve to ISO countries, including the awkward ones', () => {
  assert.equal(landingCountry('Nybor, Denmark'), 'Denmark');
  assert.equal(landingCountry('Muanda, Congo, Dem. Rep.'), 'Congo, Dem. Rep.');
  const r = makeCountryResolver(nations);
  assert.equal(r('Congo, Dem. Rep.'), 'CD');
  assert.equal(r('Turkey'), 'TR');
  assert.equal(r("Côte d'Ivoire"), 'CI');
  assert.equal(r('United States'), 'US');
  assert.equal(r('Nowhere'), null);
});

test('every bundled landing country resolves', () => {
  const r = makeCountryResolver(nations);
  const unresolved = new Set();
  for (const f of read(dir + 'landing-point-geo.json').features) {
    const c = landingCountry(f.properties.name);
    if (!r(c)) unresolved.add(c);
  }
  assert.deepEqual([...unresolved], []);
});

test('the bundled graph links real cables to real countries', () => {
  const graph = buildTelecomGraph(
    read(dir + 'cable-geo.json'),
    read(dir + 'landing-point-geo.json'),
    { nations },
  );
  const linked = [...graph.cables.values()].filter((c) => c.landings.size >= 2);
  assert.ok(linked.length > 400, `${linked.length} cables joined`);
  const fr = countryConnectivity(graph, 'FR', {
    nameOf: (a2) => nations.find((n) => n.a2 === a2)?.n || a2,
    ixps: [
      {
        coords: [2.35, 48.85],
        tags: {
          name: 'France-IX',
          country: 'FR',
          networks: 500,
          city: 'Paris',
        },
      },
    ],
  });
  assert.equal(fr.name, 'France');
  assert.ok(fr.summary.cables > 10);
  assert.ok(fr.summary.landingStations > 5);
  assert.ok(fr.neighbours.some((n) => n.country === 'US'));
  assert.equal(fr.summary.internetExchanges, 1);
  assert.ok(fr.stations.some((s) => /Marseille/.test(s.name)));
  assert.ok(!('criticality' in fr) && !('risk' in fr));
});
