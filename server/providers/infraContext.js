/**
 * Infrastructure and airspace context proxy.
 *
 *   GET /api/infra-context/overpass?kind=<kind>&south=&west=&north=&east=
 *       power-lines | pipelines | border-crossings | bridges | maritime-zones
 *   GET /api/infra-context/military-global
 *   GET /api/infra-context/ixps
 *   GET /api/infra-context/airspace-sua?south=&west=&north=&east=
 *   GET /api/infra-context/tfrs
 *   GET /api/infra-context/landing-point?id=<teleGeography id>
 *
 * The browser never sends query text: each kind maps to a fixed template, the
 * bbox is validated, bounded per kind and snapped outward to a grid so nearby
 * viewports share one cache entry. Responses are capped, cached in memory
 * (and on disk where the platform allows it), single-flighted and rate
 * limited per client.
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseTextCapped } from './common/http.js';
import { fetchOverpassPayload } from './overpass/transport.js';

const USER_AGENT = 'adam-infra-context/1.0 (+https://github.com/shep95/adam)';
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 45_000;
const GRID_DEG = 0.5;

/** Overpass kinds: fixed templates, per-kind span limit and element cap. */
export const OVERPASS_KINDS = Object.freeze({
  'power-lines': {
    maxSpanDeg: 4,
    cap: 3000,
    ttlMs: 14 * 86_400_000,
    ql: (b, cap) =>
      `[out:json][timeout:40];(way["power"~"^(line|cable)$"](${b});nwr["power"="plant"](${b}););out tags geom ${cap};`,
  },
  pipelines: {
    maxSpanDeg: 6,
    cap: 2500,
    ttlMs: 14 * 86_400_000,
    ql: (b, cap) =>
      `[out:json][timeout:40];way["man_made"="pipeline"](${b});out tags geom ${cap};`,
  },
  'border-crossings': {
    maxSpanDeg: 25,
    cap: 2000,
    ttlMs: 30 * 86_400_000,
    ql: (b, cap) =>
      `[out:json][timeout:40];nwr["barrier"="border_control"](${b});out center tags ${cap};`,
  },
  bridges: {
    maxSpanDeg: 3,
    cap: 2000,
    ttlMs: 30 * 86_400_000,
    ql: (b, cap) =>
      `[out:json][timeout:40];(way["bridge"]["highway"~"^(motorway|trunk|primary)$"](${b});way["bridge"]["railway"="rail"](${b}););out tags geom ${cap};`,
  },
  'maritime-zones': {
    maxSpanDeg: 8,
    cap: 3000,
    ttlMs: 30 * 86_400_000,
    ql: (b, cap) =>
      `[out:json][timeout:40];(nwr["seamark:type"~"^(separation_zone|separation_line|separation_boundary|separation_lane|separation_roundabout|inshore_traffic_zone|precautionary_area|anchorage|anchor_berth|harbour)$"](${b});way["landuse"="port"](${b});relation["landuse"="port"](${b}););out tags geom ${cap};`,
  },
});

const MILITARY_GLOBAL_QL =
  '[out:json][timeout:180];nwr["military"~"^(airfield|naval_base|base)$"];out center tags 8000;';

const DEFAULT_SUA_URL =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query';
const DEFAULT_TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';
const PEERINGDB = 'https://www.peeringdb.com/api';
const TELEGEOGRAPHY = 'https://www.submarinecablemap.com/api/v3';

/**
 * Validate and snap a bbox from query params.
 *
 * @param {URLSearchParams} params
 * @param {number} maxSpanDeg
 * @returns {?{south:number, west:number, north:number, east:number}}
 */
export function parseBox(params, maxSpanDeg) {
  const read = (key) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '' || raw.length > 24) return NaN;
    return Number(raw);
  };
  const south = read('south');
  const west = read('west');
  const north = read('north');
  const east = read('east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  if (north <= south || east <= west) return null;
  if (north - south > maxSpanDeg || east - west > maxSpanDeg) return null;
  const snap = (v, fn) => fn(v / GRID_DEG) * GRID_DEG;
  return {
    south: Math.max(-90, snap(south, Math.floor)),
    west: Math.max(-180, snap(west, Math.floor)),
    north: Math.min(90, snap(north, Math.ceil)),
    east: Math.min(180, snap(east, Math.ceil)),
  };
}

