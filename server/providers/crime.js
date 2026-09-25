/**
 * Open crime data, keyless and cached:
 *
 *   GET /api/crime/near?lat=&lon=&radiusM=   incidents around a point from
 *        the police/city source that covers it: data.police.uk (latest
 *        month, 1-mile radius) or Chicago / New York / Los Angeles / San
 *        Francisco open data (last 30 days)
 *   GET /api/crime/homicide-rates            intentional homicides per
 *        100,000 by country, latest year (World Bank VC.IHR.PSRC.P5, UNODC)
 */
import { makeRateLimiter } from './common/rate-limit.js';
import {
  CITY_SOURCES,
  crimeSourceFor,
  normalizeCityCrimes,
  normalizeHomicideRates,
  normalizeUkCrimes,
} from '../../src/intel/crime.js';

const UA = 'ADAM/1 (https://github.com/shep95/adam)';
const WB =
  'https://api.worldbank.org/v2/country/all/indicator/VC.IHR.PSRC.P5?format=json&mrnev=1&per_page=400';

export function crimeProxy({
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
  const getJson = async (url) => {
    const r = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return r.json();
  };
  const cached = async (key, ttl, fn) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  };

  function install(middlewares) {
    middlewares.use('/api/crime', async (req, res) => {
      if (!limit('crime')) return send(res, 429, { error: 'rate limited' });
      const url = new URL(req.url, 'http://x');
      try {
        if (url.pathname === '/homicide-rates')
          return send(
            res,
            200,
            await cached('wb', 24 * 3600_000, async () => ({
              rates: normalizeHomicideRates(await getJson(WB)),
              source: 'World Bank (UNODC) — intentional homicides per 100,000',
            })),
          );
        if (url.pathname !== '/near')
          return send(res, 404, { error: 'no such route' });
        const lat = Number(url.searchParams.get('lat'));
        const lon = Number(url.searchParams.get('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon))
          return send(res, 400, { error: 'lat and lon required' });
        const radiusM = Math.max(
          200,
          Math.min(3000, Number(url.searchParams.get('radiusM')) || 1600),
        );
        const source = crimeSourceFor(lat, lon);
        if (!source)
          return send(res, 200, {
            incidents: [],
            source: null,
            note: 'no open street-level crime data for this place; open sources cover England, Wales and Northern Ireland, Chicago, New York, Los Angeles and San Francisco',
          });
        const key = `${source}:${lat.toFixed(3)},${lon.toFixed(3)},${radiusM}`;
        const value = await cached(key, 3 * 3600_000, async () => {
          if (source === 'uk') {
            const rows = await getJson(
              `https://data.police.uk/api/crimes-street/all-crime?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}`,
            );
            const incidents = normalizeUkCrimes(rows);
            return {
              incidents,
              source: 'data.police.uk (Open Government Licence)',
              period: incidents[0]?.date || 'latest month',
              radiusM: 1609,
            };
          }
          const city = CITY_SOURCES.find((c) => c.id === source);
          const since = new Date(now() - 30 * 86_400_000)
            .toISOString()
            .slice(0, 19);
          const q = `$where=${encodeURIComponent(city.where(lat, lon, radiusM, since))}&$limit=5000`;
          const incidents = normalizeCityCrimes(
            await getJson(`${city.url}?${q}`),
            city,
          );
          return {
            incidents,
            source: city.credit,
            period: 'last 30 days',
            radiusM,
            city: city.name,
          };
        });
        return send(res, 200, value);
      } catch (error) {
        return send(res, 502, {
          error: `crime data unavailable (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-crime',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
