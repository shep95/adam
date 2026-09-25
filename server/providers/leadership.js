/**
 * Public officeholders from Wikidata, cached for 12 hours:
 *
 *   GET /api/leadership/officeholders?ids=Q30,Q1384   current heads of state
 *        and government (office, party, since) for up to 12 areas
 *   GET /api/leadership/subdivisions?id=Q30           an area's direct
 *        subdivisions (states, provinces, counties…) and their heads of
 *        government
 *
 * Public office only; nothing about where any officeholder is.
 */
import { makeRateLimiter } from './common/rate-limit.js';
import {
  QID_RE,
  normalizeOfficeholders,
  normalizeSubdivisions,
  officeholdersQuery,
  subdivisionsQuery,
} from '../../src/intel/leadership.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'ADAM/1 (public officeholders; https://github.com/shep95/adam)';
const CACHE_MS = 12 * 3600_000;

export function leadershipProxy({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 200 });
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  const sparql = async (query) => {
    const r = await fetchImpl(`${SPARQL}?query=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) throw new Error(`wikidata ${r.status}`);
    return r.json();
  };
  const cached = async (key, fn) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  };

  function install(middlewares) {
    middlewares.use('/api/leadership', async (req, res) => {
      if (!limit('leadership'))
        return send(res, 429, { error: 'rate limited' });
      const url = new URL(req.url, 'http://x');
      try {
        if (url.pathname === '/officeholders') {
          const ids = [
            ...new Set(
              String(url.searchParams.get('ids') || '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => QID_RE.test(s)),
            ),
          ].slice(0, 12);
          if (!ids.length)
            return send(res, 400, { error: 'ids= Wikidata ids required' });
          const areas = await cached(`o:${ids.join(',')}`, async () =>
            normalizeOfficeholders(await sparql(officeholdersQuery(ids))),
          );
          return send(res, 200, { areas, source: 'Wikidata (CC0)' });
        }
        if (url.pathname === '/subdivisions') {
          const id = url.searchParams.get('id') || '';
          if (!QID_RE.test(id))
            return send(res, 400, { error: 'id= Wikidata id required' });
          const subdivisions = await cached(`s:${id}`, async () =>
            normalizeSubdivisions(await sparql(subdivisionsQuery(id))),
          );
          return send(res, 200, { subdivisions, source: 'Wikidata (CC0)' });
        }
        return send(res, 404, { error: 'no such route' });
      } catch (error) {
        return send(res, 502, {
          error: `officeholder data unavailable (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-leadership',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