export function boxKey(box) {
  return `${box.south},${box.west},${box.north},${box.east}`;
}

/** A TeleGeography landing-point id: lowercase slug. */
export function validLandingId(value) {
  const id = String(value || '');
  return /^[a-z0-9][a-z0-9-]{1,120}$/.test(id) ? id : null;
}

/** Reduce Overpass elements to the compact shape the client renders. */
export function compactOverpassElements(elements, cap) {
  const out = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    if (out.length >= cap) break;
    const tags =
      element?.tags && typeof element.tags === 'object' ? element.tags : {};
    const keep = {};
    for (const key of [
      'name',
      'name:en',
      'ref',
      'operator',
      'voltage',
      'power',
      'substance',
      'type',
      'usage',
      'location',
      'barrier',
      'highway',
      'railway',
      'bridge',
      'bridge:name',
      'seamark:type',
      'seamark:name',
      'landuse',
      'harbour',
      'military',
      'plant:source',
      'plant:output:electricity',
      'capacity',
      'diameter',
      'layer',
    ]) {
      if (tags[key] !== undefined) keep[key] = String(tags[key]).slice(0, 120);
    }
    const base = { id: `${element.type}/${element.id}`, tags: keep };
    if (Array.isArray(element.geometry) && element.geometry.length > 1) {
      const coords = element.geometry
        .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]);
      if (coords.length > 1) out.push({ ...base, geometry: 'line', coords });
      continue;
    }
    if (Array.isArray(element.members)) {
      const lines = [];
      for (const member of element.members) {
        const geom = Array.isArray(member?.geometry) ? member.geometry : [];
        const coords = geom
          .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
          .map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]);
        if (coords.length > 1) lines.push(coords);
      }
      if (lines.length) {
        out.push({
          ...base,
          geometry: 'multiline',
          coords: lines.slice(0, 40),
        });
        continue;
      }
    }
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon))
      out.push({
        ...base,
        geometry: 'point',
        coords: [Number(lon.toFixed(5)), Number(lat.toFixed(5))],
      });
  }
  return out;
}

/** Overpass-shaped military elements (center only, whitelisted tags). */
export function compactMilitaryElements(elements, cap) {
  const out = [];
  for (const element of Array.isArray(elements) ? elements : []) {
    if (out.length >= cap) break;
    if (!['node', 'way', 'relation'].includes(element?.type)) continue;
    if (!Number.isSafeInteger(element?.id)) continue;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tags = {};
    for (const key of [
      'name',
      'name:en',
      'military',
      'landuse',
      'operator',
      'military_service',
      'iata',
      'icao',
    ]) {
      if (element.tags?.[key] !== undefined)
        tags[key] = String(element.tags[key]).slice(0, 120);
    }
    out.push({
      type: element.type,
      id: element.id,
      ...(element.type === 'node' ? { lat, lon } : { center: { lat, lon } }),
      tags,
    });
  }
  return out;
}

/** Join PeeringDB ix, ixfac and fac into one point per exchange. */
export function joinPeeringDb(ixs, ixfacs, facs) {
  const facById = new Map();
  for (const fac of Array.isArray(facs) ? facs : []) {
    if (Number.isFinite(fac?.latitude) && Number.isFinite(fac?.longitude))
      facById.set(fac.id, fac);
  }
  const facsByIx = new Map();
  for (const link of Array.isArray(ixfacs) ? ixfacs : []) {
    const fac = facById.get(link?.fac_id);
    if (!fac) continue;
    if (!facsByIx.has(link.ix_id)) facsByIx.set(link.ix_id, []);
    facsByIx.get(link.ix_id).push(fac);
  }
  const out = [];
  for (const ix of Array.isArray(ixs) ? ixs : []) {
    const sites = facsByIx.get(ix?.id);
    if (!sites?.length) continue;
    const lat = sites.reduce((s, f) => s + f.latitude, 0) / sites.length;
    const lon = sites.reduce((s, f) => s + f.longitude, 0) / sites.length;
    out.push({
      id: `ix/${ix.id}`,
      geometry: 'point',
      coords: [Number(lon.toFixed(4)), Number(lat.toFixed(4))],
      tags: {
        name: String(ix.name || '').slice(0, 120),
        name_long: String(ix.name_long || '').slice(0, 160),
        city: String(ix.city || '').slice(0, 80),
        country: String(ix.country || '').slice(0, 4),
        networks: Number.isFinite(ix.net_count) ? ix.net_count : null,
        facilities: sites.length,
        website: /^https?:\/\//.test(ix.website || '')
          ? String(ix.website).slice(0, 200)
          : null,
      },
    });
  }
  return out;
}

