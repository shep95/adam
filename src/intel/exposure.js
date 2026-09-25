/**
 * Infrastructure exposure: which mapped assets sit inside the reach of a live
 * hazard right now.
 *
 * Hazards are recent earthquakes (felt-radius rule of thumb by magnitude) and
 * strong satellite fire detections; assets are whatever infrastructure layers
 * are on (datacentres, dams). Radii are screening distances, not damage
 * estimates — the output says "within reach", never "damaged".
 */
import { distanceKm } from './patternWatch.js';

export const EXPOSURE_ASSET_LAYERS = Object.freeze([
  'local-datacenters',
  'local-dams',
]);
const ASSET_LABEL = {
  'local-datacenters': 'datacentre',
  'local-dams': 'dam',
};
const QUAKE_WINDOW_MS = 48 * 3600_000;
const FIRE_MIN_FRP = 50;
const FIRE_RADIUS_KM = 5;

/** Screening radius for shaking worth checking on, by magnitude. */
export function quakeReachKm(magnitude) {
  const m = Number(magnitude);
  if (!Number.isFinite(m) || m < 4.5) return 0;
  if (m < 5.5) return 40;
  if (m < 6.5) return 100;
  if (m < 7.5) return 250;
  return 500;
}

function bucket(records) {
  const grid = new Map();
  for (const r of records) {
    if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) continue;
    const k = `${Math.floor(r.lat)}:${Math.floor(r.lon)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  return grid;
}

function near(grid, lat, lon, radiusKm) {
  const dLat = Math.ceil(radiusKm / 111) + 0;
  const dLon = Math.ceil(
    radiusKm / Math.max(10, 111 * Math.cos((lat * Math.PI) / 180)),
  );
  const i0 = Math.floor(lat);
  const j0 = Math.floor(lon);
  const out = [];
  for (let i = i0 - dLat; i <= i0 + dLat; i += 1)
    for (let j = j0 - dLon; j <= j0 + dLon; j += 1) {
      const jj = ((((j + 180) % 360) + 360) % 360) - 180;
      for (const r of grid.get(`${i}:${jj}`) || []) {
        const d = distanceKm(lat, lon, r.lat, r.lon);
        if (d <= radiusKm) out.push({ record: r, distanceKm: d });
      }
    }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/**
 * @param {(layerKey: string) => object[]} getRecords
 * @param {{now?: number, limit?: number}} [options]
 * @returns {Array<{hazard: object, reachKm: number, assets: object[], counts: object, statement: string}>}
 */
export function assessExposure(
  getRecords,
  { now = Date.now(), limit = 8 } = {},
) {
  const assets = [];
  for (const layerKey of EXPOSURE_ASSET_LAYERS)
    for (const r of getRecords(layerKey) || []) assets.push({ ...r, layerKey });
  if (!assets.length) return [];
  const grid = bucket(assets);
  const hazards = [];
  for (const q of getRecords('earthquakes') || []) {
    const reach = quakeReachKm(q.magnitude);
    if (!reach) continue;
    if (Number.isFinite(q.timeMs) && now - q.timeMs > QUAKE_WINDOW_MS) continue;
    hazards.push({
      kind: 'quake',
      label: `M${q.magnitude.toFixed(1)} quake${q.place ? ` ${q.place}` : ''}`,
      lat: q.lat,
      lon: q.lon,
      reach,
      weight: q.magnitude,
    });
  }
  for (const f of getRecords('local-firms') || []) {
    if (!(f.frp >= FIRE_MIN_FRP)) continue;
    hazards.push({
      kind: 'fire',
      label: `fire ${Math.round(f.frp)} MW`,
      lat: f.lat,
      lon: f.lon,
      reach: FIRE_RADIUS_KM,
      weight: Math.log10(f.frp),
    });
  }
  const out = [];
  for (const h of hazards) {
    if (!Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    const hits = near(grid, h.lat, h.lon, h.reach);
    if (!hits.length) continue;
    const counts = {};
    for (const { record } of hits)
      counts[record.layerKey] = (counts[record.layerKey] || 0) + 1;
    const parts = Object.entries(counts).map(
      ([k, n]) => `${n} ${ASSET_LABEL[k] || k}${n === 1 ? '' : 's'}`,
    );
    const nearest = hits[0];
    out.push({
      hazard: { kind: h.kind, label: h.label, lat: h.lat, lon: h.lon },
      reachKm: h.reach,
      counts,
      assets: hits.slice(0, 6).map(({ record, distanceKm: d }) => ({
        layerKey: record.layerKey,
        name: record.name || record.id || ASSET_LABEL[record.layerKey],
        lat: record.lat,
        lon: record.lon,
        distanceKm: Math.round(d * 10) / 10,
      })),
      statement: `${parts.join(', ')} within ${h.reach} km of ${h.label} — nearest ${nearest.record.name || ASSET_LABEL[nearest.record.layerKey]} at ${nearest.distanceKm.toFixed(0)} km`,
      score: h.weight * hits.length,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Live hazard risk per asset (0–100) with the factors behind it. Resilience
 * screening from natural hazards on the globe right now (shaking reach,
 * nearby strong fires, clustered fire activity); it does not rank assets by
 * importance or consequence.
 * @returns {Array<{layerKey:string, name:string, lat:number, lon:number, score:number, factors:string[]}>}
 */
export function assetRisk(getRecords, { now = Date.now(), limit = 10 } = {}) {
  const assets = [];
  for (const layerKey of EXPOSURE_ASSET_LAYERS)
    for (const r of getRecords(layerKey) || [])
      if (Number.isFinite(r?.lat) && Number.isFinite(r?.lon))
        assets.push({ ...r, layerKey });
  if (!assets.length) return [];
  const grid = bucket(assets);
  const risk = new Map();
  const bump = (rec, pts, factor) => {
    const key = `${rec.layerKey}:${rec.lat},${rec.lon}`;
    const cur = risk.get(key) || { rec, score: 0, factors: [] };
    cur.score += pts;
    cur.factors.push(factor);
    risk.set(key, cur);
  };
  for (const q of getRecords('earthquakes') || []) {
    const reach = quakeReachKm(q.magnitude);
    if (!reach) continue;
    if (Number.isFinite(q.timeMs) && now - q.timeMs > QUAKE_WINDOW_MS) continue;
    for (const { record, distanceKm: d } of near(grid, q.lat, q.lon, reach))
      bump(
        record,
        Math.round(Math.min(60, (q.magnitude - 4) * 15) * (1 - d / reach)),
        `M${q.magnitude.toFixed(1)} quake ${Math.round(d)} km`,
      );
  }
  const fires = (getRecords('local-firms') || []).filter((f) => f.frp >= 20);
  for (const f of fires)
    for (const { record, distanceKm: d } of near(grid, f.lat, f.lon, 15))
      bump(
        record,
        Math.round(Math.min(40, 8 + 12 * Math.log10(f.frp)) * (1 - d / 15)),
        `fire ${Math.round(f.frp)} MW at ${d.toFixed(1)} km`,
      );
  return [...risk.values()]
    .map(({ rec, score, factors }) => ({
      layerKey: rec.layerKey,
      name: rec.name || ASSET_LABEL[rec.layerKey],
      kind: ASSET_LABEL[rec.layerKey] || rec.layerKey,
      lat: rec.lat,
      lon: rec.lon,
      score: Math.min(100, score),
      factors: [...new Set(factors)].slice(0, 6),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
