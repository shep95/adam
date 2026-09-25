import test from 'node:test';
import assert from 'node:assert/strict';

import { trimThread, bumpFocus, topFocus, storableTurn } from './memory.js';
import { repairThread, wireMessages, createShepherdAgent } from './agent.js';
import { parseBlocks, parseInline } from '../ui/shepherd/renderText.js';
import { formatZoneTime, zoneFor } from './localTime.js';
import {
  circleRing,
  compactResult,
  createShepherdExecutor,
} from './executor.js';
import { formatConsoleBlock } from './consoleState.js';
import { normalizeOverlay, confidenceTier, boundsFor } from './overlay.js';
import {
  buildingHeightM,
  footprintsFromOverpass,
  viewBox,
  buildingsQuery,
} from './buildings3d.js';
import { ndjsonEvents } from './client.js';
import tzLookup from 'tz-lookup';

test('threads trim to an operator turn and focus decays', () => {
  const thread = [
    { role: 'assistant', text: 'x' },
    { role: 'tool', toolCallId: 'a', name: 'n', result: '{}' },
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'yo' },
  ];
  assert.equal(trimThread(thread)[0].role, 'user');
  assert.equal(
    storableTurn({ role: 'user', text: 'a', images: [{ data: 'x' }] })
      .imageNote,
    '1 image(s)',
  );
  let focus = bumpFocus({}, 'layer:flights', 0);
  focus = bumpFocus(focus, 'layer:flights', 1000);
  focus = bumpFocus(focus, 'place:40,-74', 14 * 86_400_000);
  assert.deepEqual(topFocus(focus, 1), ['place:40,-74']);
});

test('repairThread answers orphaned tool calls and drops stray results', () => {
  const repaired = repairThread([
    { role: 'user', text: 'go' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'c1', name: 'drop_pin', args: {} },
        { id: 'c2', name: 'x', args: {} },
      ],
    },
    { role: 'tool', toolCallId: 'c1', name: 'drop_pin', result: '{"ok":true}' },
    { role: 'tool', toolCallId: 'zz', name: 'x', result: '{}' },
  ]);
  const tools = repaired
    .filter((t) => t.role === 'tool')
    .map((t) => t.toolCallId)
    .sort();
  assert.deepEqual(tools, ['c1', 'c2']);
  const wire = wireMessages([
    { role: 'user', text: 'a', images: [{ mime: 'image/png', data: 'AAA' }] },
    { role: 'assistant', text: 'b' },
    { role: 'user', text: 'c', images: [{ mime: 'image/png', data: 'BBB' }] },
  ]);
  assert.equal(wire[0].images, undefined);
  assert.equal(wire[2].images[0].data, 'BBB');
});

function memoryStub() {
  let saved = [];
  return {
    loadThread: async () => [],
    saveThread: async (t) => {
      saved = t;
    },
    clearThread: async () => {},
    loadPrefs: async () => ({}),
    savePrefs: async () => {},
    saved: () => saved,
  };
}

test('agent runs tool rounds until the model answers in words', async () => {
  const replies = [
    [
      { type: 'meta', provider: 'x', model: 'm' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'drop_pin',
        args: { lat: 1, lon: 2 },
      },
    ],
    [{ type: 'text', delta: 'pinned.' }],
  ];
  const sent = [];
  const client = {
    async *chat(body) {
      sent.push(body);
      for (const e of replies.shift()) yield e;
    },
  };
  const ran = [];
  const executor = {
    run: async (name, args) => (ran.push([name, args]), '{"ok":true}'),
  };
  const events = [];
  const memory = memoryStub();
  const agent = createShepherdAgent({
    client,
    executor,
    memory,
    getConsoleBlock: () => 'camera 1,2',
    onEvent: (e) => events.push(e.type),
  });
  await agent.send({ text: 'pin 1,2' });
  assert.deepEqual(ran, [['drop_pin', { lat: 1, lon: 2 }]]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].messages.at(-1).role, 'tool');
  assert.equal(sent[0].console, 'camera 1,2');
  assert.equal(agent.thread().at(-1).text, 'pinned.');
  assert.ok(events.includes('tool-start') && events.at(-1) === 'idle');
  assert.equal(memory.saved().length, 4);
});

test('agent surfaces stream errors without throwing', async () => {
  const client = {
    // eslint-disable-next-line require-yield
    async *chat() {
      const error = new Error('access token required');
      error.status = 401;
      error.body = { access: true };
      throw error;
    },
  };
  const events = [];
  const agent = createShepherdAgent({
    client,
    executor: { run: async () => '{}' },
    memory: memoryStub(),
    getConsoleBlock: () => '',
    onEvent: (e) => events.push(e),
  });
  await agent.send({ text: 'hi' });
  const err = events.find((e) => e.type === 'error');
  assert.equal(err.status, 401);
  assert.equal(err.body.access, true);
});

