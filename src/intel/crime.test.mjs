import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CITY_SOURCES,
  ORG_CRIME,
  categoryBreakdown,
  crimeGrid,
  crimeSourceFor,
  normalizeCityCrimes,
  normalizeHomicideRates,
  normalizeUkCrimes,
  organizedCrimeActivity,
} from './crime.js';

test('sources by place', () => {
  assert.equal(crimeSourceFor(51.5074, -0.1278), 'uk');
  assert.equal(crimeSourceFor(41.88, -87.63), 'chicago');
  assert.equal(crimeSourceFor(40.73, -73.99), 'new-york');
  assert.equal(crimeSourceFor(48.85, 2.35), null);
  assert.match(
    CITY_SOURCES[0].where(41.8, -87.6, 1000, '2026-09-01T00:00:00'),
    /within_circle\(location, 41\.8, -87\.6, 1000\)/,
  );
  assert.match(
    CITY_SOURCES.find((c) => c.id === 'los-angeles').where(
      34,
      -118,
      1113.2,
      'x',
    ),
    /lat between 33\.99000 and 34\.01000/,
  );
});

test('incidents normalise and grid into a heat map', () => {
  const uk = normalizeUkCrimes([
    {
      category: 'anti-social-behaviour',
      month: '2026-07',
      location: {
        latitude: '51.5011',
        longitude: '-0.1201',
        street: { name: 'On or near High St' },
      },
    },
    {
      category: 'burglary',
      month: '2026-07',
      location: { latitude: '51.50115', longitude: '-0.12012' },
    },
    { category: 'x', location: {} },
  ]);
  assert.equal(uk.length, 2);
  assert.equal(uk[0].category, 'anti social behaviour');
  const city = normalizeCityCrimes(
    [
      {
        primary_type: 'THEFT',
        date: '2026-09-01T10:00:00',
        latitude: '41.88',
        longitude: '-87.63',
      },
      { primary_type: 'X', latitude: '0', longitude: '0' },
    ],
    CITY_SOURCES[0],
  );
  assert.deepEqual(city, [
    { category: 'theft', date: '2026-09-01', lat: 41.88, lon: -87.63 },
  ]);
  const grid = crimeGrid([
    ...uk,
    { category: 'burglary', lat: 51.5012, lon: -0.12014 },
    { category: 'theft', lat: 51.52, lon: -0.1 },
  ]);
  assert.equal(grid[0].count, 3);
  assert.equal(grid[0].intensity, 1);
  assert.equal(grid.at(-1).count, 1);
  assert.deepEqual(categoryBreakdown(uk)[0], {
    category: 'anti social behaviour',
    count: 1,
    share: 50,
  });
});

test('homicide rates and organized-crime activity', () => {
  const rates = normalizeHomicideRates([
    {},
    [
      {
        countryiso3code: 'MEX',
        value: 25.16,
        date: '2022',
        country: { value: 'Mexico' },
      },
      { countryiso3code: '', value: 5 },
      { countryiso3code: 'JPN', value: null },
    ],
  ]);
  assert.deepEqual(rates, { MEX: { rate: 25.2, year: 2022, name: 'Mexico' } });
  assert.ok(ORG_CRIME.test('Jalisco New Generation Cartel'));
  assert.ok(ORG_CRIME.test('Barrio 18 Gang'));
  assert.ok(!ORG_CRIME.test('Police Forces of Mexico (2018-)'));
  const pt = (lon, lat, a1, a2, place, date) => ({
    geometry: { coordinates: [lon, lat] },
    properties: { actor1: a1, actor2: a2, place, date, fatalities: 1 },
  });
  const act = organizedCrimeActivity({
    features: [
      pt(
        -103.3,
        20.6,
        'Jalisco New Generation Cartel',
        'Police Forces of Mexico (2018-)',
        'Guadalajara, Jalisco, Mexico',
        '2026-09-01',
      ),
      pt(
        -103.0,
        20.2,
        'Jalisco New Generation Cartel',
        null,
        'Tlaquepaque, Jalisco, Mexico',
        '2026-09-05',
      ),
      pt(
        -102.5,
        19.5,
        'Jalisco New Generation Cartel',
        'Sinaloa Cartel',
        'Uruapan, Michoacan, Mexico',
        '2026-08-01',
      ),
      pt(
        -99,
        19,
        'Protesters (Mexico)',
        null,
        'Mexico City, Mexico',
        '2026-08-01',
      ),
    ],
  });
  assert.equal(act[0].name, 'Jalisco New Generation Cartel');
  assert.equal(act[0].events, 3);
  assert.equal(act[0].lastReported, '2026-09-05');
  assert.equal(act[0].regions[0].region, 'Jalisco, Mexico');
  assert.equal(act[0].area.length, 3);
  assert.equal(act[1].name, 'Sinaloa Cartel');
  assert.equal(act.length, 2);
});
