/**
 * Small planar geometry helpers for operator-drawn zones. Rings are arrays of
 * [lon, lat] pairs; zones are small enough that planar tests are accurate,
 * and rings that cross the antimeridian are unwrapped first.
 */

/** Unwrap a ring so consecutive longitudes never jump by more than 180°. */
export function unwrapRing(ring) {
  const out = [];
  let prev = null;
  for (const [lon, lat] of ring || []) {
    let x = lon;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    out.push([x, lat]);
    prev = x;
  }
  return out;
}

/**
 * Even-odd point-in-polygon test in lon/lat space, antimeridian-safe.
 *
 * @param {Array<[number, number]>} ring
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
export function pointInPolygon(ring, lon, lat) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const unwrapped = unwrapRing(ring);
  const xs = unwrapped.map((p) => p[0]);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  for (const shift of [0, 360, -360]) {
    const x = lon + shift;
    if (x < min || x > max) continue;
    let inside = false;
    for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
      const [xi, yi] = unwrapped[i];
      const [xj, yj] = unwrapped[j];
      if (
        yi > lat !== yj > lat &&
        x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Bounding box of a ring as {west, south, east, north} (unwrapped longitudes). */
export function ringBounds(ring) {
  const unwrapped = unwrapRing(ring);
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const [x, y] of unwrapped) {
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, y);
    north = Math.max(north, y);
  }
  return { west, south, east, north };
}

/** Area-weighted-free centroid (vertex mean) of a ring, as {lon, lat}. */
export function ringCenter(ring) {
  const unwrapped = unwrapRing(ring);
  if (!unwrapped.length) return null;
  const lon = unwrapped.reduce((s, p) => s + p[0], 0) / unwrapped.length;
  const lat = unwrapped.reduce((s, p) => s + p[1], 0) / unwrapped.length;
  return { lon: ((((lon + 180) % 360) + 360) % 360) - 180, lat };
}
