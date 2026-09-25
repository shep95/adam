/**
 * Track prediction: where a contact is going and when it gets there, if it
 * holds course and speed — with an uncertainty radius that grows with time,
 * report age and the domain's typical heading/speed drift.
 *
 * Dead reckoning along the great circle; the band is a 1-sigma-ish screening
 * radius, not a statistical guarantee, and every answer says so.
 */
import { destination, greatCircleKm } from './geoMeasure.js';
import { pointInPolygon } from './geo.js';

const DRIFT = {
  vessel: { headingDeg: 8, speedFrac: 0.12 },
  aircraft: { headingDeg: 4, speedFrac: 0.06 },
};

/**
 * @param {{lat:number, lon:number, speedKts:number, headingDeg:number, ageMs?:number, domain?:'vessel'|'aircraft'}} c
 * @param {{horizonMin?:number, stepMin?:number}} [o]
 * @returns {Array<{min:number, lat:number, lon:number, radiusKm:number}>}
 */
export function predictTrack(c, { horizonMin = 240, stepMin = 10 } = {}) {
  if (
    ![c?.lat, c?.lon, c?.speedKts, c?.headingDeg].every(Number.isFinite) ||
    c.speedKts < 0.5
  )
    return [];
  const drift = DRIFT[c.domain] || DRIFT.vessel;
  const kmPerMin = (c.speedKts * 1.852) / 60;
  const ageMin = Math.max(0, (c.ageMs || 0) / 60000);
  const out = [];
  for (let m = 0; m <= horizonMin; m += stepMin) {
    const t = m + ageMin; // the report is old: dead-reckon from its time
    const km = kmPerMin * t;
    const p = destination(c, km, c.headingDeg);
    const cross = km * Math.tan((drift.headingDeg * Math.PI) / 180);
    const along = km * drift.speedFrac;
    out.push({
      min: m,
      lat: p.lat,
      lon: p.lon,
      radiusKm: Math.max(0.3, Math.hypot(cross, along)),
    });
  }
  return out;
}

/**
 * First time the predicted track enters a zone ring ([lon, lat]).
 * @returns {{minutes:number, lat:number, lon:number, radiusKm:number, confidence:string}|null}
 */
export function etaToZone(track, ring) {
  for (let i = 0; i < track.length; i += 1) {
    const p = track[i];
    if (pointInPolygon(ring, p.lon, p.lat)) {
      // Refine between the previous step and this one.
      const prev = track[i - 1];
      let minutes = p.min;
      if (prev) {
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 12; k += 1) {
          const mid = (lo + hi) / 2;
          const lat = prev.lat + (p.lat - prev.lat) * mid;
          const lon = prev.lon + (p.lon - prev.lon) * mid;
          if (pointInPolygon(ring, lon, lat)) hi = mid;
          else lo = mid;
        }
        minutes = prev.min + (p.min - prev.min) * hi;
      }
      return {
        minutes: Math.round(minutes),
        lat: p.lat,
        lon: p.lon,
        radiusKm: p.radiusKm,
        confidence:
          p.radiusKm < 5 ? 'high' : p.radiusKm < 25 ? 'moderate' : 'low',
      };
    }
  }
  return null;
}

/** Closest point of approach to a fixed point. */
export function closestApproach(track, point) {
  let best = null;
  for (const p of track) {
    const km = greatCircleKm(p, point);
    if (!best || km < best.km) best = { ...p, km };
  }
  return best;
}

export function formatMinutes(min) {
  if (!Number.isFinite(min)) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} min`;
}

/** Plain sentence for Shepherd and the UI. */
export function predictionSentence(name, eta, zoneName) {
  if (!eta)
    return `${name} does not enter ${zoneName} within the prediction horizon if it holds course and speed.`;
  return `If ${name} holds course and speed it enters ${zoneName} in ${formatMinutes(eta.minutes)} (±${eta.radiusKm.toFixed(1)} km at that time, ${eta.confidence} confidence).`;
}
