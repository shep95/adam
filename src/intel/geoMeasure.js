/**
 * Measurement on the sphere (mean radius 6371.0088 km): great-circle and
 * rhumb-line distance and bearing, polygon area, range rings and corridor
 * buffers. Coordinates are {lat, lon} in degrees; rings are [lon, lat].
 */

export const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const UNITS = Object.freeze({
  km: { label: 'km', perKm: 1 },
  nm: { label: 'nm', perKm: 1 / 1.852 },
  mi: { label: 'mi', perKm: 1 / 1.609344 },
});

export function greatCircleKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function initialBearingDeg(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x =
    Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) *
      Math.cos(b.lat * RAD) *
      Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** Rhumb (constant-bearing) distance and bearing. */
export function rhumb(a, b) {
  const p1 = a.lat * RAD;
  const p2 = b.lat * RAD;
  const dp = p2 - p1;
  let dl = (b.lon - a.lon) * RAD;
  if (Math.abs(dl) > Math.PI)
    dl = dl > 0 ? -(2 * Math.PI - dl) : 2 * Math.PI + dl;
  const dpsi = Math.log(
    Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2),
  );
  const q = Math.abs(dpsi) > 1e-12 ? dp / dpsi : Math.cos(p1);
  const km = Math.sqrt(dp * dp + q * q * dl * dl) * EARTH_KM;
  const bearingDeg = (Math.atan2(dl, dpsi) * DEG + 360) % 360;
  return { km, bearingDeg };
}

/** Point reached from `a` going `km` on `bearingDeg` (great circle). */
export function destination(a, km, bearingDeg) {
  const d = km / EARTH_KM;
  const b = bearingDeg * RAD;
  const p1 = a.lat * RAD;
  const l1 = a.lon * RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: p2 * DEG, lon: ((l2 * DEG + 540) % 360) - 180 };
}

/** Points along a great-circle leg (for drawing), inclusive of both ends. */
export function greatCirclePath(a, b, steps = 32) {
  const km = greatCircleKm(a, b);
  if (km < 1e-6) return [a, b];
  const brg = initialBearingDeg(a, b);
  const pts = [];
  // Re-aim each step toward b so long legs stay on the true great circle.
  let cur = a;
  for (let i = 0; i < steps; i += 1) {
    pts.push(cur);
    const rest = greatCircleKm(cur, b);
    cur = destination(cur, rest / (steps - i), initialBearingDeg(cur, b));
  }
  pts.push(b);
  return brg >= 0 ? pts : pts;
}

/** Points along a rhumb leg. */
export function rhumbPath(a, b, steps = 32) {
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    let dLon = b.lon - a.lon;
    if (Math.abs(dLon) > 180) dLon -= Math.sign(dLon) * 360;
    // Interpolate in Mercator latitude so the bearing stays constant.
    const m = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
    const inv = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * DEG;
    const lat =
      Math.abs(b.lat - a.lat) < 1e-9
        ? a.lat
        : inv(m(a.lat) + (m(b.lat) - m(a.lat)) * t);
    pts.push({ lat, lon: ((a.lon + dLon * t + 540) % 360) - 180 });
  }
  return pts;
}

/** Area of a polygon (points {lat, lon}, not closed) in km². */
export function polygonAreaKm2(points) {
  if (!points || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    let dl = (p2.lon - p1.lon) * RAD;
    if (dl > Math.PI) dl -= 2 * Math.PI;
    if (dl < -Math.PI) dl += 2 * Math.PI;
    sum += dl * (2 + Math.sin(p1.lat * RAD) + Math.sin(p2.lat * RAD));
  }
  return Math.abs((sum * EARTH_KM * EARTH_KM) / 2);
}

/** Circle ring ([lon, lat]) of `km` around a centre. */
export function circleRing(c, km, steps = 72) {
  const ring = [];
  for (let i = 0; i < steps; i += 1) {
    const p = destination(c, km, (i * 360) / steps);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}

/** Corridor polygon ([lon, lat]) of half-width `km` around a polyline. */
export function corridorRing(line, km) {
  if (!line || line.length < 2) return [];
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i += 1) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const brg =
      i === 0
        ? initialBearingDeg(line[0], line[1])
        : i === line.length - 1
          ? initialBearingDeg(prev, line[i])
          : (() => {
              const b1 = initialBearingDeg(prev, line[i]);
              const b2 = initialBearingDeg(line[i], next);
              let d = ((b2 - b1 + 540) % 360) - 180;
              return (b1 + d / 2 + 360) % 360;
            })();
    const l = destination(line[i], km, brg - 90);
    const r = destination(line[i], km, brg + 90);
    left.push([l.lon, l.lat]);
    right.push([r.lon, r.lat]);
  }
  return [...left, ...right.reverse()];
}

export function formatDistance(km, unit = 'km') {
  const u = UNITS[unit] || UNITS.km;
  const v = km * u.perKm;
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${u.label}`;
}

export function formatArea(km2, unit = 'km') {
  if (unit === 'nm')
    return `${(km2 / 3.429904).toLocaleString('en-US', { maximumFractionDigits: 1 })} nm²`;
  if (unit === 'mi')
    return `${(km2 / 2.589988).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi²`;
  return `${km2.toLocaleString('en-US', { maximumFractionDigits: km2 < 10 ? 2 : 0 })} km²`;
}

export function formatBearing(deg) {
  return `${String(Math.round(deg) % 360).padStart(3, '0')}°`;
}

/**
 * Measure a path: per-leg and total distance and bearings, great-circle or
 * rhumb.
 */
export function measurePath(points, { rhumbLine = false } = {}) {
  const legs = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const leg = rhumbLine
      ? rhumb(a, b)
      : { km: greatCircleKm(a, b), bearingDeg: initialBearingDeg(a, b) };
    total += leg.km;
    legs.push(leg);
  }
  return { legs, totalKm: total };
}
