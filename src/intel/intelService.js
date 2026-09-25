/**
 * ADAM intel service: the runtime that ties the pure intel modules to the
 * live data manager.
 *
 * - samples every contact layer into the rolling baseline store
 * - evaluates alert triggers every few seconds and announces trips
 * - remembers the last tracked contact across view-mode changes
 * - holds up to four pinned contacts for the comparison rail
 * - builds the situational brief on demand
 *
 * One instance per application; voice actions reach it through
 * `getIntelService()`.
 */

import { createBaselineStore, regionKeyFor } from './baselineStore.js';
import { createAlertMonitor } from './alertRules.js';
import {
  briefDelta,
  briefSnapshot,
  buildSituationBrief,
  formatBriefMarkdown,
} from './briefing.js';
import { layerSnapshots } from '../data/layerSnapshot.js';
import { createPatternWatch } from './patternWatch.js';

export const BASELINE_LAYERS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'local-firms',
  'earthquakes',
]);
export const PIN_LIMIT = 4;
const SAMPLE_INTERVAL_MS = 5 * 60_000;
const FIRST_SAMPLE_DELAY_MS = 90_000;
const ALERT_INTERVAL_MS = 5_000;
const RECORD_LIMIT = 20_000;
const LAST_TRACKED_KEY = 'adam.intel.lastTracked.v1';
const PINS_KEY = 'adam.intel.pins.v1';
const LAST_BRIEF_KEY = 'adam.intel.lastBrief.v1';
/** Fine baselines apply below this camera altitude, around the view. */
export const FINE_BASELINE_MAX_ALT_M = 200_000;
const FINE_CELL_DEG = 1;
const FINE_FOCUS_DEG = 3;

let activeService = null;

export function getIntelService() {
  return activeService;
}

/** Identity fields a contact can be found by, in preference order. */
const IDENTITY_FIELDS = ['icao24', 'mmsi', 'noradId', 'id'];

export function contactKeyFor(layerKey, record) {
  for (const field of IDENTITY_FIELDS) {
    const value = record?.[field];
    if (value !== null && value !== undefined && String(value).trim())
      return { layerKey, field, value: String(value).trim() };
  }
  return null;
}

