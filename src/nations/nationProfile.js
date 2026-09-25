/**
 * Nation profiles: who a state is (from the bundled world-countries extract)
 * and where its institutions and infrastructure sit (OpenStreetMap through
 * the Overpass proxy, and ADAM's own infrastructure layers).
 *
 * Institutions, not individuals: legislatures, executive offices,
 * ministries, courts, embassies. Nothing here locates a person.
 */

let nationsPromise = null;

/** @returns {Promise<Array<object>>} */
export function loadNations() {
  nationsPromise ??= import('../data/local_data/nations/nations.json').then(
    (m) => m.default || m,
  );
  return nationsPromise;
}

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Everyday names that the ISO/common names do not match first. */
export const NATION_ALIASES = Object.freeze({
  uk: 'GBR',
  'united kingdom': 'GBR',
  britain: 'GBR',
  'great britain': 'GBR',
  england: 'GBR',
  scotland: 'GBR',
  wales: 'GBR',
  us: 'USA',
  usa: 'USA',
  america: 'USA',
  'united states of america': 'USA',
  korea: 'KOR',
  'south korea': 'KOR',
  'north korea': 'PRK',
  dprk: 'PRK',
  russia: 'RUS',
  uae: 'ARE',
  emirates: 'ARE',
  drc: 'COD',
  'dr congo': 'COD',
  congo: 'COG',
  holland: 'NLD',
  'the netherlands': 'NLD',
  turkey: 'TUR',
  turkiye: 'TUR',
  'ivory coast': 'CIV',
  burma: 'MMR',
  persia: 'IRN',
  'czech republic': 'CZE',
  vatican: 'VAT',
  taiwan: 'TWN',
  prc: 'CHN',
  ksa: 'SAU',
});

/** Best nation for a free-text query (name, official name, ISO code). */
export function findNation(nations, query) {
  const q = norm(query);
  if (!q) return null;
  const up = String(query).trim().toUpperCase();
  const alias = NATION_ALIASES[q];
  if (alias) return nations.find((n) => n.a3 === alias) || null;
  let best = null;
  for (const n of nations) {
    let score = 0;
    if (up === n.a3 || up === n.a2) score = 100;
    else if (norm(n.n) === q) score = 90;
    else if (norm(n.o) === q) score = 85;
    else if (norm(n.n).startsWith(q)) score = 60 + q.length;
    else if (norm(n.o).includes(q)) score = 40 + q.length;
    else if (norm(n.n).includes(q)) score = 30 + q.length;
    if (score > (best?.score || 0)) best = { score, nation: n };
  }
  return best?.nation || null;
}

/** Institutions around a capital, bounded to a radius (metres). */
export function governmentQuery(lat, lon, radiusM = 7000) {
  const r = Math.max(1000, Math.min(20_000, Math.round(radiusM)));
  const at = `around:${r},${lat.toFixed(5)},${lon.toFixed(5)}`;
  return `[out:json][timeout:25];(
nwr["government"](${at});
nwr["office"="government"](${at});
nwr["office"="diplomatic"](${at});
nwr["amenity"="embassy"](${at});
nwr["building"="government"]["name"](${at});
nwr["building"="parliament"](${at});
nwr["amenity"="courthouse"]["name"](${at});
);out center 600;`;
}

const KIND_RULES = [
  [
    'legislature',
    (t) =>
      t.government === 'legislative' ||
      t.building === 'parliament' ||
      /parliament|congress|senate|assembly|duma|bundestag|knesset|diet/i.test(
        t.name || '',
      ),
  ],
  [
    'executive',
    (t) =>
      ['presidency', 'prime_minister', 'executive'].includes(t.government) ||
      /presiden|prime minister|chancellery|white house|élysée|kremlin/i.test(
        t.name || '',
      ),
  ],
  [
    'judiciary',
    (t) =>
      t.amenity === 'courthouse' ||
      t.government === 'judiciary' ||
      /supreme court|constitutional court/i.test(t.name || ''),
  ],
  ['embassy', (t) => t.amenity === 'embassy' || t.office === 'diplomatic'],
  [
    'ministry',
    (t) =>
      t.government === 'ministry' ||
      /ministry|ministère|ministerio|ministerium|department of/i.test(
        t.name || '',
      ),
  ],
  [
    'defence',
    (t) =>
      /defen[cs]e|military|armed forces/i.test(
        `${t.name || ''} ${t.government || ''}`,
      ),
  ],
];

export function institutionKind(tags = {}) {
  for (const [kind, test] of KIND_RULES) if (test(tags)) return kind;
  return 'government office';
}

/** Overpass payload → overlay nodes (named features only, deduplicated). */
export function institutionsFromOverpass(json, { limit = 160 } = {}) {
  const seen = new Set();
  const out = [];
  for (const el of json?.elements || []) {
    const tags = el.tags || {};
    const name = tags['name:en'] || tags.name;
    if (!name) continue;
    const lat = Number(el.lat ?? el.center?.lat);
    const lon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = institutionKind(tags);
    out.push({
      id: `osm-${el.type}-${el.id}`,
      label: name.slice(0, 80),
      lat,
      lon,
      kind,
      confidence: kind === 'government office' ? 0.6 : 0.85,
      note: [
        kind,
        tags.country ? `country ${tags.country}` : '',
        tags.website || '',
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  const order = [
    'legislature',
    'executive',
    'judiciary',
    'ministry',
    'defence',
    'embassy',
    'government office',
  ];
  return out
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .slice(0, limit);
}

/** ADAM layers that together read as a national infrastructure picture. */
export const NATIONAL_INFRASTRUCTURE_LAYERS = Object.freeze([
  'military-installations',
  'infra-power-lines',
  'infra-pipelines',
  'infra-border-crossings',
  'infra-ixps',
  'infra-chokepoints',
  'telegeography-submarine-cables',
  'local-datacenters',
  'local-dams',
  'airspace-firs',
  'maritime-zones',
]);

/** Compact text profile for Shepherd and the card. */
export function describeNation(n) {
  return {
    name: n.n,
    official: n.o,
    iso3: n.a3,
    capital: n.cap.join(', ') || null,
    region: [n.r, n.sr].filter(Boolean).join(' · '),
    areaKm2: n.km2,
    landBorders: n.b,
    landlocked: Boolean(n.ll2),
    unMember: n.un,
    independent: n.ind,
    centroid: { lat: n.ll?.[0], lon: n.ll?.[1] },
  };
}
