/**
 * Volcanoes and near-Earth asteroids, keyless and cached:
 *
 *   GET /api/volcanoes               every Holocene volcano (Smithsonian GVP
 *                                    WFS), land and submarine — 24 h cache
 *   GET /api/volcanoes/elevated      US volcanoes above normal (USGS HANS)
 *                                    — 10 min cache
 *   GET /api/space/close-approaches  asteroids passing within 0.05 AU in the
 *                                    next 60 days (JPL SBDB close-approach
 *                                    API) — 1 h cache
 */
import { makeRateLimiter } from './common/rate-limit.js';
import { normalizeGvp, normalizeHans } from '../../src/intel/volcanoes.js';
import { normalizeCloseApproaches } from '../../src/space/solarSystem.js';

const GVP =
  'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json';
const HANS =
  'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes';
const CAD =
  'https://ssd-api.jpl.nasa.gov/cad.api?date-min=now&date-max=%2B60&dist-max=0.05&sort=dist&fullname=true';
const UA = 'ADAM/1 (https://github.com/shep95/adam)';

export function earthSpaceProxy({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 150 });
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    try {
      const value = await fn();
      cache.set(key, { at: now(), value });
      return value;
    } catch (error) {
      if (hit) return { ...hit.value, stale: true };
      throw error;
    }
  }
  const getJson = async (url) => {
    const r = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return r.json();
  };

  function install(middlewares) {
    middlewares.use('/api/volcanoes', async (req, res) => {
      if (!limit('volcanoes')) return send(res, 429, { error: 'rate limited' });
      const path = new URL(req.url, 'http://x').pathname;
      try {
        if (path === '/elevated')
          return send(
            res,
            200,
            await cached('hans', 10 * 60_000, async () => ({
              volcanoes: normalizeHans(await getJson(HANS)),
              source: 'USGS Volcano Hazards Program',
              at: new Date(now()).toISOString(),
            })),
          );
        return send(
          res,
          200,
          await cached('gvp', 24 * 3600_000, async () => ({
            volcanoes: normalizeGvp(await getJson(GVP)),
            source:
              'Smithsonian Global Volcanism Program, Volcanoes of the World',
            at: new Date(now()).toISOString(),
          })),
        );
      } catch (error) {
        return send(res, 502, {
          error: `volcano feed unavailable (${error.message})`,
        });
      }
    });
    middlewares.use('/api/space/close-approaches', async (req, res) => {
      if (!limit('cad')) return send(res, 429, { error: 'rate limited' });
      try {
        return send(
          res,
          200,
          await cached('cad', 3600_000, async () => ({
            approaches: normalizeCloseApproaches(await getJson(CAD)),
            source: 'NASA/JPL SBDB close-approach data',
            at: new Date(now()).toISOString(),
          })),
        );
      } catch (error) {
        return send(res, 502, {
          error: `close-approach feed unavailable (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-earth-space',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
