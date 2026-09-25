/**
 * Sources that need the operator's own account. Each route answers 501 with
 * the env var to set when its key is missing; keys never reach the browser.
 *
 *   GET /api/keyed/status                 which of these are configured
 *   GET /api/notams?lat=&lon=&radiusNm=   FAA NOTAM API (FAA_NOTAM_CLIENT_ID,
 *       or ?icao=KJFK                     FAA_NOTAM_CLIENT_SECRET) → GeoJSON:
 *                                         polygons where the NOTAM has them,
 *                                         circles from centre + radius
 *   GET /api/acled?lat=&lon=&radiusKm=&days=   ACLED conflict events
 *       or ?country=Sudan&days=           (ACLED_USERNAME + ACLED_PASSWORD, or
 *                                         legacy ACLED_KEY + ACLED_EMAIL) →
 *                                         GeoJSON points
 *   GET /api/sanctions?q=&schema=         OpenSanctions search for vessels,
 *                                         aircraft, companies and
 *                                         organisations (OPENSANCTIONS_API_KEY).
 *                                         People are not searchable here and
 *                                         person results are dropped.
 */
import { makeRateLimiter } from './common/rate-limit.js';

const FAA_NOTAM = 'https://external-api.faa.gov/notamapi/v1/notams';
const ACLED_TOKEN = 'https://acleddata.com/oauth/token';
const ACLED_READ = 'https://acleddata.com/api/acled/read';
const ACLED_LEGACY = 'https://api.acleddata.com/acled/read';
const OPENSANCTIONS = 'https://api.opensanctions.org/search/default';
const CACHE_MS = 10 * 60_000;
const KM_PER_DEG = 111.32;

export const SANCTION_SCHEMAS = [
  'Vessel',
  'Airplane',
  'Company',
  'Organization',
];

const send = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function keyedStatus(env = process.env) {
  return {
    notams: Boolean(
      str(env.FAA_NOTAM_CLIENT_ID) && str(env.FAA_NOTAM_CLIENT_SECRET),
    ),
    acled: Boolean(
      (str(env.ACLED_USERNAME) && str(env.ACLED_PASSWORD)) ||
      (str(env.ACLED_KEY) && str(env.ACLED_EMAIL)),
    ),
    sanctions: Boolean(str(env.OPENSANCTIONS_API_KEY)),
  };
}

// ── NOTAM ────────────────────────────────────────────────────────────────

/** "3842N07702W" / "384215N0770215W" → { lat, lon }. */
export function parseNotamCoord(text) {
  const m =
    /^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])$/.exec(
      str(text).toUpperCase(),
    );
  if (!m) return null;
  const lat =
    (+m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0)) * (m[4] === 'S' ? -1 : 1);
  const lon =
    (+m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0)) * (m[8] === 'W' ? -1 : 1);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function circleRing(lat, lon, radiusKm, steps = 48) {
  const ring = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([
      +(
        lon +
        (radiusKm /
          (KM_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)))) *
          Math.cos(a)
      ).toFixed(5),
      +(lat + (radiusKm / KM_PER_DEG) * Math.sin(a)).toFixed(5),
    ]);
  }
  return ring;
}

function firstGeometry(g) {
  if (!g) return null;
  if (g.type === 'GeometryCollection')
    return (
      g.geometries?.find((x) => /Polygon/.test(x.type)) ||
      g.geometries?.find((x) => x.type === 'Point') ||
      null
    );
  return g;
}

