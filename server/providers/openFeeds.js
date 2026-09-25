/**
 * Reach beyond the built-in layers, each route bounded:
 *
 *   GET  /api/spaceweather        NOAA SWPC: planetary Kp, F10.7 solar flux,
 *                                 NOAA R/S/G scales (keyless; 10-min cache)
 *   GET  /api/events?query=…      GDELT GEO 2.0: news-reported locations for a
 *                                 query over a timespan, as GeoJSON points
 *   POST /api/ingest/<feed>       push GeoJSON from your own systems
 *                                 (Authorization: Bearer ADAM_INGEST_TOKEN)
 *   GET  /api/ingest[/<feed>]     list feeds / read one
 *   GET  /api/fetch-geo?url=…     pull a public GeoJSON/KML/CSV URL onto the
 *                                 globe: https only, public addresses only,
 *                                 no redirects, 5 MB cap
 *
 * Ingested feeds live in this server's memory (a restart or a cold
 * serverless instance starts empty); point a persistent sender at it or run
 * the standalone server for long-lived feeds.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { readRequestBody } from './common/request.js';
import { makeRateLimiter } from './common/rate-limit.js';

const SWPC = 'https://services.swpc.noaa.gov';
const TEN_MIN = 10 * 60_000;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const MAX_INGEST_BYTES = 2 * 1024 * 1024;
const MAX_FEEDS = 20;
const MAX_FEATURES = 5000;

const send = (res, status, payload, type = 'application/json') => {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

// ── Space weather ────────────────────────────────────────────────────────
export function parseKp(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const header = rows[0];
  const iT = header.indexOf('time_tag');
  const iK = header.indexOf('Kp');
  const last = rows.at(-1);
  const kp = Number(last?.[iK]);
  return Number.isFinite(kp) ? { kp, time: String(last[iT]) } : null;
}

export function parseScales(obj) {
  const now = obj?.['0'];
  if (!now) return null;
  const pick = (k) => {
    const s = Number(now?.[k]?.Scale);
    return Number.isFinite(s) ? s : 0;
  };
  return { R: pick('R'), S: pick('S'), G: pick('G') };
}

export function spaceWeatherSummary({ kp, flux, scales }) {
  const effects = [];
  if (scales?.G >= 1 || kp?.kp >= 5)
    effects.push(
      `geomagnetic storm G${Math.max(scales?.G || 0, kp?.kp >= 5 ? Math.min(5, Math.floor(kp.kp) - 4) : 0)}: HF radio and GNSS accuracy degraded at high latitudes`,
    );
  if (scales?.R >= 1)
    effects.push(`radio blackout R${scales.R}: HF degraded on the dayside`);
  if (scales?.S >= 1)
    effects.push(
      `solar radiation storm S${scales.S}: polar HF and satellite operations affected`,
    );
  return {
    kp: kp?.kp ?? null,
    kpTime: kp?.time ?? null,
    f107: flux?.flux ?? null,
    f107Time: flux?.time ?? null,
    scales: scales || null,
    effects,
    quiet: effects.length === 0,
  };
}

// ── GDELT events ─────────────────────────────────────────────────────────
export function gdeltUrl(query, timespan = '24h') {
  const q = String(query || '').slice(0, 200);
  const ts = /^\d{1,3}(h|d)$/.test(timespan) ? timespan : '24h';
  const u = new URL('https://api.gdeltproject.org/api/v2/geo/geo');
  u.search = new URLSearchParams({
    query: q,
    format: 'GeoJSON',
    timespan: ts,
    maxpoints: '250',
  }).toString();
  return u.href;
}

export function normalizeGdelt(geo) {
  const out = [];
  for (const f of geo?.features || []) {
    const [lon, lat] = f?.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const html = String(f.properties?.html || '');
    const url = (html.match(/href="(https?:\/\/[^"]+)"/) || [])[1] || null;
    out.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name: String(f.properties?.name || '').slice(0, 120),
        count: Number(f.properties?.count) || 1,
        url,
      },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

// ── Ingest ───────────────────────────────────────────────────────────────
const GEOM = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

export function validateIngest(body) {
  const features =
    body?.type === 'FeatureCollection'
      ? body.features
      : body?.type === 'Feature'
        ? [body]
        : null;
  if (!Array.isArray(features))
    return { error: 'send a GeoJSON Feature or FeatureCollection' };
  if (features.length > MAX_FEATURES)
    return { error: `at most ${MAX_FEATURES} features` };
  const clean = [];
  for (const f of features) {
    if (!f || f.type !== 'Feature' || !GEOM.has(f.geometry?.type)) continue;
    clean.push({
      type: 'Feature',
      geometry: f.geometry,
      properties:
        f.properties && typeof f.properties === 'object' ? f.properties : {},
    });
  }
  return { collection: { type: 'FeatureCollection', features: clean } };
}

// ── URL fetch guard ──────────────────────────────────────────────────────
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('::ffff:') // mapped v4: refuse rather than re-parse
  );
}

export async function checkFetchUrl(
  raw,
  lookup = (h) => dns.lookup(h, { all: true }),
) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    return { error: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { error: 'https only' };
  if (u.username || u.password) return { error: 'no credentials in URLs' };
  if (u.port && u.port !== '443') return { error: 'standard https port only' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { error: 'private address refused' };
  } else {
    let addrs = [];
    try {
      addrs = await lookup(host);
    } catch {
      return { error: 'host does not resolve' };
    }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address)))
      return { error: 'private address refused' };
  }
  return { url: u.href };
}

const ALLOWED_TYPES =
  /(application\/(geo\+)?json|application\/vnd\.google-earth\.kml\+xml|application\/xml|text\/xml|text\/csv|text\/plain|application\/json)/i;

export function openFeedsProxy({
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  lookup,
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const feeds = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < TEN_MIN) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return value;
  }

  const getJson = async (url) => {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return res.json();
  };

  function install(middlewares) {
    middlewares.use('/api/spaceweather', async (req, res) => {
      try {
        const value = await cached('swpc', async () => {
          const [kpRows, flux, scales] = await Promise.allSettled([
            getJson(`${SWPC}/products/noaa-planetary-k-index.json`),
            getJson(`${SWPC}/json/f107_cm_flux.json`),
            getJson(`${SWPC}/products/noaa-scales.json`),
          ]);
          const f =
            flux.status === 'fulfilled' && Array.isArray(flux.value)
              ? flux.value.at(-1)
              : null;
          return spaceWeatherSummary({
            kp: kpRows.status === 'fulfilled' ? parseKp(kpRows.value) : null,
            flux: f ? { flux: Number(f.flux), time: f.time_tag } : null,
            scales:
              scales.status === 'fulfilled' ? parseScales(scales.value) : null,
          });
        });
        send(res, 200, { source: 'NOAA SWPC', ...value });
      } catch (error) {
        send(res, 502, {
          error: `space weather unavailable (${error.message})`,
        });
      }
    });

    middlewares.use('/api/events', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const query = url.searchParams.get('query') || '';
      if (!query.trim()) return send(res, 400, { error: 'query required' });
      if (!limit('events')) return send(res, 429, { error: 'rate limited' });
      try {
        const u = gdeltUrl(query, url.searchParams.get('timespan') || '24h');
        const value = await cached(u, async () =>
          normalizeGdelt(await getJson(u)),
        );
        send(res, 200, { source: 'GDELT GEO 2.0', query, ...value });
      } catch (error) {
        send(res, 502, { error: `events unavailable (${error.message})` });
      }
    });

    middlewares.use('/api/ingest', async (req, res) => {
      const feed = String(req.url || '/')
        .split('?')[0]
        .replace(/^\/+/, '')
        .trim();
      if (req.method === 'GET') {
        if (!feed)
          return send(res, 200, {
            feeds: [...feeds.entries()].map(([name, f]) => ({
              name,
              features: f.collection.features.length,
              updatedAt: new Date(f.at).toISOString(),
            })),
          });
        const f = feeds.get(feed);
        if (!f) return send(res, 404, { error: `no feed ${feed}` });
        return send(res, 200, {
          name: feed,
          updatedAt: new Date(f.at).toISOString(),
          ...f.collection,
        });
      }
      if (req.method !== 'POST')
        return send(res, 405, { error: 'method not allowed' });
      const token = String(env.ADAM_INGEST_TOKEN || '').trim();
      const auth = String(req.headers?.authorization || '');
      if (!token || token.length < 16 || auth !== `Bearer ${token}`)
        return send(res, 401, {
          error: 'ingest needs Authorization: Bearer ADAM_INGEST_TOKEN',
        });
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/i.test(feed))
        return send(res, 400, { error: 'feed name: letters, digits, dashes' });
      if (!feeds.has(feed) && feeds.size >= MAX_FEEDS)
        return send(res, 400, { error: `at most ${MAX_FEEDS} feeds` });
      let body;
      try {
        body = JSON.parse(await readRequestBody(req, MAX_INGEST_BYTES));
      } catch {
        return send(res, 400, { error: 'invalid JSON or over 2 MB' });
      }
      const { collection, error } = validateIngest(body);
      if (error) return send(res, 400, { error });
      feeds.set(feed, { at: now(), collection });
      return send(res, 200, { feed, accepted: collection.features.length });
    });

    middlewares.use('/api/fetch-geo', async (req, res) => {
      if (!limit('fetch-geo')) return send(res, 429, { error: 'rate limited' });
      const raw = new URL(req.url, 'http://x').searchParams.get('url');
      const checked = await checkFetchUrl(raw, lookup);
      if (checked.error) return send(res, 400, { error: checked.error });
      try {
        const upstream = await fetchImpl(checked.url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept:
              'application/geo+json, application/json, application/vnd.google-earth.kml+xml, text/csv, */*;q=0.1',
          },
        });
        if (upstream.status >= 300 && upstream.status < 400)
          return send(res, 400, { error: 'redirects are not followed' });
        if (!upstream.ok)
          return send(res, 502, { error: `upstream ${upstream.status}` });
        const type = upstream.headers.get('content-type') || '';
        if (!ALLOWED_TYPES.test(type))
          return send(res, 415, {
            error: `unsupported content type ${type || 'unknown'}`,
          });
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_FETCH_BYTES)
          return send(res, 413, { error: 'over 5 MB' });
        return send(res, 200, buf.toString('utf8'), type.split(';')[0]);
      } catch (error) {
        return send(res, 502, { error: `fetch failed (${error.message})` });
      }
    });
  }

  return {
    name: 'adam-open-feeds',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
