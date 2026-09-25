/**
 * More keyless public-agency traffic camera packs, each pinned to the
 * agency's own image host:
 *
 *   nyc        NYC DOT traffic management centre (webcams.nyctmc.org)
 *   hongkong   Hong Kong Transport Department (tdcctv.data.one.gov.hk)
 *
 * Each loader fails soft to [] like the packs in sources.js and has its own
 * env kill switch (CCTV_NYC_ENABLED, CCTV_HONGKONG_ENABLED = 0).
 */
import { CCTV_SOURCE_FETCH_TIMEOUT_MS } from './constants.js';
import {
  cameraDisplayCode,
  fallbackHeadingFromId,
  prioritizeSources,
} from './normalize.js';

export const NYC_CAMERAS_URL = 'https://webcams.nyctmc.org/api/cameras';
export const NYC_IMAGE_ORIGIN = 'https://webcams.nyctmc.org/';
export const HK_CAMERAS_URL =
  'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml';
export const HK_IMAGE_ORIGIN = 'https://tdcctv.data.one.gov.hk/';

const UA = 'adam-cctv-proxy/1.0';

function capFor(envName, fallback) {
  const raw = Number(process.env[envName] || fallback);
  return Number.isFinite(raw)
    ? Math.max(8, Math.min(1500, Math.floor(raw)))
    : fallback;
}

function baseCamera(cameraId, lat, lon) {
  return {
    id: cameraId,
    lat,
    lon,
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    feedType: 'image',
  };
}

const inBox = (lat, lon, [s, w, n, e]) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  lat >= s &&
  lat <= n &&
  lon >= w &&
  lon <= e;

// ── New York City ────────────────────────────────────────────────────────

export function nycCameraToSource(row) {
  const rawId = String(row?.id || '').trim();
  if (!/^[\w-]{4,64}$/.test(rawId)) return null;
  if (row.isOnline === false || row.isOnline === 'false') return null;
  const lat = Number(row.latitude);
  const lon = Number(row.longitude);
  if (!inBox(lat, lon, [40.45, -74.3, 40.95, -73.65])) return null;
  const given = String(row.imageUrl || '').trim();
  const url = given.startsWith(NYC_IMAGE_ORIGIN)
    ? given
    : `${NYC_IMAGE_ORIGIN}api/cameras/${encodeURIComponent(rawId)}/image`;
  const name = String(row.name || '').trim() || `NYC DOT ${rawId.slice(0, 8)}`;
  return {
    ...baseCamera(`nyc-${rawId}`, lat, lon),
    name,
    city: String(row.area || 'New York'),
    cityId: 'nyc',
    provider: 'NYC DOT',
    groundElevationM: 10,
    url,
    snapshotUrl: url,
    sourceKind: 'nyc-dot',
    license: 'NYC DOT traffic cameras (public)',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

export async function loadNycSourcesFromOpenData({ fetchImpl = fetch } = {}) {
  try {
    const resp = await fetchImpl(NYC_CAMERAS_URL, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] NYC camera download failed:', resp.status);
      return [];
    }
    const body = await resp.json();
    const rows = Array.isArray(body) ? body : body?.cameras || body?.data || [];
    const cameras = rows.map(nycCameraToSource).filter(Boolean);
    const out = prioritizeSources(
      cameras,
      capFor('CCTV_NYC_MAX_SOURCES', 400),
      [{ lat: 40.758, lon: -73.9855 }],
    );
    console.log(
      `[CCTV] Loaded NYC camera sources: ${cameras.length} (using ${out.length})`,
    );
    return out;
  } catch (error) {
    console.warn('[CCTV] NYC camera download error:', error?.message || error);
    return [];
  }
}

// ── Hong Kong ────────────────────────────────────────────────────────────

const xmlText = (block, tag) => {
  const m = new RegExp(
    `<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`,
    'i',
  ).exec(block);
  return m
    ? m[1]
        .trim()
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
    : '';
};

export function parseHongKongCameras(xml) {
  const out = [];
  for (const [, block] of String(xml || '').matchAll(
    /<image>([\s\S]*?)<\/image>/gi,
  )) {
    const key = xmlText(block, 'key');
    if (!/^[A-Za-z0-9_-]{2,16}$/.test(key)) continue;
    const lat = Number(xmlText(block, 'latitude'));
    const lon = Number(xmlText(block, 'longitude'));
    if (!inBox(lat, lon, [22.1, 113.8, 22.6, 114.5])) continue;
    const given = xmlText(block, 'url');
    const url = given.startsWith(HK_IMAGE_ORIGIN)
      ? given
      : `${HK_IMAGE_ORIGIN}${key}.JPG`;
    const description = xmlText(block, 'description');
    const district = xmlText(block, 'district');
    const name = description || `HK ${key}`;
    out.push({
      ...baseCamera(`hk-${key}`, lat, lon),
      name,
      city: district ? `${district}, Hong Kong` : 'Hong Kong',
      cityId: 'hongkong',
      provider: 'Hong Kong Transport Department',
      groundElevationM: 10,
      url,
      snapshotUrl: url,
      sourceKind: 'hk-td',
      license: 'Transport Department, HKSAR — DATA.GOV.HK terms',
      code: cameraDisplayCode(key),
    });
  }
  return out;
}

export async function loadHongKongSourcesFromOpenData({
  fetchImpl = fetch,
} = {}) {
  try {
    const resp = await fetchImpl(HK_CAMERAS_URL, {
      headers: { Accept: 'application/xml,text/xml', 'User-Agent': UA },
      signal: AbortSignal.timeout(CCTV_SOURCE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn('[CCTV] Hong Kong camera download failed:', resp.status);
      return [];
    }
    const cameras = parseHongKongCameras(await resp.text());
    const out = prioritizeSources(
      cameras,
      capFor('CCTV_HONGKONG_MAX_SOURCES', 250),
      [{ lat: 22.2988, lon: 114.1722 }],
    );
    console.log(
      `[CCTV] Loaded Hong Kong camera sources: ${cameras.length} (using ${out.length})`,
    );
    return out;
  } catch (error) {
    console.warn(
      '[CCTV] Hong Kong camera download error:',
      error?.message || error,
    );
    return [];
  }
}
