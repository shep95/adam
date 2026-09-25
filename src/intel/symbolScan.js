/**
 * Symbols from the sky: what a city has built that carries religious or
 * esoteric meaning, and the shapes its buildings and streets make from
 * above — all from OpenStreetMap.
 *
 *   sacred     places of worship of every faith, crosses, shrines
 *   esoteric   lodges (Masonic and similar fraternal orders), obelisks,
 *              pyramids, megaliths and stone circles
 *   shapes     read from footprints and road geometry: cruciform plans,
 *              star forts, pentagons, and star junctions (many streets
 *              radiating from one roundabout)
 *
 * Tags and names are what mappers recorded; shapes are measured from the
 * geometry. Neither says what anything means to anyone — the panel says so.
 */

const M_PER_DEG = 111_320;

export function symbolQuery([s, w, n, e], cap = 1500) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:45];(
nwr["amenity"="place_of_worship"](${b});
nwr["building"~"^(church|cathedral|chapel|synagogue|mosque|temple|shrine|monastery)$"](${b});
nwr["historic"~"^(wayside_cross|wayside_shrine)$"](${b});
nwr["man_made"~"^(cross|obelisk)$"](${b});
nwr["memorial"="obelisk"](${b});
nwr["building"="pyramid"](${b});
nwr["historic"="archaeological_site"]["site_type"~"megalith|stone_circle"](${b});
nwr["megalith_type"](${b});
nwr["club"="freemasonry"](${b});
nwr["name"~"Masonic|Freemason|Grand Lodge|Shrine Temple|Shriners|Rosicrucian|Theosophical|Scottish Rite|Knights Templar|Odd Fellows",i](${b});
way["historic"="fort"](${b});
);out tags geom ${cap};`;
}

export function junctionQuery([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:45];way["junction"="roundabout"](${b})->.r;.r out body geom;node(w.r)->.n;way(bn.n)["highway"]["junction"!="roundabout"];out body;`;
}

/** Bounding box around a centre, clamped to city scale. */
export function cityBox(lat, lon, radiusKm = 6) {
  const r = Math.max(0.5, Math.min(15, radiusKm));
  const dLat = r / 111.32;
  const dLon = r / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(
    (v) => +v.toFixed(5),
  );
}

// ── Geometry ───────────────────────────────────────────────────────────

function toLocal(ring) {
  const lat0 = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  return ring.map((p) => [p.lon * M_PER_DEG * k, p.lat * M_PER_DEG]);
}

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}

export function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.slice().reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Douglas–Peucker on a closed ring (metres). */
export function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const dp = (a, b, list) => {
    let max = 0;
    let idx = -1;
    const [x1, y1] = a;
    const [x2, y2] = b;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    list.forEach((p, i) => {
      const d =
        Math.abs((y2 - y1) * p[0] - (x2 - x1) * p[1] + x2 * y1 - y2 * x1) / len;
      if (d > max) {
        max = d;
        idx = i;
      }
    });
    if (max <= tol) return [a];
    return [
      ...dp(a, list[idx], list.slice(0, idx)),
      ...dp(list[idx], b, list.slice(idx + 1)),
    ];
  };
  // Split the ring at its farthest pair of points.
  let far = 0;
  for (let i = 1; i < pts.length; i += 1)
    if (
      Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) >
      Math.hypot(pts[far][0] - pts[0][0], pts[far][1] - pts[0][1])
    )
      far = i;
  const a = dp(pts[0], pts[far], pts.slice(1, far));
  const b = dp(pts[far], pts[0], pts.slice(far + 1));
  return [...a, ...b];
}

/**
 * What shape a footprint makes from above.
 * @returns {'cruciform'|'star'|'pentagon'|'circle'|null}
 */
export function footprintShape(ring) {
  if (!Array.isArray(ring) || ring.length < 5) return null;
  const pts = toLocal(
    ring.at(-1).lat === ring[0].lat && ring.at(-1).lon === ring[0].lon
      ? ring.slice(0, -1)
      : ring,
  );
  const area = polygonArea(pts);
  if (area < 150) return null;
  const hull = convexHull(pts);
  const solidity = area / Math.max(polygonArea(hull), 1);
  const size = Math.sqrt(area);
  const simple = simplify(pts, size * 0.04);
  const n = simple.length;
  // Concave corners: reflex vertices of the simplified ring.
  let reflex = 0;
  const sign = Math.sign(
    simple.reduce((s, p, i) => {
      const q = simple[(i + 1) % n];
      return s + (p[0] * q[1] - q[0] * p[1]);
    }, 0),
  );
  for (let i = 0; i < n; i += 1) {
    const a = simple[(i + n - 1) % n];
    const b = simple[i];
    const c = simple[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.sign(cross) === -sign) reflex += 1;
  }
  const perimeter = pts.reduce(
    (s, p, i) =>
      s +
      Math.hypot(
        pts[(i + 1) % pts.length][0] - p[0],
        pts[(i + 1) % pts.length][1] - p[1],
      ),
    0,
  );
  const roundness = (4 * Math.PI * area) / (perimeter * perimeter);
  if (roundness > 0.88 && n >= 8) return 'circle';
  if (reflex === 4 && n >= 12 && n <= 16 && solidity < 0.8) return 'cruciform';
  if (reflex >= 4 && reflex === n / 2 && solidity < 0.75) return 'star';
  if (n === 5 && reflex === 0 && solidity > 0.95) return 'pentagon';
  return null;
}

