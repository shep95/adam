import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  OVERPASS_KINDS,
  compactMilitaryElements,
  compactOverpassElements,
  compactSuaGeoJson,
  compactTfrList,
  infraContextProxy,
  joinPeeringDb,
  parseBox,
  validLandingId,
} from '../../server/providers/infraContext.js';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { viewportLoadable } from '../layers/contextOverlay/index.js';
import {
  cablesLandingNear,
  landingDetailRows,
} from '../layers/submarineCables/landingDetail.js';

const params = (o) => new URLSearchParams(o);

test('bbox parsing validates, bounds span and snaps outward', () => {
  assert.deepEqual(
    parseBox(
      params({ south: '30.2', west: '-97.9', north: '30.4', east: '-97.6' }),
      4,
    ),
    {
      south: 30,
      west: -98,
      north: 30.5,
      east: -97.5,
    },
  );
  assert.equal(
    parseBox(params({ south: '0', west: '0', north: '10', east: '10' }), 4),
    null,
  );
  assert.equal(
    parseBox(params({ south: 'x', west: '0', north: '1', east: '1' }), 4),
    null,
  );
  assert.equal(
    parseBox(params({ south: '1', west: '170', north: '2', east: '-170' }), 40),
    null,
  );
  assert.equal(
    parseBox(params({ south: '1e400', west: '0', north: '1', east: '1' }), 4),
    null,
  );
});

test('landing ids are strict slugs', () => {
  assert.equal(validLandingId('marseille-france'), 'marseille-france');
  assert.equal(validLandingId('../etc/passwd'), null);
  assert.equal(validLandingId('a b'), null);
  assert.equal(validLandingId(''), null);
});

test('overpass templates are fixed and interpolate only the numeric box', () => {
  for (const [kind, spec] of Object.entries(OVERPASS_KINDS)) {
    const ql = spec.ql('1,2,3,4', 10);
    assert.match(ql, /^\[out:json\]/, kind);
    assert.ok(ql.includes('(1,2,3,4)'), kind);
  }
});

test('overpass elements compact to points, lines and multilines with whitelisted tags', () => {
  const out = compactOverpassElements(
    [
      { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'A', secret: 'x' } },
      {
        type: 'way',
        id: 2,
        geometry: [
          { lat: 1, lon: 1 },
          { lat: 2, lon: 2 },
        ],
        tags: { power: 'line', voltage: '400000' },
      },
      {
        type: 'relation',
        id: 3,
        members: [
          {
            geometry: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 1 },
            ],
          },
        ],
        tags: {},
      },
      { type: 'way', id: 4, center: { lat: 5, lon: 6 }, tags: {} },
      { type: 'node', id: 5 },
    ],
    10,
  );
  assert.deepEqual(
    out.map((f) => f.geometry),
    ['point', 'line', 'multiline', 'point'],
  );
  assert.equal(out[0].tags.secret, undefined);
  assert.equal(out[1].tags.voltage, '400000');
  assert.equal(
    compactOverpassElements([{ type: 'node', id: 1, lat: 1, lon: 1 }], 0)
      .length,
    0,
  );
});

test('military overview keeps Overpass shape for the installation normalizer', () => {
  const out = compactMilitaryElements(
    [
      {
        type: 'way',
        id: 7,
        center: { lat: 1, lon: 2 },
        tags: { military: 'airfield', name: 'X', note: 'drop' },
      },
      { type: 'node', id: 8, lat: 3, lon: 4, tags: { military: 'base' } },
      { type: 'bogus', id: 9, lat: 1, lon: 1 },
    ],
    10,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].center, { lat: 1, lon: 2 });
  assert.equal(out[0].tags.note, undefined);
});

test('PeeringDB join places each exchange at its facilities and drops unlocated ones', () => {
  const out = joinPeeringDb(
    [
      {
        id: 1,
        name: 'DE-CIX',
        city: 'Frankfurt',
        country: 'DE',
        net_count: 1000,
        website: 'https://de-cix.net',
      },
      { id: 2, name: 'Nowhere-IX' },
    ],
    [
      { ix_id: 1, fac_id: 10 },
      { ix_id: 1, fac_id: 11 },
      { ix_id: 2, fac_id: 99 },
    ],
    [
      { id: 10, latitude: 50, longitude: 8 },
      { id: 11, latitude: 50.2, longitude: 8.2 },
    ],
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].coords, [8.1, 50.1]);
  assert.equal(out[0].tags.facilities, 2);
  assert.equal(
    joinPeeringDb(
      [{ id: 3, website: 'javascript:alert(1)' }],
      [{ ix_id: 3, fac_id: 10 }],
      [{ id: 10, latitude: 1, longitude: 1 }],
    )[0].tags.website,
    null,
  );
});

