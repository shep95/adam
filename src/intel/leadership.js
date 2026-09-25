/**
 * Who holds public office over a place: the chain of administrative areas
 * that contain a point (country → state/province → county → municipality,
 * from OpenStreetMap boundaries) and each one's current head of state and
 * head of government, office title, party and start date (Wikidata).
 *
 * Public office only: names, titles and terms as published. Nothing here
 * locates, follows or predicts where any officeholder is.
 */

/** Overpass: every administrative area containing a point. */
export function adminAreasQuery(lat, lon) {
  return `[out:json][timeout:25];is_in(${lat.toFixed(5)},${lon.toFixed(5)})->.a;area.a["boundary"="administrative"]["admin_level"];out tags;`;
}

const LEVEL_NAMES = {
  2: 'nation',
  3: 'region',
  4: 'state / province',
  5: 'region',
  6: 'county / district',
  7: 'district',
  8: 'municipality',
  9: 'borough',
  10: 'ward',
};

export function levelName(level) {
  return LEVEL_NAMES[level] || `level ${level}`;
}

/** Overpass areas → [{level, levelName, name, wikidata}] from nation down. */
export function normalizeAdminChain(json, { maxLevel = 8 } = {}) {
  const byLevel = new Map();
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const level = Number(t.admin_level);
    if (!Number.isFinite(level) || level < 2 || level > maxLevel) continue;
    if (!/^Q\d+$/.test(t.wikidata || '')) continue;
    // One area per level; prefer the one with an English name.
    if (byLevel.has(level) && !t['name:en']) continue;
    byLevel.set(level, {
      level,
      levelName: levelName(level),
      name: t['name:en'] || t.name || t.wikidata,
      localName: t.name || null,
      wikidata: t.wikidata,
    });
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

const ROLE_PROPS = [
  ['head of state', 'P35', 'P1906'],
  ['head of government', 'P6', 'P1313'],
];

/** SPARQL: current heads of state and government for a set of areas. */
export function officeholdersQuery(ids) {
  const values = ids.map((q) => `wd:${q}`).join(' ');
  const branches = ROLE_PROPS.map(
    ([role, p, office]) => `{
    ?area p:${p} ?st . ?st ps:${p} ?person .
    BIND("${role}" AS ?role)
    OPTIONAL { ?area wdt:${office} ?office }
  }`,
  ).join(' UNION ');
  return `SELECT ?area ?role ?person ?personLabel ?officeLabel ?start ?partyLabel ?legislatureLabel WHERE {
  VALUES ?area { ${values} }
  ${branches}
  ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
  FILTER NOT EXISTS { ?st pq:P582 ?end }
  OPTIONAL { ?st pq:P580 ?start }
  OPTIONAL { ?person wdt:P102 ?party }
  OPTIONAL { ?area wdt:P194 ?legislature }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} LIMIT 300`;
}

/** SPARQL: an area's direct subdivisions and their heads of government. */
export function subdivisionsQuery(id) {
  return `SELECT ?sub ?subLabel ?coord ?person ?personLabel ?officeLabel ?start ?partyLabel WHERE {
  wd:${id} wdt:P150 ?sub .
  FILTER NOT EXISTS { ?sub wdt:P576 ?dissolved }
  OPTIONAL { ?sub wdt:P625 ?coord }
  OPTIONAL {
    ?sub p:P6 ?st . ?st ps:P6 ?person .
    ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
    FILTER NOT EXISTS { ?st pq:P582 ?end }
    OPTIONAL { ?st pq:P580 ?start }
    OPTIONAL { ?person wdt:P102 ?party }
  }
  OPTIONAL { ?sub wdt:P1313 ?office }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
} LIMIT 600`;
}

const qid = (uri) =>
  String(uri || '')
    .split('/')
    .pop() || null;
const val = (b, k) => b?.[k]?.value ?? null;
const cleanLabel = (s) => (s && !/^Q\d+$/.test(s) ? s : null);
const day = (s) => (s ? String(s).slice(0, 10).replace(/^\+/, '') : null);

export function parsePoint(wkt) {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(String(wkt || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function addHolder(list, h) {
  const same = list.find((x) => x.id === h.id && x.role === h.role);
  if (!same) return list.push({ ...h, parties: h.party ? [h.party] : [] });
  if (h.party && !same.parties.includes(h.party)) same.parties.push(h.party);
  if (h.start && (!same.start || h.start > same.start)) same.start = h.start;
}

/**
 * Officeholder rows → { Qarea: {legislature, holders:[{role, name, office,
 * parties, start}]} }. When several people hold a role without an end date
 * (stale data), the most recent start wins and the rest are dropped.
 */
export function normalizeOfficeholders(body) {
  const out = {};
  for (const b of body?.results?.bindings || []) {
    const area = qid(val(b, 'area'));
    const id = qid(val(b, 'person'));
    if (!area || !id) continue;
    const entry = (out[area] ??= { legislature: null, holders: [] });
    entry.legislature ||= cleanLabel(val(b, 'legislatureLabel'));
    addHolder(entry.holders, {
      id,
      role: val(b, 'role'),
      name: cleanLabel(val(b, 'personLabel')) || id,
      office: cleanLabel(val(b, 'officeLabel')),
      party: cleanLabel(val(b, 'partyLabel')),
      start: day(val(b, 'start')),
    });
  }
  for (const entry of Object.values(out)) {
    const latest = new Map();
    for (const h of entry.holders) {
      const cur = latest.get(h.role);
      if (!cur || (h.start || '') > (cur.start || '')) latest.set(h.role, h);
    }
    entry.holders = ['head of state', 'head of government']
      .map((r) => latest.get(r))
      .filter(Boolean);
    // Same person in both roles (presidential systems): one line.
    const [a, b] = entry.holders;
    if (a && b && a.id === b.id) {
      entry.holders = [{ ...a, role: 'head of state and government' }];
    }
  }
  return out;
}

export function normalizeSubdivisions(body) {
  const bySub = new Map();
  for (const b of body?.results?.bindings || []) {
    const id = qid(val(b, 'sub'));
    if (!id) continue;
    const name = cleanLabel(val(b, 'subLabel'));
    if (!name) continue;
    if (!bySub.has(id))
      bySub.set(id, {
        id,
        name,
        coords: parsePoint(val(b, 'coord')),
        office: cleanLabel(val(b, 'officeLabel')),
        holders: [],
      });
    const s = bySub.get(id);
    const pid = qid(val(b, 'person'));
    if (pid)
      addHolder(s.holders, {
        id: pid,
        role: 'head of government',
        name: cleanLabel(val(b, 'personLabel')) || pid,
        office: s.office,
        party: cleanLabel(val(b, 'partyLabel')),
        start: day(val(b, 'start')),
      });
  }
  const subs = [...bySub.values()].map((s) => {
    const latest = s.holders.sort((x, y) =>
      (y.start || '').localeCompare(x.start || ''),
    )[0];
    return { ...s, holder: latest || null, holders: undefined };
  });
  return subs.sort((a, b) => a.name.localeCompare(b.name));
}

export const QID_RE = /^Q\d{1,10}$/;