test('reply parser: confidence lines, lists, code and inline marks', () => {
  const blocks = parseBlocks(
    '## read\nthe strait is **busy** today.\n- tankers up\n- ais gaps\n\nconfidence: 0.62 · signal: moderate · evidence: counts vs baseline · unknown: dark vessels\n```\nraw\n```',
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'p', 'list', 'confidence', 'code'],
  );
  assert.equal(blocks[3].value, 0.62);
  assert.equal(blocks[3].signal, 'moderate');
  assert.equal(blocks[3].unknown, 'dark vessels');
  assert.deepEqual(
    parseInline('a `b` **c**').map((r) => r.kind),
    ['text', 'code', 'text', 'strong'],
  );
  assert.equal(
    parseBlocks('<img src=x onerror=alert(1)>')[0].text,
    '<img src=x onerror=alert(1)>',
  );
});

test('local time resolves a zone and formats it', () => {
  assert.equal(zoneFor(tzLookup, 40.71, -74.0), 'America/New_York');
  assert.equal(zoneFor(tzLookup, 35.68, 139.69 + 360), 'Asia/Tokyo');
  assert.equal(zoneFor(tzLookup, 95, 0), null);
  const t = formatZoneTime(
    'America/New_York',
    new Date('2026-07-04T16:00:00Z'),
  );
  assert.equal(t.time, '12:00:00');
  assert.equal(t.abbr, 'EDT');
});

test('executor helpers: circles, bounded results, extra tools', async () => {
  const ring = circleRing(0, 0, 111.32, 4);
  assert.equal(ring.length, 4);
  assert.ok(Math.abs(ring[0][0] - 1) < 1e-3);
  assert.match(compactResult({ big: 'x'.repeat(9000) }), /truncated/);
  const calls = [];
  const rules = [];
  const exec = createShepherdExecutor({
    runGevAction: async (name, args) => (
      calls.push([name, args]),
      { ok: true }
    ),
    viewer: {},
    dataManager: { isEnabled: () => true, getAll: () => [] },
    intel: {
      alerts: { add: (r) => (rules.push(r), { id: 'r1', label: 'x' }) },
    },
    overlay: { dropPin: (a) => ({ ok: true, ...a }) },
    buildings: { set: async (on) => ({ ok: true, state: on ? 'on' : 'off' }) },
    client: {},
  });
  assert.equal(
    JSON.parse(
      await exec.run('set_layers', {
        layers: [{ id: 'flights', enabled: true }],
      }),
    ).ok,
    true,
  );
  assert.deepEqual(calls[0], [
    'set_layer_visibility',
    { layerId: 'flights', enabled: true },
  ]);
  await exec.run('fly_to_location', { query: 'hormuz' });
  assert.equal(calls[1][0], 'fly_to_location');
  const zone = JSON.parse(
    await exec.run('create_alert_zone', {
      kind: 'count-in-zone',
      layer: 'military',
      lat: 26.5,
      lon: 56.3,
      radiusNm: 50,
      threshold: 0,
    }),
  );
  assert.equal(zone.ok, true);
  assert.equal(rules[0].ring.length, 48);
  assert.equal(rules[0].threshold, 0);
  const bad = JSON.parse(await exec.run('set_3d_buildings', null));
  assert.equal(bad.state, 'off');
});

test('console block is terse and honest', () => {
  const text = formatConsoleBlock({
    utc: '2026-01-01T00:00:00Z',
    camera: { lat: 1, lon: 2, altM: 300, headingDeg: 0, pitchDeg: -30 },
    localTime: 'GMT+1 01:00:00',
    tracking: null,
    layers: [
      { id: 'flights', count: 12, feed: 'nominal' },
      { id: 'cctv', count: 0, feed: 'stale' },
    ],
    pins: [],
    lastTracked: null,
    filters: { timeWindowMs: 600000, altitudeBands: ['high'] },
    alertRules: 2,
    overlay: null,
    buildings3d: null,
  });
  assert.match(text, /layers on: flights=12 cctv=0\(stale\)/);
  assert.match(text, /filters: window 10m, alt high/);
});