/** Compact an ArcGIS GeoJSON response into polygon rings with airspace tags. */
export function compactSuaGeoJson(json, cap = 800) {
  const out = [];
  for (const feature of Array.isArray(json?.features) ? json.features : []) {
    if (out.length >= cap) break;
    const props = feature?.properties || {};
    const geometry = feature?.geometry;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const rings = polygons
      .map((poly) => poly?.[0])
      .filter((ring) => Array.isArray(ring) && ring.length > 2)
      .map((ring) =>
        ring
          .filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))
          .map((p) => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]),
      );
    if (!rings.length) continue;
    const pick = (...keys) => {
      for (const key of keys) {
        const value = props[key];
        if (value !== undefined && value !== null && String(value).trim())
          return String(value).slice(0, 80);
      }
      return null;
    };
    out.push({
      id: `sua/${pick('OBJECTID', 'GLOBAL_ID', 'IDENT', 'NAME') || out.length}`,
      geometry: 'multiline',
      coords: rings.map((ring) => [...ring, ring[0]]),
      tags: {
        name: pick('NAME', 'Name', 'name'),
        type: pick('TYPE_CODE', 'TYPE', 'Type', 'CLASS'),
        upper: pick('UPPER_DESC', 'UPPER_VAL', 'UPPER_LIMIT'),
        lower: pick('LOWER_DESC', 'LOWER_VAL', 'LOWER_LIMIT'),
        times: pick('TIMESOFUSE', 'TIMES_OF_USE', 'SCHEDULE'),
        agency: pick('CONT_AGENT', 'CONTROLLING_AGENCY', 'AGENCY'),
        state: pick('STATE'),
      },
    });
  }
  return out;
}

/** Normalize the FAA TFR list payload (array of notices). */
export function compactTfrList(json, cap = 400) {
  const rows = Array.isArray(json)
    ? json
    : Array.isArray(json?.data)
      ? json.data
      : [];
  return rows
    .slice(0, cap)
    .map((row) => ({
      notam: String(row?.notam_id ?? row?.notamId ?? row?.NOTAM_ID ?? '').slice(
        0,
        20,
      ),
      type: String(row?.type ?? row?.TYPE ?? '').slice(0, 40),
      state: String(row?.state ?? row?.STATE ?? '').slice(0, 4),
      facility: String(row?.facility ?? row?.FACILITY ?? '').slice(0, 10),
      description: String(row?.description ?? row?.DESCRIPTION ?? '').slice(
        0,
        200,
      ),
    }))
    .filter((row) => row.notam);
}

/** Landing point + cable detail from TeleGeography's public API. */
export function compactLandingPoint(point, cables) {
  return {
    id: String(point?.id || ''),
    name: String(point?.name || '').slice(0, 120),
    country: String(point?.country || '').slice(0, 80),
    cables: (Array.isArray(cables) ? cables : []).map((cable) => ({
      id: String(cable?.id || '').slice(0, 120),
      name: String(cable?.name || '').slice(0, 120),
      owners: String(cable?.owners || '').slice(0, 400),
      rfs: String(cable?.rfs || cable?.rfs_year || '').slice(0, 40),
      length: String(cable?.length || '').slice(0, 40),
      planned: cable?.is_planned === true,
      capacity: String(cable?.capacity || cable?.design_capacity || '').slice(
        0,
        80,
      ),
      url: /^https?:\/\//.test(cable?.url || '')
        ? String(cable.url).slice(0, 200)
        : null,
    })),
  };
}

