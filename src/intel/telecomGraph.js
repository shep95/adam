/**
 * Telecom dependency graph from public data: which submarine cables land in
 * a country, at which stations, which countries each cable reaches, and the
 * internet exchanges inside it (PeeringDB). Built from the bundled
 * TeleGeography cable and landing-point files, so it works offline.
 *
 * It describes connectivity — counts, lists and links — the way
 * TeleGeography and PeeringDB publish it. It does not score or rank
 * individual sites by how much would break without them.
 */

const EARTH_R_KM = 6371;

/** TeleGeography country names that differ from the nations file. */
const COUNTRY_ALIASES = {
  'ascension and tristan da cunha': 'SH',
  'congo, dem. rep.': 'CD',
  'congo, rep.': 'CG',
  "cote d'ivoire": 'CI',
  'sint eustatius and saba': 'BQ',
  turkey: 'TR',
  'virgin islands (u.k.)': 'VG',
  'virgin islands (u.s.)': 'VI',
};

export function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** "Kinshasa, Congo, Dem. Rep." → "Congo, Dem. Rep."; "Nybor, Denmark" → "Denmark". */
export function landingCountry(name) {
  const parts = String(name || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return '';
  const last = parts.at(-1);
  if ((last === 'Dem. Rep.' || last === 'Rep.') && parts.length >= 2)
    return `${parts.at(-2)}, ${last}`;
  return last;
}

/** Map a TeleGeography country name to ISO 3166 alpha-2 using the nations list. */
export function makeCountryResolver(nations = []) {
  const byName = new Map();
  for (const n of nations) {
    if (!n?.a2) continue;
    byName.set(normName(n.n), n.a2);
    if (n.o) byName.set(normName(n.o), n.a2);
  }
  return (name) => {
    const key = normName(name);
    return COUNTRY_ALIASES[key] || byName.get(key) || null;
  };
}

function distanceKm(lon1, lat1, lon2, lat2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lineParts(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * Join cables to landing points by segment endpoints (within radiusKm).
 * @returns {{ landings: Map<string, object>, cables: Map<string, object> }}
 */
export function buildTelecomGraph(
  cableFc,
  landingFc,
  { nations = [], radiusKm = 15 } = {},
) {
  const resolve = makeCountryResolver(nations);
  const landings = new Map();
  const grid = new Map();
  const cell = (lon, lat) => `${Math.floor(lon)},${Math.floor(lat)}`;
  for (const f of landingFc?.features || []) {
    const [lon, lat] = f?.geometry?.coordinates || [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const id = String(f.properties?.id || '');
    const countryName = landingCountry(f.properties?.name);
    const landing = {
      id,
      name: String(f.properties?.name || id),
      countryName,
      country: resolve(countryName),
      lon,
      lat,
      cables: new Set(),
    };
    landings.set(id, landing);
    const key = cell(lon, lat);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(landing);
  }
  const nearest = (lon, lat) => {
    let best = null;
    let bestD = radiusKm;
    const cx = Math.floor(lon);
    const cy = Math.floor(lat);
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (const l of grid.get(`${cx + dx},${cy + dy}`) || []) {
          const d = distanceKm(lon, lat, l.lon, l.lat);
          if (d <= bestD) {
            bestD = d;
            best = l;
          }
        }
    return best;
  };
  const cables = new Map();
  for (const f of cableFc?.features || []) {
    const id = String(f.properties?.id || f.id || '');
    if (!id) continue;
    if (!cables.has(id))
      cables.set(id, {
        id,
        name: String(f.properties?.name || id),
        landings: new Set(),
        countries: new Set(),
      });
    const cable = cables.get(id);
    for (const part of lineParts(f.geometry)) {
      if (!Array.isArray(part) || part.length < 2) continue;
      for (const p of [part[0], part.at(-1)]) {
        if (!Number.isFinite(p?.[0]) || !Number.isFinite(p?.[1])) continue;
        const l = nearest(p[0], p[1]);
        if (!l) continue;
        cable.landings.add(l.id);
        l.cables.add(id);
        if (l.country) cable.countries.add(l.country);
      }
    }
  }
  return { landings, cables };
}

/**
 * One country's international connectivity.
 * @param {{landings: Map, cables: Map}} graph
 * @param {string} a2 ISO alpha-2
 * @param {{ixps?: Array<{tags:{country:string,name:string,networks:number|null,city:string}}>, nameOf?: (a2:string)=>string}} [extra]
 */
export function countryConnectivity(
  graph,
  a2,
  { ixps = [], nameOf = (c) => c } = {},
) {
  const code = String(a2 || '').toUpperCase();
  const stations = [...graph.landings.values()].filter(
    (l) => l.country === code,
  );
  const cableIds = new Set(stations.flatMap((l) => [...l.cables]));
  const cables = [...cableIds]
    .map((id) => graph.cables.get(id))
    .filter(Boolean)
    .map((c) => ({
      id: c.id,
      name: c.name,
      reaches: [...c.countries].filter((x) => x !== code).sort(),
      landsAt: [...c.landings]
        .map((id) => graph.landings.get(id))
        .filter((l) => l?.country === code)
        .map((l) => l.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const neighbourCount = new Map();
  for (const c of cables)
    for (const n of c.reaches)
      neighbourCount.set(n, (neighbourCount.get(n) || 0) + 1);
  const neighbours = [...neighbourCount.entries()]
    .map(([country, count]) => ({
      country,
      name: nameOf(country),
      cables: count,
    }))
    .sort((a, b) => b.cables - a.cables || a.name.localeCompare(b.name));
  const exchanges = (ixps || [])
    .filter((ix) => String(ix?.tags?.country || '').toUpperCase() === code)
    .map((ix) => ({
      name: ix.tags.name,
      city: ix.tags.city || null,
      networks: ix.tags.networks ?? null,
      lon: ix.coords?.[0],
      lat: ix.coords?.[1],
    }))
    .sort((a, b) => (b.networks || 0) - (a.networks || 0));
  return {
    country: code,
    name: nameOf(code),
    summary: {
      cables: cables.length,
      landingStations: stations.length,
      directlyLinkedCountries: neighbours.length,
      internetExchanges: exchanges.length,
    },
    stations: stations
      .map((l) => ({
        id: l.id,
        name: l.name,
        lat: l.lat,
        lon: l.lon,
        cables: l.cables.size,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    cables,
    neighbours,
    exchanges,
    sources: 'TeleGeography Submarine Cable Map (CC BY-NC-SA), PeeringDB',
  };
}
