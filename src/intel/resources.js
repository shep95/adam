/**
 * Natural wealth by country and the sites that produce it.
 *
 * Rankings come from World Bank indicators: resource rents (the value of a
 * resource above what it costs to extract) for oil, gas, coal, minerals and
 * forests, turned into dollars with GDP; national reserves (gold holdings as
 * total reserves minus reserves excluding gold, and foreign exchange);
 * renewable freshwater and arable land. Sites in view come from
 * OpenStreetMap: mines and quarries, oil and gas wells, refineries, LNG
 * terminals, storage and power plants.
 */

export const RESOURCE_TYPES = [
  {
    id: 'total',
    label: 'all natural resources',
    unit: 'usd',
    rent: 'NY.GDP.TOTL.RT.ZS',
  },
  { id: 'oil', label: 'oil', unit: 'usd', rent: 'NY.GDP.PETR.RT.ZS' },
  { id: 'gas', label: 'natural gas', unit: 'usd', rent: 'NY.GDP.NGAS.RT.ZS' },
  { id: 'coal', label: 'coal', unit: 'usd', rent: 'NY.GDP.COAL.RT.ZS' },
  {
    id: 'minerals',
    label: 'minerals & metals',
    unit: 'usd',
    rent: 'NY.GDP.MINR.RT.ZS',
  },
  { id: 'forest', label: 'forests', unit: 'usd', rent: 'NY.GDP.FRST.RT.ZS' },
  {
    id: 'gold',
    label: 'gold reserves (value)',
    unit: 'usd',
    total: 'FI.RES.TOTL.CD',
    exGold: 'FI.RES.XGLD.CD',
  },
  {
    id: 'fx',
    label: 'foreign exchange reserves',
    unit: 'usd',
    indicator: 'FI.RES.XGLD.CD',
  },
  {
    id: 'water',
    label: 'renewable freshwater',
    unit: 'km3',
    indicator: 'ER.H2O.INTR.K3',
  },
  {
    id: 'arable',
    label: 'arable land',
    unit: 'ha',
    indicator: 'AG.LND.ARBL.HA',
  },
];

export const GDP = 'NY.GDP.MKTP.CD';

export function resourceType(id) {
  return RESOURCE_TYPES.find((r) => r.id === id) || RESOURCE_TYPES[0];
}

/** Indicators a resource type needs. */
export function indicatorsFor(type) {
  const t = resourceType(type);
  if (t.rent) return [t.rent, GDP];
  if (t.total) return [t.total, t.exGold];
  return [t.indicator];
}

export function wbUrl(indicator) {
  return `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&mrnev=1&per_page=400`;
}

/** World Bank rows → { iso3: {value, year, name} } (countries only). */
export function wbValues(body) {
  const out = {};
  for (const r of (Array.isArray(body) ? body[1] : null) || []) {
    const iso3 = r.countryiso3code;
    // Aggregates (World, regions, income groups) have no ISO3 or known codes.
    if (
      !/^[A-Z]{3}$/.test(iso3 || '') ||
      r.value == null ||
      !r.country?.id ||
      /^\d/.test(r.country.id)
    )
      continue;
    out[iso3] = {
      value: Number(r.value),
      year: Number(r.date) || null,
      name: r.country?.value || iso3,
    };
  }
  return out;
}

