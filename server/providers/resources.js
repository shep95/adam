/**
 * Natural wealth rankings, keyless and cached for a day:
 *
 *   GET /api/resources?type=total|oil|gas|coal|minerals|forest|gold|fx|water|arable
 *        countries ranked by that resource (World Bank indicators; see
 *        src/intel/resources.js for how each value is computed)
 */
import { makeRateLimiter } from './common/rate-limit.js';
import {
  RESOURCE_TYPES,
  indicatorsFor,
  rankResource,
  wbUrl,
  wbValues,
} from '../../src/intel/resources.js';

const UA = 'ADAM/1 (https://github.com/shep95/adam)';

export function resourcesProxy({
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
  // One World Bank indicator, cached 24 h and shared between types (GDP).
  const indicator = async (id) => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < 24 * 3600_000) return hit.value;
    const r = await fetchImpl(wbUrl(id), {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const value = wbValues(await r.json());
    cache.set(id, { at: now(), value });
    return value;
  };

  function install(middlewares) {
    middlewares.use('/api/resources', async (req, res) => {
      if (!limit('resources')) return send(res, 429, { error: 'rate limited' });
      const url = new URL(req.url, 'http://x');
      const type = url.searchParams.get('type') || 'total';
      if (!RESOURCE_TYPES.some((t) => t.id === type))
        return send(res, 400, {
          error: `type must be one of ${RESOURCE_TYPES.map((t) => t.id).join(', ')}`,
        });
      const limitRows = Math.max(
        1,
        Math.min(250, Number(url.searchParams.get('limit')) || 60),
      );
      try {
        const ids = indicatorsFor(type);
        const maps = Object.fromEntries(
          await Promise.all(ids.map(async (id) => [id, await indicator(id)])),
        );
        return send(res, 200, {
          ...rankResource(type, maps, { limit: limitRows }),
          source: `World Bank (${ids.join(', ')})`,
        });
      } catch (error) {
        return send(res, 502, {
          error: `resource data unavailable (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-resources',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
