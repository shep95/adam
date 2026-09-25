/**
 * Storm field: what the weather is doing around the camera, from the radar
 * and satellite rasters themselves rather than one point observation.
 *
 * Pure math (this file) + a tile sampler (createStormSampler) that reads the
 * same /api/weather tiles the radar layer draws:
 *
 *   radar      MRMS base reflectivity (CONUS) → dBZ per ~1 km pixel
 *   clouds     global longwave IR → cold, bright cloud tops
 *   lightning  15-min strike density
 *
 * The field is sampled at the camera's ground point and on rings out to
 * 30 km, so effects ramp up as a cell approaches instead of switching on at a
 * threshold. stormState() then places the camera in the storm's vertical
 * structure: under the base (rain, dark, low visibility), inside the cloud
 * (whiteout, flashes), above the tops (clear, lightning glowing below).
 */

/** NWS reflectivity palette (dBZ → RGB), the colours the WMS style uses. */
export const DBZ_PALETTE = Object.freeze([
  [5, [4, 233, 231]],
  [10, [1, 159, 244]],
  [15, [3, 0, 244]],
  [20, [2, 253, 2]],
  [25, [1, 197, 1]],
  [30, [0, 142, 0]],
  [35, [253, 248, 2]],
  [40, [229, 188, 0]],
  [45, [253, 149, 0]],
  [50, [253, 0, 0]],
  [55, [212, 0, 0]],
  [60, [188, 0, 0]],
  [65, [248, 0, 253]],
  [70, [152, 84, 198]],
  [75, [253, 253, 253]],
]);

/** dBZ for one RGBA pixel (nearest palette colour); 0 when transparent. */
export function dbzFromRgba(r, g, b, a) {
  if (a < 40) return 0;
  let best = 0;
  let bestD = Infinity;
  for (const [dbz, [pr, pg, pb]] of DBZ_PALETTE) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = dbz;
    }
  }
  return bestD > 90 * 90 ? 0 : best;
}

/** Precipitation intensity 0–1 from reflectivity (drizzle ~20, severe 55+). */
export function intensityFromDbz(dbz) {
  if (!(dbz >= 15)) return 0;
  return Math.min(1, (dbz - 15) / 40);
}

/** Cloud density 0–1 from an IR pixel: bright/cold tops read dense. */
export function cloudFromRgba(r, g, b, a) {
  if (a < 20) return 0;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return Math.max(0, Math.min(1, (lum - 0.35) / 0.5)) * (a / 255);
}

const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const RING_RADII_KM = Object.freeze([4, 9, 16, 25]);
const FALLOFF_KM = 30;

/**
 * Combine centre and ring samples into one field. Ring samples count with a
 * linear falloff to 30 km, so an approaching cell ramps the field smoothly.
 * @param {{dbz:number, cloud:number, lightning:number}} centre
 * @param {Array<{km:number, dbz:number, cloud:number, lightning:number}>} ring
 */
export function combineField(centre, ring = []) {
  let approach = 0;
  let nearestKm = intensityFromDbz(centre.dbz) > 0 ? 0 : null;
  let peakDbz = centre.dbz || 0;
  let lightning = centre.lightning || 0;
  let cloud = centre.cloud || 0;
  for (const s of ring) {
    const w = Math.max(0, 1 - s.km / FALLOFF_KM);
    approach = Math.max(approach, intensityFromDbz(s.dbz) * w);
    if (
      intensityFromDbz(s.dbz) > 0.1 &&
      (nearestKm == null || s.km < nearestKm)
    )
      nearestKm = s.km;
    peakDbz = Math.max(peakDbz, s.dbz * (w > 0.5 ? 1 : 0));
    lightning = Math.max(lightning, (s.lightning || 0) * w);
    cloud = Math.max(cloud, (s.cloud || 0) * w * 0.8);
  }
  return {
    here: intensityFromDbz(centre.dbz),
    approach,
    dbz: centre.dbz || 0,
    peakDbz,
    cloud,
    lightning,
    nearestKm,
  };
}

/**
 * Where the camera sits in the storm column, and what that looks like.
 * @param {ReturnType<typeof combineField>} field
 * @param {number} heightAglM Camera height above ground.
 * @returns {{rain:number, inCloud:number, darkness:number, visibilityM:number,
 *   lightning:number, layer:'clear'|'below'|'inside'|'above'|'high'}}
 */
