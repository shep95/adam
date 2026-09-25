/**
 * Astrocartography: the lines across the Earth where each body was on an
 * angle at a chosen instant.
 *
 * For a moment (UTC) each body has a right ascension α and declination δ.
 * From those come four world lines:
 *
 *   MC   the meridian where the body is on the upper meridian (culminating)
 *   IC   the opposite meridian (lower meridian)
 *   AC   the curve where the body is on the eastern horizon (rising)
 *   DC   the curve where the body is on the western horizon (setting)
 *
 * MC/IC are straight meridians; AC/DC are curves that depend on latitude.
 *
 * Positions use Paul Schlyter's compact planetary theory (good to a few
 * arc-minutes for the Sun and planets, ~0.25° for the Moon). This is a sky
 * geometry tool, not a claim about people — it draws where a body stood over
 * the Earth, nothing about anyone born or living there.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const rev = (x) => ((x % 360) + 360) % 360;
const sind = (x) => Math.sin(x * D2R);
const cosd = (x) => Math.cos(x * D2R);
const atan2d = (y, x) => Math.atan2(y, x) * R2D;
const asind = (x) => Math.asin(x) * R2D;

export const BODIES = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'pluto',
];

export const BODY_COLORS = {
  sun: '#FFD60A',
  moon: '#E5E5EA',
  mercury: '#AF9CEF',
  venus: '#FF8FB1',
  mars: '#FF453A',
  jupiter: '#FF9F0A',
  saturn: '#C9A227',
  uranus: '#64D2FF',
  neptune: '#0A84FF',
  pluto: '#BF5AF2',
};

/** Schlyter day number (epoch 1999-12-31 00:00 UT = 0), with UT fraction. */
export function dayNumber(date) {
  const Y = date.getUTCFullYear();
  const M = date.getUTCMonth() + 1;
  const D = date.getUTCDate();
  const ut =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  const d =
    367 * Y -
    Math.floor((7 * (Y + Math.floor((M + 9) / 12))) / 4) +
    Math.floor((275 * M) / 9) +
    D -
    730530;
  return d + ut / 24;
}

/** Solve Kepler for eccentric anomaly (degrees), iterating for the Moon. */
function eccentricAnomaly(M, e, iterate) {
  let E = M + R2D * e * sind(M) * (1 + e * cosd(M));
  if (!iterate) return E;
  for (let i = 0; i < 8; i += 1) {
    const dE = (E - R2D * e * sind(E) - M) / (1 - e * cosd(E));
    E -= dE;
    if (Math.abs(dE) < 1e-5) break;
  }
  return E;
}

// Orbital elements as functions of day number d (Schlyter).
const ELEMENTS = {
  sun: (d) => ({
    N: 0,
    i: 0,
    w: 282.9404 + 4.70935e-5 * d,
    a: 1,
    e: 0.016709 - 1.151e-9 * d,
    M: 356.047 + 0.9856002585 * d,
  }),
  moon: (d) => ({
    N: 125.1228 - 0.0529538083 * d,
    i: 5.1454,
    w: 318.0634 + 0.1643573223 * d,
    a: 60.2666,
    e: 0.0549,
    M: 115.3654 + 13.0649929509 * d,
  }),
  mercury: (d) => ({
    N: 48.3313 + 3.24587e-5 * d,
    i: 7.0047 + 5.0e-8 * d,
    w: 29.1241 + 1.01444e-5 * d,
    a: 0.387098,
    e: 0.205635 + 5.59e-10 * d,
    M: 168.6562 + 4.0923344368 * d,
  }),
  venus: (d) => ({
    N: 76.6799 + 2.4659e-5 * d,
    i: 3.3946 + 2.75e-8 * d,
    w: 54.891 + 1.38374e-5 * d,
    a: 0.72333,
    e: 0.006773 - 1.302e-9 * d,
    M: 48.0052 + 1.6021302244 * d,
  }),
  mars: (d) => ({
    N: 49.5574 + 2.11081e-5 * d,
    i: 1.8497 - 1.78e-8 * d,
    w: 286.5016 + 2.92961e-5 * d,
    a: 1.523688,
    e: 0.093405 + 2.516e-9 * d,
    M: 18.6021 + 0.5240207766 * d,
  }),
  jupiter: (d) => ({
    N: 100.4542 + 2.76854e-5 * d,
    i: 1.303 - 1.557e-7 * d,
    w: 273.8777 + 1.64505e-5 * d,
    a: 5.20256,
    e: 0.048498 + 4.469e-9 * d,
    M: 19.895 + 0.0830853001 * d,
  }),
  saturn: (d) => ({
    N: 113.6634 + 2.3898e-5 * d,
    i: 2.4886 - 1.081e-7 * d,
    w: 339.3939 + 2.97661e-5 * d,
    a: 9.55475,
    e: 0.055546 - 9.499e-9 * d,
    M: 316.967 + 0.0334442282 * d,
  }),
  uranus: (d) => ({
    N: 74.0005 + 1.3978e-5 * d,
    i: 0.7733 + 1.9e-8 * d,
    w: 96.6612 + 3.0565e-5 * d,
    a: 19.18171 - 1.55e-8 * d,
    e: 0.047318 + 7.45e-9 * d,
    M: 142.5905 + 0.011725806 * d,
  }),
  neptune: (d) => ({
    N: 131.7806 + 3.0173e-5 * d,
    i: 1.77 - 2.55e-7 * d,
    w: 272.8461 - 6.027e-6 * d,
    a: 30.05826 + 3.313e-8 * d,
    e: 0.008606 + 2.15e-9 * d,
    M: 260.2471 + 0.005995147 * d,
  }),
  // Pluto: Keplerian J2000 elements with linear mean-anomaly rate. Lower
  // accuracy than the planets above (a few degrees over decades); included
  // because astrology uses it. Flagged approximate to the caller.
  pluto: (d) => ({
    N: 110.30347,
    i: 17.14175,
    w: 113.76329,
    a: 39.48168677,
    e: 0.24880766,
    M: 14.53 + 0.00396 * d,
  }),
};

