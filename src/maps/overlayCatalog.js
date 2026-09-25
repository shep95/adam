/**
 * Map sources that can be stacked over the base map: other basemaps (to blend
 * or compare), daily Earth observation, transparent reference overlays,
 * bathymetry, and the future-coast (sea level) projections. Pure data and
 * helpers; the LAYERS panel turns these into Cesium imagery layers.
 *
 * Every entry carries its credit line; the panel shows it while the layer is
 * on and Cesium puts it in the credit bar.
 */

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const ESRI_CREDIT = 'Powered by Esri';
const GIBS_CREDIT = 'NASA EOSDIS GIBS';

export const TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_CREDIT =
  'Elevation: Terrain Tiles (AWS Open Data) — SRTM, GMTED, ETOPO1, NED and others';

export const OVERLAY_GROUPS = [
  { id: 'future', label: 'future coast' },
  { id: 'heat', label: 'heat' },
  { id: 'base', label: 'base maps' },
  { id: 'earth', label: 'earth observation' },
  { id: 'reference', label: 'reference overlays' },
  { id: 'sea', label: 'ocean floor' },
];

/** Yesterday (UTC) as YYYY-MM-DD: the newest complete GIBS daily mosaic. */
export function gibsDate(now = new Date()) {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

const gibs = (layer, matrix, ext, date) =>
  `${GIBS}/${layer}/default/${date}/GoogleMapsCompatible_${matrix}/{z}/{y}/{x}.${ext}`;

export const OVERLAY_SOURCES = [
  {
    id: 'sea-level',
    group: 'future',
    label: 'sea level rise · world',
    kind: 'sealevel',
    alpha: 0.85,
    credit: TERRARIUM_CREDIT,
    note: 'Land between today’s coast and the chosen rise, shaded by flood depth. Bathtub model on global elevation: no ocean-connectivity check, sea walls, subsidence or tides; elevation error is several metres, so small rises are indicative.',
  },
  {
    id: 'noaa-slr',
    group: 'future',
    label: 'sea level rise · US (NOAA)',
    kind: 'noaa-slr',
    alpha: 0.75,
    credit: 'NOAA Office for Coastal Management — Sea Level Rise Viewer',
    note: 'US coasts only, 0–10 ft above high tide, hydrologically connected areas. Follows the rise set above, rounded to whole feet.',
  },
  {
    id: 'activity-heat',
    group: 'heat',
    label: 'human activity heat',
    kind: 'heatlights',
    alpha: 0.9,
    maxLevel: 8,
    credit: `${GIBS_CREDIT} — NASA Black Marble, shown in heat colours`,
    note: 'Night-time light as a heat ramp: where people, cities and industry concentrate. Light, not temperature.',
  },
  {
    id: 'lst-day',
    group: 'heat',
    label: 'surface temperature · day',
    kind: 'gibs',
    layer: 'MODIS_Terra_Land_Surface_Temp_Day',
    matrix: 'Level7',
    ext: 'png',
    maxLevel: 7,
    alpha: 0.75,
    credit: `${GIBS_CREDIT} — MODIS land surface temperature`,
    note: 'Measured land surface temperature, yesterday by day. Gaps are cloud.',
  },
  {
    id: 'lst-night',
    group: 'heat',
    label: 'surface temperature · night',
    kind: 'gibs',
    layer: 'MODIS_Terra_Land_Surface_Temp_Night',
    matrix: 'Level7',
    ext: 'png',
    maxLevel: 7,
    alpha: 0.75,
    credit: `${GIBS_CREDIT} — MODIS land surface temperature`,
    note: 'Night-time land surface temperature: cities stay warm after dark.',
  },
  {
    id: 'esri-imagery',
    group: 'base',
    label: 'Esri satellite',
    kind: 'arcgis',
    url: `${ESRI}/World_Imagery/MapServer`,
    credit: `${ESRI_CREDIT} — Esri, Maxar, Earthstar Geographics`,
  },
  {
    id: 'esri-streets',
    group: 'base',
    label: 'Esri streets',
    kind: 'arcgis',
    url: `${ESRI}/World_Street_Map/MapServer`,
    credit: ESRI_CREDIT,
  },
  {
    id: 'esri-topo',
    group: 'base',
    label: 'Esri topographic',
    kind: 'arcgis',
    url: `${ESRI}/World_Topo_Map/MapServer`,
    credit: ESRI_CREDIT,
  },
  {
    id: 'esri-natgeo',
    group: 'base',
    label: 'National Geographic',
    kind: 'arcgis',
    url: `${ESRI}/NatGeo_World_Map/MapServer`,
    credit: `${ESRI_CREDIT} — National Geographic, Esri`,
  },
  {
    id: 'esri-hillshade',
    group: 'base',
    label: 'hillshade',
    kind: 'arcgis',
    url: `${ESRI}/Elevation/World_Hillshade/MapServer`,
    alpha: 0.5,
    credit: ESRI_CREDIT,
  },
  {
    id: 'osm',
    group: 'base',
    label: 'OpenStreetMap',
    kind: 'xyz',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxLevel: 19,
    credit: '© OpenStreetMap contributors',
  },
  {
    id: 'osm-hot',
    group: 'base',
    label: 'OSM humanitarian',
    kind: 'xyz',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxLevel: 19,
    credit: '© OpenStreetMap contributors, HOT',
  },
  {
    id: 'opentopomap',
    group: 'base',
    label: 'OpenTopoMap',
    kind: 'xyz',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxLevel: 17,
    credit: '© OpenStreetMap contributors, SRTM · OpenTopoMap (CC-BY-SA)',
  },
  {
    id: 'carto-dark',
    group: 'base',
    label: 'Carto dark',
    kind: 'xyz',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    maxLevel: 19,
    credit: '© OpenStreetMap contributors © CARTO',
  },
  {
    id: 'carto-light',
    group: 'base',
    label: 'Carto light',
    kind: 'xyz',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    maxLevel: 19,
    credit: '© OpenStreetMap contributors © CARTO',
  },
  {
    id: 's2-cloudless',
    group: 'base',
    label: 'Sentinel-2 cloudless 2021',
    kind: 'xyz',
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg',
    maxLevel: 15,
    credit:
      'Sentinel-2 cloudless — s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2021), CC BY-NC-SA 4.0',
  },
  {
    id: 'gibs-viirs',
    group: 'earth',
    label: 'VIIRS true colour · yesterday',
    kind: 'gibs',
    layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
    matrix: 'Level9',
    ext: 'jpg',
    maxLevel: 9,
    credit: GIBS_CREDIT,
  },
  {
    id: 'gibs-modis',
    group: 'earth',
    label: 'MODIS Terra true colour · yesterday',
    kind: 'gibs',
    layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    matrix: 'Level9',
    ext: 'jpg',
    maxLevel: 9,
    credit: GIBS_CREDIT,
  },
  {
    id: 'gibs-sst',
    group: 'earth',
    label: 'sea surface temperature',
    kind: 'gibs',
    layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    matrix: 'Level7',
    ext: 'png',
    maxLevel: 7,
    alpha: 0.7,
    credit: `${GIBS_CREDIT} — GHRSST MUR`,
  },
  {
    id: 'gibs-snow',
    group: 'earth',
    label: 'snow cover',
    kind: 'gibs',
    layer: 'MODIS_Terra_NDSI_Snow_Cover',
    matrix: 'Level8',
    ext: 'png',
    maxLevel: 8,
    alpha: 0.8,
    credit: GIBS_CREDIT,
  },
  {
    id: 'gibs-night',
    group: 'earth',
    label: 'Black Marble night lights',
    kind: 'gibs',
    layer: 'VIIRS_Black_Marble',
    matrix: 'Level8',
    ext: 'png',
    date: '2016-01-01',
    maxLevel: 8,
    credit: `${GIBS_CREDIT} — NASA Black Marble`,
  },
  {
    id: 'esri-labels',
    group: 'reference',
    label: 'place names and borders',
    kind: 'arcgis',
    url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer`,
    credit: ESRI_CREDIT,
  },
  {
    id: 'esri-transport',
    group: 'reference',
    label: 'roads',
    kind: 'arcgis',
    url: `${ESRI}/Reference/World_Transportation/MapServer`,
    credit: ESRI_CREDIT,
  },
  {
    id: 'openseamap',
    group: 'reference',
    label: 'sea marks (OpenSeaMap)',
    kind: 'xyz',
    url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
    maxLevel: 18,
    credit: '© OpenSeaMap contributors',
  },
  {
    id: 'openrailwaymap',
    group: 'reference',
    label: 'railways (OpenRailwayMap)',
    kind: 'xyz',
    url: 'https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxLevel: 19,
    credit: '© OpenStreetMap contributors · OpenRailwayMap (CC-BY-SA)',
  },
  {
    id: 'gebco',
    group: 'sea',
    label: 'GEBCO bathymetry',
    kind: 'wms',
    url: 'https://wms.gebco.net/mapserv',
    layers: 'GEBCO_LATEST',
    credit: 'GEBCO Compilation Group, GEBCO Grid',
  },
  {
    id: 'esri-ocean',
    group: 'sea',
    label: 'Esri ocean floor',
    kind: 'arcgis',
    url: `${ESRI}/Ocean/World_Ocean_Base/MapServer`,
    credit: `${ESRI_CREDIT} — GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org`,
  },
];

/**
 * Global mean sea level rise, metres above 1995–2014, from IPCC AR6 WG1
 * (median unless marked) plus the long-run ice-sheet equivalents.
 */
export const SEA_LEVEL_PRESETS = [
  { id: 'now', label: 'today', rise: 0 },
  {
    id: '2050',
    label: '2050',
    rise: 0.2,
    note: 'AR6, all scenarios 0.15–0.30 m',
  },
  {
    id: '2100-low',
    label: '2100 · low emissions',
    rise: 0.44,
    note: 'AR6 SSP1-2.6 median',
  },
  {
    id: '2100-mid',
    label: '2100 · middle',
    rise: 0.56,
    note: 'AR6 SSP2-4.5 median',
  },
  {
    id: '2100-high',
    label: '2100 · high emissions',
    rise: 0.77,
    note: 'AR6 SSP5-8.5 median',
  },
  {
    id: '2100-ice',
    label: '2100 · ice-sheet collapse',
    rise: 2,
    note: 'AR6 low-likelihood, high-impact',
  },
  {
    id: '2150-ice',
    label: '2150 · ice-sheet collapse',
    rise: 5,
    note: 'AR6 low-likelihood, high-impact',
  },
  {
    id: 'greenland',
    label: 'all of Greenland melted',
    rise: 7.4,
    note: 'centuries to millennia',
  },
  {
    id: 'all-ice',
    label: 'all land ice melted',
    rise: 70,
    note: 'thousands of years',
  },
];

export const MAX_RISE_M = 100;

export function clampRise(m) {
  const n = Number(m);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_RISE_M, n)) : 0;
}

export function riseToFeet(m) {
  return Math.max(0, Math.min(10, Math.round(clampRise(m) * 3.28084)));
}

export function noaaSlrUrl(m) {
  return `https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_${riseToFeet(m)}ft/MapServer`;
}

export function sourceById(id) {
  return OVERLAY_SOURCES.find((s) => s.id === id) || null;
}

/** Terrarium RGB → metres. */
export function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Colour one elevation sample for a rise: transparent above the new sea or at
 * or below today's (already water), blue that deepens with flood depth
 * between. Returns [r, g, b, a] (0–255).
 */
export function floodColor(elev, rise) {
  if (!(rise > 0) || elev <= 0 || elev > rise) return [0, 0, 0, 0];
  const depth = Math.min(1, (rise - elev) / Math.max(1, rise));
  return [
    Math.round(40 - 30 * depth),
    Math.round(150 - 90 * depth),
    Math.round(235 - 55 * depth),
    Math.round(170 + 70 * depth),
  ];
}

/** Ironbow heat ramp: 0 → transparent-black, 1 → white-hot. */
export function ironbow(t) {
  const stops = [
    [0, 0, 0],
    [34, 0, 77],
    [125, 0, 115],
    [219, 26, 46],
    [255, 140, 0],
    [255, 232, 82],
    [255, 255, 255],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

/** Recolour night-light pixels into the heat ramp; dark stays clear. */
export function heatPixels(data) {
  for (let i = 0; i < data.length; i += 4) {
    const lum =
      (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    if (lum < 0.05) {
      data[i + 3] = 0;
      continue;
    }
    const t = Math.min(1, Math.pow((lum - 0.05) / 0.95, 0.6));
    const [r, g, b] = ironbow(t);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = Math.round(120 + 135 * t);
  }
  return data;
}

/** Recolour a Terrarium RGBA buffer in place into a flood tile. */
export function floodPixels(data, rise) {
  for (let i = 0; i < data.length; i += 4) {
    const c = floodColor(
      terrariumElevation(data[i], data[i + 1], data[i + 2]),
      rise,
    );
    data[i] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = c[3];
  }
  return data;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^(www|tiles?|[a-c])\./, '');
  } catch {
    return 'custom';
  }
}

/**
 * Turn a pasted URL into a source. Accepts an XYZ template ({z}/{x}/{y},
 * {-y}, {s}), a WMTS REST template ({TileMatrix}/{TileRow}/{TileCol}), an
 * ArcGIS MapServer or ImageServer URL, or a WMS endpoint with a layers=
 * parameter. HTTPS only. Returns { source } or { error }.
 */
export function parseCustomSource(text, label = '') {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'paste a tile URL' };
  let url;
  try {
    url = new URL(raw.replace(/[{}]/g, (c) => (c === '{' ? '%7B' : '%7D')));
  } catch {
    return { error: 'not a URL' };
  }
  if (url.protocol !== 'https:') return { error: 'https URLs only' };
  const id = `custom-${hashString(raw)}`;
  const name = String(label || '').trim() || hostLabel(raw);
  const base = { id, group: 'custom', label: name, custom: true, credit: name };
  const template = raw
    .replace(/\{TileMatrix\}/gi, '{z}')
    .replace(/\{TileRow\}/gi, '{y}')
    .replace(/\{TileCol\}/gi, '{x}');
  if (
    /\{z\}/.test(template) &&
    /\{x\}/.test(template) &&
    /\{-?y\}/.test(template)
  ) {
    const reverseY = /\{-y\}/.test(template);
    return {
      source: {
        ...base,
        kind: 'xyz',
        url: template.replace('{-y}', '{reverseY}'),
        subdomains: /\{s\}/.test(template) ? 'abc' : undefined,
        reverseY,
        maxLevel: 19,
      },
    };
  }
  if (/\/(MapServer|ImageServer)\/?$/i.test(url.pathname)) {
    return {
      source: {
        ...base,
        kind: 'arcgis',
        url: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
      },
    };
  }
  const params = new URLSearchParams(
    [...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (
    params.get('service')?.toUpperCase() === 'WMS' ||
    /wms/i.test(url.pathname)
  ) {
    const layers = params.get('layers');
    if (!layers) return { error: 'WMS URL needs a layers= parameter' };
    return {
      source: {
        ...base,
        kind: 'wms',
        url: `${url.origin}${url.pathname}`,
        layers,
      },
    };
  }
  return {
    error:
      'use an XYZ template with {z}/{x}/{y}, an ArcGIS MapServer URL or a WMS URL with layers=',
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** The persisted form of a stack: ids, opacity, visibility, custom sources. */
export function serializeStack(entries, rise) {
  return {
    v: 1,
    rise: clampRise(rise),
    layers: entries.map((e) => ({
      id: e.source.id,
      alpha: Math.round(e.alpha * 100) / 100,
      show: e.show !== false,
      ...(e.source.custom ? { source: e.source } : {}),
    })),
  };
}

/** Validate a persisted stack; unknown ids and non-https customs drop out. */
export function restoreStack(saved) {
  if (!saved || saved.v !== 1 || !Array.isArray(saved.layers))
    return { rise: 0, layers: [] };
  const layers = [];
  for (const l of saved.layers.slice(0, 16)) {
    let source = sourceById(l?.id);
    if (!source && l?.source?.custom) {
      const parsed = parseCustomSource(
        l.source.kind === 'wms'
          ? `${l.source.url}?service=WMS&layers=${encodeURIComponent(l.source.layers)}`
          : l.source.reverseY
            ? l.source.url.replace('{reverseY}', '{-y}')
            : l.source.url,
        l.source.label,
      );
      source = parsed.source || null;
    }
    if (!source || layers.some((x) => x.source.id === source.id)) continue;
    const alpha = Number(l.alpha);
    layers.push({
      source,
      alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
      show: l.show !== false,
    });
  }
  return { rise: clampRise(saved.rise), layers };
}
