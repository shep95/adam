import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { leadershipProxy } from '../../server/providers/leadership.js';

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

const uri = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });

test('leadership routes validate ids and query wikidata once per key', async () => {
  const calls = [];
  const plugin = leadershipProxy({
    fetchImpl: async (url) => {
      const q = decodeURIComponent(String(url).split('query=')[1]);
      calls.push(q);
      const bindings = q.includes('wdt:P150')
        ? [{ sub: uri('Q99'), subLabel: { value: 'California' } }]
        : [
            {
              area: uri('Q30'),
              role: { value: 'head of state' },
              person: uri('Q1'),
              personLabel: { value: 'A' },
            },
          ];
      return { ok: true, json: async () => ({ results: { bindings } }) };
    },
  });
  const o = await get(plugin, '/api/leadership/officeholders?ids=Q30,bad,Q30');
  assert.equal(o.status, 200);
  assert.equal(o.body.areas.Q30.holders[0].name, 'A');
  await get(plugin, '/api/leadership/officeholders?ids=Q30');
  assert.equal(calls.length, 1);
  const s = await get(plugin, '/api/leadership/subdivisions?id=Q30');
  assert.equal(s.body.subdivisions[0].name, 'California');
  assert.equal(
    (await get(plugin, '/api/leadership/subdivisions?id=x')).status,
    400,
  );
  assert.equal(
    (await get(plugin, '/api/leadership/officeholders?ids=')).status,
    400,
  );
  // Injection attempts never reach the query.
  await get(plugin, '/api/leadership/officeholders?ids=Q1%7D%20UNION');
  assert.ok(calls.every((c) => !c.includes('UNION {}') && !c.includes('Q1}')));
});