function createCache({ dir, maxEntries = 200 }) {
  const memory = new Map();
  const file = (key) =>
    path.join(dir, `${key.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 180)}.json`);
  return {
    async get(key, ttlMs) {
      const hit = memory.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit;
      try {
        const parsed = JSON.parse(await fsp.readFile(file(key), 'utf8'));
        if (Number.isFinite(parsed?.at) && Date.now() - parsed.at < ttlMs) {
          memory.set(key, parsed);
          return parsed;
        }
      } catch {
        /* no disk entry */
      }
      return null;
    },
    async stale(key) {
      if (memory.has(key)) return memory.get(key);
      try {
        return JSON.parse(await fsp.readFile(file(key), 'utf8'));
      } catch {
        return null;
      }
    },
    async set(key, payload) {
      const entry = { at: Date.now(), payload };
      memory.set(key, entry);
      while (memory.size > maxEntries)
        memory.delete(memory.keys().next().value);
      try {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(file(key), JSON.stringify(entry), 'utf8');
      } catch {
        /* read-only platform: memory cache only */
      }
      return entry;
    },
  };
}

async function fetchJson(
  url,
  { fetchImpl = fetch, maxBytes = MAX_RESPONSE_BYTES } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await readResponseTextCapped(response, maxBytes);
    if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

/**
 * @param {{fetchImpl?: Function, overpass?: Function, cacheDir?: string, env?: object}} [options]
 */
export function infraContextProxy({
  fetchImpl = (...args) => fetch(...args),
  overpass = fetchOverpassPayload,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'infra-context'),
  env = process.env,
} = {}) {
  const cache = createCache({ dir: cacheDir });
  const inflight = new Map();
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 240,
  });

  const once = (key, work) => {
    if (!inflight.has(key))
      inflight.set(
        key,
        Promise.resolve()
          .then(work)
          .finally(() => inflight.delete(key)),
      );
    return inflight.get(key);
  };

  async function cached(key, ttlMs, work) {
    const hit = await cache.get(key, ttlMs);
    if (hit) return { ...hit.payload, cache: 'HIT' };
    try {
      const payload = await once(key, work);
      await cache.set(key, payload);
      return { ...payload, cache: 'MISS' };
    } catch (error) {
      const stale = await cache.stale(key);
      if (stale) return { ...stale.payload, cache: 'STALE', stale: true };
      throw error;
    }
  }

  async function runOverpass(ql, cap) {
    const upstream = await overpass(
      `data=${encodeURIComponent(ql)}`,
      MAX_RESPONSE_BYTES,
    );
    if (upstream.status >= 400 || upstream.rateLimited || upstream.runtimeError)
      throw new Error(upstream.rateLimited ? 'rate_limited' : 'unavailable');
    const parsed = JSON.parse(upstream.body);
    const features = compactOverpassElements(parsed?.elements, cap);
    return {
      features,
      saturated: (parsed?.elements?.length || 0) >= cap,
      retrievedAt: new Date().toISOString(),
    };
  }

  const routes = {
    async overpass(url) {
      const kind = url.searchParams.get('kind');
      const spec = Object.hasOwn(OVERPASS_KINDS, kind)
        ? OVERPASS_KINDS[kind]
        : null;
      if (!spec) return [400, { error: 'Unknown context kind' }];
      const box = parseBox(url.searchParams, spec.maxSpanDeg);
      if (!box)
        return [
          400,
          {
            error: `A non-dateline bbox no larger than ${spec.maxSpanDeg} degrees is required`,
          },
        ];
      const bbox = `${box.south},${box.west},${box.north},${box.east}`;
      const payload = await cached(`${kind}:${boxKey(box)}`, spec.ttlMs, () =>
        runOverpass(spec.ql(bbox, spec.cap), spec.cap),
      );
      return [200, { kind, box, ...payload }];
    },
    async 'military-global'() {
      const payload = await cached(
        'military-global',
        30 * 86_400_000,
        async () => {
          const upstream = await overpass(
            `data=${encodeURIComponent(MILITARY_GLOBAL_QL)}`,
            MAX_RESPONSE_BYTES,
          );
          if (
            upstream.status >= 400 ||
            upstream.rateLimited ||
            upstream.runtimeError
          )
            throw new Error(
              upstream.rateLimited ? 'rate_limited' : 'unavailable',
            );
          const parsed = JSON.parse(upstream.body);
          return {
            elements: compactMilitaryElements(parsed?.elements, 8000),
            retrievedAt: new Date().toISOString(),
          };
        },
      );
      return [200, payload];
    },
    async ixps() {
      const payload = await cached('peeringdb-ixps', 86_400_000, async () => {
        const [ix, ixfac, fac] = await Promise.all([
          fetchJson(`${PEERINGDB}/ix?depth=0`, { fetchImpl }),
          fetchJson(`${PEERINGDB}/ixfac?depth=0`, { fetchImpl }),
          fetchJson(`${PEERINGDB}/fac?depth=0`, { fetchImpl }),
        ]);
        return {
          features: joinPeeringDb(ix?.data, ixfac?.data, fac?.data),
          retrievedAt: new Date().toISOString(),
        };
      });
      return [200, payload];
    },
    async 'airspace-sua'(url) {
      const box = parseBox(url.searchParams, 20);
      if (!box)
        return [
          400,
          {
            error: 'A non-dateline bbox no larger than 20 degrees is required',
          },
        ];
      const base = String(env.ADAM_FAA_SUA_URL || DEFAULT_SUA_URL);
      if (!/^https:\/\//.test(base))
        return [500, { error: 'Airspace source misconfigured' }];
      const params = new URLSearchParams({
        where: '1=1',
        geometry: `${box.west},${box.south},${box.east},${box.north}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        resultRecordCount: '800',
        f: 'geojson',
      });
      const payload = await cached(
        `sua:${boxKey(box)}`,
        86_400_000,
        async () => ({
          features: compactSuaGeoJson(
            await fetchJson(`${base}?${params}`, { fetchImpl }),
          ),
          retrievedAt: new Date().toISOString(),
        }),
      );
      return [200, { box, ...payload }];
    },
    async tfrs() {
      const base = String(env.ADAM_FAA_TFR_URL || DEFAULT_TFR_LIST_URL);
      if (!/^https:\/\//.test(base))
        return [500, { error: 'TFR source misconfigured' }];
      const payload = await cached('tfr-list', 10 * 60_000, async () => ({
        tfrs: compactTfrList(await fetchJson(base, { fetchImpl })),
        retrievedAt: new Date().toISOString(),
      }));
      return [200, payload];
    },
    async 'landing-point'(url) {
      const id = validLandingId(url.searchParams.get('id'));
      if (!id) return [400, { error: 'A landing point id is required' }];
      const payload = await cached(
        `landing:${id}`,
        7 * 86_400_000,
        async () => {
          const point = await fetchJson(
            `${TELEGEOGRAPHY}/landing-point/${id}.json`,
            { fetchImpl },
          );
          const ids = (Array.isArray(point?.cables) ? point.cables : [])
            .map((c) => validLandingId(c?.id))
            .filter(Boolean)
            .slice(0, 16);
          const cables = await Promise.all(
            ids.map((cableId) =>
              fetchJson(`${TELEGEOGRAPHY}/cable/${cableId}.json`, {
                fetchImpl,
              }).catch(() => ({
                id: cableId,
                name: (point.cables.find((c) => c.id === cableId) || {}).name,
              })),
            ),
          );
          return compactLandingPoint(point, cables);
        },
      );
      return [200, payload];
    },
  };

  function install(middlewares) {
    middlewares.use('/api/infra-context', async (req, res) => {
      if (req.method !== 'GET')
        return send(res, 405, { error: 'Method not allowed' });
      if (!limiter(clientKey(req)))
        return send(
          res,
          429,
          { error: 'Rate limit exceeded' },
          { 'Retry-After': '10' },
        );
      const url = new URL(req.url, 'http://localhost');
      const name = url.pathname.replace(/^\/+|\/+$/g, '');
      const route = Object.hasOwn(routes, name) ? routes[name] : null;
      if (!route) return send(res, 404, { error: 'Unknown context route' });
      try {
        const [status, payload] = await route(url);
        send(res, status, payload);
      } catch (error) {
        send(res, 503, {
          error: 'Context source temporarily unavailable',
          reason:
            error?.message === 'rate_limited' ? 'rate_limited' : 'unavailable',
        });
      }
    });
  }

  return {
    name: 'adam-infra-context',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