test('overlay payloads are validated and tiered by confidence', () => {
  const o = normalizeOverlay({
    nodes: [
      { id: 'a', label: 'port', lat: 1, lon: 2, confidence: 0.9 },
      { id: 'a', label: 'dup', lat: 1, lon: 2 },
      { id: 'b', label: 'x', lat: 200, lon: 2 },
      { id: 'c', label: 'yard', lat: 1.1, lon: 2.1, confidence: 7 },
    ],
    links: [
      { from: 'a', to: 'c' },
      { from: 'a', to: 'b' },
    ],
  });
  assert.deepEqual(
    o.nodes.map((n) => n.id),
    ['a', 'c'],
  );
  assert.equal(o.nodes[1].confidence, 1);
  assert.equal(o.links.length, 1);
  assert.equal(confidenceTier(0.5), 'moderate');
  assert.ok(boundsFor(o.nodes).north > 1.1);
});

test('building heights and footprints from OSM', () => {
  assert.equal(buildingHeightM({ height: '42 m' }), 42);
  assert.equal(buildingHeightM({ 'building:levels': '10' }), 32);
  assert.equal(buildingHeightM({}), 9);
  const fp = footprintsFromOverpass({
    elements: [
      {
        type: 'way',
        tags: { building: 'yes', 'building:levels': '3' },
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 1e-4 },
          { lat: 1e-4, lon: 1e-4 },
          { lat: 0, lon: 0 },
        ],
      },
      { type: 'way', tags: {}, geometry: [{ lat: 0, lon: 0 }] },
    ],
  });
  assert.equal(fp.length, 1);
  assert.ok(Math.abs(fp[0].height - 9.6) < 1e-9);
  const box = viewBox(40.7, -74, 1500);
  assert.ok(box[2] - box[0] < 0.03);
  assert.match(buildingsQuery(box), /way\["building"\]\(/);
});

test('ndjson reader tolerates torn and split lines', async () => {
  const chunks = [
    '{"type":"te',
    'xt","delta":"a"}\n{bad}\n',
    '{"type":"done"}',
  ];
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  const out = [];
  for await (const e of ndjsonEvents(body)) out.push(e.type);
  assert.deepEqual(out, ['text', 'done']);
});

test('console_command drives panels, scope, capture and alerts', async () => {
  const calls = [];
  const scopeBtn = {
    attrs: { 'aria-pressed': 'true' },
    getAttribute(k) {
      return this.attrs[k];
    },
    click() {
      calls.push('scope-click');
    },
  };
  const doc = {
    getElementById: (id) => (id === 'scope-toggle' ? scopeBtn : null),
    documentElement: { dataset: { uiScale: '1.15', adamView: 'surface' } },
  };
  const consoleHandle = {
    opsDeck: { toggleView: (id, open) => calls.push(`view:${id}:${open}`) },
    capture: {
      snapshot: async () => calls.push('snap'),
      setScale: (s) => calls.push(`scale:${s}`),
    },
    hudPolicy: { openDisplay: (o) => calls.push(`display:${o}`) },
  };
  const removed = [];
  const exec = createShepherdExecutor({
    runGevAction: async () => ({ ok: true }),
    viewer: {},
    dataManager: {
      isEnabled: () => true,
      getAll: () => [{ id: 'flights', enabled: true, stats: { count: 12 } }],
    },
    intel: {
      alerts: {
        list: () => [{ id: 'r1' }],
        remove: (id) => (removed.push(id), true),
      },
      getPins: () => [],
    },
    overlay: { clear: () => ({ ok: true }) },
    buildings: {},
    client: {},
    getConsole: () => consoleHandle,
    doc,
  });
  const run = async (args) =>
    JSON.parse(await exec.run('console_command', args));
  assert.equal(
    (await run({ command: 'open_panel', panel: 'filter' })).ok,
    true,
  );
  assert.equal((await run({ command: 'scope', value: 'off' })).scope, 'off');
  assert.equal((await run({ command: 'snapshot' })).ok, true);
  await run({ command: 'ui_scale', value: '1.3' });
  await run({ command: 'open_panel', panel: 'display' });
  const status = await run({ command: 'system_status' });
  assert.deepEqual(calls, [
    'view:filters:true',
    'scope-click',
    'snap',
    'scale:1.3',
    'display:true',
  ]);
  assert.equal(status.layers[0].count, 12);
  assert.equal(status.uiScale, 1.15);
  assert.equal(JSON.parse(await exec.run('list_alerts', {})).rules.length, 1);
  assert.equal(
    JSON.parse(await exec.run('remove_alert', { id: 'r1' })).ok,
    true,
  );
  assert.deepEqual(removed, ['r1']);
});
