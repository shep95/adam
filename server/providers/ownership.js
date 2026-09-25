/**
 * Who owns and operates a country's infrastructure, from Wikidata.
 *
 *   GET /api/ownership?country=FR&kind=ports|airports|power|dams|refineries
 *
 * Returns GeoJSON points with owner and operator, each classified as state
 * (government, agency, state-owned enterprise, sovereign fund), foreign
 * (headquartered in another country) or private. Owners and operators that
 * are people are excluded in the query itself: this maps institutions, not
 * individuals. 12-hour cache per country and kind.
 */
import { makeRateLimiter } from './common/rate-limit.js';

const SPARQL = 'https://query.wikidata.org/sparql';
const UA = 'ADAM/1 (infrastructure ownership; https://github.com/shep95/adam)';
const CACHE_MS = 12 * 3600_000;

/** Wikidata classes per kind; instance-of these or a direct subclass. */
export const OWNERSHIP_KINDS = {
  ports: ['Q44782', 'Q283202'], // port, harbour
  airports: ['Q1248784', 'Q644371'], // airport, international airport
  power: ['Q159719', 'Q134447', 'Q15911738', 'Q194356'], // power station, nuclear, hydro, wind farm
  dams: ['Q12323'],
  refineries: ['Q235356'],
};

/** Owner classes that mean "the state". */
const STATE_CLASSES = [
  'Q7188', // government
  'Q327333', // government agency
  'Q270791', // state-owned enterprise
  'Q3624078', // sovereign state
  'Q6256', // country
  'Q1411191', // sovereign wealth fund
  'Q2659904', // government organisation
  'Q192350', // ministry
];

export function ownershipQuery(iso2, kind, limit = 600) {
  const classes = OWNERSHIP_KINDS[kind] || OWNERSHIP_KINDS.ports;
  const stateValues = STATE_CLASSES.map((q) => `wd:${q}`).join(' ');
  const party = (v) => `
  OPTIONAL {
    ?item wdt:${v === 'owner' ? 'P127' : 'P137'} ?${v} .
    FILTER NOT EXISTS { ?${v} wdt:P31 wd:Q5 }
    OPTIONAL { ?${v} wdt:P17 ?${v}C . ?${v}C wdt:P297 ?${v}Country . }
    BIND(EXISTS { VALUES ?sc { ${stateValues} } ?${v} wdt:P31/wdt:P279? ?sc } AS ?${v}State)
  }`;
  return `SELECT ?item ?itemLabel ?coord ?owner ?ownerLabel ?ownerCountry ?ownerState ?operator ?operatorLabel ?operatorCountry ?operatorState WHERE {
  ?country wdt:P297 "${iso2}" .
  VALUES ?class { ${classes.map((q) => `wd:${q}`).join(' ')} }
  ?item wdt:P31/wdt:P279? ?class ; wdt:P17 ?country ; wdt:P625 ?coord .${party('owner')}${party('operator')}
  FILTER(BOUND(?owner) || BOUND(?operator))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${limit}`;
}

const qid = (uri) =>
  String(uri || '')
    .split('/')
    .pop() || null;
const val = (b, k) => b?.[k]?.value ?? null;

