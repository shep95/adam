/**
 * The solar system around the globe: where the planets are (JPL "Keplerian
 * elements for approximate positions of the major planets", valid
 * 1800–2050, arc-minute accuracy), where each sits in the sky from a place
 * on Earth, the main asteroid belt, and what a near-Earth asteroid would do
 * if it struck — energy and blast radii from its size and speed.
 *
 * Pure functions; the SPACE panel draws them.
 */
import { gmstDeg } from '../environment/astronomy.js';

const RAD = Math.PI / 180;
const OBLIQUITY = 23.43928 * RAD;
export const AU_KM = 149_597_870.7;

/** a (AU), e, I, L, ϖ (long. perihelion), Ω (node) at J2000 and per-century rates. */
export const PLANETS = [
  [
    'mercury',
    [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    [
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689,
      -0.12534081,
    ],
    '#b8b0a4',
  ],
  [
    'venus',
    [
      0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718,
      76.67984255,
    ],
    [
      0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329,
      -0.27769418,
    ],
    '#e8d9a8',
  ],
  [
    'earth',
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    '#4fa3ff',
  ],
  [
    'mars',
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088,
      -0.29257343,
    ],
    '#e0703c',
  ],
  [
    'jupiter',
    [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668,
      0.20469106,
    ],
    '#d9b48a',
  ],
  [
    'saturn',
    [
      9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831,
      113.66242448,
    ],
    [
      -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216,
      -0.28867794,
    ],
    '#e6cf8f',
  ],
  [
    'uranus',
    [
      19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763,
      74.01692503,
    ],
    [
      -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281,
      0.04240589,
    ],
    '#9fd9e0',
  ],
  [
    'neptune',
    [
      30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227,
      131.78422574,
    ],
    [
      0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464,
      -0.00508664,
    ],
    '#5a7cff',
  ],
].map(([name, el, rate, color]) => ({ name, el, rate, color }));

const julianCenturies = (date) =>
  (date.valueOf() / 86_400_000 + 2440587.5 - 2451545.0) / 36525;

function solveKepler(M, e) {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 8; i += 1)
    E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

/** Heliocentric ecliptic position (AU) of one planet. */
export function heliocentric(planet, date) {
  const T = julianCenturies(date);
  const [a, e, I, L, wbar, node] = planet.el.map(
    (v, i) => v + planet.rate[i] * T,
  );
  const w = (wbar - node) * RAD;
  let M = ((L - wbar) % 360) * RAD;
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const O = node * RAD;
  const i = I * RAD;
  const x =
    (Math.cos(w) * Math.cos(O) - Math.sin(w) * Math.sin(O) * Math.cos(i)) * xp +
    (-Math.sin(w) * Math.cos(O) - Math.cos(w) * Math.sin(O) * Math.cos(i)) * yp;
  const y =
    (Math.cos(w) * Math.sin(O) + Math.sin(w) * Math.cos(O) * Math.cos(i)) * xp +
    (-Math.sin(w) * Math.sin(O) + Math.cos(w) * Math.cos(O) * Math.cos(i)) * yp;
  const z = Math.sin(w) * Math.sin(i) * xp + Math.cos(w) * Math.sin(i) * yp;
  return { x, y, z, a, e };
}

/** Every planet: heliocentric position, distance from Earth, sky position. */
export function planetPositions(date, { lat = 0, lon = 0 } = {}) {
  const earth = heliocentric(PLANETS[2], date);
  const lst = (gmstDeg(date) + lon) * RAD;
  return PLANETS.map((p) => {
    const h = p.name === 'earth' ? earth : heliocentric(p, date);
    const out = {
      name: p.name,
      color: p.color,
      x: h.x,
      y: h.y,
      z: h.z,
      sunDistanceAu: Math.hypot(h.x, h.y, h.z),
    };
    if (p.name === 'earth') return out;
    // Geocentric ecliptic → equatorial → horizon.
    const gx = h.x - earth.x;
    const gy = h.y - earth.y;
    const gz = h.z - earth.z;
    const xe = gx;
    const ye = gy * Math.cos(OBLIQUITY) - gz * Math.sin(OBLIQUITY);
    const ze = gy * Math.sin(OBLIQUITY) + gz * Math.cos(OBLIQUITY);
    const ra = Math.atan2(ye, xe);
    const dec = Math.atan2(ze, Math.hypot(xe, ye));
    const H = lst - ra;
    const phi = lat * RAD;
    const alt = Math.asin(
      Math.sin(phi) * Math.sin(dec) +
        Math.cos(phi) * Math.cos(dec) * Math.cos(H),
    );
    const az =
      Math.atan2(
        Math.sin(H),
        Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
      ) + Math.PI;
    out.earthDistanceAu = Math.hypot(gx, gy, gz);
    out.earthDistanceKm = Math.round(out.earthDistanceAu * AU_KM);
    out.lightMinutes = +(
      (out.earthDistanceAu * AU_KM) /
      299_792.458 /
      60
    ).toFixed(1);
    out.raDeg = (ra / RAD + 360) % 360;
    out.decDeg = dec / RAD;
    out.altitudeDeg = alt / RAD;
    out.azimuthDeg = (az / RAD + 360) % 360;
    return out;
  });
}