export function stormState(field, heightAglM) {
  const h = Math.max(0, heightAglM) / 1000;
  const I = Math.max(field.here, field.approach * 0.85);
  const convective = field.peakDbz >= 40 || field.lightning > 0;
  // Echo tops rise with reflectivity: stratiform ~5 km, strong cells 12–16.
  const topKm =
    I > 0 ? Math.min(16, 5 + Math.max(0, field.peakDbz - 25) * 0.3) : 0;
  const baseKm = convective ? 1.2 : 1.8;
  const cloud = Math.max(field.cloud, I);
  if (h > 25 || (I < 0.02 && field.cloud < 0.15))
    return {
      rain: 0,
      inCloud: 0,
      darkness: 0,
      visibilityM: 50_000,
      lightning: h > 25 ? 0 : field.lightning * 0.3,
      layer: h > 25 ? 'high' : 'clear',
    };
  const underBase = 1 - smooth(baseKm - 0.3, baseKm + 0.3, h);
  const belowTop = topKm > 0 ? 1 - smooth(topKm - 0.6, topKm + 0.6, h) : 0;
  const inside = Math.min(1 - underBase, belowTop) * Math.min(1, cloud * 1.25);
  const rain = I * (underBase + (1 - underBase) * belowTop * 0.45);
  const shade = underBase * (0.18 + 0.6 * I) + inside * (0.25 + 0.45 * I);
  const above = 1 - belowTop;
  const lerp = (a, b, t) => a + (b - a) * t;
  // Heavy rain under a cell: ~1–2 km; light rain ~20 km; inside cloud ~150 m.
  const visBelow = lerp(
    50_000,
    30_000 * (1 - I) ** 2 + 800,
    underBase * Math.min(1, I * 4),
  );
  const visInside = lerp(50_000, 150 + 1500 * (1 - cloud), inside);
  const visibilityM = Math.round(Math.min(visBelow, visInside));
  const lightning = convective
    ? Math.min(1, Math.max(field.lightning, smooth(40, 60, field.peakDbz))) *
      (underBase * 0.8 + inside + above * 0.5)
    : 0;
  const layer =
    inside > 0.35
      ? 'inside'
      : underBase > 0.5 && I > 0.05
        ? 'below'
        : above > 0.5 && I > 0.05
          ? 'above'
          : 'clear';
  return {
    rain: Math.min(1, rain),
    inCloud: Math.min(1, inside),
    darkness: Math.min(0.85, shade + above * 0.05 * I),
    visibilityM,
    lightning,
    layer,
  };
}

/** Geographic tile (the weather proxy's level-6 grid) and pixel for a point. */
export function tileAndPixel(lat, lon, z = 6, size = 256) {
  const span = 180 / 2 ** z;
  const fx = (lon + 180) / span;
  const fy = (90 - lat) / span;
  const x = Math.min(2 ** (z + 1) - 1, Math.max(0, Math.floor(fx)));
  const y = Math.min(2 ** z - 1, Math.max(0, Math.floor(fy)));
  return {
    z,
    x,
    y,
    px: Math.min(size - 1, Math.floor((fx - x) * size)),
    py: Math.min(size - 1, Math.floor((fy - y) * size)),
  };
}

/** Point `km` away on `bearingDeg` (spherical). */
export function offsetPoint(lat, lon, km, bearingDeg) {
  const R = 6371;
  const d = km / R;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return {
    lat: (p2 * 180) / Math.PI,
    lon: (((l2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/**
 * Tile sampler over the weather proxy. Keeps decoded tiles (LRU) and the
 * latest manifest time per product.
 * @param {{fetchImpl?: Function, loadPixels?: (url: string) => Promise<Uint8ClampedArray|null>, now?: () => number}} [deps]
 */
export function createStormSampler({
  fetchImpl = (...a) => globalThis.fetch(...a),
  loadPixels,
  now = () => Date.now(),
} = {}) {
  const manifests = new Map();
  const tiles = new Map();
  const pending = new Map();
  const MAX_TILES = 32;

  async function manifest(product) {
    const m = manifests.get(product);
    if (m && now() - m.at < 4 * 60_000) return m.value;
    try {
      const res = await fetchImpl(`/api/weather/manifest?product=${product}`);
      const value = res.ok ? await res.json() : null;
      manifests.set(product, { at: now(), value });
      return value;
    } catch {
      manifests.set(product, { at: now(), value: null });
      return null;
    }
  }

  const inBounds = (b, lat, lon) =>
    b && lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

  async function tilePixels(product, time, t) {
    const key = `${product}|${time}|${t.z}/${t.x}/${t.y}`;
    if (tiles.has(key)) {
      const v = tiles.get(key);
      tiles.delete(key);
      tiles.set(key, v);
      return v;
    }
    if (!pending.has(key))
      pending.set(
        key,
        (async () => {
          const url = `/api/weather/tile?product=${product}&time=${encodeURIComponent(time)}&z=${t.z}&x=${t.x}&y=${t.y}`;
          let px = null;
          try {
            px = await loadPixels(url);
          } catch {
            px = null;
          }
          tiles.set(key, px);
          while (tiles.size > MAX_TILES)
            tiles.delete(tiles.keys().next().value);
          pending.delete(key);
          return px;
        })(),
      );
    return pending.get(key);
  }

  async function sample(product, lat, lon) {
    const m = await manifest(product);
    if (!m || m.unavailable || !m.latest || !inBounds(m.bounds, lat, lon))
      return null;
    const t = tileAndPixel(lat, lon);
    const px = await tilePixels(product, m.latest, t);
    if (!px) return null;
    const i = (t.py * 256 + t.px) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  }

  async function point(lat, lon) {
    const [radar, clouds, lightning] = await Promise.all([
      sample('radar', lat, lon),
      sample('clouds', lat, lon),
      sample('lightning', lat, lon),
    ]);
    return {
      covered: radar != null,
      dbz: radar ? dbzFromRgba(...radar) : 0,
      cloud: clouds ? cloudFromRgba(...clouds) : 0,
      lightning: lightning ? Math.min(1, lightning[3] / 160) : 0,
    };
  }

  return {
    /** Field around a point: centre plus rings of 8 bearings. */
    async fieldAt(lat, lon) {
      const centre = await point(lat, lon);
      const ring = [];
      await Promise.all(
        RING_RADII_KM.flatMap((km) =>
          [0, 45, 90, 135, 180, 225, 270, 315].map(async (brg) => {
            const p = offsetPoint(lat, lon, km, brg);
            const s = await point(p.lat, p.lon);
            ring.push({ km, ...s });
          }),
        ),
      );
      return {
        radarCovered: centre.covered || ring.some((s) => s.covered),
        ...combineField(centre, ring),
      };
    },
    manifest,
  };
}
