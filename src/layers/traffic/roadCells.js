/**
 * Prefetch ring for traffic roads.
 *
 * Road windows are ~0.05° boxes centred on the look-at point, so an exact
 * bounds cache almost never hits while panning. This cache snaps major roads
 * to a fixed 0.05° grid instead: after a view loads, the 3×3 ring of cells
 * around it is fetched in one idle request, and any later window whose cells
 * are all complete renders its major roads without a network round trip.
 *
 * Pure (no Cesium): roads are the normalized `{coordinates, type, oneway}`
 * records from the Overpass proxy. A road spanning several cells is shared by
 * reference, and lookups de-duplicate by identity.
 */

export const CELL_DEG = 0.05;

const EPS = 1e-9;

export function cellIndex(lat, lon) {
  return [Math.floor(lat / CELL_DEG + EPS), Math.floor(lon / CELL_DEG + EPS)];
}

const key = (i, j) => `${i}:${j}`;

/** Cells a bounds box touches (south/west inclusive, north/east exclusive). */
export function cellsForBounds({ south, west, north, east }) {
  const [i0, j0] = cellIndex(south, west);
  const [i1, j1] = cellIndex(north - EPS * 10, east - EPS * 10);
  const cells = [];
  for (let i = i0; i <= i1; i += 1)
    for (let j = j0; j <= j1; j += 1) cells.push([i, j]);
  return cells;
}

/** Cell-aligned bounds covering the (2r+1)² block around a centre. */
export function ringBounds({ lat, lon }, radius = 1) {
  const [i, j] = cellIndex(lat, lon);
  return {
    south: (i - radius) * CELL_DEG,
    west: (j - radius) * CELL_DEG,
    north: (i + radius + 1) * CELL_DEG,
    east: (j + radius + 1) * CELL_DEG,
  };
}

function roadBox(road) {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const [lon, lat] of road.coordinates || []) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return Number.isFinite(s) ? { south: s, west: w, north: n, east: e } : null;
}

/**
 * @param {{maxCells?: number}} [options]
 */
export function createRoadCellCache({ maxCells = 600 } = {}) {
  /** @type {Map<string, object[]>} */
  const cells = new Map();

  const touch = (k) => {
    const v = cells.get(k);
    cells.delete(k);
    cells.set(k, v);
    return v;
  };

  return {
    /** Store roads fetched for a cell-aligned box; every cell in it is complete. */
    ingest(bounds, roads = []) {
      const inBox = new Map();
      for (const [i, j] of cellsForBounds(bounds)) inBox.set(key(i, j), []);
      for (const road of roads) {
        const box = roadBox(road);
        if (!box) continue;
        const clipped = {
          south: Math.max(box.south, bounds.south),
          west: Math.max(box.west, bounds.west),
          north: Math.min(box.north, bounds.north),
          east: Math.min(box.east, bounds.east),
        };
        if (clipped.south > clipped.north || clipped.west > clipped.east)
          continue;
        for (const [i, j] of cellsForBounds({
          ...clipped,
          north: clipped.north + EPS * 20,
          east: clipped.east + EPS * 20,
        }))
          inBox.get(key(i, j))?.push(road);
      }
      for (const [k, list] of inBox) {
        cells.delete(k);
        cells.set(k, list);
      }
      while (cells.size > maxCells) cells.delete(cells.keys().next().value);
      return inBox.size;
    },
    /** Major roads for a window when every cell it touches is cached. */
    lookup(bounds) {
      const wanted = cellsForBounds(bounds).map(([i, j]) => key(i, j));
      if (!wanted.length || !wanted.every((k) => cells.has(k))) return null;
      const out = new Set();
      for (const k of wanted) for (const road of touch(k)) out.add(road);
      return [...out];
    },
    /** True when a box still has uncached cells. */
    missing(bounds) {
      return cellsForBounds(bounds).some(([i, j]) => !cells.has(key(i, j)));
    },
    clear() {
      cells.clear();
    },
    get size() {
      return cells.size;
    },
  };
}