/** Points along a planet's orbit (ecliptic x, y in AU) for drawing. */
export function orbitPath(planet, date, steps = 120) {
  const T = julianCenturies(date);
  const [a, e, , , wbar] = planet.el.map((v, i) => v + planet.rate[i] * T);
  const pts = [];
  for (let k = 0; k <= steps; k += 1) {
    const E = (k / steps) * 2 * Math.PI;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const w = wbar * RAD;
    pts.push([
      xp * Math.cos(w) - yp * Math.sin(w),
      xp * Math.sin(w) + yp * Math.cos(w),
    ]);
  }
  return pts;
}

/**
 * An illustrative main belt: `n` bodies between 2.1 and 3.3 AU with the
 * Kirkwood gaps (3:1, 5:2, 7:3 resonances with Jupiter) left empty.
 */
export function asteroidBelt(n = 1500, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const gaps = [2.5, 2.82, 2.95];
  const out = [];
  while (out.length < n) {
    const a = 2.1 + rand() * 1.2;
    if (gaps.some((g) => Math.abs(a - g) < 0.025)) continue;
    const th = rand() * 2 * Math.PI;
    const r = a * (1 + (rand() - 0.5) * 0.15);
    out.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return out;
}

/** Diameter (km) from absolute magnitude H and an assumed albedo. */
export function diameterKm(H, albedo = 0.14) {
  return (1329 / Math.sqrt(albedo)) * 10 ** (-H / 5);
}

/**
 * If it hit: kinetic energy (megatons TNT) and rough ground effects for an
 * asteroid of `diameterM` metres at `velocityKms`. Radii use airburst/nuclear
 * overpressure scaling (5 psi ≈ severe damage, 1 psi ≈ windows) and a simple
 * crater scaling for bodies large enough to reach the ground.
 */
export function impactEffects(diameterM, velocityKms, { density = 2600 } = {}) {
  const r = diameterM / 2;
  const mass = (4 / 3) * Math.PI * r ** 3 * density;
  const joules = 0.5 * mass * (velocityKms * 1000) ** 2;
  const mt = joules / 4.184e15;
  const y3 = Math.cbrt(Math.max(mt, 0));
  const reachesGround = diameterM >= 50;
  return {
    energyMt: mt,
    hiroshimas: mt / 0.015,
    severeDamageKm: +(4.6 * y3).toFixed(1),
    windowsKm: +(11.9 * y3).toFixed(1),
    thermalBurnsKm: +(8.5 * Math.pow(Math.max(mt, 0), 0.41)).toFixed(1),
    craterKm: reachesGround ? +(0.02 * Math.pow(mt, 0.3) * 10).toFixed(2) : 0,
    reachesGround,
  };
}

/** JPL close-approach API rows → records. */
export function normalizeCloseApproaches(body) {
  const fields = body?.fields || [];
  const idx = (k) => fields.indexOf(k);
  return (body?.data || []).map((row) => {
    const H = Number(row[idx('h')]);
    const dAu = Number(row[idx('dist')]);
    const v = Number(row[idx('v_rel')]);
    const dKm = diameterKm(H);
    const hit =
      Number.isFinite(dKm) && Number.isFinite(v)
        ? impactEffects(dKm * 1000, v)
        : null;
    return {
      name: String(row[idx('fullname')] || row[idx('des')] || '').trim(),
      designation: row[idx('des')],
      closeApproach: row[idx('cd')],
      distanceAu: dAu,
      distanceLunar: Number.isFinite(dAu)
        ? +(dAu / 0.00256955529).toFixed(2)
        : null,
      distanceKm: Number.isFinite(dAu) ? Math.round(dAu * AU_KM) : null,
      velocityKms: v,
      absMag: H,
      diameterM: Number.isFinite(dKm) ? Math.round(dKm * 1000) : null,
      ifItHit: hit,
    };
  });
}
