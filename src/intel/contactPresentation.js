/**
 * Contact presentation policy: one place that decides how visible a live
 * contact should be under the operator's filters.
 *
 *   time window     — hide contacts not heard from inside the window
 *   region polygon  — contacts outside the drawn region fade to 20%
 *   altitude bands  — aircraft quick-filter chips
 *   vessel types    — vessel quick-filter chips
 *   staleness       — contacts whose transponder went quiet decay visually
 *
 * Renderers call `contactPresentationFactor(layerKey, fields)` at their
 * existing alpha compose site and multiply it in. A factor of 0 hides the
 * contact. `presentationEpoch()` changes whenever the policy changes, so
 * renderers that only write on change know to repaint.
 */

import { normalizeVesselType } from '../data/vesselLabels.js';
import { pointInPolygon, ringBounds, unwrapRing } from './geo.js';

export const OUTSIDE_REGION_ALPHA = 0.2;
export const STALE_FLOOR_ALPHA = 0.3;

/** Quiet time (ms) after which a contact of this layer counts as stale. */
export const STALE_AFTER_MS = Object.freeze({
  flights: 2 * 60_000,
  military: 2 * 60_000,
  'ais-live-vessels': 15 * 60_000,
});

export const TIME_WINDOWS = Object.freeze([
  { id: 'all', label: 'ALL', ms: null },
  { id: '10m', label: '10 MIN', ms: 10 * 60_000 },
  { id: '1h', label: '1 H', ms: 60 * 60_000 },
  { id: '6h', label: '6 H', ms: 6 * 60 * 60_000 },
]);

const FT_PER_M = 3.28084;

export const ALTITUDE_BANDS = Object.freeze([
  { id: 'surface', label: 'SFC', maxFt: 100 },
  { id: 'low', label: 'LOW', maxFt: 10_000 },
  { id: 'medium', label: 'MED', maxFt: 25_000 },
  { id: 'high', label: 'HIGH', maxFt: 45_000 },
  { id: 'strato', label: 'STRAT', maxFt: Infinity },
]);

export const VESSEL_TYPE_CLASSES = Object.freeze([
  { id: 'cargo', label: 'CARGO', pattern: /cargo|container|bulk|carrier/i },
  { id: 'tanker', label: 'TANKER', pattern: /tanker/i },
  { id: 'passenger', label: 'PAX', pattern: /passenger|ferry|cruise/i },
  {
    id: 'military',
    label: 'MIL',
    pattern: /military|law enforce|naval|warship/i,
  },
  { id: 'fishing', label: 'FISH', pattern: /fishing/i },
  { id: 'other', label: 'OTHER', pattern: /.+/ },
]);

/** Altitude band id for an aircraft. */
export function altitudeBandFor({ altitudeM, onGround } = {}) {
  if (onGround === true) return 'surface';
  if (!Number.isFinite(altitudeM)) return 'surface';
  const ft = altitudeM * FT_PER_M;
  return ALTITUDE_BANDS.find((band) => ft < band.maxFt)?.id || 'strato';
}

/** Vessel class id for an AIS ship type (code or text). */
export function vesselClassFor(type) {
  const text = normalizeVesselType(type);
  if (!text) return 'unknown';
  return VESSEL_TYPE_CLASSES.find((c) => c.pattern.test(text))?.id || 'unknown';
}

/**
 * Visual decay for a contact heard `ageMs` ago. 1 until the layer's stale
 * threshold, then a linear decay to STALE_FLOOR_ALPHA at four times it.
 */
export function stalenessFactor(layerKey, ageMs) {
  const threshold = STALE_AFTER_MS[layerKey];
  if (!threshold || !Number.isFinite(ageMs) || ageMs <= threshold) return 1;
  const t = Math.min(1, (ageMs - threshold) / (threshold * 3));
  return 1 - t * (1 - STALE_FLOOR_ALPHA);
}

