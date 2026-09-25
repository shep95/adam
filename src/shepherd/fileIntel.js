/**
 * Files dropped on Shepherd that are not photos:
 *
 *   GeoJSON / KML / KMZ   drawn on the globe as a named overlay, framed, and
 *                         summarised for the analyst (feature count, extent)
 *   text documents        (.txt .md .csv .json .html .xml) read locally and
 *                         handed to Shepherd as a document to extract places,
 *                         dates and units from and plot on the globe
 *
 * Nothing is uploaded except the document text the operator then sends.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

export const DOC_CHAR_LIMIT = 60_000;
const GEO_EXT = /\.(geo)?json$|\.kml$|\.kmz$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|log)$/i;

/** 'image' | 'geo' | 'document' | null */
export function classifyFile(file) {
  const name = String(file?.name || '');
  const type = String(file?.type || '');
  if (type.startsWith('image/')) return 'image';
  if (/\.kmz$|\.kml$/i.test(name) || type.includes('kml')) return 'geo';
  if (/\.geojson$/i.test(name) || type === 'application/geo+json') return 'geo';
  if (TEXT_EXT.test(name) || type.startsWith('text/')) return 'document';
  if (GEO_EXT.test(name)) return 'geo';
  return null;
}

/** True when a parsed JSON value is GeoJSON. */
export function isGeoJson(value) {
  const t = value?.type;
  return (
    t === 'FeatureCollection' ||
    t === 'Feature' ||
    [
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
    ].includes(t)
  );
}

/** Strip markup and collapse whitespace; cap the length. */
export function documentText(raw, name = '') {
  let text = String(raw || '');
  if (/\.html?$/i.test(name) || /^\s*</.test(text))
    text = text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const truncated = text.length > DOC_CHAR_LIMIT;
  return { text: text.slice(0, DOC_CHAR_LIMIT), truncated, chars: text.length };
}

/** The message Shepherd receives for a dropped document. */
export function documentPrompt({ name, text, truncated }, ask = '') {
  return [
    ask ||
      'Read this document. Give a BLUF summary, then plot every identifiable place, facility, route or area it mentions on the globe (drop_pin for points, osint_overlay for linked sets) with confidence tiers, and list dates, units, vessels and aircraft it names. Places and craft only — do not profile private individuals.',
    '',
    `[document: ${name}${truncated ? ' — truncated' : ''}]`,
    text,
    '[end of document]',
  ].join('\n');
}

/**
 * @param {{viewer: Cesium.Viewer}} deps
 */
export function createFileOverlays({ viewer }) {
  const sources = [];

  async function load(file, { color = '#00BCD4', fly = true } = {}) {
    const name = String(file.name || 'overlay');
    let source;
    if (/\.kmz$|\.kml$/i.test(name)) {
      source = await Cesium.KmlDataSource.load(file, {
        camera: viewer.scene.camera,
        canvas: viewer.scene.canvas,
        clampToGround: true,
      });
    } else {
      const parsed = JSON.parse(await file.text());
      if (!isGeoJson(parsed)) throw new Error('not GeoJSON');
      source = await Cesium.GeoJsonDataSource.load(parsed, {
        stroke: Cesium.Color.fromCssColorString(color),
        fill: Cesium.Color.fromCssColorString(color).withAlpha(0.15),
        markerColor: Cesium.Color.fromCssColorString(color),
        strokeWidth: 2,
        clampToGround: true,
      });
    }
    source.name = `file:${name}`;
    await viewer.dataSources.add(source);
    sources.push(source);
    const entities = source.entities.values;
    const kinds = { points: 0, lines: 0, areas: 0 };
    for (const e of entities) {
      if (e.polygon) kinds.areas += 1;
      else if (e.polyline) kinds.lines += 1;
      else if (e.position) kinds.points += 1;
    }
    if (fly && entities.length) {
      try {
        await viewer.flyTo(source, { duration: 1.6 });
      } catch {
        /* empty or unframeable */
      }
    }
    governorRequestRender('file-overlay');
    return { name, features: entities.length, ...kinds };
  }

  return {
    load,
    list: () =>
      sources.map((s) => ({
        name: s.name,
        features: s.entities.values.length,
      })),
    clear() {
      for (const s of sources.splice(0)) viewer.dataSources.remove(s, true);
      governorRequestRender('file-overlay');
    },
  };
}

/** CSV with lat/lon (or latitude/longitude) columns → GeoJSON points. */
export function csvToGeoJson(text, { max = 5000 } = {}) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (rows.length < 2) return null;
  const split = (line) =>
    (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [])
      .map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'))
      .slice(0, -1);
  const head = split(rows[0]).map((h) => h.trim().toLowerCase());
  const iLat = head.findIndex((h) => ['lat', 'latitude', 'y'].includes(h));
  const iLon = head.findIndex((h) =>
    ['lon', 'lng', 'long', 'longitude', 'x'].includes(h),
  );
  if (iLat < 0 || iLon < 0) return null;
  const features = [];
  for (const line of rows.slice(1, max + 1)) {
    const cells = split(line);
    const lat = Number(cells[iLat]);
    const lon = Number(cells[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const properties = {};
    head.forEach((h, i) => {
      if (i !== iLat && i !== iLon) properties[h] = cells[i];
    });
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    });
  }
  return { type: 'FeatureCollection', features };
}
