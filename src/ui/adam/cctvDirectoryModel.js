/**
 * CCTV directory model: the public camera catalog grouped by country and
 * agency, searchable, and ranked by distance. Pure — no DOM, no Cesium.
 */

const COUNTRY = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  FI: 'Finland',
  EE: 'Estonia',
  DE: 'Germany',
  AU: 'Australia',
};

/** ISO country code for a catalog camera, from its region id or provider. */
export function countryFor(camera) {
  const id = String(camera?.cityId || '').toLowerCase();
  const provider = String(camera?.provider || '').toLowerCase();
  if (
    id === 'austin' ||
    id.startsWith('tx-') ||
    id.startsWith('ca-d') ||
    id.startsWith('deldot') ||
    /txdot|caltrans|deldot|austin/.test(provider)
  )
    return 'US';
  if (
    ['british-columbia', 'calgary', 'ontario'].includes(id) ||
    /drivebc|calgary|ontario/.test(provider)
  )
    return 'CA';
  if (id === 'london' || /transport for london/.test(provider)) return 'GB';
  if (id === 'finland' || /fintraffic/.test(provider)) return 'FI';
  if (['estonia', 'tallinn'].includes(id) || /tallinn|tarktee/.test(provider))
    return 'EE';
  if (id.startsWith('warendorf') || /warendorf/.test(provider)) return 'DE';
  if (id === 'nsw' || /nsw/.test(provider)) return 'AU';
  return '??';
}

export function countryName(code) {
  return COUNTRY[code] || 'Other';
}

const EARTH_KM = 6371;
const RAD = Math.PI / 180;
export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const valid = (c) =>
  c && c.id && Number.isFinite(c.lat) && Number.isFinite(c.lon);

/**
 * Countries → agencies with counts and a representative point (the camera
 * nearest the agency's centroid, so the fly-to lands on real coverage).
 */
export function groupDirectory(cameras = []) {
  const byCountry = new Map();
  for (const c of cameras) {
    if (!valid(c)) continue;
    const code = countryFor(c);
    if (!byCountry.has(code)) byCountry.set(code, new Map());
    const agencies = byCountry.get(code);
    const key = c.provider || c.city || 'Unknown agency';
    if (!agencies.has(key)) agencies.set(key, []);
    agencies.get(key).push(c);
  }
  const out = [];
  for (const [code, agencies] of byCountry) {
    const rows = [];
    for (const [provider, list] of agencies) {
      const lat = list.reduce((s, c) => s + c.lat, 0) / list.length;
      const lon = list.reduce((s, c) => s + c.lon, 0) / list.length;
      let anchor = list[0];
      let best = Infinity;
      for (const c of list) {
        const d = distanceKm(lat, lon, c.lat, c.lon);
        if (d < best) {
          best = d;
          anchor = c;
        }
      }
      const video = list.filter((c) =>
        /video|hls|mjpeg/i.test(c.feedType || ''),
      ).length;
      rows.push({ provider, count: list.length, video, anchor });
    }
    rows.sort((a, b) => b.count - a.count);
    out.push({
      code,
      name: countryName(code),
      count: rows.reduce((s, r) => s + r.count, 0),
      agencies: rows,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Cameras matching every word of the query in name, city, provider or code. */
export function searchCameras(cameras = [], query = '', limit = 30) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  for (const c of cameras) {
    if (!valid(c)) continue;
    const hay =
      `${c.name || ''} ${c.city || ''} ${c.provider || ''} ${c.code || ''} ${countryName(countryFor(c))}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The `n` cameras nearest a point, with distance in km. */
export function nearestCameras(cameras = [], lat, lon, n = 10) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  return cameras
    .filter(valid)
    .map((c) => ({ camera: c, km: distanceKm(lat, lon, c.lat, c.lon) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}

export function formatKm(km) {
  if (!Number.isFinite(km)) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}
