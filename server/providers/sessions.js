/**
 * Live sessions: several operators on one picture.
 *
 *   POST /api/session                 create a room → { id }
 *   POST /api/session/<id>/events     append { kind, from, payload }
 *   GET  /api/session/<id>/events?after=<seq>&wait=<s>
 *                                     events after seq; waits up to 25 s for
 *                                     new ones (long poll)
 *
 * Kinds: hello (presence), view (camera), pin, note (chat), overlay.
 * Rooms are unguessable ids behind the access gate; each keeps its last 300
 * events for 12 hours. Storage is this server's memory; set
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to share rooms across
 * serverless instances (then reads poll instead of waiting).
 */
import crypto from 'node:crypto';
import { readRequestBody } from './common/request.js';
import { makeRateLimiter } from './common/rate-limit.js';

export const SESSION_KINDS = ['hello', 'view', 'pin', 'note', 'overlay', 'bye'];
const MAX_EVENTS = 300;
const TTL_MS = 12 * 3600_000;
const MAX_BODY = 32 * 1024;

export function newRoomId() {
  return crypto.randomBytes(12).toString('base64url');
}

/** Validate and trim an incoming event; null when unacceptable. */
export function cleanEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const kind = String(body.kind || '');
  if (!SESSION_KINDS.includes(kind)) return null;
  const from =
    String(body.from || 'operator')
      .replace(/[^\p{L}\p{N} ._-]/gu, '')
      .slice(0, 40) || 'operator';
  const clientId = String(body.clientId || '')
    .replace(/[^a-z0-9-]/gi, '')
    .slice(0, 40);
  const p =
    body.payload && typeof body.payload === 'object' ? body.payload : {};
  const num = (v, lo, hi) =>
    Number.isFinite(+v) && +v >= lo && +v <= hi ? +(+v).toFixed(6) : null;
  let payload = {};
  if (kind === 'view') {
    payload = {
      lat: num(p.lat, -90, 90),
      lon: num(p.lon, -180, 180),
      alt: num(p.alt, 0, 5e8),
      heading: num(p.heading, -720, 720),
      pitch: num(p.pitch, -180, 180),
    };
    if (payload.lat == null || payload.lon == null || payload.alt == null)
      return null;
  } else if (kind === 'pin') {
    payload = {
      lat: num(p.lat, -90, 90),
      lon: num(p.lon, -180, 180),
      label: String(p.label || '').slice(0, 80),
    };
    if (payload.lat == null || payload.lon == null) return null;
  } else if (kind === 'note') {
    payload = { text: String(p.text || '').slice(0, 500) };
    if (!payload.text.trim()) return null;
  } else if (kind === 'overlay') {
    const json = JSON.stringify(p.overlay || null);
    if (json.length > 24 * 1024) return null;
    payload = {
      overlay: p.overlay || null,
      title: String(p.title || '').slice(0, 120),
    };
  }
  return { kind, from, clientId, payload };
}

export function memoryStore({ now = () => Date.now() } = {}) {
  const rooms = new Map();
  const waiters = new Map();
  const prune = () => {
    for (const [id, r] of rooms)
      if (now() - r.touched > TTL_MS) rooms.delete(id);
  };
  return {
    shared: false,
    async create(id) {
      prune();
      rooms.set(id, { seq: 0, events: [], touched: now() });
    },
    async exists(id) {
      return rooms.has(id);
    },
    async append(id, event) {
      const r = rooms.get(id);
      if (!r) return null;
      r.seq += 1;
      r.touched = now();
      const e = { ...event, seq: r.seq, at: new Date(now()).toISOString() };
      r.events.push(e);
      if (r.events.length > MAX_EVENTS)
        r.events.splice(0, r.events.length - MAX_EVENTS);
      for (const w of waiters.get(id) || []) w();
      waiters.delete(id);
      return e;
    },
    async after(id, seq) {
      const r = rooms.get(id);
      return r ? r.events.filter((e) => e.seq > seq) : null;
    },
    wait(id, ms) {
      return new Promise((resolve) => {
        const list = waiters.get(id) || [];
        const t = setTimeout(resolve, ms);
        list.push(() => {
          clearTimeout(t);
          resolve();
        });
        waiters.set(id, list);
      });
    },
  };
}

