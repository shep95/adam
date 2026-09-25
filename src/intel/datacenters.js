/**
 * Data-centre intelligence: the sites, the infrastructure that constrains
 * where they can be built, and the supply chain behind the chips inside them.
 *
 * Sites, power, water and fibre come live from OpenStreetMap (Overpass) for
 * the current view. Chip fabs and raw-material chokepoints are a small
 * curated set of public facts (each with its source class), because OSM does
 * not tag process node or ore refining. The prediction layer is a transparent
 * weighted score over a grid of the view — it is a heuristic that shows where
 * the live siting constraints line up, plainly marked as a model output and
 * never as a confirmed site. Supply-chain links are drawn as a readable graph;
 * ADAM does not rank which shared asset to disable for maximum damage.
 */

// ── Layer 1: data centres, coloured by function ────────────────────────────

export const DC_FUNCTIONS = {
  ai_training: { label: 'ai training (gpu clusters)', color: '#FF375F' },
  ai_inference: { label: 'ai inference', color: '#FF9F0A' },
  hyperscale: { label: 'hyperscale cloud', color: '#0A84FF' },
  colocation: { label: 'colocation / wholesale', color: '#64D2FF' },
  enterprise: { label: 'enterprise (single company)', color: '#BF5AF2' },
  government: { label: 'government / defense', color: '#30D158' },
  crypto: { label: 'crypto mining', color: '#FFD60A' },
  edge: { label: 'edge / telecom', color: '#8E8E93' },
  unknown: { label: 'data centre (unclassified)', color: '#AEAEB2' },
};

const OPERATOR_HINTS = [
  [/\b(aws|amazon)\b/i, 'hyperscale'],
  [/\b(google|gcp)\b/i, 'hyperscale'],
  [/\b(microsoft|azure)\b/i, 'hyperscale'],
  [/\b(meta|facebook)\b/i, 'hyperscale'],
  [/\b(oracle|ovh|alibaba|tencent|huawei\s*cloud)\b/i, 'hyperscale'],
  [
    /\b(equinix|digital\s*realty|cyxtera|coresite|iron\s*mountain)\b/i,
    'colocation',
  ],
  [/\b(vantage|qts|switch|ntt|cyrusone|stack\s*infra)\b/i, 'colocation'],
  [
    /\b(coreweave|lambda|crusoe|nebius|together\s*ai|xai|openai)\b/i,
    'ai_training',
  ],
];

/** Classify one OSM element's tags into a DC function id. */
export function classifyDataCentre(tags = {}) {
  const t = tags;
  const text = `${t.name || ''} ${t.operator || ''} ${t.brand || ''}`;
  const usage =
    `${t['data_center'] || ''} ${t.use || ''} ${t.description || ''}`.toLowerCase();
  const gov =
    /\b(gov|government|defense|defence|military|national\s*lab|\.mil)\b/i;
  const crypto = /\b(bitcoin|crypto|mining\s*farm|hashrate|asic)\b/i;

  if (
    gov.test(text) ||
    t.operator_type === 'government' ||
    t.access === 'military'
  )
    return 'government';
  if (crypto.test(text) || /crypto|mining/.test(usage)) return 'crypto';
  if (
    /\b(ai|gpu|training|supercomput|hpc)\b/i.test(text) ||
    /ai|gpu|training/.test(usage)
  )
    return 'ai_training';
  for (const [re, fn] of OPERATOR_HINTS) if (re.test(text)) return fn;
  if (t.telecom === 'data_center' && (t.man_made === 'tower' || t.tower))
    return 'edge';
  if (/colo|wholesale|carrier\s*neutral/i.test(text)) return 'colocation';
  if (t.office || /enterprise|corporate\s*data/i.test(text))
    return 'enterprise';
  return 'unknown';
}

