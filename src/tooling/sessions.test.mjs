import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import {
  cleanEvent,
  memoryStore,
  sessionsProxy,
  upstashStore,
} from '../../server/providers/sessions.js';

async function server(plugins) {
  const { handle } = createMiddlewareStack(plugins);
  const s = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  return { base, close: () => s.close() };
}

test('events are validated and trimmed', () => {
  assert.equal(cleanEvent({ kind: 'nope' }), null);
  assert.equal(
    cleanEvent({ kind: 'view', payload: { lat: 999, lon: 0, alt: 1 } }),
    null,
  );
  const v = cleanEvent({
    kind: 'view',
    from: 'ana <script>',
    payload: { lat: 48.8, lon: 2.3, alt: 5000, heading: 90 },
  });
  assert.equal(v.from, 'ana script');
  assert.equal(v.payload.alt, 5000);
  assert.equal(cleanEvent({ kind: 'note', payload: { text: '  ' } }), null);
  assert.equal(
    cleanEvent({ kind: 'note', payload: { text: 'x'.repeat(900) } }).payload
      .text.length,
    500,
  );
});

test('rooms: create, post, read after, long-poll wakes on a new event', async () => {
  const s = await server([sessionsProxy({ env: {}, store: memoryStore() })]);
  try {
    const { id } = await (
      await fetch(`${s.base}/api/session`, { method: 'POST' })
    ).json();
    assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    const post = (body) =>
      fetch(`${s.base}/api/session/${id}/events`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    assert.equal((await post({ kind: 'hello', from: 'ana' })).status, 200);
    const first = await (
      await fetch(`${s.base}/api/session/${id}/events?after=0`)
    ).json();
    assert.equal(first.events.length, 1);
    const waiting = fetch(
      `${s.base}/api/session/${id}/events?after=1&wait=10`,
    ).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 150));
    await post({
      kind: 'pin',
      from: 'ben',
      payload: { lat: 1, lon: 2, label: 'here' },
    });
    const woke = await waiting;
    assert.equal(woke.events[0].kind, 'pin');
    assert.equal(woke.events[0].seq, 2);
    assert.equal(
      (await fetch(`${s.base}/api/session/unknownroomid1234/events`)).status,
      404,
    );
    assert.equal((await post({ kind: 'bad' })).status, 400);
  } finally {
    s.close();
  }
});

test('upstash store speaks the REST command protocol', async () => {
  const lists = new Map();
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer T');
    const [cmd, key, ...args] = JSON.parse(init.body);
    const list = lists.get(key) || [];
    let result = null;
    if (cmd === 'RPUSH') {
      list.push(args[0]);
      lists.set(key, list);
      result = list.length;
    } else if (cmd === 'LLEN') result = list.length;
    else if (cmd === 'LRANGE') result = list.slice();
    else if (cmd === 'EXISTS') result = lists.has(key) ? 1 : 0;
    return { ok: true, json: async () => ({ result }) };
  };
  const db = upstashStore({
    url: 'https://x.upstash.io',
    token: 'T',
    fetchImpl,
  });
  await db.create('room123456789012');
  const e = await db.append('room123456789012', {
    kind: 'note',
    payload: { text: 'hi' },
  });
  assert.equal(e.seq, 1);
  const after = await db.after('room123456789012', 0);
  assert.equal(after.length, 1);
  assert.equal(after[0].payload.text, 'hi');
});
