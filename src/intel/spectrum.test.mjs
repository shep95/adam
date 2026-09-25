import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BANDS,
  bandsFor,
  formatMHz,
  normalizeTransmitters,
  parseFrequency,
  parseKiwiList,
  transmitterQuery,
} from './spectrum.js';

test('frequencies parse in any unit and land in the right band', () => {
  assert.equal(parseFrequency('1090'), 1090);
  assert.equal(parseFrequency('2.4 GHz'), 2400);
  assert.equal(parseFrequency('518 kHz'), 0.518);
  assert.equal(parseFrequency('abc'), null);
  assert.match(bandsFor(1090)[0].uses, /ADS-B/);
  assert.match(bandsFor(156.8)[0].uses, /channel 16/);
  assert.match(bandsFor(1575.42)[0].uses, /GPS L1/);
  assert.match(bandsFor(121.5)[0].uses, /emergency/);
  assert.equal(bandsFor(2437)[0].service, 'ISM 2.4 GHz');
  assert.equal(formatMHz(2400), '2.4 GHz');
  assert.equal(formatMHz(0.518), '518 kHz');
  for (const b of BANDS) assert.ok(b.from < b.to, b.service);
});

test('KiwiSDR list parses from its JS wrapper, skipping bad rows', () => {
  const text = `var kiwisdr_com = [
    { "name": "Twente KiwiSDR", "url": "http://websdr.ewi.utwente.nl:8073", "gps": "(52.239, 6.857)", "antenna": "mini-whip", "users": "3", "users_max": "8" },
    { "name": "bad", "url": "http://x", "gps": "nowhere" },
    { "name": "ftp", "url": "ftp://x", "gps": "(1, 2)" },
  ];`;
  const r = parseKiwiList(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].lat, 52.239);
  assert.equal(r[0].users, 3);
  assert.deepEqual(parseKiwiList('garbage'), []);
});

test('transmitters from OSM masts', () => {
  assert.match(transmitterQuery([1, 2, 3, 4]), /tower:type/);
  const t = normalizeTransmitters({
    elements: [
      {
        type: 'node',
        lat: 1,
        lon: 2,
        tags: {
          man_made: 'mast',
          'tower:type': 'communication',
          'communication:radio': 'fm',
          operator: 'BBC',
          height: '300',
        },
      },
      {
        type: 'way',
        center: { lat: 3, lon: 4 },
        tags: { 'communication:mobile_phone': 'yes' },
      },
      { type: 'node', tags: {} },
    ],
  });
  assert.equal(t.length, 2);
  assert.deepEqual(t[0].uses, ['radio']);
  assert.equal(t[0].heightM, 300);
});
