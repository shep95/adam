/**
 * Point → country from Natural Earth outlines (bundled, 1:50m), with a
 * bounding-box index so a few thousand lookups stay fast. Points just off a
 * coast (ports, platforms, flares) fall back to the nearest country within
 * ~40 km.
 */

const RAD = Math.PI / 180;

/** Minimal TopoJSON → GeoJSON features for one object (quantized arcs). */
export function topoFeatures(topo, objectName) {
  const [sx, sy] = topo.transform?.scale || [1, 1];
  const [tx, ty] = topo.transform?.translate || [0, 0];
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      if (topo.transform) {
        x += dx;
        y += dy;
        return [x * sx + tx, y * sy + ty];
      }
      return [dx, dy];
    });
  });
  const line = (indexes) => {
    const out = [];
    for (const i of indexes) {
      const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const geometry = (g) => {
    if (g.type === 'Polygon')
      return { type: 'Polygon', coordinates: g.arcs.map(line) };
    if (g.type === 'MultiPolygon')
      return {
        type: 'MultiPolygon',
        coordinates: g.arcs.map((p) => p.map(line)),
      };
    return null;
  };
  const obj = topo.objects[objectName];
  const list = obj.type === 'GeometryCollection' ? obj.geometries : [obj];
  return list.map((g) => ({
    type: 'Feature',
    id: g.id,
    properties: g.properties || {},
    geometry: geometry(g),
  }));
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function polygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** @param {Array<{properties:{name:string}, id?:string, geometry:object}>} features */
export function buildCountryIndex(features) {
  const parts = [];
  for (const f of features || []) {
    const name = f?.properties?.name;
    if (!name) continue;
    for (const poly of polygons(f.geometry)) {
      const outer = poly[0];
      if (!outer?.length) continue;
      let w = 180;
      let e = -180;
      let s = 90;
      let n = -90;
      for (const [x, y] of outer) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
      parts.push({ name, id: f.id ?? null, poly, bbox: [w, s, e, n] });
    }
  }
  const inPoly = (p, lon, lat) =>
    ringContains(p.poly[0], lon, lat) &&
    !p.poly.slice(1).some((hole) => ringContains(hole, lon, lat));

  function lookup(lat, lon, { nearKm = 40 } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    for (const p of parts) {
      const [w, s, e, n] = p.bbox;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      if (inPoly(p, lon, lat)) return p.name;
    }
    if (!(nearKm > 0)) return null;
    // Offshore: nearest outline vertex within nearKm.
    const pad = nearKm / 111;
    let best = null;
    let bestKm = nearKm;
    for (const p of parts) {
      const [w, s, e, n] = p.bbox;
      if (
        lon < w - pad * 2 ||
        lon > e + pad * 2 ||
        lat < s - pad ||
        lat > n + pad
      )
        continue;
      for (const [x, y] of p.poly[0]) {
        const dx = (x - lon) * Math.cos(lat * RAD) * 111.32;
        const dy = (y - lat) * 111.32;
        const d = Math.hypot(dx, dy);
        if (d < bestKm) {
          bestKm = d;
          best = p.name;
        }
      }
    }
    return best;
  }
  return { lookup, size: parts.length };
}

let indexPromise = null;
/** Lazily load and index the bundled outlines. */
export function loadCountryIndex() {
  indexPromise ??=
    import('../data/local_data/countries/countries-50m.json').then((mod) => {
      const topo = mod.default || mod;
      return buildCountryIndex(topoFeatures(topo, 'countries'));
    });
  return indexPromise;
}