/** Staleness descriptor for a metadata card. */
export function describeStaleness(layerKey, lastSeenMs, now = Date.now()) {
  if (!Number.isFinite(lastSeenMs))
    return { stale: false, ageMs: null, label: null };
  const ageMs = Math.max(0, now - lastSeenMs);
  const threshold = STALE_AFTER_MS[layerKey] ?? Infinity;
  const minutes = Math.floor(ageMs / 60_000);
  const label =
    ageMs < 60_000
      ? `${Math.floor(ageMs / 1000)}s ago`
      : minutes < 120
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h ago`;
  return { stale: ageMs > threshold, ageMs, label };
}

function createPolicy() {
  return {
    timeWindowMs: null,
    region: null, // {ring, unwrapped, bounds}
    altitudeBands: new Set(ALTITUDE_BANDS.map((b) => b.id)),
    vesselClasses: new Set([
      ...VESSEL_TYPE_CLASSES.map((c) => c.id),
      'unknown',
    ]),
    staleness: true,
  };
}

let policy = createPolicy();
let epoch = 0;
const listeners = new Set();

function changed() {
  epoch += 1;
  for (const listener of [...listeners]) {
    try {
      listener(snapshotPresentation());
    } catch (error) {
      console.warn('[contact-presentation] listener failed:', error);
    }
  }
}

export function presentationEpoch() {
  return epoch;
}

export function subscribePresentation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshotPresentation() {
  return {
    timeWindowMs: policy.timeWindowMs,
    region: policy.region ? policy.region.ring : null,
    altitudeBands: [...policy.altitudeBands],
    vesselClasses: [...policy.vesselClasses],
    staleness: policy.staleness,
    epoch,
  };
}

/** True when any filter narrows the picture (staleness decay excluded). */
export function presentationIsFiltered() {
  return (
    policy.timeWindowMs !== null ||
    policy.region !== null ||
    policy.altitudeBands.size < ALTITUDE_BANDS.length ||
    policy.vesselClasses.size < VESSEL_TYPE_CLASSES.length + 1
  );
}

export function setTimeWindow(ms) {
  const next = Number.isFinite(ms) && ms > 0 ? ms : null;
  if (next === policy.timeWindowMs) return;
  policy.timeWindowMs = next;
  changed();
}

export function setRegionFilter(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    if (policy.region === null) return;
    policy.region = null;
  } else {
    const clean = ring
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (clean.length < 3) return;
    policy.region = {
      ring: clean,
      unwrapped: unwrapRing(clean),
      bounds: ringBounds(clean),
    };
  }
  changed();
}

export function setAltitudeBandEnabled(id, enabled) {
  if (!ALTITUDE_BANDS.some((b) => b.id === id)) return;
  const had = policy.altitudeBands.has(id);
  if (had === Boolean(enabled)) return;
  if (enabled) policy.altitudeBands.add(id);
  else policy.altitudeBands.delete(id);
  changed();
}

export function setVesselClassEnabled(id, enabled) {
  const valid =
    id === 'unknown' || VESSEL_TYPE_CLASSES.some((c) => c.id === id);
  if (!valid) return;
  const had = policy.vesselClasses.has(id);
  if (had === Boolean(enabled)) return;
  if (enabled) policy.vesselClasses.add(id);
  else policy.vesselClasses.delete(id);
  changed();
}

export function setStalenessEnabled(enabled) {
  if (policy.staleness === Boolean(enabled)) return;
  policy.staleness = Boolean(enabled);
  changed();
}

export function resetPresentation() {
  policy = createPolicy();
  changed();
}

/** Whether a lon/lat lies inside the region filter (true when none is set). */
export function insideRegionFilter(lon, lat) {
  const region = policy.region;
  if (!region) return true;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  const { south, north } = region.bounds;
  if (lat < south || lat > north) return false;
  return pointInPolygon(region.ring, lon, lat);
}

/**
 * Alpha multiplier for one contact.
 *
 * @param {string} layerKey - 'flights' | 'military' | 'ais-live-vessels' | other
 * @param {{lat?: number, lon?: number, altitudeM?: number, onGround?: boolean,
 *          lastSeenMs?: number, shipType?: string}} fields
 * @param {number} [now]
 * @returns {number} 0 (hidden) … 1 (full)
 */
export function contactPresentationFactor(layerKey, fields, now = Date.now()) {
  if (!fields) return 1;
  const ageMs = Number.isFinite(fields.lastSeenMs)
    ? now - fields.lastSeenMs
    : null;
  if (
    policy.timeWindowMs !== null &&
    ageMs !== null &&
    ageMs > policy.timeWindowMs
  )
    return 0;
  if (layerKey === 'flights' || layerKey === 'military') {
    if (policy.altitudeBands.size < ALTITUDE_BANDS.length) {
      if (!policy.altitudeBands.has(altitudeBandFor(fields))) return 0;
    }
  } else if (layerKey === 'ais-live-vessels') {
    if (policy.vesselClasses.size < VESSEL_TYPE_CLASSES.length + 1) {
      if (!policy.vesselClasses.has(vesselClassFor(fields.shipType))) return 0;
    }
  }
  let factor = 1;
  if (policy.region && !insideRegionFilter(fields.lon, fields.lat))
    factor *= OUTSIDE_REGION_ALPHA;
  if (policy.staleness && ageMs !== null)
    factor *= stalenessFactor(layerKey, ageMs);
  return factor;
}

/** Filter plain records (analyst/brief use): keeps records with factor > 0. */
export function recordPassesPresentation(layerKey, record, now = Date.now()) {
  return contactPresentationFactor(layerKey, record, now) > 0;
}