export function normalizeNotams(body) {
  const features = [];
  for (const item of body?.items || []) {
    const n = item?.properties?.coreNOTAMData?.notam || {};
    let geometry = firstGeometry(item.geometry);
    const radiusNm = num(n.radius);
    const centre = parseNotamCoord(n.coordinates);
    if ((!geometry || geometry.type === 'Point') && centre && radiusNm > 0)
      geometry = {
        type: 'Polygon',
        coordinates: [circleRing(centre.lat, centre.lon, radiusNm * 1.852)],
      };
    if (!geometry && centre)
      geometry = { type: 'Point', coordinates: [centre.lon, centre.lat] };
    if (!geometry) continue;
    features.push({
      type: 'Feature',
      geometry,
      properties: {
        id: n.id || n.number,
        number: n.number || null,
        location: n.icaoLocation || n.location || null,
        classification: n.classification || null,
        start: n.effectiveStart || null,
        end: n.effectiveEnd || null,
        lowerFL: n.minimumFL || null,
        upperFL: n.maximumFL || null,
        radiusNm,
        text: str(n.text).slice(0, 800),
        source: 'FAA NOTAM API',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ── ACLED ────────────────────────────────────────────────────────────────

export function acledParams({
  country,
  lat,
  lon,
  radiusKm,
  days = 30,
  now = new Date(),
}) {
  const d = Math.max(1, Math.min(365, Math.round(num(days) || 30)));
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - d * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const p = new URLSearchParams({
    _format: 'json',
    event_date: `${start}|${end}`,
    event_date_where: 'BETWEEN',
    limit: '2000',
    fields:
      'event_id_cnty|event_date|event_type|sub_event_type|actor1|actor2|country|admin1|location|latitude|longitude|fatalities|notes|source',
  });
  if (country) p.set('country', country);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const r = Math.max(1, Math.min(1000, radiusKm || 100));
    const dLat = r / KM_PER_DEG;
    const dLon =
      r / (KM_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    p.set('latitude', `${(lat - dLat).toFixed(4)}|${(lat + dLat).toFixed(4)}`);
    p.set('latitude_where', 'BETWEEN');
    p.set('longitude', `${(lon - dLon).toFixed(4)}|${(lon + dLon).toFixed(4)}`);
    p.set('longitude_where', 'BETWEEN');
  }
  return p;
}

export function normalizeAcled(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  const features = [];
  for (const r of rows) {
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (lat == null || lon == null) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: r.event_id_cnty,
        date: r.event_date,
        type: r.event_type,
        subType: r.sub_event_type,
        actor1: r.actor1 || null,
        actor2: r.actor2 || null,
        place: [r.location, r.admin1, r.country].filter(Boolean).join(', '),
        fatalities: num(r.fatalities) ?? 0,
        notes: str(r.notes).slice(0, 400),
        reportedBy: r.source || null,
        source: 'ACLED',
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function summarizeEvents(fc) {
  const byType = {};
  let fatalities = 0;
  for (const f of fc.features) {
    byType[f.properties.type] = (byType[f.properties.type] || 0) + 1;
    fatalities += f.properties.fatalities || 0;
  }
  return { events: fc.features.length, fatalities, byType };
}

// ── OpenSanctions ────────────────────────────────────────────────────────

export function normalizeSanctions(body) {
  return (body?.results || [])
    .filter((r) => SANCTION_SCHEMAS.includes(r.schema))
    .slice(0, 20)
    .map((r) => {
      const p = r.properties || {};
      const one = (k) => (Array.isArray(p[k]) ? p[k][0] : p[k]) ?? null;
      return {
        id: r.id,
        name: r.caption,
        schema: r.schema,
        topics: p.topics || [],
        datasets: r.datasets || [],
        countries: p.country || p.jurisdiction || p.flag || [],
        imo: one('imoNumber'),
        mmsi: one('mmsi'),
        flag: one('flag'),
        registration: one('registrationNumber'),
        score: r.score ?? null,
        url: `https://www.opensanctions.org/entities/${encodeURIComponent(r.id)}/`,
      };
    });
}

export function keyedFeedsProxy({
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 120 });
  let acledToken = null;

  const cached = async (key, fn) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  };

  const getJson = async (url, init = {}) => {
    const res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return res.json();
  };

  async function acledAuth() {
    if (acledToken && acledToken.expires > now()) return acledToken.value;
    const body = new URLSearchParams({
      username: str(env.ACLED_USERNAME),
      password: str(env.ACLED_PASSWORD),
      grant_type: 'password',
      client_id: 'acled',
    });
    const tok = await getJson(ACLED_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!tok?.access_token) throw new Error('ACLED sign-in failed');
    acledToken = {
      value: tok.access_token,
      expires: now() + ((tok.expires_in || 3600) - 60) * 1000,
    };
    return acledToken.value;
  }

  function install(middlewares) {
    middlewares.use('/api/keyed/status', (req, res) =>
      send(res, 200, keyedStatus(env)),
    );

    middlewares.use('/api/notams', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const id = str(env.FAA_NOTAM_CLIENT_ID);
      const secret = str(env.FAA_NOTAM_CLIENT_SECRET);
      if (!id || !secret)
        return send(res, 501, {
          error:
            'NOTAMs need FAA_NOTAM_CLIENT_ID and FAA_NOTAM_CLIENT_SECRET (api.faa.gov)',
        });
      if (!limit('notams')) return send(res, 429, { error: 'rate limited' });
      const q = new URLSearchParams({
        responseFormat: 'geoJson',
        pageSize: '500',
      });
      const icao = str(url.searchParams.get('icao')).toUpperCase();
      const lat = num(url.searchParams.get('lat'));
      const lon = num(url.searchParams.get('lon'));
      if (/^[A-Z0-9]{3,4}$/.test(icao)) q.set('icaoLocation', icao);
      else if (
        lat != null &&
        lon != null &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
      ) {
        q.set('locationLatitude', lat.toFixed(4));
        q.set('locationLongitude', lon.toFixed(4));
        q.set(
          'locationRadius',
          String(
            Math.max(
              1,
              Math.min(
                100,
                Math.round(num(url.searchParams.get('radiusNm')) || 25),
              ),
            ),
          ),
        );
      } else return send(res, 400, { error: 'icao, or lat and lon, required' });
      try {
        const fc = await cached(`notam:${q}`, async () =>
          normalizeNotams(
            await getJson(`${FAA_NOTAM}?${q}`, {
              headers: { client_id: id, client_secret: secret },
            }),
          ),
        );
        return send(res, 200, fc);
      } catch (error) {
        return send(res, 502, {
          error: `NOTAM lookup failed (${error.message})`,
        });
      }
    });

    middlewares.use('/api/acled', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const status = keyedStatus(env);
      if (!status.acled)
        return send(res, 501, {
          error:
            'ACLED needs ACLED_USERNAME and ACLED_PASSWORD (acleddata.com account)',
        });
      if (!limit('acled')) return send(res, 429, { error: 'rate limited' });
      const country = str(url.searchParams.get('country')).slice(0, 60);
      const lat = num(url.searchParams.get('lat'));
      const lon = num(url.searchParams.get('lon'));
      if (!country && (lat == null || lon == null))
        return send(res, 400, { error: 'country, or lat and lon, required' });
      const params = acledParams({
        country,
        lat,
        lon,
        radiusKm: num(url.searchParams.get('radiusKm')),
        days: url.searchParams.get('days'),
        now: new Date(now()),
      });
      try {
        const fc = await cached(`acled:${params}`, async () => {
          if (str(env.ACLED_USERNAME) && str(env.ACLED_PASSWORD)) {
            const token = await acledAuth();
            return normalizeAcled(
              await getJson(`${ACLED_READ}?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
              }),
            );
          }
          params.set('key', str(env.ACLED_KEY));
          params.set('email', str(env.ACLED_EMAIL));
          return normalizeAcled(await getJson(`${ACLED_LEGACY}?${params}`));
        });
        return send(res, 200, { ...fc, summary: summarizeEvents(fc) });
      } catch (error) {
        return send(res, 502, {
          error: `ACLED lookup failed (${error.message})`,
        });
      }
    });

    middlewares.use('/api/sanctions', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const key = str(env.OPENSANCTIONS_API_KEY);
      if (!key)
        return send(res, 501, {
          error:
            'Sanctions checks need OPENSANCTIONS_API_KEY (opensanctions.org)',
        });
      if (!limit('sanctions')) return send(res, 429, { error: 'rate limited' });
      const q = str(url.searchParams.get('q')).slice(0, 120);
      if (q.length < 2) return send(res, 400, { error: 'q required' });
      const want = str(url.searchParams.get('schema'));
      // One schema narrows the search; none searches everything and keeps
      // only vessels, aircraft, companies and organisations.
      const p = new URLSearchParams({ q, limit: '40' });
      if (SANCTION_SCHEMAS.includes(want)) p.set('schema', want);
      try {
        const results = await cached(`os:${p}`, async () =>
          normalizeSanctions(
            await getJson(`${OPENSANCTIONS}?${p}`, {
              headers: { Authorization: `ApiKey ${key}` },
            }),
          ),
        );
        return send(res, 200, {
          query: q,
          results,
          source: 'OpenSanctions (CC BY-NC 4.0)',
        });
      } catch (error) {
        return send(res, 502, {
          error: `sanctions lookup failed (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-keyed-feeds',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