function safeStorage(kind) {
  try {
    const storage = globalThis[kind];
    const probe = '__adam_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function sanitizeContactRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const layerKey = String(raw.layerKey || '').slice(0, 40);
  const field = IDENTITY_FIELDS.includes(raw.field) ? raw.field : null;
  const value = String(raw.value ?? '').slice(0, 64);
  if (!layerKey || !field || !value) return null;
  return {
    layerKey,
    field,
    value,
    label: String(raw.label || value).slice(0, 64),
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
  };
}

/**
 * @param {{dataManager: object, events?: EventTarget, now?: () => number,
 *          localStorage?: object|null, sessionStorage?: object|null,
 *          timers?: {setInterval: Function, clearInterval: Function, setTimeout: Function, clearTimeout: Function}}} options
 */
export function createIntelService({
  dataManager,
  events = typeof window === 'undefined' ? null : window,
  now = () => Date.now(),
  localStorage = safeStorage('localStorage'),
  sessionStorage = safeStorage('sessionStorage'),
  timers = globalThis,
} = {}) {
  const listeners = new Set();
  const emit = (type, detail) => {
    for (const listener of [...listeners]) {
      try {
        listener(type, detail);
      } catch (error) {
        console.warn('[intel] listener failed:', error);
      }
    }
    events?.dispatchEvent?.(new CustomEvent(`adam:${type}`, { detail }));
  };

  const baselines = createBaselineStore({ storage: localStorage, now });
  // Fine 1° cells, sampled only around the operator's focus when zoomed in:
  // a 10° cell is noise for a port, a base or a chokepoint.
  const fineBaselines = createBaselineStore({
    storage: localStorage,
    now,
    cellDeg: FINE_CELL_DEG,
    storageKey: 'adam.intel.baselines.fine.v1',
  });
  let focus = null;
  const inFocus = (r) =>
    focus &&
    Math.abs(Number(r?.lat) - focus.lat) <= FINE_FOCUS_DEG &&
    Math.abs(((Number(r?.lon) - focus.lon + 540) % 360) - 180) <=
      FINE_FOCUS_DEG;
  const fineActive = () =>
    Boolean(focus && focus.altM < FINE_BASELINE_MAX_ALT_M);
  const alerts = createAlertMonitor({
    storage: localStorage,
    onTrip: (rule, result) => emit('alert-tripped', { rule, result }),
    onChange: () => emit('alerts-changed', null),
  });

  let lastTracked = sanitizeContactRef(
    readJson(sessionStorage, LAST_TRACKED_KEY, null),
  );
  let pins = (readJson(sessionStorage, PINS_KEY, []) || [])
    .map(sanitizeContactRef)
    .filter(Boolean)
    .slice(0, PIN_LIMIT);

  const isEnabled = (layerKey) => {
    try {
      return Boolean(dataManager?.isEnabled?.(layerKey));
    } catch {
      return false;
    }
  };

  function getRecords(layerKey) {
    if (!isEnabled(layerKey)) return [];
    const module = dataManager?.layers?.get(layerKey)?.module;
    if (typeof module?.getAnalystRecords !== 'function') return [];
    try {
      return module.getAnalystRecords(RECORD_LIMIT) || [];
    } catch {
      return [];
    }
  }

  function findRecord(ref) {
    if (!ref) return null;
    const records = getRecords(ref.layerKey);
    return (
      records.find((r) => String(r?.[ref.field] ?? '').trim() === ref.value) ||
      null
    );
  }

  function layerRows() {
    try {
      return layerSnapshots(dataManager?.getAll?.() || []);
    } catch {
      return [];
    }
  }

  function sampleBaselines() {
    for (const layerKey of BASELINE_LAYERS) {
      const records = getRecords(layerKey);
      if (records.length) baselines.sample(layerKey, records);
      if (fineActive()) {
        const local = records.filter(inFocus);
        if (local.length) fineBaselines.sample(layerKey, local);
      }
    }
    baselines.persist();
    fineBaselines.persist();
    emit('baselines-sampled', { size: baselines.size() });
  }

  const patterns = createPatternWatch();
  let patternCount = 0;

  function evaluateAlerts() {
    const t = now();
    alerts.evaluate(getRecords, t);
    try {
      if (patterns.sample(getRecords, t)) {
        const n = patterns.findings({ limit: 99 }).length;
        if (n !== patternCount) {
          patternCount = n;
          emit('patterns-changed', { count: n });
        }
      }
    } catch (error) {
      console.warn('[intel] pattern watch failed:', error);
    }
  }

  function rememberTracked(layerKey, id, label) {
    if (!layerKey || !id) return;
    const records = getRecords(layerKey);
    const record = records.find((r) =>
      IDENTITY_FIELDS.some((f) => String(r?.[f] ?? '') === String(id)),
    );
    const key = record
      ? contactKeyFor(layerKey, record)
      : {
          layerKey,
          field: layerKey === 'ais-live-vessels' ? 'mmsi' : 'icao24',
          value: String(id),
        };
    lastTracked = sanitizeContactRef({ ...key, label: label || id, at: now() });
    writeJson(sessionStorage, LAST_TRACKED_KEY, lastTracked);
    emit('last-tracked-changed', lastTracked);
  }

  const onAwarenessSelected = (event) => {
    const detail = event?.detail;
    if (!detail?.layerId || !detail?.id) return;
    if (!['flights', 'military', 'satellites'].includes(detail.layerId)) return;
    rememberTracked(detail.layerId, detail.id, detail.label);
  };
  const onEntitySelected = (event) => {
    const detail = event?.detail;
    if (detail?.layerId !== 'ais-live-vessels') return;
    const mmsi =
      detail.properties?.mmsi || String(detail.id || '').replace(/^ais-/, '');
    rememberTracked(detail.layerId, mmsi, detail.label);
  };

  const handles = [];
  let started = false;

  const service = {
    baselines,
    alerts,
    getRecords,
    findRecord,
    layerRows,

    start() {
      if (started) return service;
      started = true;
      events?.addEventListener?.(
        'gev:awareness-subject-selected',
        onAwarenessSelected,
      );
      events?.addEventListener?.('gev:entity-selected', onEntitySelected);
      handles.push([
        'timeout',
        timers.setTimeout(sampleBaselines, FIRST_SAMPLE_DELAY_MS),
      ]);
      handles.push([
        'interval',
        timers.setInterval(sampleBaselines, SAMPLE_INTERVAL_MS),
      ]);
      handles.push([
        'interval',
        timers.setInterval(evaluateAlerts, ALERT_INTERVAL_MS),
      ]);
      activeService = service;
      return service;
    },

    stop() {
      events?.removeEventListener?.(
        'gev:awareness-subject-selected',
        onAwarenessSelected,
      );
      events?.removeEventListener?.('gev:entity-selected', onEntitySelected);
      for (const [kind, handle] of handles.splice(0)) {
        if (kind === 'timeout') timers.clearTimeout(handle);
        else timers.clearInterval(handle);
      }
      baselines.persist();
      if (activeService === service) activeService = null;
      started = false;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    sampleBaselines,
    evaluateAlerts,

    /** Behaviour patterns over the last ~45 min (orbits, AIS dark, meetings, jumps). */
    patterns: (options) => patterns.findings(options),

    /** Anomalous regions for every sampled layer, strongest first. */
    anomalies({ limit = 6 } = {}) {
      const out = [];
      for (const layerKey of BASELINE_LAYERS) {
        const records = getRecords(layerKey);
        if (records.length)
          out.push(...baselines.anomalies(layerKey, records, { limit: 3 }));
      }
      return out
        .sort(
          (a, b) => Math.abs((b.ratio || 0) - 1) - Math.abs((a.ratio || 0) - 1),
        )
        .slice(0, limit);
    },

    /**
     * Baseline assessment for the region containing a point, for each layer.
     */
    assessAt(lat, lon, layerKeys = BASELINE_LAYERS) {
      const regionKey = regionKeyFor(lat, lon);
      if (!regionKey) return [];
      const out = [];
      for (const layerKey of layerKeys) {
        if (!BASELINE_LAYERS.includes(layerKey)) continue;
        const records = getRecords(layerKey);
        if (!records.length) continue;
        const count = records.filter(
          (r) => regionKeyFor(r.lat, r.lon) === regionKey,
        ).length;
        out.push(baselines.assess(layerKey, regionKey, count));
      }
      return out;
    },

    /** Where the operator is looking; enables fine 1° baselines up close. */
    setFocus(lat, lon, altM) {
      if (![lat, lon, altM].every(Number.isFinite)) return;
      focus = { lat, lon, altM };
    },
    getFocus: () => (focus ? { ...focus, fine: fineActive() } : null),

    /**
     * Situational brief. `delta` compares with the previous brief this
     * session; `format: 'markdown'` adds a BLUF-first written product.
     */
    brief({ delta = false, format = 'spoken' } = {}) {
      const fine = fineActive();
      const brief = buildSituationBrief({
        layers: layerRows(),
        getRecords: fine ? (key) => getRecords(key) : getRecords,
        baselineStore: baselines,
        alertTrips: alerts.activeTrips(),
        now: now(),
      });
      if (fine) {
        const local = [];
        for (const layerKey of BASELINE_LAYERS) {
          const records = getRecords(layerKey).filter(inFocus);
          if (records.length)
            local.push(
              ...fineBaselines.anomalies(layerKey, records, { limit: 3 }),
            );
        }
        brief.anomalies = [...local, ...brief.anomalies].slice(0, 8);
        brief.baselineScale =
          '1° cells around the view (zoomed in), 10° cells elsewhere';
      } else brief.baselineScale = '10° cells';
      const previous = readJson(sessionStorage, LAST_BRIEF_KEY, null);
      if (delta) {
        brief.delta = briefDelta(previous, brief);
        if (brief.delta) brief.spoken = `${brief.spoken} ${brief.delta.spoken}`;
      }
      writeJson(sessionStorage, LAST_BRIEF_KEY, briefSnapshot(brief));
      if (format === 'markdown')
        brief.markdown = formatBriefMarkdown(brief, brief.delta || null);
      return brief;
    },

    getLastTracked() {
      if (!lastTracked) return null;
      return { ...lastTracked, record: findRecord(lastTracked) };
    },
    rememberTracked,
    clearLastTracked() {
      lastTracked = null;
      writeJson(sessionStorage, LAST_TRACKED_KEY, null);
      emit('last-tracked-changed', null);
    },

    getPins() {
      return pins.map((pin) => ({ ...pin, record: findRecord(pin) }));
    },
    /** Pin a contact; returns false when the rail is full or it is pinned. */
    pin(layerKey, record, label) {
      const key = contactKeyFor(layerKey, record);
      if (!key) return false;
      if (
        pins.some((p) => p.layerKey === key.layerKey && p.value === key.value)
      )
        return false;
      if (pins.length >= PIN_LIMIT) return false;
      const ref = sanitizeContactRef({
        ...key,
        label: label || record?.callsign || record?.name || key.value,
        at: now(),
      });
      if (!ref) return false;
      pins = [...pins, ref];
      writeJson(sessionStorage, PINS_KEY, pins);
      emit('pins-changed', pins);
      return true;
    },
    unpin(layerKey, value) {
      const before = pins.length;
      pins = pins.filter(
        (p) => !(p.layerKey === layerKey && p.value === value),
      );
      if (pins.length === before) return false;
      writeJson(sessionStorage, PINS_KEY, pins);
      emit('pins-changed', pins);
      return true;
    },
  };
  return service;
}
