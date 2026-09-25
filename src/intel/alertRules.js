/**
 * Alert trigger rules: the operator defines a condition over live contacts
 * and ADAM flashes when it trips.
 *
 * Rule kinds:
 *   count-in-zone  — more than `threshold` contacts of a layer inside a polygon
 *   speed-in-zone  — any vessel/aircraft inside a polygon faster than
 *                    `maxSpeedKts` knots (for example, harbor speed limits)
 *   quake-in-zone  — an earthquake of at least `minMagnitude` inside the zone
 *                    in the last 24 h (USGS feed)
 *   fire-in-zone   — more than `threshold` satellite fire detections of at
 *                    least `minFrp` MW inside the zone (NASA FIRMS)
 *
 * Evaluation is pure; `createAlertMonitor` adds edge triggering (fires once on
 * the rising edge, re-arms after the condition clears) and persistence.
 */

import { pointInPolygon } from './geo.js';

export const ALERT_RULE_KINDS = Object.freeze([
  'count-in-zone',
  'speed-in-zone',
  'quake-in-zone',
  'fire-in-zone',
]);
/** Hazard kinds read a fixed layer. */
export const HAZARD_RULE_LAYERS = Object.freeze({
  'quake-in-zone': 'earthquakes',
  'fire-in-zone': 'local-firms',
});
const QUAKE_WINDOW_MS = 24 * 3600_000;
export const ALERT_LAYERS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
]);
export const ALERT_STORAGE_KEY = 'adam.intel.alerts.v1';
const MAX_RULES = 24;
const MAX_RING_POINTS = 64;
const MPS_TO_KTS = 1.943844;

/**
 * Sanitize an untrusted rule (from storage or UI) into a valid rule or null.
 *
 * @param {object} raw
 * @returns {?object}
 */
