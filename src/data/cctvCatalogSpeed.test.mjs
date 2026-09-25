import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const cams = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `${prefix} ${i}`,
    lat: 40 + i * 0.01,
    lon: -74,
    url: `https://example.test/${prefix}/${i}.jpg`,
  }));

async function withLiveEnv(fn) {
  const saved = { ...process.env };
  try {
    process.env.CCTV_SOURCES_FILE = '/nonexistent/cctv.json';
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_PREFER_AUSTIN = '1';
    await fn();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('a slow pack does not hold the catalog: first wave answers, late pack merges in', async () => {
  await withLiveEnv(async () => {
    let releaseSlow;
    const slowGate = new Promise((r) => (releaseSlow = r));
    const getSources = createCctvCatalog({
      sourceRoot: '/nonexistent',
      firstWaveMs: 30,
      packs: [
        {
          name: 'fast',
          enabled: () => true,
          load: async () => cams('fast', 3),
        },
        {
          name: 'slow',
          enabled: () => true,
          load: async () => {
            await slowGate;
            return cams('slow', 2);
          },
        },
        {
          name: 'broken',
          enabled: () => true,
          load: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const t0 = Date.now();
    const first = await getSources();
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(first.map((s) => s.id).sort(), [
      'fast-0',
      'fast-1',
      'fast-2',
    ]);
    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    const merged = await getSources();
    assert.equal(merged.length, 5);
  });
});

test('an expired catalog is served at once while one refresh runs', async () => {
  await withLiveEnv(async () => {
    let loads = 0;
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      const getSources = createCctvCatalog({
        sourceRoot: '/nonexistent',
        firstWaveMs: 5000,
        packs: [
          {
            name: 'p',
            enabled: () => true,
            load: async () => {
              loads += 1;
              if (loads > 1) await new Promise((r) => setTimeout(r, 50));
              return cams(`gen${loads}`, 2);
            },
          },
        ],
      });
      const first = await getSources();
      assert.equal(first[0].id, 'gen1-0');
      offset = 60 * 60 * 1000; // past the TTL
      const t0 = realNow();
      const [a, b] = await Promise.all([getSources(), getSources()]);
      assert.ok(realNow() - t0 < 40, 'stale catalog served without waiting');
      assert.equal(a[0].id, 'gen1-0');
      assert.equal(b[0].id, 'gen1-0');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(loads, 2);
      assert.equal((await getSources())[0].id, 'gen2-0');
    } finally {
      Date.now = realNow;
    }
  });
});
