/**
 * Crime from open data. Street-level incidents where police forces and
 * cities publish them (UK Police, Chicago, New York, Los Angeles, San
 * Francisco) as a heat grid; intentional homicide rates by country (World
 * Bank, from UNODC); and where organized armed groups are reported active,
 * by region, from ACLED events — reported activity, not territory, and no
 * individuals.
 */

export const CITY_SOURCES = [
  {
    id: 'chicago',
    name: 'Chicago',
    lat: 41.8781,
    lon: -87.6298,
    radiusKm: 45,
    url: 'https://data.cityofchicago.org/resource/ijzp-q8t2.json',
    where: (lat, lon, m, since) =>
      `within_circle(location, ${lat}, ${lon}, ${m}) AND date > '${since}'`,
    fields: {
      category: 'primary_type',
      date: 'date',
      lat: 'latitude',
      lon: 'longitude',
    },
    credit: 'City of Chicago Data Portal',
  },
  {
    id: 'new-york',
    name: 'New York',
    lat: 40.7128,
    lon: -74.006,
    radiusKm: 45,
    url: 'https://data.cityofnewyork.us/resource/5uac-w243.json',
    where: (lat, lon, m, since) =>
      `within_circle(lat_lon, ${lat}, ${lon}, ${m}) AND cmplnt_fr_dt > '${since}'`,
    fields: {
      category: 'ofns_desc',
      date: 'cmplnt_fr_dt',
      lat: 'latitude',
      lon: 'longitude',
    },
    credit: 'NYC Open Data (NYPD complaints)',
  },
  {
    id: 'los-angeles',
    name: 'Los Angeles',
    lat: 34.0522,
    lon: -118.2437,
    radiusKm: 60,
    url: 'https://data.lacity.org/resource/2nrs-mtv8.json',
    where: (lat, lon, m, since) => {
      const d = m / 111_320;
      const e = d / Math.cos((lat * Math.PI) / 180);
      return `lat between ${(lat - d).toFixed(5)} and ${(lat + d).toFixed(5)} AND lon between ${(lon - e).toFixed(5)} and ${(lon + e).toFixed(5)} AND date_occ > '${since}'`;
    },
    fields: {
      category: 'crm_cd_desc',
      date: 'date_occ',
      lat: 'lat',
      lon: 'lon',
    },
    credit: 'LA City Open Data (LAPD)',
  },
  {
    id: 'san-francisco',
    name: 'San Francisco',
    lat: 37.7749,
    lon: -122.4194,
    radiusKm: 25,
    url: 'https://data.sfgov.org/resource/wg3w-h783.json',
    where: (lat, lon, m, since) =>
      `within_circle(point, ${lat}, ${lon}, ${m}) AND incident_datetime > '${since}'`,
    fields: {
      category: 'incident_category',
      date: 'incident_datetime',
      lat: 'latitude',
      lon: 'longitude',
    },
    credit: 'DataSF (SFPD incidents)',
  },
];

/** England, Wales and Northern Ireland (data.police.uk coverage). */
export function inUkPoliceArea(lat, lon) {
  return lat > 49.8 && lat < 55.9 && lon > -8.3 && lon < 1.9;
}

const R = 6371;
const dist = (aLat, aLon, bLat, bLon) => {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) *
      Math.cos(bLat * r) *
      Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Which open source covers a point: 'uk', a city id, or null. */
export function crimeSourceFor(lat, lon) {
  if (inUkPoliceArea(lat, lon)) return 'uk';
  const city = CITY_SOURCES.find(
    (c) => dist(lat, lon, c.lat, c.lon) <= c.radiusKm,
  );
  return city ? city.id : null;
}

export function normalizeUkCrimes(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      category: String(r.category || 'other').replace(/-/g, ' '),
      date: r.month || null,
      lat: Number(r.location?.latitude),
      lon: Number(r.location?.longitude),
      street: r.location?.street?.name || null,
      outcome: r.outcome_status?.category || null,
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

export function normalizeCityCrimes(rows, source) {
  const f = source.fields;
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      category: String(r[f.category] || 'other').toLowerCase(),
      date: r[f.date] ? String(r[f.date]).slice(0, 10) : null,
      lat: Number(r[f.lat]),
      lon: Number(r[f.lon]),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        r.lat !== 0 &&
        r.lon !== 0,
    );
}