export function normalizeAlertRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ALERT_RULE_KINDS.includes(raw.kind) ? raw.kind : null;
  const layerKey = HAZARD_RULE_LAYERS[kind]
    ? HAZARD_RULE_LAYERS[kind]
    : ALERT_LAYERS.includes(raw.layerKey)
      ? raw.layerKey
      : null;
  if (!kind || !layerKey) return null;
  const ring = Array.isArray(raw.ring)
    ? raw.ring
        .slice(0, MAX_RING_POINTS)
        .map((p) => [Number(p?.[0]), Number(p?.[1])])
        .filter(
          ([lon, lat]) =>
            Number.isFinite(lon) &&
            Number.isFinite(lat) &&
            Math.abs(lat) <= 90 &&
            Math.abs(lon) <= 180,
        )
    : [];
  if (ring.length < 3) return null;
  const rule = {
    id:
      typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/i.test(raw.id)
        ? raw.id
        : `rule-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    layerKey,
    ring,
    label: String(raw.label || '')
      .replace(/[\u0000-\u001f<>]/g, '')
      .slice(0, 60),
    enabled: raw.enabled !== false,
  };
  if (kind === 'count-in-zone' || kind === 'fire-in-zone') {
    const threshold = Math.floor(
      Number(kind === 'fire-in-zone' ? (raw.threshold ?? 0) : raw.threshold),
    );
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100000)
      return null;
    rule.threshold = threshold;
    if (kind === 'fire-in-zone') {
      const minFrp = Number(raw.minFrp ?? 0);
      if (!Number.isFinite(minFrp) || minFrp < 0 || minFrp > 100000)
        return null;
      rule.minFrp = minFrp;
    }
  } else if (kind === 'quake-in-zone') {
    const minMagnitude = Number(raw.minMagnitude);
    if (!Number.isFinite(minMagnitude) || minMagnitude < 0 || minMagnitude > 10)
      return null;
    rule.minMagnitude = minMagnitude;
  } else {
    const maxSpeedKts = Number(raw.maxSpeedKts);
    if (!Number.isFinite(maxSpeedKts) || maxSpeedKts <= 0 || maxSpeedKts > 2000)
      return null;
    rule.maxSpeedKts = maxSpeedKts;
  }
  if (!rule.label) {
    rule.label =
      kind === 'count-in-zone'
        ? `>${rule.threshold} ${layerKey} in zone`
        : kind === 'quake-in-zone'
          ? `M${rule.minMagnitude}+ quake in zone`
          : kind === 'fire-in-zone'
            ? `>${rule.threshold} fires${rule.minFrp ? ` ≥${rule.minFrp} MW` : ''} in zone`
            : `${layerKey} over ${rule.maxSpeedKts} kt in zone`;
  }
  return rule;
}

/** Speed of a record in knots, from whichever unit it carries. */
export function recordSpeedKts(record) {
  if (Number.isFinite(record?.speedKts)) return record.speedKts;
  if (Number.isFinite(record?.speedMps)) return record.speedMps * MPS_TO_KTS;
  return null;
}

/**
 * Evaluate one rule against the current records of its layer.
 *
 * @param {object} rule - A normalized rule.
 * @param {Array<object>} records - Records with lat/lon (and speed).
 * @returns {{triggered: boolean, count: number, matches: Array<object>, detail: string}}
 */
export function evaluateAlertRule(rule, records, now = Date.now()) {
  const inside = (records || []).filter(
    (r) =>
      Number.isFinite(r?.lat) &&
      Number.isFinite(r?.lon) &&
      pointInPolygon(rule.ring, r.lon, r.lat),
  );
  if (rule.kind === 'count-in-zone') {
    const triggered = inside.length > rule.threshold;
    return {
      triggered,
      count: inside.length,
      matches: triggered ? inside.slice(0, 12) : [],
      detail: `${inside.length} ${rule.layerKey} in zone (limit ${rule.threshold})`,
    };
  }
  if (rule.kind === 'quake-in-zone') {
    const hits = inside
      .filter(
        (r) =>
          Number.isFinite(r.magnitude) &&
          r.magnitude >= rule.minMagnitude &&
          (!Number.isFinite(r.timeMs) || now - r.timeMs <= QUAKE_WINDOW_MS),
      )
      .sort((a, b) => b.magnitude - a.magnitude);
    return {
      triggered: hits.length > 0,
      count: hits.length,
      matches: hits.slice(0, 12),
      detail: hits.length
        ? `${hits.length} quake${hits.length === 1 ? '' : 's'} M${rule.minMagnitude}+ · strongest M${hits[0].magnitude.toFixed(1)}${hits[0].place ? ` ${hits[0].place}` : ''}`
        : `no M${rule.minMagnitude}+ quake in the last 24 h`,
    };
  }
  if (rule.kind === 'fire-in-zone') {
    const hot = inside.filter(
      (r) => !rule.minFrp || (Number.isFinite(r.frp) && r.frp >= rule.minFrp),
    );
    const triggered = hot.length > rule.threshold;
    const peak = hot.reduce((m, r) => Math.max(m, r.frp || 0), 0);
    return {
      triggered,
      count: hot.length,
      matches: triggered ? hot.slice(0, 12) : [],
      detail: `${hot.length} fire detection${hot.length === 1 ? '' : 's'}${rule.minFrp ? ` ≥${rule.minFrp} MW` : ''} in zone (limit ${rule.threshold})${hot.length ? ` · peak ${Math.round(peak)} MW` : ''}`,
    };
  }
  const fast = inside.filter((r) => {
    const kts = recordSpeedKts(r);
    return kts !== null && kts > rule.maxSpeedKts;
  });
  return {
    triggered: fast.length > 0,
    count: fast.length,
    matches: fast.slice(0, 12),
    detail: fast.length
      ? `${fast.length} over ${rule.maxSpeedKts} kt: ${fast
          .slice(0, 3)
          .map(
            (r) =>
              `${r.name || r.callsign || r.id || r.mmsi || 'contact'} ${Math.round(recordSpeedKts(r))} kt`,
          )
          .join(', ')}`
      : `no contact over ${rule.maxSpeedKts} kt`,
  };
}

/**
 * Stateful monitor with rising-edge firing and persistence.
 *
 * @param {{storage?: object|null, onTrip?: Function, onChange?: Function}} [options]
 */
export function createAlertMonitor({
  storage = null,
  onTrip = () => {},
  onChange = () => {},
} = {}) {
  /** @type {Map<string, object>} */
  const rules = new Map();
  /** @type {Map<string, {triggered: boolean, lastResult: object|null, trippedAt: number|null}>} */
  const state = new Map();

  const persist = () => {
    if (!storage) return;
    try {
      storage.setItem(ALERT_STORAGE_KEY, JSON.stringify([...rules.values()]));
    } catch {
      /* storage full or unavailable */
    }
  };

  const load = () => {
    if (!storage) return;
    try {
      const parsed = JSON.parse(storage.getItem(ALERT_STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return;
      for (const raw of parsed.slice(0, MAX_RULES)) {
        const rule = normalizeAlertRule(raw);
        if (rule) rules.set(rule.id, rule);
      }
    } catch {
      /* corrupt storage: start empty */
    }
  };

  load();

  return {
    list: () =>
      [...rules.values()].map((rule) => ({
        ...rule,
        triggered: state.get(rule.id)?.triggered || false,
        detail: state.get(rule.id)?.lastResult?.detail || null,
      })),
    add(raw) {
      if (rules.size >= MAX_RULES) return null;
      const rule = normalizeAlertRule(raw);
      if (!rule) return null;
      rules.set(rule.id, rule);
      persist();
      onChange();
      return rule;
    },
    remove(id) {
      const removed = rules.delete(id);
      state.delete(id);
      if (removed) {
        persist();
        onChange();
      }
      return removed;
    },
    setEnabled(id, enabled) {
      const rule = rules.get(id);
      if (!rule) return false;
      rule.enabled = Boolean(enabled);
      if (!rule.enabled) state.delete(id);
      persist();
      onChange();
      return true;
    },
    /**
     * @param {(layerKey: string) => Array<object>} getRecords
     * @param {number} [now]
     * @returns {Array<{rule: object, result: object}>} Rules that tripped now.
     */
    evaluate(getRecords, now = Date.now()) {
      const tripped = [];
      let changed = false;
      for (const rule of rules.values()) {
        if (!rule.enabled) continue;
        const result = evaluateAlertRule(
          rule,
          getRecords(rule.layerKey) || [],
          now,
        );
        const prior = state.get(rule.id);
        const wasTriggered = prior?.triggered || false;
        state.set(rule.id, {
          triggered: result.triggered,
          lastResult: result,
          trippedAt: result.triggered
            ? wasTriggered
              ? prior.trippedAt
              : now
            : null,
        });
        if (result.triggered !== wasTriggered) changed = true;
        if (result.triggered && !wasTriggered) {
          tripped.push({ rule, result });
          onTrip(rule, result);
        }
      }
      if (changed) onChange();
      return tripped;
    },
    activeTrips: () =>
      [...rules.values()]
        .filter((rule) => state.get(rule.id)?.triggered)
        .map((rule) => ({
          rule,
          result: state.get(rule.id).lastResult,
          trippedAt: state.get(rule.id).trippedAt,
        })),
  };
}
