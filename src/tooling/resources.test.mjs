import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { resourcesProxy } from '../../server/providers/resources.js';

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

const row = (iso3, value) => ({
  countryiso3code: iso3,
  value,
  date: '2021',
  country: { id: iso3.slice(0, 2), value: iso3 },
});

test('resource ranking fetches and caches world bank indicators', async () => {
  const calls = [];
  const plugin = resourcesProxy({
    fetchImpl: async (url) => {
      const u = String(url);
      calls.push(u);
      const body = u.includes('NY.GDP.MKTP.CD')
        ? [{}, [row('SAU', 1e12), row('NOR', 5e11)]]
        : [{}, [row('SAU', 20), row('NOR', 5)]];
      return { ok: true, json: async () => body };
    },
  });
  const oil = await get(plugin, '/api/resources?type=oil');
  assert.equal(oil.status, 200);
  assert.equal(oil.body.rows[0].iso3, 'SAU');
  assert.equal(oil.body.unit, 'usd');
  assert.match(oil.body.source, /World Bank/);
  await get(plugin, '/api/resources?type=gas');
  // GDP is shared between rent types and cached.
  assert.equal(calls.filter((c) => c.includes('NY.GDP.MKTP.CD')).length, 1);
  const bad = await get(plugin, '/api/resources?type=unobtainium');
  assert.equal(bad.status, 400);
});

test('resource ranking reports upstream failure', async () => {
  const plugin = resourcesProxy({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  const r = await get(plugin, '/api/resources?type=water');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /503/);
});
