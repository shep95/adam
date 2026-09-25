/**
 * What is under the cursor, in words. Pure: given a point and what the
 * console knows, returns short lines for the hover card.
 */
import { MARITIME_CHOKEPOINTS } from '../../layers/contextOverlay/chokepoints.js';
import { greatCircleKm } from '../../intel/geoMeasure.js';
import { pointInPolygon } from '../../intel/geo.js';

const CHOKEPOINT_KM = 120;
const WATCH_KM = 60;

/** Open ocean resolves to Etc/GMT±n zones in tz-lookup. */
export function isOpenWater(zone) {
  return !zone || /^Etc\//.test(zone);
}

export function placeFromZone(zone) {
  if (isOpenWater(zone)) return 'open water';
  const [region, city] = String(zone).split('/');
  return `${(city || region).replace(/_/g, ' ')}${city ? ` · ${region.toLowerCase()}` : ''} time zone`;
}

/**
 * @param {{lat:number, lon:number}} p
 * @param {{zone?: string|null, localTime?: string|null, zones?: object[],
 *   mission?: object|null, watch?: object[]}} ctx
 * @returns {string[]}
 */
export function hoverLines(p, ctx = {}) {
  const lines = [];
  let nearest = null;
  for (const c of MARITIME_CHOKEPOINTS) {
    const km = greatCircleKm(p, { lat: c.coords[1], lon: c.coords[0] });
    if (km <= CHOKEPOINT_KM && (!nearest || km < nearest.km))
      nearest = { c, km };
  }
  if (nearest)
    lines.push(
      `${nearest.c.name}${nearest.km > 15 ? ` (${Math.round(nearest.km)} km)` : ''} · ${nearest.c.width} wide · ${nearest.c.note}`,
    );
  for (const z of ctx.zones || [])
    if (pointInPolygon(z.ring, p.lon, p.lat))
      lines.push(`inside zone ${z.name}`);
  for (const a of ctx.mission?.areas || [])
    if (greatCircleKm(p, a) <= (a.radiusKm || 100))
      lines.push(`mission area${a.label ? ` ${a.label}` : ''}`);
  const near = (ctx.watch || [])
    .filter((w) => Number.isFinite(w.lat) && greatCircleKm(p, w) <= WATCH_KM)
    .slice(0, 2);
  for (const w of near)
    lines.push(`watch ${w.score} · ${w.title.toLowerCase()}`);
  const place = placeFromZone(ctx.zone);
  lines.push(ctx.localTime ? `${place} · ${ctx.localTime}` : place);
  return lines;
}
