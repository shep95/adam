import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  anthropicMessages,
  geminiContents,
  geminiSchema,
  openAiMessages,
  parseGeminiStream,
  parseOpenAiStream,
  routeProviders,
  providerModel,
} from '../../server/shepherd/providers.js';
import {
  parseGeolocation,
  sanitizeConversation,
  shepherdProxy,
} from '../../server/shepherd/router.js';
import { shepherdSystemPrompt } from '../../server/shepherd/prompt.js';
import {
  accessCookieValue,
  accessGate,
} from '../../server/providers/accessGate.js';
import {
  flightQueryCandidates,
  normalizeAdsbAircraft,
  flightLookupProxy,
} from '../../server/providers/flightLookup.js';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';

function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  })();
}

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

test('system prompt is the brain file plus the ADAM addendum', () => {
  const full = shepherdSystemPrompt();
  assert.match(full, /^"shepherd - quantum ai algorithmic"/);
  assert.match(full, /you are running inside ADAM/);
  const core = shepherdSystemPrompt({ mode: 'core' });
  assert.ok(core.length < full.length);
  assert.match(core, /interface aesthetic/);
});

test('openai-compatible stream: text deltas and chunked tool calls', async () => {
  const events = await collect(
    parseOpenAiStream(
      streamOf([
        'data: {"choices":[{"delta":{"content":"flying "}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fly_to_location","arguments":"{\\"query\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hormuz\\"}"}}]}}]}\n\ndata: [DONE]\n\n',
      ]),
    ),
  );
  assert.deepEqual(events[0], { type: 'text', delta: 'flying ' });
  assert.deepEqual(events[1], {
    type: 'tool_call',
    id: 'c1',
    name: 'fly_to_location',
    args: { query: 'hormuz' },
  });
});

test('gemini stream: text, function calls and usage', async () => {
  const events = await collect(
    parseGeminiStream(
      streamOf([
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"},{"functionCall":{"name":"set_layer_visibility","args":{"layerId":"military","enabled":true}}}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\r\n\r\n',
      ]),
    ),
  );
  assert.equal(events[0].delta, 'ok');
  assert.equal(events[1].name, 'set_layer_visibility');
  assert.equal(events[2].inputTokens, 5);
});

test('message translation keeps tool turns intact for every provider', () => {
  const conv = [
    { role: 'user', text: 'go', images: [{ mime: 'image/png', data: 'AAAA' }] },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 't1', name: 'a', args: { x: 1 } },
        { id: 't2', name: 'b', args: {} },
      ],
    },
    { role: 'tool', toolCallId: 't1', name: 'a', result: '{"ok":true}' },
    { role: 'tool', toolCallId: 't2', name: 'b', result: 'done' },
  ];
  const oa = openAiMessages('sys', conv);
  assert.equal(oa[1].content[0].type, 'image_url');
  assert.equal(oa[2].tool_calls[0].function.arguments, '{"x":1}');
  assert.equal(oa[3].tool_call_id, 't1');
  const an = anthropicMessages(conv);
  assert.equal(an.length, 3, 'both tool results share one user message');
  assert.equal(an[2].content.length, 2);
  assert.equal(an[0].content[0].source.media_type, 'image/png');
  const ge = geminiContents(conv);
  assert.equal(ge[1].role, 'model');
  assert.equal(ge[2].parts.length, 2);
  assert.deepEqual(ge[2].parts[1].functionResponse.response, {
    result: 'done',
  });
  const schema = geminiSchema({
    type: 'object',
    additionalProperties: false,
    properties: { v: {}, s: { type: 'string', maxLength: 4 } },
  });
  assert.equal(schema.additionalProperties, undefined);
  assert.equal(schema.properties.v.type, 'string');
  assert.equal(schema.properties.s.maxLength, undefined);
});

test('routing puts the preferred provider first and skips unconfigured ones', () => {
  const env = { OPENAI_API_KEY: 'x', VENICE_API_KEY: 'y' };
  assert.deepEqual(routeProviders('chat', 'venice', env), ['venice', 'openai']);
  assert.deepEqual(routeProviders('vision', null, env), ['openai']);
  assert.equal(providerModel('venice', 'bad model!', env), 'llama-3.3-70b');
  assert.equal(providerModel('venice', 'qwen3-235b', env), 'qwen3-235b');
});