/** Overpass QL for data centres in a bounding box [s,w,n,e]. */
export function dataCentreQuery([s, w, n, e], cap = 800) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:40];(
nwr["telecom"="data_center"](${b});
nwr["building"="data_center"](${b});
nwr["office"="data_center"](${b});
nwr["man_made"="data_center"](${b});
nwr["landuse"="data_center"](${b});
nwr["power"="plant"]["plant:method"="crypto"](${b});
);out tags center ${cap};`;
}

export function normalizeDataCentres(json) {
  const out = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      id: `${el.type}/${el.id}`,
      fn: classifyDataCentre(t),
      name: t.name || t.operator || null,
      operator: t.operator || null,
      lat,
      lon,
    });
  }
  return out;
}

// ── Layer 2: power (the binding constraint) ────────────────────────────────

export const FUEL_COLORS = {
  nuclear: '#7CF5A0',
  gas: '#FF9F0A',
  coal: '#8E8E93',
  hydro: '#0A84FF',
  wind: '#64D2FF',
  solar: '#FFD60A',
  biomass: '#BF9B30',
  oil: '#C0724A',
  geothermal: '#FF6B6B',
  other: '#AEAEB2',
};

export function powerFuel(tags = {}) {
  const s =
    `${tags['plant:source'] || tags['generator:source'] || tags.source || ''}`.toLowerCase();
  if (/nuclear/.test(s)) return 'nuclear';
  if (/gas/.test(s)) return 'gas';
  if (/coal/.test(s)) return 'coal';
  if (/hydro/.test(s)) return 'hydro';
  if (/wind/.test(s)) return 'wind';
  if (/solar|photovoltaic/.test(s)) return 'solar';
  if (/biomass|biogas|waste/.test(s)) return 'biomass';
  if (/oil|diesel/.test(s)) return 'oil';
  if (/geothermal/.test(s)) return 'geothermal';
  return 'other';
}

/** Megawatts from an OSM output tag like "1.5 MW" / "800 kW" / "2 GW". */
export function parsePowerMW(raw) {
  const m = /([\d.]+)\s*(gw|mw|kw|w)?/i.exec(String(raw || ''));
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] || 'mw').toLowerCase();
  return unit === 'gw'
    ? v * 1000
    : unit === 'kw'
      ? v / 1000
      : unit === 'w'
        ? v / 1e6
        : v;
}

/** Power plants, substations and high-voltage lines in a box. */
export function powerQuery([s, w, n, e], minKv = 230) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:45];(
nwr["power"="plant"](${b});
nwr["power"="substation"]["voltage"~"^[0-9]"](${b});
way["power"="line"]["voltage"~"^[0-9]"](${b});
);out tags center 1200;`;
}

export function normalizePower(json, { minKv = 230 } = {}) {
  const plants = [];
  const substations = [];
  const lines = [];
  const kvOf = (t) =>
    Math.max(
      0,
      ...String(t.voltage || '')
        .split(/[;,]/)
        .map((v) => Number(v) / 1000)
        .filter(Number.isFinite),
    );
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (t.power === 'plant' && Number.isFinite(lat)) {
      plants.push({
        id: `${el.type}/${el.id}`,
        fuel: powerFuel(t),
        name: t.name || null,
        mw: parsePowerMW(t['plant:output:electricity']),
        lat,
        lon,
      });
    } else if (t.power === 'substation' && Number.isFinite(lat)) {
      const kv = kvOf(t);
      if (kv >= minKv)
        substations.push({
          id: `${el.type}/${el.id}`,
          kv,
          name: t.name || null,
          lat,
          lon,
        });
    } else if (t.power === 'line') {
      const kv = kvOf(t);
      if (kv >= minKv && el.geometry)
        lines.push({
          id: `${el.type}/${el.id}`,
          kv,
          coords: el.geometry.map((g) => [g.lon, g.lat]),
        });
    }
  }
  return { plants, substations, lines };
}

// ── Layer 3: water ─────────────────────────────────────────────────────────

