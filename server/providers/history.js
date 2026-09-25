/**
 * GET /api/history/battles?from=&to=   battles with coordinates in a span of
 * years from Wikidata (CC0), for the war timeline. Spans are capped at 50
 * years; answers are cached for a day.
 */
import { makeRateLimiter } from './common/rate-limit.js';
import { battleQuery, normalizeBattles } from '../../src/history/wars.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'ADAM/1 (war timeline; https://github.com/shep95/adam)';

export function historyProxy({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 20, globalMax: 100 });
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  function install(middlewares) {
    middlewares.use('/api/history/battles', async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const from = Math.round(Number(u.searchParams.get('from')));
      const to = Math.round(Number(u.searchParams.get('to')));
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to < from ||
        to - from > 50 ||
        from < -3000 ||
        to > 2100
      )
        return send(res, 400, { error: 'from and to years, at most 50 apart' });
      const key = `${from}:${to}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < 86_400_000) return send(res, 200, hit.value);
      if (!limit('history')) return send(res, 429, { error: 'rate limited' });
      try {
        const r = await fetchImpl(SPARQL, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            Accept: 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ query: battleQuery(from, to) }),
          signal: AbortSignal.timeout(55_000),
        });
        if (!r.ok) throw new Error(`upstream ${r.status}`);
        const value = {
          battles: normalizeBattles(await r.json()),
          source: 'Wikidata (CC0)',
        };
        cache.set(key, { at: now(), value });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        return send(res, 200, value);
      } catch (error) {
        return send(res, 502, {
          error: `battles unavailable (${error.message})`,
        });
      }
    });
  }
  return {
    name: 'adam-history',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