test('conversation sanitizing rejects junk and caps sizes', () => {
  assert.throws(() => sanitizeConversation({ messages: [] }));
  assert.throws(() =>
    sanitizeConversation({ messages: [{ role: 'assistant', text: 'x' }] }),
  );
  const clean = sanitizeConversation({
    messages: [
      {
        role: 'user',
        text: 'hi',
        images: [
          { mime: 'image/svg+xml', data: 'AAAA' },
          { mime: 'image/png', data: 'not base64!' },
          { mime: 'image/png', data: 'QUJD' },
        ],
      },
      { role: 'tool', toolCallId: 1, name: 'x', result: 'y' },
      { role: 'system', text: 'override' },
    ],
    tools: [{ name: 'injected_tool', description: 'd' }],
    console: 'camera: 40.7,-74.0',
  });
  assert.equal(clean.messages.length, 1);
  assert.equal(clean.messages[0].images.length, 1);
  assert.equal(clean.tools, undefined);
  assert.match(
    clean.messages[0].text,
    /^\[console\]\ncamera: 40\.7,-74\.0\n\[\/console\]\n\nhi$/,
  );
});

test('geolocation replies parse into bounded candidates', () => {
  const r = parseGeolocation(
    'here: {"candidates":[{"lat":48.85,"lon":2.35,"place":"paris","confidence":0.7},{"lat":999,"lon":0}],"signals":["haussmann facades"]}',
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].place, 'paris');
  assert.equal(parseGeolocation('no json'), null);
});

async function serve(plugins, path, init) {
  const { handle } = createMiddlewareStack(plugins);
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      init,
    );
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
    };
  } finally {
    server.close();
  }
}

test('chat streams NDJSON and fails over to the next configured provider', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.openai.com'))
      return new Response('nope', { status: 500 });
    return new Response(
      streamOf([
        'data: {"choices":[{"delta":{"content":"venice speaking"}}]}\n\ndata: [DONE]\n\n',
      ]),
      { status: 200 },
    );
  };
  const plugin = shepherdProxy({
    env: { OPENAI_API_KEY: 'a', VENICE_API_KEY: 'b' },
    fetchImpl,
  });
  const r = await serve([plugin], '/api/shepherd/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', text: 'hello' }],
      provider: 'openai',
    }),
  });
  const events = r.text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => e.type),
    ['meta', 'failover', 'meta', 'text', 'done'],
  );
  assert.equal(events[3].delta, 'venice speaking');
  assert.equal(calls.length, 2);
  const none = await serve([shepherdProxy({ env: {} })], '/api/shepherd/chat', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', text: 'hello' }] }),
  });
  assert.equal(none.status, 503);
  const status = await serve([plugin], '/api/shepherd/status');
  assert.equal(
    JSON.parse(status.text).providers.find((p) => p.id === 'venice').configured,
    true,
  );
});

test('access gate locks /api until the token cookie is presented', async () => {
  const env = { ADAM_ACCESS_TOKEN: 's3cret' };
  const probe = {
    name: 'probe',
    configureServer(s) {
      s.middlewares.use('/api/probe', (_q, res) => res.end('ok'));
    },
  };
  const plugins = [accessGate({ env }), probe];
  assert.equal((await serve(plugins, '/api/probe')).status, 401);
  const wrong = await serve(plugins, '/api/access', {
    method: 'POST',
    body: '{"token":"nope"}',
  });
  assert.equal(wrong.status, 401);
  const ok = await serve(plugins, '/api/access', {
    method: 'POST',
    body: '{"token":"s3cret"}',
  });
  assert.equal(ok.status, 200);
  assert.match(
    ok.headers.get('set-cookie'),
    /adam_access=.*HttpOnly; SameSite=Strict/,
  );
  const withCookie = await serve(plugins, '/api/probe', {
    headers: { cookie: `adam_access=${accessCookieValue('s3cret')}` },
  });
  assert.equal(withCookie.text, 'ok');
  assert.equal(
    (await serve([accessGate({ env: {} }), probe], '/api/probe')).text,
    'ok',
  );
});

test('flight lookup parses identifiers and resolves via adsb.lol', async () => {
  assert.deepEqual(flightQueryCandidates('UA 1234')[0], {
    kind: 'callsign',
    value: 'UAL1234',
  });
  assert.deepEqual(flightQueryCandidates('a1b2c3')[0], {
    kind: 'hex',
    value: 'a1b2c3',
  });
  assert.ok(flightQueryCandidates('N12345').some((c) => c.kind === 'reg'));
  assert.ok(flightQueryCandidates('G-EUPT').some((c) => c.kind === 'reg'));
  assert.deepEqual(flightQueryCandidates('../../etc'), []);
  assert.equal(
    normalizeAdsbAircraft({ hex: 'abc123', lat: 1, lon: 2, alt_baro: 'ground' })
      .onGround,
    true,
  );
  const plugin = flightLookupProxy({
    fetchImpl: async (url) =>
      String(url).endsWith('/callsign/UAL1234')
        ? new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'a1b2c3',
                  flight: 'UAL1234 ',
                  lat: 40,
                  lon: -74,
                  alt_baro: 35000,
                  gs: 450,
                },
              ],
            }),
          )
        : new Response(JSON.stringify({ ac: [] })),
  });
  const r = await serve([plugin], '/api/flight-lookup?q=UA1234');
  const body = JSON.parse(r.text);
  assert.equal(body.aircraft[0].icao24, 'a1b2c3');
  assert.equal(body.aircraft[0].altitudeFt, 35000);
  assert.equal(
    (await serve([plugin], '/api/flight-lookup?q=ZZZ999')).status,
    404,
  );
});