// ── Classification ─────────────────────────────────────────────────────

const ESOTERIC_NAME =
  /masonic|freemason|grand lodge|shrine temple|shriners|rosicrucian|theosoph|scottish rite|knights templar|odd fellows/i;

function centre(el) {
  if (Number.isFinite(el.lat)) return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  const g = el.geometry || [];
  if (!g.length) return null;
  return {
    lat: g.reduce((s, p) => s + p.lat, 0) / g.length,
    lon: g.reduce((s, p) => s + p.lon, 0) / g.length,
  };
}

/** Overpass elements → categorised sites with any shape found. */
export function classifySymbols(json) {
  const out = [];
  const seen = new Set();
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const at = centre(el);
    if (!at) continue;
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let category = null;
    let kind = null;
    if (t.club === 'freemasonry' || ESOTERIC_NAME.test(t.name || '')) {
      category = 'esoteric';
      kind = 'lodge';
    } else if (t.man_made === 'obelisk' || t.memorial === 'obelisk') {
      category = 'esoteric';
      kind = 'obelisk';
    } else if (t.building === 'pyramid') {
      category = 'esoteric';
      kind = 'pyramid';
    } else if (
      t.megalith_type ||
      /megalith|stone_circle/.test(t.site_type || '')
    ) {
      category = 'esoteric';
      kind = t.megalith_type
        ? `megalith · ${t.megalith_type.replace(/_/g, ' ')}`
        : 'megalith';
    } else if (
      t.amenity === 'place_of_worship' ||
      /church|cathedral|chapel|synagogue|mosque|temple|shrine|monastery/.test(
        t.building || '',
      )
    ) {
      category = 'sacred';
      kind =
        [t.religion, t.denomination]
          .filter(Boolean)
          .join(' · ')
          .replace(/_/g, ' ') ||
        t.building ||
        'place of worship';
    } else if (
      /wayside_cross|wayside_shrine/.test(t.historic || '') ||
      t.man_made === 'cross'
    ) {
      category = 'sacred';
      kind = t.historic === 'wayside_shrine' ? 'wayside shrine' : 'cross';
    } else if (t.historic === 'fort') {
      category = 'shape';
      kind = 'fort';
    }
    if (!category) continue;
    const shape =
      el.type === 'way' && el.geometry?.length
        ? footprintShape(el.geometry)
        : null;
    if (category === 'shape' && shape !== 'star') continue; // only star-shaped forts
    out.push({
      id: key,
      name: t.name || t['name:en'] || null,
      category,
      kind: category === 'shape' ? 'star fort' : kind,
      religion: t.religion || null,
      shape,
      lat: +at.lat.toFixed(6),
      lon: +at.lon.toFixed(6),
      wikipedia: t.wikipedia || null,
      website: t.website || null,
    });
  }
  return out;
}

/**
 * Star junctions: roundabouts with many streets meeting them.
 * @param {object} json Overpass result of junctionQuery (ways with nodes).
 */
export function starJunctions(json, { minSpokes = 6 } = {}) {
  const ways = json?.elements || [];
  const rings = ways.filter(
    (w) => w.type === 'way' && w.tags?.junction === 'roundabout',
  );
  const roads = ways.filter(
    (w) =>
      w.type === 'way' && w.tags?.highway && w.tags?.junction !== 'roundabout',
  );
  const out = [];
  for (const r of rings) {
    const nodes = new Set(r.nodes || []);
    const spokes = new Set();
    const names = new Set();
    for (const w of roads) {
      if ((w.nodes || []).some((n) => nodes.has(n))) {
        spokes.add(w.id);
        if (w.tags?.name) names.add(w.tags.name);
      }
    }
    if (spokes.size < minSpokes) continue;
    const c = centre(r);
    if (!c) continue;
    out.push({
      id: `way/${r.id}`,
      name: r.tags?.name || null,
      category: 'shape',
      kind: `star junction · ${spokes.size} streets`,
      spokes: spokes.size,
      streets: [...names].slice(0, 12),
      shape: 'star',
      lat: +c.lat.toFixed(6),
      lon: +c.lon.toFixed(6),
    });
  }
  return out.sort((a, b) => b.spokes - a.spokes);
}

export function summarizeSymbols(sites) {
  const count = (list, k) =>
    list.reduce((m, s) => {
      m[s[k] || 'unspecified'] = (m[s[k] || 'unspecified'] || 0) + 1;
      return m;
    }, {});
  return {
    total: sites.length,
    byCategory: count(sites, 'category'),
    byReligion: count(
      sites.filter((s) => s.category === 'sacred'),
      'religion',
    ),
    shapes: sites
      .filter((s) => s.shape)
      .map((s) => ({ name: s.name, kind: s.kind, shape: s.shape })),
  };
}
