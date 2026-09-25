import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { crimeProxy } from '../../server/providers/crime.js';

async function get(plugin, path) {
  const { handle } = createMiddlewareStack([plugin]);
  const s = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`);
    return { status: r.status, body: await r.json() };
  } finally {
    s.close();
  }
}

test('crime routes pick the right open source and say when there is none', async () => {
  const calls = [];
  const plugin = crimeProxy({
    now: () => Date.parse('2026-09-25T00:00:00Z'),
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = String(url);
      const json = (b) => ({ ok: true, json: async () => b });
      if (u.includes('data.police.uk'))
        return json([
          {
            category: 'burglary',
            month: '2026-07',
            location: { latitude: '51.5', longitude: '-0.12' },
          },
        ]);
      if (u.includes('cityofchicago'))
        return json([
          {
            primary_type: 'THEFT',
            date: '2026-09-20T00:00:00',
            latitude: '41.88',
            longitude: '-87.63',
          },
        ]);
      if (u.includes('worldbank'))
        return json([
          {},
          [
            {
              countryiso3code: 'MEX',
              value: 25,
              date: '2022',
              country: { value: 'Mexico' },
            },
          ],
        ]);
      throw new Error(u);
    },
  });
  const uk = await get(plugin, '/api/crime/near?lat=51.5&lon=-0.12');
  assert.equal(uk.body.incidents[0].category, 'burglary');
  const chi = await get(
    plugin,
    '/api/crime/near?lat=41.88&lon=-87.63&radiusM=1000',
  );
  assert.equal(chi.body.city, 'Chicago');
  assert.match(
    decodeURIComponent(calls.find((c) => c.includes('cityofchicago'))),
    /within_circle\(location, 41\.88, -87\.63, 1000\) AND date > '2026-08-26T00:00:00'/,
  );
  const none = await get(plugin, '/api/crime/near?lat=48.85&lon=2.35');
  assert.equal(none.body.source, null);
  assert.match(none.body.note, /no open street-level crime data/);
  const wb = await get(plugin, '/api/crime/homicide-rates');
  assert.equal(wb.body.rates.MEX.rate, 25);
});