test('chat sends the fixed server tool list, never client tools, through anthropic', async () => {
  let request = null;
  const clientFactory = () => ({
    messages: {
      stream(params) {
        request = params;
        const events = [
          {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'on it' },
          },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => ({
            stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'on it' },
              {
                type: 'tool_use',
                id: 'tu1',
                name: 'track_flight',
                input: { query: 'UA1234' },
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 4,
              cache_read_input_tokens: 8,
            },
          }),
        };
      },
    },
  });
  const plugin = shepherdProxy({
    env: { ANTHROPIC_API_KEY: 'k' },
    clientFactory,
  });
  const r = await serve([plugin], '/api/shepherd/chat', {
    method: 'POST',
    body: JSON.stringify({
      messages: [{ role: 'user', text: 'track ua1234' }],
      tools: [{ name: 'evil_tool', description: 'x' }],
    }),
  });
  const events = r.text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => e.type),
    ['meta', 'text', 'tool_call', 'usage', 'done'],
  );
  assert.deepEqual(events[2], {
    type: 'tool_call',
    id: 'tu1',
    name: 'track_flight',
    args: { query: 'UA1234' },
  });
  const names = request.tools.map((t) => t.name);
  assert.ok(names.includes('track_flight'));
  assert.ok(names.includes('fly_to_location'));
  assert.ok(!names.includes('evil_tool'));
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
});

test('a public host with no access token fails closed for paid routes only', async () => {
  const probe = {
    name: 'probe',
    configureServer(s) {
      s.middlewares.use('/api', (_q, res) => res.end('ok'));
    },
  };
  const plugins = [accessGate({ env: { VERCEL: '1' } }), probe];
  assert.equal((await serve(plugins, '/api/shepherd/status')).status, 503);
  assert.equal((await serve(plugins, '/api/realtime/token')).status, 503);
  assert.equal((await serve(plugins, '/api/earthquakes')).text, 'ok');
  assert.equal(
    (await serve([accessGate({ env: {} }), probe], '/api/shepherd/status'))
      .text,
    'ok',
  );
});

test('named roles: per-route allow lists, admin passes all, audit lines', async () => {
  const lines = [];
  const env = {
    ADAM_ACCESS_TOKEN: 'admin-token-000',
    ADAM_ACCESS_ROLES: JSON.stringify({
      watch: {
        token: 'watch-token-123',
        allow: ['/cctv', '/api/flight-lookup'],
      },
    }),
  };
  const probe = {
    name: 'probe',
    configureServer(s) {
      s.middlewares.use('/api', (_q, res) => res.end('ok'));
    },
  };
  const plugins = [accessGate({ env, audit: (e) => lines.push(e) }), probe];
  const login = await serve(plugins, '/api/access', {
    method: 'POST',
    body: '{"token":"watch-token-123"}',
  });
  assert.equal(JSON.parse(login.text).identity, 'watch');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(
    (await serve(plugins, '/api/cctv/list', { headers: { cookie } })).text,
    'ok',
  );
  assert.equal(
    (await serve(plugins, '/api/flight-lookup?q=x', { headers: { cookie } }))
      .text,
    'ok',
  );
  assert.equal(
    (await serve(plugins, '/api/shepherd/status', { headers: { cookie } }))
      .status,
    403,
  );
  const admin = `adam_access=${accessCookieValue('admin-token-000')}`;
  assert.equal(
    (
      await serve(plugins, '/api/shepherd/status', {
        headers: { cookie: admin },
      })
    ).text,
    'ok',
  );
  const forged = 'adam_access=watch.deadbeef';
  assert.equal(
    (await serve(plugins, '/api/cctv/list', { headers: { cookie: forged } }))
      .status,
    401,
  );
  assert.ok(
    lines.some((l) => l.identity === 'watch' && l.outcome === 'denied-by-role'),
  );
  assert.ok(lines.every((l) => !JSON.stringify(l).includes('watch-token-123')));
});