export function parsePoint(wkt) {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(String(wkt || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Classify a party relative to the site's country. */
export function partyClass({ state, country }, siteCountry) {
  if (state && (!country || country === siteCountry)) return 'state';
  if (state) return 'foreign-state';
  if (country && country !== siteCountry) return 'foreign';
  return 'private';
}

export function normalizeOwnership(body, iso2) {
  const byItem = new Map();
  for (const b of body?.results?.bindings || []) {
    const id = qid(val(b, 'item'));
    const coords = parsePoint(val(b, 'coord'));
    if (!id || !coords) continue;
    if (!byItem.has(id))
      byItem.set(id, {
        id,
        name: val(b, 'itemLabel'),
        coords,
        owners: new Map(),
        operators: new Map(),
      });
    const it = byItem.get(id);
    for (const [role, map] of [
      ['owner', it.owners],
      ['operator', it.operators],
    ]) {
      const pid = qid(val(b, role));
      if (!pid || map.has(pid)) continue;
      const party = {
        id: pid,
        name: val(b, `${role}Label`),
        country: val(b, `${role}Country`),
        state: val(b, `${role}State`) === 'true',
      };
      party.class = partyClass(party, iso2);
      map.set(pid, party);
    }
  }
  const rank = { 'foreign-state': 4, foreign: 3, state: 2, private: 1 };
  const features = [];
  for (const it of byItem.values()) {
    const owners = [...it.owners.values()];
    const operators = [...it.operators.values()];
    const parties = owners.length ? owners : operators;
    const control = parties.reduce(
      (best, p) => (rank[p.class] > rank[best] ? p.class : best),
      'private',
    );
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: it.coords },
      properties: {
        id: it.id,
        name: /^Q\d+$/.test(it.name || '') ? null : it.name,
        control,
        owners:
          owners
            .map(
              (p) =>
                `${p.name}${p.country && p.country !== iso2 ? ` (${p.country})` : ''}`,
            )
            .join('; ') || null,
        operators:
          operators
            .map(
              (p) =>
                `${p.name}${p.country && p.country !== iso2 ? ` (${p.country})` : ''}`,
            )
            .join('; ') || null,
        ownerCountries: [
          ...new Set(parties.map((p) => p.country).filter(Boolean)),
        ],
        wikidata: `https://www.wikidata.org/wiki/${it.id}`,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function summarizeOwnership(fc, iso2) {
  const byControl = { state: 0, 'foreign-state': 0, foreign: 0, private: 0 };
  const byOwnerCountry = {};
  const parties = {};
  for (const f of fc.features) {
    const p = f.properties;
    byControl[p.control] += 1;
    for (const c of p.ownerCountries)
      if (c !== iso2) byOwnerCountry[c] = (byOwnerCountry[c] || 0) + 1;
    for (const name of String(p.owners || p.operators || '')
      .split('; ')
      .filter(Boolean))
      parties[name] = (parties[name] || 0) + 1;
  }
  const topParties = Object.entries(parties)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, sites]) => ({ name, sites }));
  return { sites: fc.features.length, byControl, byOwnerCountry, topParties };
}

export function ownershipProxy({
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 12, globalMax: 60 });

  function install(middlewares) {
    middlewares.use('/api/ownership', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const iso2 = String(url.searchParams.get('country') || '').toUpperCase();
      const kind = String(url.searchParams.get('kind') || 'ports');
      const reply = (status, payload) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      };
      if (!/^[A-Z]{2}$/.test(iso2))
        return reply(400, { error: 'country must be an ISO alpha-2 code' });
      if (!OWNERSHIP_KINDS[kind])
        return reply(400, {
          error: `kind is one of ${Object.keys(OWNERSHIP_KINDS).join(', ')}`,
        });
      const key = `${iso2}:${kind}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_MS) return reply(200, hit.value);
      if (!limit('ownership')) return reply(429, { error: 'rate limited' });
      try {
        const r = await fetchImpl(SPARQL, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            Accept: 'application/sparql-results+json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ query: ownershipQuery(iso2, kind) }),
          signal: AbortSignal.timeout(55_000),
        });
        if (!r.ok) throw new Error(`upstream ${r.status}`);
        const fc = normalizeOwnership(await r.json(), iso2);
        const value = {
          ...fc,
          country: iso2,
          kind,
          summary: summarizeOwnership(fc, iso2),
          source:
            'Wikidata (CC0) — coverage depends on what editors have recorded',
        };
        cache.set(key, { at: now(), value });
        if (cache.size > 300) cache.delete(cache.keys().next().value);
        return reply(200, value);
      } catch (error) {
        return reply(502, {
          error: `ownership lookup failed (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-ownership',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