test('FAA SUA GeoJSON and TFR lists compact defensively', () => {
  const sua = compactSuaGeoJson({
    features: [
      {
        properties: { NAME: 'R-2508', TYPE_CODE: 'R' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      { properties: {}, geometry: null },
    ],
  });
  assert.equal(sua.length, 1);
  assert.equal(sua[0].tags.type, 'R');
  assert.equal(sua[0].geometry, 'multiline');
  assert.deepEqual(
    compactTfrList([
      { notam_id: '4/1234', type: 'SECURITY', state: 'DC' },
      {},
    ]).map((t) => t.notam),
    ['4/1234'],
  );
  assert.deepEqual(compactTfrList({ nope: true }), []);
});

async function serve(plugin, pathname) {
  const { handle } = createMiddlewareStack([plugin]);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${pathname}`,
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('proxy routes reject unknown kinds, bad boxes and ids, and serve stale on failure', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adam-infra-'));
  let calls = 0;
  let fail = false;
  const plugin = infraContextProxy({
    cacheDir,
    overpass: async () => {
      calls += 1;
      if (fail) throw new Error('down');
      return {
        status: 200,
        body: JSON.stringify({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 30.1,
              lon: -97.7,
              tags: { barrier: 'border_control' },
            },
          ],
        }),
      };
    },
    fetchImpl: async () => {
      throw new Error('no network in tests');
    },
  });
  assert.equal(
    (
      await serve(
        plugin,
        '/api/infra-context/overpass?kind=evil&south=1&west=1&north=2&east=2',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await serve(
        plugin,
        '/api/infra-context/overpass?kind=power-lines&south=0&west=0&north=10&east=10',
      )
    ).status,
    400,
  );
  assert.equal(
    (await serve(plugin, '/api/infra-context/landing-point?id=../../x')).status,
    400,
  );
  assert.equal((await serve(plugin, '/api/infra-context/nope')).status, 404);
  const ok = await serve(
    plugin,
    '/api/infra-context/overpass?kind=border-crossings&south=30&west=-98&north=31&east=-97',
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.features.length, 1);
  assert.equal(ok.body.cache, 'MISS');
  const again = await serve(
    plugin,
    '/api/infra-context/overpass?kind=border-crossings&south=30.1&west=-97.9&north=30.9&east=-97.1',
  );
  assert.equal(again.body.cache, 'HIT');
  assert.equal(calls, 1);
  const ixps = await serve(plugin, '/api/infra-context/ixps');
  assert.equal(ixps.status, 503);
  assert.equal(ixps.body.reason, 'unavailable');
  fail = true;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('viewport gating and landing-point detail helpers', () => {
  assert.equal(
    viewportLoadable({ south: 0, west: 0, north: 3, east: 3 }, 4),
    true,
  );
  assert.equal(
    viewportLoadable({ south: 0, west: 170, north: 3, east: -170 }, 40),
    false,
  );
  assert.equal(viewportLoadable(null, 4), false);
  const cables = [
    {
      properties: { id: 'a', name: 'Alpha' },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [5.37, 43.3],
            [6, 40],
          ],
        ],
      },
    },
    {
      properties: { id: 'b', name: 'Beta' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [10, 10],
          [11, 11],
        ],
      },
    },
  ];
  assert.deepEqual(
    cablesLandingNear(5.38, 43.29, cables).map((c) => c.name),
    ['Alpha'],
  );
  const rows = landingDetailRows({
    country: 'France',
    cables: [{ name: 'Alpha', planned: false, rfs: '2020', owners: 'X, Y' }],
  });
  assert.deepEqual(rows[0], ['Country', 'France']);
  assert.match(rows[2][1], /ACTIVE · RFS 2020 · Owners: X, Y/);
});