/** Upstash Redis REST: a list per room, 12 h expiry. */
export function upstashStore({
  url,
  token,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
}) {
  const call = async (...command) => {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    if (!r.ok) throw new Error(`redis ${r.status}`);
    return (await r.json()).result;
  };
  const key = (id) => `adam:session:${id}`;
  return {
    shared: true,
    async create(id) {
      await call(
        'RPUSH',
        key(id),
        JSON.stringify({
          seq: 0,
          kind: 'created',
          at: new Date(now()).toISOString(),
        }),
      );
      await call('EXPIRE', key(id), Math.round(TTL_MS / 1000));
    },
    async exists(id) {
      return (await call('EXISTS', key(id))) === 1;
    },
    async append(id, event) {
      const len = await call('LLEN', key(id));
      if (!len) return null;
      const e = { ...event, seq: len, at: new Date(now()).toISOString() };
      await call('RPUSH', key(id), JSON.stringify(e));
      await call('LTRIM', key(id), -MAX_EVENTS, -1);
      await call('EXPIRE', key(id), Math.round(TTL_MS / 1000));
      return e;
    },
    async after(id, seq) {
      const list = await call('LRANGE', key(id), 0, -1);
      if (!list?.length) return null;
      return list
        .map((s) => JSON.parse(s))
        .filter((e) => e.seq > seq && e.kind !== 'created');
    },
    wait: (id, ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1500))),
  };
}

export function sessionsProxy({
  env = process.env,
  store = null,
  fetchImpl,
} = {}) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  const db =
    store ||
    (url && token ? upstashStore({ url, token, fetchImpl }) : memoryStore());
  const limit = makeRateLimiter({
    windowMs: 60_000,
    max: 240,
    globalMax: 2400,
  });
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };

  function install(middlewares) {
    middlewares.use('/api/session', async (req, res) => {
      if (!limit('session')) return send(res, 429, { error: 'rate limited' });
      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean);
      try {
        if (!parts.length) {
          if (req.method !== 'POST')
            return send(res, 405, { error: 'POST to create a room' });
          const id = newRoomId();
          await db.create(id);
          return send(res, 200, { id, shared: db.shared });
        }
        const [id, sub] = parts;
        if (!/^[A-Za-z0-9_-]{12,32}$/.test(id) || sub !== 'events')
          return send(res, 404, { error: 'no such room' });
        if (req.method === 'POST') {
          let body;
          try {
            body = JSON.parse(
              (await readRequestBody(req, MAX_BODY)).toString('utf8') || '{}',
            );
          } catch {
            return send(res, 400, { error: 'bad JSON' });
          }
          const event = cleanEvent(body);
          if (!event) return send(res, 400, { error: 'bad event' });
          const saved = await db.append(id, event);
          if (!saved)
            return send(res, 404, {
              error: 'no such room (it expires after 12 h)',
            });
          return send(res, 200, { seq: saved.seq });
        }
        const after = Math.max(0, Number(u.searchParams.get('after')) || 0);
        const waitS = Math.max(
          0,
          Math.min(25, Number(u.searchParams.get('wait')) || 0),
        );
        let events = await db.after(id, after);
        if (events === null)
          return send(res, 404, {
            error: 'no such room (it expires after 12 h)',
          });
        if (!events.length && waitS > 0) {
          await db.wait(id, waitS * 1000);
          events = (await db.after(id, after)) || [];
        }
        return send(res, 200, { events, shared: db.shared });
      } catch (error) {
        return send(res, 502, {
          error: `session store failed (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-sessions',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
