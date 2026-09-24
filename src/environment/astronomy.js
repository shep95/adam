/**
 * Low-cost positional astronomy for the live environment panel: sun, moon
 * and the brightest stars as seen from a point on the ground, rise/set times,
 * moon phase and shadow geometry. Formulas follow the widely used
 * low-precision series (after Meeus / Montenbruck) — good to a fraction of a
 * degree, which is what a sky readout needs. Pure functions; no Cesium.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const SUN_HORIZON = -0.833;
const MOON_HORIZON = 0.133;

export const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;

const rightAscension = (l, b) =>
  Math.atan2(
    Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY),
    Math.cos(l),
  );
const declination = (l, b) =>
  Math.asin(
    Math.sin(b) * Math.cos(OBLIQUITY) +
      Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l),
  );
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;
const altitudeOf = (H, phi, dec) =>
  Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
/** Azimuth measured from north, clockwise. */
const azimuthOf = (H, phi, dec) =>
  Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  ) + Math.PI;

function refraction(h) {
  const alt = Math.max(0, h);
  return 0.0002967 / Math.tan(alt + 0.00312536 / (alt + 0.08901179));
}

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C =
    RAD *
    (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return {
    ra: rightAscension(l, b),
    dec: declination(l, b),
    distKm: 385001 - 20905 * Math.cos(M),
  };
}

const norm360 = (deg) => ((deg % 360) + 360) % 360;

/** Sun altitude/azimuth in degrees. */
export function sunPosition(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return {
    altitude: altitudeOf(H, phi, c.dec) / RAD,
    azimuth: norm360(azimuthOf(H, phi, c.dec) / RAD),
  };
}

/** Moon altitude/azimuth (degrees, refraction-corrected) and distance. */
export function moonPosition(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitudeOf(H, phi, c.dec);
  h += refraction(h);
  return {
    altitude: h / RAD,
    azimuth: norm360(azimuthOf(H, phi, c.dec) / RAD),
    distanceKm: Math.round(c.distKm),
  };
}

const PHASES = [
  [0.0625, 'new moon'],
  [0.1875, 'waxing crescent'],
  [0.3125, 'first quarter'],
  [0.4375, 'waxing gibbous'],
  [0.5625, 'full moon'],
  [0.6875, 'waning gibbous'],
  [0.8125, 'last quarter'],
  [0.9375, 'waning crescent'],
  [1.01, 'new moon'],
];

/** Illuminated fraction (0–1) and phase (0 new → 0.5 full → 1 new). */
export function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sunDist = 149598000;
  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) +
      Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra),
  );
  const inc = Math.atan2(
    sunDist * Math.sin(phi),
    m.distKm - sunDist * Math.cos(phi),
  );
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) -
      Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  const fraction = (1 + Math.cos(inc)) / 2;
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;
  return { fraction, phase, name: PHASES.find(([limit]) => phase < limit)[1] };
}

/** Named phase of the day from the sun's altitude. */
export function dayPhase(sunAltitude, rising = true) {
  if (sunAltitude >= 6) return 'daylight';
  if (sunAltitude >= -0.833)
    return rising ? 'golden hour · morning' : 'golden hour · evening';
  if (sunAltitude >= -6) return 'civil twilight';
  if (sunAltitude >= -12) return 'nautical twilight';
  if (sunAltitude >= -18) return 'astronomical twilight';
  return 'night';
}

/**
 * Rise/set events for a body within [from, from+24h), found by scanning
 * altitude in 5-minute steps and interpolating the horizon crossing.
 */
export function riseSet(positionFn, from, lat, lon, horizon) {
  const step = 5 * 60_000;
  const events = { rise: null, set: null, alwaysUp: false, alwaysDown: false };
  let prevT = from.valueOf();
  let prevH = positionFn(new Date(prevT), lat, lon).altitude - horizon;
  let above = 0;
  for (let t = prevT + step; t <= prevT + DAY_MS + 1; t += step) {
    const h = positionFn(new Date(t), lat, lon).altitude - horizon;
    if (h > 0) above += 1;
    if (prevH <= 0 && h > 0 && !events.rise)
      events.rise = new Date(t - (step * h) / (h - prevH));
    if (prevH > 0 && h <= 0 && !events.set)
      events.set = new Date(t - (step * h) / (h - prevH));
    prevH = h;
  }
  if (!events.rise && !events.set) {
    if (above > 0) events.alwaysUp = true;
    else events.alwaysDown = true;
  }
  return events;
}

export const sunTimes = (from, lat, lon) =>
  riseSet(sunPosition, from, lat, lon, SUN_HORIZON);