export function waterQuery([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:40];(
nwr["man_made"="water_works"](${b});
nwr["man_made"="wastewater_plant"](${b});
nwr["man_made"="water_treatment"](${b});
nwr["natural"="water"]["water"~"reservoir|lake"](${b});
nwr["landuse"="reservoir"](${b});
);out tags center 500;`;
}

export const WATER_KINDS = {
  works: { label: 'water treatment', color: '#0A84FF' },
  wastewater: { label: 'wastewater / reclaimed', color: '#30D158' },
  reservoir: { label: 'reservoir / lake', color: '#64D2FF' },
};

export function classifyWater(tags = {}) {
  if (tags.man_made === 'wastewater_plant') return 'wastewater';
  if (tags.man_made === 'water_works' || tags.man_made === 'water_treatment')
    return 'works';
  if (tags.natural === 'water' || tags.landuse === 'reservoir')
    return 'reservoir';
  return null;
}

export function normalizeWater(json) {
  const out = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const kind = classifyWater(t);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!kind || !Number.isFinite(lat)) continue;
    out.push({
      id: `${el.type}/${el.id}`,
      kind,
      name: t.name || null,
      lat,
      lon,
    });
  }
  return out;
}

// ── Layer 4 & 5: chip supply chain and materials (curated public facts) ────
// Each entry is public knowledge; `status` and `note` are as of 2025 and may
// change — say so when you present them.

export const FAB_KINDS = {
  logic: { label: 'logic fab', color: '#0A84FF' },
  memory: { label: 'memory / hbm fab', color: '#BF5AF2' },
  packaging: { label: 'advanced packaging (cowos)', color: '#FF375F' },
  equipment: { label: 'equipment maker', color: '#FFD60A' },
};

export const CHIP_FABS = [
  {
    name: 'TSMC Fab 18 (Tainan)',
    kind: 'logic',
    node: '3–5 nm',
    lat: 23.05,
    lon: 120.27,
    org: 'TSMC',
    country: 'TW',
  },
  {
    name: 'TSMC Fab 20 (Hsinchu)',
    kind: 'logic',
    node: '2 nm',
    lat: 24.78,
    lon: 121.0,
    org: 'TSMC',
    country: 'TW',
  },
  {
    name: 'TSMC Arizona (Phoenix)',
    kind: 'logic',
    node: '4 nm',
    lat: 33.73,
    lon: -112.09,
    org: 'TSMC',
    country: 'US',
  },
  {
    name: 'TSMC AP7 advanced packaging (Chiayi)',
    kind: 'packaging',
    node: 'CoWoS',
    lat: 23.46,
    lon: 120.3,
    org: 'TSMC',
    country: 'TW',
  },
  {
    name: 'Samsung Pyeongtaek',
    kind: 'logic',
    node: '3–5 nm',
    lat: 37.05,
    lon: 127.05,
    org: 'Samsung',
    country: 'KR',
  },
  {
    name: 'Samsung Taylor (Texas)',
    kind: 'logic',
    node: '4 nm',
    lat: 30.57,
    lon: -97.41,
    org: 'Samsung',
    country: 'US',
  },
  {
    name: 'Intel Fab 52 (Ocotillo, AZ)',
    kind: 'logic',
    node: '18A',
    lat: 33.32,
    lon: -111.9,
    org: 'Intel',
    country: 'US',
  },
  {
    name: 'Intel Ohio (New Albany)',
    kind: 'logic',
    node: '18A (planned)',
    lat: 40.08,
    lon: -82.8,
    org: 'Intel',
    country: 'US',
  },
  {
    name: 'SK hynix M16 (Icheon)',
    kind: 'memory',
    node: 'HBM / DRAM',
    lat: 37.27,
    lon: 127.44,
    org: 'SK hynix',
    country: 'KR',
  },
  {
    name: 'Micron Fab (Taichung)',
    kind: 'memory',
    node: 'HBM / DRAM',
    lat: 24.22,
    lon: 120.62,
    org: 'Micron',
    country: 'TW',
  },
  {
    name: 'ASML (Veldhoven)',
    kind: 'equipment',
    node: 'EUV lithography',
    lat: 51.42,
    lon: 5.4,
    org: 'ASML',
    country: 'NL',
  },
  {
    name: 'Applied Materials (Santa Clara)',
    kind: 'equipment',
    node: 'deposition / etch',
    lat: 37.37,
    lon: -121.98,
    org: 'Applied Materials',
    country: 'US',
  },
  {
    name: 'Tokyo Electron (Tokyo)',
    kind: 'equipment',
    node: 'coater / etch',
    lat: 35.68,
    lon: 139.74,
    org: 'TEL',
    country: 'JP',
  },
];

export const MATERIALS = [
  {
    name: 'Spruce Pine high-purity quartz',
    material: 'quartz',
    role: 'fab crucibles',
    lat: 35.92,
    lon: -82.06,
    country: 'US',
    control: 'single-point dependency',
  },
  {
    name: 'Bayan Obo rare earths',
    material: 'rare earths',
    role: 'magnets (cooling, turbines)',
    lat: 41.77,
    lon: 109.97,
    country: 'CN',
    control: 'China export licensing',
  },
  {
    name: 'China gallium/germanium refining',
    material: 'gallium / germanium',
    role: 'chips',
    lat: 34.34,
    lon: 108.94,
    country: 'CN',
    control: 'China export controls',
  },
  {
    name: 'Escondida (copper)',
    material: 'copper',
    role: 'grid & cabling',
    lat: -24.27,
    lon: -69.07,
    country: 'CL',
    control: null,
  },
  {
    name: 'Salar de Atacama (lithium)',
    material: 'lithium',
    role: 'backup batteries',
    lat: -23.5,
    lon: -68.2,
    country: 'CL',
    control: null,
  },
  {
    name: 'DR Congo cobalt belt',
    material: 'cobalt',
    role: 'batteries',
    lat: -10.7,
    lon: 26.3,
    country: 'CD',
    control: 'concentrated supply',
  },
  {
    name: 'Cliffs / silicon metal (Appalachia)',
    material: 'silicon metal',
    role: 'polysilicon',
    lat: 37.8,
    lon: -80.0,
    country: 'US',
    control: null,
  },
  {
    name: 'Amur / helium (Russia)',
    material: 'helium',
    role: 'fab processes',
    lat: 49.6,
    lon: 129.0,
    country: 'RU',
    control: 'sanctioned',
  },
  {
    name: 'Cigar Lake (uranium)',
    material: 'uranium',
    role: 'nuclear PPAs',
    lat: 58.06,
    lon: -104.5,
    country: 'CA',
    control: null,
  },
];

// ── Prediction: a transparent siting-pressure score over a grid ────────────

/**
 * Score grid cells over a box for data-centre siting pressure, from the live
 * features on screen. This is a weighted heuristic, NOT a trained/backtested
 * model — it shows where the constraints line up, and its output must always
 * read as a prediction, never as a confirmed site. Returns cells with a 0..1
 * score and the features that drove each one.
 */
export function predictSiting({
  box,
  substations = [],
  dataCentres = [],
  fibre = [],
  cells = 12,
} = {}) {
  const [s, w, n, e] = box;
  const dLat = (n - s) / cells;
  const dLon = (e - w) / cells;
  const km = (aLat, aLon, bLat, bLon) => {
    const R = 6371;
    const p = Math.PI / 180;
    const dφ = (bLat - aLat) * p;
    const dλ = (bLon - aLon) * p;
    const h =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const near = (lat, lon, points, radiusKm) => {
    let best = Infinity;
    for (const p of points) {
      const d = km(lat, lon, p.lat, p.lon);
      if (d < best) best = d;
    }
    return best === Infinity ? 0 : Math.max(0, 1 - best / radiusKm);
  };
  const out = [];
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const lat = s + (i + 0.5) * dLat;
      const lon = w + (j + 0.5) * dLon;
      const power = near(lat, lon, substations, 60);
      const cluster = near(lat, lon, dataCentres, 40);
      const fiber = fibre.length ? near(lat, lon, fibre, 30) : 0.3;
      // Weights: power availability dominates siting today, then existing
      // agglomeration, then fibre. Absent a live fibre layer, fibre is a mild
      // neutral prior so it neither helps nor punishes.
      const score = 0.55 * power + 0.3 * cluster + 0.15 * fiber;
      if (score > 0.08)
        out.push({
          lat,
          lon,
          score: Math.round(score * 100) / 100,
          drivers: {
            power: round(power),
            cluster: round(cluster),
            fibre: round(fiber),
          },
          south: s + i * dLat,
          west: w + j * dLon,
          north: s + (i + 1) * dLat,
          east: w + (j + 1) * dLon,
        });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

// ── Linkages: the supply-chain graph (readable, not a target ranking) ──────

/**
 * Build edges material → fab → data centre and plant/substation/water →
 * data centre, each link tagged confirmed (co-located / same operator) or
 * inferred (nearest within a radius). This is a descriptive graph; it does
 * not score which shared asset to disable, by design.
 */
export function supplyLinks({
  dataCentres = [],
  substations = [],
  water = [],
  plants = [],
} = {}) {
  const km = (a, b) => {
    const R = 6371;
    const p = Math.PI / 180;
    const dφ = (b.lat - a.lat) * p;
    const dλ = (b.lon - a.lon) * p;
    const h =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const nearest = (dc, points, radiusKm) => {
    let best = null;
    let bestD = radiusKm;
    for (const p of points) {
      const d = km(dc, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { to: best, km: Math.round(bestD * 10) / 10 } : null;
  };
  const links = [];
  for (const dc of dataCentres) {
    const sub = nearest(dc, substations, 30);
    if (sub)
      links.push({
        kind: 'power',
        from: [dc.lon, dc.lat],
        to: [sub.to.lon, sub.to.lat],
        confidence: sub.km < 3 ? 'confirmed' : 'inferred',
        label: `${sub.to.kv ? `${sub.to.kv} kV substation` : 'substation'} · ${sub.km} km`,
      });
    const wat = nearest(dc, water, 25);
    if (wat)
      links.push({
        kind: 'water',
        from: [dc.lon, dc.lat],
        to: [wat.to.lon, wat.to.lat],
        confidence: wat.km < 4 ? 'confirmed' : 'inferred',
        label: `${WATER_KINDS[wat.to.kind]?.label || 'water'} · ${wat.km} km`,
      });
    const plant = nearest(dc, plants, 40);
    if (plant)
      links.push({
        kind: 'generation',
        from: [dc.lon, dc.lat],
        to: [plant.to.lon, plant.to.lat],
        confidence: plant.km < 3 ? 'confirmed' : 'inferred',
        label: `${plant.to.fuel} plant · ${plant.km} km`,
      });
  }
  return links;
}