/** Compute the ranking for one resource type from fetched indicator maps. */
export function rankResource(
  type,
  maps,
  { isCountry = () => true, limit = 25 } = {},
) {
  const t = resourceType(type);
  const rows = [];
  if (t.rent) {
    const rent = maps[t.rent] || {};
    const gdp = maps[GDP] || {};
    for (const [iso3, r] of Object.entries(rent)) {
      const g = gdp[iso3];
      if (!g || !isCountry(iso3) || !(r.value > 0)) continue;
      rows.push({
        iso3,
        name: r.name,
        value: (r.value / 100) * g.value,
        share: Math.round(r.value * 10) / 10,
        year: r.year,
      });
    }
  } else if (t.total) {
    const total = maps[t.total] || {};
    const ex = maps[t.exGold] || {};
    for (const [iso3, r] of Object.entries(total)) {
      const x = ex[iso3];
      if (!x || !isCountry(iso3)) continue;
      const gold = r.value - x.value;
      if (gold > 0)
        rows.push({ iso3, name: r.name, value: gold, year: r.year });
    }
  } else {
    for (const [iso3, r] of Object.entries(maps[t.indicator] || {})) {
      if (isCountry(iso3) && r.value > 0)
        rows.push({ iso3, name: r.name, value: r.value, year: r.year });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  const total = rows.reduce((s, r) => s + r.value, 0);
  return {
    type: t.id,
    label: t.label,
    unit: t.unit,
    total,
    rows: rows
      .slice(0, limit)
      .map((r, i) => ({
        ...r,
        rank: i + 1,
        worldShare: total ? Math.round((r.value / total) * 1000) / 10 : 0,
      })),
    count: rows.length,
  };
}

export function formatValue(v, unit) {
  if (!Number.isFinite(v)) return '—';
  if (unit === 'usd') {
    if (v >= 1e12) return `$${(v / 1e12).toFixed(2)} trillion`;
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)} billion`;
    return `$${(v / 1e6).toFixed(0)} million`;
  }
  if (unit === 'km3')
    return `${Math.round(v).toLocaleString('en-US')} km³ a year`;
  if (unit === 'ha') return `${(v / 1e6).toFixed(1)} million ha`;
  return String(v);
}

// ── Sites from OpenStreetMap ───────────────────────────────────────────

export const SITE_KINDS = {
  mine: { label: 'mines & quarries', color: '#C9A227' },
  well: { label: 'oil & gas wells', color: '#8D6E63' },
  refinery: { label: 'refineries', color: '#FF7043' },
  lng: { label: 'LNG & gas terminals', color: '#4FC3F7' },
  storage: { label: 'fuel & strategic storage', color: '#BA68C8' },
  power: { label: 'power plants', color: '#FFD54F' },
};

export function siteQuery([s, w, n, e], cap = 1500) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:40];(
nwr["landuse"="quarry"](${b});
nwr["industrial"="mine"](${b});
nwr["man_made"~"^(mineshaft|adit)$"](${b});
nwr["man_made"="petroleum_well"](${b});
nwr["industrial"~"^(refinery|oil|gas)$"](${b});
nwr["man_made"="works"]["product"~"oil|petrol|gas|steel|aluminium|copper"](${b});
nwr["man_made"="storage_tank"]["content"~"oil|fuel|gas|lng"](${b});
nwr["industrial"~"^(fuel_depot|tank_farm)$"](${b});
nwr["power"="plant"](${b});
);out tags center ${cap};`;
}

export function classifySite(t) {
  if (t.power === 'plant') return 'power';
  if (
    /refinery/.test(t.industrial || '') ||
    (t.man_made === 'works' && /oil|petrol/.test(t.product || ''))
  )
    return 'refinery';
  if (
    /lng/i.test(`${t.content || ''} ${t.name || ''}`) ||
    (t.industrial === 'gas' && /terminal/i.test(t.name || ''))
  )
    return 'lng';
  if (
    t.man_made === 'petroleum_well' ||
    t.industrial === 'oil' ||
    t.industrial === 'gas'
  )
    return 'well';
  if (
    t.man_made === 'storage_tank' ||
    /fuel_depot|tank_farm/.test(t.industrial || '')
  )
    return 'storage';
  if (
    t.landuse === 'quarry' ||
    t.industrial === 'mine' ||
    /mineshaft|adit/.test(t.man_made || '') ||
    t.man_made === 'works'
  )
    return 'mine';
  return null;
}

export function normalizeSites(json) {
  const out = [];
  for (const el of json?.elements || []) {
    const t = el.tags || {};
    const kind = classifySite(t);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!kind || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      kind,
      name: t.name || null,
      detail:
        [
          t.resource,
          t.product,
          t['plant:source'],
          t['plant:output:electricity'],
          t.operator,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      lat,
      lon,
    });
  }
  return out;
}
