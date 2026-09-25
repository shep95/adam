import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import {
  acledParams,
  keyedFeedsProxy,
  keyedStatus,
  normalizeAcled,
  normalizeNotams,
  normalizeSanctions,
  parseNotamCoord,
  summarizeEvents,
} from '../../server/providers/keyedFeeds.js';

async function serve(plugins, path) {
  const { handle } = createMiddlewareStack(plugins);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
    );
    return { status: response.status, text: await response.text() };
  } finally {
    server.close();
  }
}

const json = (b) => ({ ok: true, json: async () => b });

test('NOTAM coordinates and radius become a circle polygon', () => {
  const c = parseNotamCoord('3842N07702W');
  assert.ok(Math.abs(c.lat - 38.7) < 1e-9 && Math.abs(c.lon + 77.0333) < 1e-3);
  assert.ok(parseNotamCoord('384215N0770215W'));
  assert.equal(parseNotamCoord('junk'), null);
  const fc = normalizeNotams({
    items: [
      {
        properties: {
          coreNOTAMData: {
            notam: {
              number: '1/2345',
              icaoLocation: 'KDCA',
              coordinates: '3842N07702W',
              radius: '10',
              text: 'TFR',
              effectiveStart: '2026-09-25T00:00Z',
            },
          },
        },
        geometry: {
          type: 'GeometryCollection',
          geometries: [{ type: 'Point', coordinates: [-77.03, 38.7] }],
        },
      },
      { properties: { coreNOTAMData: { notam: { number: 'x' } } } },
    ],
  });
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].geometry.type, 'Polygon');
  assert.equal(fc.features[0].properties.location, 'KDCA');
  assert.equal(fc.features[0].geometry.coordinates[0].length, 49);
});

test('ACLED params bound the box and dates; rows become points', () => {
  const p = acledParams({
    lat: 15.5,
    lon: 32.5,
    radiusKm: 111.32,
    days: 7,
    now: new Date('2026-09-25T00:00:00Z'),
  });
  assert.equal(p.get('event_date'), '2026-09-18|2026-09-25');
  assert.equal(p.get('latitude'), '14.5000|16.5000');
  assert.equal(p.get('latitude_where'), 'BETWEEN');
  const fc = normalizeAcled({
    data: [
      {
        event_id_cnty: 'SDN1',
        latitude: '15.6',
        longitude: '32.5',
        event_type: 'Battles',
        fatalities: '3',
        location: 'Khartoum',
        country: 'Sudan',
      },
      {
        event_id_cnty: 'SDN2',
        latitude: '15.7',
        longitude: '32.6',
        event_type: 'Protests',
        fatalities: '0',
      },
      { event_id_cnty: 'bad', latitude: '', longitude: 'x' },
    ],
  });
  assert.equal(fc.features.length, 2);
  assert.deepEqual(summarizeEvents(fc), {
    events: 2,
    fatalities: 3,
    byType: { Battles: 1, Protests: 1 },
  });
});

test('sanctions results never include people', () => {
  const r = normalizeSanctions({
    results: [
      {
        id: 'v1',
        caption: 'OCEAN STAR',
        schema: 'Vessel',
        properties: {
          imoNumber: ['9123456'],
          flag: ['pa'],
          topics: ['sanction'],
        },
        datasets: ['us_ofac_sdn'],
      },
      { id: 'p1', caption: 'Some Person', schema: 'Person', properties: {} },
      { id: 'c1', caption: 'Shell Co', schema: 'Company', properties: {} },
    ],
  });
  assert.deepEqual(
    r.map((x) => x.id),
    ['v1', 'c1'],
  );
  assert.equal(r[0].imo, '9123456');
  assert.match(r[0].url, /opensanctions\.org\/entities\/v1/);
});

test('routes say which key to set, and keys never reach the browser', async () => {
  assert.deepEqual(keyedStatus({}), {
    notams: false,
    acled: false,
    sanctions: false,
  });
  const bare = keyedFeedsProxy({
    env: {},
    fetchImpl: async () => {
      throw new Error('no');
    },
  });
  const n = await serve([bare], '/api/notams?icao=KJFK');
  assert.equal(n.status, 501);
  assert.match(n.text, /FAA_NOTAM_CLIENT_ID/);
  assert.equal((await serve([bare], '/api/acled?country=Sudan')).status, 501);
  assert.equal((await serve([bare], '/api/sanctions?q=ocean')).status, 501);

  const calls = [];
  const plugin = keyedFeedsProxy({
    env: {
      FAA_NOTAM_CLIENT_ID: 'CID',
      FAA_NOTAM_CLIENT_SECRET: 'CSECRET',
      ACLED_USERNAME: 'u@x',
      ACLED_PASSWORD: 'APASS',
      OPENSANCTIONS_API_KEY: 'OSKEY',
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      if (u.includes('oauth/token'))
        return json({ access_token: 'TOK', expires_in: 86400 });
      if (u.includes('acled/read'))
        return json({
          data: [
            {
              event_id_cnty: 'A',
              latitude: '1',
              longitude: '2',
              event_type: 'Battles',
              fatalities: '1',
            },
          ],
        });
      if (u.includes('faa.gov')) return json({ items: [] });
      if (u.includes('opensanctions'))
        return json({
          results: [
            { id: 'p', schema: 'Person', caption: 'x' },
            { id: 'v', schema: 'Vessel', caption: 'V' },
          ],
        });
      throw new Error('unexpected ' + u);
    },
  });
  const status = await serve([plugin], '/api/keyed/status');
  assert.deepEqual(JSON.parse(status.text), {
    notams: true,
    acled: true,
    sanctions: true,
  });
  const notams = await serve(
    [plugin],
    '/api/notams?lat=38.7&lon=-77&radiusNm=30',
  );
  assert.equal(notams.status, 200);
  const faa = calls.find((c) => c.url.includes('faa.gov'));
  assert.equal(faa.init.headers.client_id, 'CID');
  assert.match(faa.url, /locationRadius=30/);
  const acled = await serve([plugin], '/api/acled?country=Sudan&days=7');
  assert.equal(JSON.parse(acled.text).summary.events, 1);
  assert.equal(
    calls.find((c) => c.url.includes('acled/read')).init.headers.Authorization,
    'Bearer TOK',
  );
  const sanctions = await serve(
    [plugin],
    '/api/sanctions?q=ocean&schema=Person',
  );
  const body = JSON.parse(sanctions.text);
  assert.deepEqual(
    body.results.map((r) => r.id),
    ['v'],
  );
  assert.ok(
    !calls
      .find((c) => c.url.includes('opensanctions'))
      .url.includes('schema=Person'),
  );
  for (const r of [status, notams, acled, sanctions])
    for (const secret of ['CSECRET', 'APASS', 'OSKEY', 'TOK'])
      assert.ok(!r.text.includes(secret), `${secret} leaked`);
});