export const moonTimes = (from, lat, lon) =>
  riseSet(moonPosition, from, lat, lon, MOON_HORIZON);

/** Time of the sun's highest point in the 24 h after `from`. */
export function solarNoon(from, lat, lon) {
  let best = { t: from.valueOf(), alt: -90 };
  for (let t = from.valueOf(); t <= from.valueOf() + DAY_MS; t += 10 * 60_000) {
    const alt = sunPosition(new Date(t), lat, lon).altitude;
    if (alt > best.alt) best = { t, alt };
  }
  return new Date(best.t);
}

/**
 * Where shadows fall and how long they are relative to the object's height.
 * @returns {{towardDeg: number, lengthRatio: number}|null} null when the sun is down
 */
export function shadowGeometry(sun) {
  if (!sun || sun.altitude <= 0.5) return null;
  return {
    towardDeg: norm360(sun.azimuth + 180),
    lengthRatio: 1 / Math.tan(sun.altitude * RAD),
  };
}

/** Brightest stars: [name, RA hours, Dec degrees, magnitude]. */
export const BRIGHT_STARS = Object.freeze([
  ['sirius', 6.7525, -16.7161, -1.46],
  ['canopus', 6.3992, -52.6957, -0.74],
  ['arcturus', 14.261, 19.1824, -0.05],
  ['alpha centauri', 14.6601, -60.8339, -0.01],
  ['vega', 18.6156, 38.7837, 0.03],
  ['capella', 5.2782, 45.998, 0.08],
  ['rigel', 5.2423, -8.2016, 0.13],
  ['procyon', 7.655, 5.225, 0.34],
  ['betelgeuse', 5.9195, 7.4071, 0.5],
  ['achernar', 1.6286, -57.2368, 0.46],
  ['altair', 19.8464, 8.8683, 0.77],
  ['aldebaran', 4.5987, 16.5093, 0.85],
  ['antares', 16.4901, -26.432, 0.96],
  ['spica', 13.4199, -11.1613, 0.97],
  ['pollux', 7.7553, 28.0262, 1.14],
  ['fomalhaut', 22.9608, -29.6222, 1.16],
  ['deneb', 20.6905, 45.2803, 1.25],
  ['regulus', 10.1395, 11.9672, 1.35],
  ['polaris', 2.5302, 89.2641, 1.98],
]);

/** Stars above `minAltitude`, brightest first. */
export function visibleStars(
  date,
  lat,
  lon,
  { minAltitude = 10, limit = 6 } = {},
) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const st = siderealTime(toDays(date), lw);
  const out = [];
  for (const [name, raH, decDeg, mag] of BRIGHT_STARS) {
    const ra = RAD * raH * 15;
    const dec = RAD * decDeg;
    const H = st - ra;
    const altitude = altitudeOf(H, phi, dec) / RAD;
    if (altitude < minAltitude) continue;
    out.push({
      name,
      magnitude: mag,
      altitude,
      azimuth: norm360(azimuthOf(H, phi, dec) / RAD),
    });
  }
  return out.sort((a, b) => a.magnitude - b.magnitude).slice(0, limit);
}

const COMPASS = [
  'n',
  'nne',
  'ne',
  'ene',
  'e',
  'ese',
  'se',
  'sse',
  's',
  'ssw',
  'sw',
  'wsw',
  'w',
  'wnw',
  'nw',
  'nnw',
];
export const compassPoint = (deg) =>
  COMPASS[Math.round(norm360(deg) / 22.5) % 16];

/** Everything the panel shows, for one moment at one place. */
export function skyReading(date, lat, lon) {
  const sun = sunPosition(date, lat, lon);
  const later = sunPosition(new Date(date.valueOf() + 10 * 60_000), lat, lon);
  const moon = moonPosition(date, lat, lon);
  const illumination = moonIllumination(date);
  const dayStart = new Date(date.valueOf() - 12 * 3_600_000);
  return {
    sun: { ...sun, rising: later.altitude > sun.altitude },
    phase: dayPhase(sun.altitude, later.altitude > sun.altitude),
    isDay: sun.altitude > SUN_HORIZON,
    sunTimes: sunTimes(dayStart, lat, lon),
    solarNoon: solarNoon(dayStart, lat, lon),
    moon: { ...moon, ...illumination },
    moonTimes: moonTimes(dayStart, lat, lon),
    shadow: shadowGeometry(sun),
    stars: sun.altitude < -6 ? visibleStars(date, lat, lon) : [],
  };
}