/** Incidents → grid cells (cellM metres) with counts, hottest first. */
export function crimeGrid(incidents, { cellM = 250 } = {}) {
  if (!incidents.length) return [];
  const lat0 = incidents[0].lat;
  const dLat = cellM / 111_320;
  const dLon = dLat / Math.max(0.1, Math.cos((lat0 * Math.PI) / 180));
  const cells = new Map();
  for (const i of incidents) {
    const y = Math.floor(i.lat / dLat);
    const x = Math.floor(i.lon / dLon);
    const key = `${y},${x}`;
    const c = cells.get(key) || {
      south: y * dLat,
      west: x * dLon,
      north: (y + 1) * dLat,
      east: (x + 1) * dLon,
      count: 0,
      categories: {},
    };
    c.count += 1;
    c.categories[i.category] = (c.categories[i.category] || 0) + 1;
    cells.set(key, c);
  }
  const list = [...cells.values()].sort((a, b) => b.count - a.count);
  const max = list[0].count;
  return list.map((c) => ({ ...c, intensity: c.count / max }));
}

export function categoryBreakdown(incidents, limit = 12) {
  const by = {};
  for (const i of incidents) by[i.category] = (by[i.category] || 0) + 1;
  return Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([category, count]) => ({
      category,
      count,
      share: Math.round((count / incidents.length) * 1000) / 10,
    }));
}

/** Heat colour for 0..1 (dark amber → red → white-hot). */
export function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.5) return [255, Math.round(140 + (60 - 140) * (x / 0.5)), 0];
  return [
    255,
    Math.round(60 + (255 - 60) * ((x - 0.5) / 0.5)),
    Math.round(255 * ((x - 0.5) / 0.5)),
  ];
}

/** World Bank indicator rows → { iso3: {rate, year, name} }. */
export function normalizeHomicideRates(body) {
  const rows = Array.isArray(body) ? body[1] : null;
  const out = {};
  for (const r of rows || []) {
    const iso3 = r.countryiso3code;
    if (!/^[A-Z]{3}$/.test(iso3 || '') || r.value == null) continue;
    out[iso3] = {
      rate: Math.round(r.value * 10) / 10,
      year: Number(r.date) || null,
      name: r.country?.value || iso3,
    };
  }
  return out;
}

export const ORG_CRIME =
  /(cartel|\bgang|\bmaras?\b|ms-13|barrio 18|clan del golfo|tren de aragua|primeiro comando|comando vermelho|familia michoacana|zetas|mafia|ndrangheta|camorra|cosa nostra|yakuza|triad|crime group|criminal group|criminal organi[sz]ation|bandits?\b|pandilla|syndicate|narco)/i;

function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (const q of p.slice().reverse()) {
    while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * ACLED features → organized armed groups: where each is reported active
 * (regions with counts, an activity outline around its events), events,
 * fatalities, last report. Unnamed ("unidentified gang") actors are pooled.
 */
export function organizedCrimeActivity(fc) {
  const groups = new Map();
  for (const f of fc?.features || []) {
    const p = f.properties || {};
    for (const actor of [p.actor1, p.actor2]) {
      if (!actor || !ORG_CRIME.test(actor)) continue;
      const name = actor.replace(/\s*\([^)]*\)\s*$/, '').trim();
      const g = groups.get(name) || {
        name,
        events: 0,
        fatalities: 0,
        regions: {},
        points: [],
        last: null,
      };
      g.events += 1;
      g.fatalities += p.fatalities || 0;
      const region =
        String(p.place || '')
          .split(', ')
          .slice(-2)
          .join(', ') || 'unspecified';
      g.regions[region] = (g.regions[region] || 0) + 1;
      g.points.push(f.geometry.coordinates);
      if (!g.last || String(p.date) > g.last) g.last = p.date;
      groups.set(name, g);
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.events - a.events)
    .map((g) => ({
      name: g.name,
      events: g.events,
      fatalities: g.fatalities,
      lastReported: g.last,
      regions: Object.entries(g.regions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([region, events]) => ({ region, events })),
      area: g.points.length >= 3 ? hull(g.points) : null,
      points: g.points.slice(0, 400),
    }));
}
