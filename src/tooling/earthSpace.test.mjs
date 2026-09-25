import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { earthSpaceProxy } from '../../server/providers/earthSpace.js';

async function serve(plugins, path) {
  const { handle } = createMiddlewareStack(plugins);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test('volcano and close-approach routes normalise and cache', async () => {
  let calls = 0;
  const plugin = earthSpaceProxy({
    fetchImpl: async (url) => {
      calls += 1;
      const u = String(url);
      const json = (b) => ({ ok: true, json: async () => b });
      if (u.includes('volcano.si.edu'))
        return json({
          features: [
            {
              geometry: { coordinates: [-175.4, -20.5] },
              properties: {
                Volcano_Name: 'Hunga',
                Primary_Volcano_Type: 'Submarine',
              },
            },
          ],
        });
      if (u.includes('hans-public'))
        return json([
          {
            volcano_name: 'Kilauea',
            latitude: 19.4,
            longitude: -155.3,
            color_code: 'ORANGE',
          },
        ]);
      if (u.includes('cad.api'))
        return json({
          fields: ['des', 'cd', 'dist', 'v_rel', 'h', 'fullname'],
          data: [['X', '2026-Oct-01 00:00', '0.01', '12', '24', 'X']],
        });
      throw new Error(u);
    },
  });
  const v = await serve([plugin], '/api/volcanoes');
  assert.equal(v.body.volcanoes[0].submarine, true);
  const e = await serve([plugin], '/api/volcanoes/elevated');
  assert.equal(e.body.volcanoes[0].color, 'ORANGE');
  const c = await serve([plugin], '/api/space/close-approaches');
  assert.equal(c.body.approaches[0].designation, 'X');
  await serve([plugin], '/api/volcanoes');
  assert.equal(calls, 3, 'second GVP read comes from cache');
  const down = earthSpaceProxy({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal((await serve([down], '/api/volcanoes')).status, 502);
});
