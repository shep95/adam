/**
 * Where the heat is: satellite thermal detections (FIRMS fire radiative
 * power, MW) summed by country and by 1° cell. Fires, gas flares, volcanoes
 * and large industrial heat all show up; FIRMS does not say which, so the
 * summary names places and totals, not causes.
 */

/** @param {Array<{lat:number, lon:number, frp:number}>} fires */
export function heatByCountry(fires, lookup, { limit = 20 } = {}) {
  const by = new Map();
  let unassigned = 0;
  for (const f of fires || []) {
    if (!Number.isFinite(f?.lat) || !Number.isFinite(f?.lon)) continue;
    const frp = Number.isFinite(f.frp) ? f.frp : 0;
    const name = lookup(f.lat, f.lon);
    if (!name) {
      unassigned += 1;
      continue;
    }
    const row = by.get(name) || {
      country: name,
      detections: 0,
      frpMw: 0,
      hottestMw: 0,
    };
    row.detections += 1;
    row.frpMw += frp;
    row.hottestMw = Math.max(row.hottestMw, frp);
    by.set(name, row);
  }
  const rows = [...by.values()]
    .map((r) => ({
      ...r,
      frpMw: Math.round(r.frpMw),
      hottestMw: Math.round(r.hottestMw),
    }))
    .sort((a, b) => b.frpMw - a.frpMw || b.detections - a.detections);
  const total = rows.reduce((s, r) => s + r.frpMw, 0);
  return {
    countries: rows.slice(0, limit).map((r) => ({
      ...r,
      share: total ? Math.round((r.frpMw / total) * 1000) / 10 : 0,
    })),
    totalMw: total,
    detections: rows.reduce((s, r) => s + r.detections, 0),
    unassigned,
  };
}

/** The hottest 1° cells, with where they are. */
export function hotCells(fires, lookup, { cellDeg = 1, limit = 12 } = {}) {
  const cells = new Map();
  for (const f of fires || []) {
    if (!Number.isFinite(f?.lat) || !Number.isFinite(f?.lon)) continue;
    const key = `${Math.floor(f.lat / cellDeg)},${Math.floor(f.lon / cellDeg)}`;
    const c = cells.get(key) || {
      frpMw: 0,
      detections: 0,
      lat: 0,
      lon: 0,
      w: 0,
    };
    const frp = Number.isFinite(f.frp) ? f.frp : 0;
    const w = Math.max(frp, 1);
    c.frpMw += frp;
    c.detections += 1;
    c.lat += f.lat * w;
    c.lon += f.lon * w;
    c.w += w;
    cells.set(key, c);
  }
  return [...cells.values()]
    .sort((a, b) => b.frpMw - a.frpMw)
    .slice(0, limit)
    .map((c) => {
      const lat = c.lat / c.w;
      const lon = c.lon / c.w;
      return {
        lat: Math.round(lat * 100) / 100,
        lon: Math.round(lon * 100) / 100,
        country: lookup?.(lat, lon) || 'open water',
        frpMw: Math.round(c.frpMw),
        detections: c.detections,
      };
    });
}