function eclObliquity(d) {
  return 23.4393 - 3.563e-7 * d;
}

/** Sun's geocentric rectangular ecliptic coords and mean longitude. */
function sunRect(d) {
  const el = ELEMENTS.sun(d);
  const E = eccentricAnomaly(el.M, el.e, false);
  const xv = cosd(E) - el.e;
  const yv = Math.sqrt(1 - el.e * el.e) * sind(E);
  const v = atan2d(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  const lon = rev(v + el.w);
  return {
    xs: r * cosd(lon),
    ys: r * sind(lon),
    Ls: rev(el.M + el.w),
    lon,
  };
}

/** Moon perturbations in longitude and latitude (degrees). */
function moonPerturb(d, lon, lat) {
  const Ms = ELEMENTS.sun(d).M;
  const Mm = ELEMENTS.moon(d).M;
  const Nm = ELEMENTS.moon(d).N;
  const ws = ELEMENTS.sun(d).w;
  const wm = ELEMENTS.moon(d).w;
  const Ls = rev(Ms + ws);
  const Lm = rev(Mm + wm + Nm);
  const Dm = rev(Lm - Ls); // mean elongation
  const F = rev(Lm - Nm); // argument of latitude
  let dLon = 0;
  dLon += -1.274 * sind(Mm - 2 * Dm);
  dLon += 0.658 * sind(2 * Dm);
  dLon += -0.186 * sind(Ms);
  dLon += -0.059 * sind(2 * Mm - 2 * Dm);
  dLon += -0.057 * sind(Mm - 2 * Dm + Ms);
  dLon += 0.053 * sind(Mm + 2 * Dm);
  dLon += 0.046 * sind(2 * Dm - Ms);
  dLon += 0.041 * sind(Mm - Ms);
  dLon += -0.035 * sind(Dm);
  dLon += -0.031 * sind(Mm + Ms);
  dLon += -0.015 * sind(2 * F - 2 * Dm);
  dLon += 0.011 * sind(Mm - 4 * Dm);
  let dLat = 0;
  dLat += -0.173 * sind(F - 2 * Dm);
  dLat += -0.055 * sind(Mm - F - 2 * Dm);
  dLat += -0.046 * sind(Mm + F - 2 * Dm);
  dLat += 0.033 * sind(F + 2 * Dm);
  dLat += 0.017 * sind(2 * Mm + F);
  return { lon: lon + dLon, lat: lat + dLat };
}

/** Geocentric equatorial right ascension and declination (degrees). */
export function bodyEquatorial(body, d) {
  const ecl = eclObliquity(d);
  if (body === 'sun') {
    const { xs, ys } = sunRect(d);
    const xe = xs;
    const ye = ys * cosd(ecl);
    const ze = ys * sind(ecl);
    return {
      ra: rev(atan2d(ye, xe)),
      dec: asind(ze / Math.sqrt(xe * xe + ye * ye + ze * ze)),
    };
  }
  const el = ELEMENTS[body];
  if (!el) throw new Error(`unknown body: ${body}`);
  const o = el(d);
  const E = eccentricAnomaly(o.M, o.e, body === 'moon');
  const xv = o.a * (cosd(E) - o.e);
  const yv = o.a * (Math.sqrt(1 - o.e * o.e) * sind(E));
  const v = atan2d(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  // Heliocentric (planets) or geocentric (Moon) ecliptic rectangular coords.
  let xh =
    r * (cosd(o.N) * cosd(v + o.w) - sind(o.N) * sind(v + o.w) * cosd(o.i));
  let yh =
    r * (sind(o.N) * cosd(v + o.w) + cosd(o.N) * sind(v + o.w) * cosd(o.i));
  let zh = r * (sind(v + o.w) * sind(o.i));
  if (body === 'moon') {
    let lon = atan2d(yh, xh);
    let lat = atan2d(zh, Math.sqrt(xh * xh + yh * yh));
    ({ lon, lat } = moonPerturb(d, lon, lat));
    xh = r * cosd(lon) * cosd(lat);
    yh = r * sind(lon) * cosd(lat);
    zh = r * sind(lat);
  } else {
    // Add the Sun's geocentric position to get geocentric ecliptic coords.
    const { xs, ys } = sunRect(d);
    xh += xs;
    yh += ys;
  }
  const xe = xh;
  const ye = yh * cosd(ecl) - zh * sind(ecl);
  const ze = yh * sind(ecl) + zh * cosd(ecl);
  return {
    ra: rev(atan2d(ye, xe)),
    dec: asind(ze / Math.sqrt(xe * xe + ye * ye + ze * ze)),
  };
}

/** Greenwich mean sidereal time in degrees (0 = 0° RA over Greenwich). */
export function gmstDegrees(date) {
  const d = dayNumber(date);
  const { Ls } = sunRect(d);
  const ut =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600;
  return rev(Ls + 180 + 15 * ut);
}

function splitOnWrap(points) {
  const segs = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && Math.abs(p[0] - cur[cur.length - 1][0]) > 180) {
      if (cur.length > 1) segs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

/**
 * The four angle lines for one body at a moment. MC/IC are single meridians
 * (one segment each); AC/DC are curves returned as one or more [lon,lat]
 * segments (split where they wrap the antimeridian).
 */
export function bodyLines(body, date, { latStep = 1, latLimit = 84 } = {}) {
  const d = dayNumber(date);
  const { ra, dec } = bodyEquatorial(body, d);
  const gmst = gmstDegrees(date);
  const wrap = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
  const mcLon = wrap(ra - gmst);
  const icLon = wrap(ra - gmst + 180);
  const mcSeg = [];
  const icSeg = [];
  for (let lat = -latLimit; lat <= latLimit; lat += latStep) {
    mcSeg.push([mcLon, lat]);
    icSeg.push([icLon, lat]);
  }
  const ac = [];
  const dc = [];
  for (let lat = -latLimit; lat <= latLimit; lat += latStep) {
    const cosH = -Math.tan(lat * D2R) * Math.tan(dec * D2R);
    if (cosH < -1 || cosH > 1) continue; // body never rises/sets here
    const H0 = Math.acos(cosH) * R2D;
    ac.push([wrap(ra - gmst - H0), lat]); // rising (eastern horizon)
    dc.push([wrap(ra - gmst + H0), lat]); // setting (western horizon)
  }
  return {
    body,
    ra,
    dec,
    lines: [
      { angle: 'MC', segments: [mcSeg], lon: mcLon },
      { angle: 'IC', segments: [icSeg], lon: icLon },
      { angle: 'AC', segments: splitOnWrap(ac) },
      { angle: 'DC', segments: splitOnWrap(dc) },
    ],
  };
}

/** Every body's lines for a moment. */
export function chartLines(date, { bodies = BODIES, ...opts } = {}) {
  return bodies.map((b) => bodyLines(b, date, opts));
}

/**
 * Convert a local wall-clock time to a UTC Date.
 * @param {{year,month,day,hour,minute}} parts local calendar fields
 * @param {number} offsetHours minutes east of UTC in hours (e.g. -5, +5.5)
 */
export function localToUtc(
  { year, month, day, hour = 0, minute = 0 },
  offsetHours,
) {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - offsetHours * 3600_000,
  );
}
