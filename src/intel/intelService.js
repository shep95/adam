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
import { assessExposure, assetRisk } from './exposure.js';
import { recommendActions } from './recommend.js';
import { etaToZone, predictTrack, predictionSentence } from './predict.js';
import { pointInPolygon } from './geo.js';
import { correlate } from './correlate.js';
import { missionWords, triage as rankTriage } from './triage.js';

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
export const MISSION_KEY = 'adam.intel.mission.v1';
export const WATCH_LOG_KEY = 'adam.intel.watchlog.v1';
export const ZONES_KEY = 'adam.intel.zones.v1';
export const FINDINGS_KEY = 'adam.intel.findings.v1';
const FINDINGS_MAX = 200;
const ZONES_MAX = 40;
const WATCH_LOG_MAX = 500;
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
  fetchImpl = (...a) => globalThis.fetch?.(...a),
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

  // ── Watch log: every trip and high-ranked watch item, timestamped ──────
  let watchLog = (readJson(localStorage, WATCH_LOG_KEY, []) || []).slice(
    -WATCH_LOG_MAX,
  );
  let notifyConfigured = null;
  async function notify(entry) {
    try {
      if (notifyConfigured === null) {
        const res = await fetchImpl('/api/notify', {
          credentials: 'same-origin',
        });
        notifyConfigured = res?.ok ? (await res.json()).configured > 0 : false;
      }
      if (!notifyConfigured) return false;
      const res = await fetchImpl('/api/notify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: entry.title,
          text: entry.detail,
          severity: entry.severity,
          lat: entry.lat,
          lon: entry.lon,
          at: new Date(entry.at).toISOString(),
        }),
      });
      return Boolean(res?.ok);
    } catch {
      return false;
    }
  }
  function logEvent(raw) {
    const entry = {
      at: now(),
      kind: String(raw.kind || 'note').slice(0, 30),
      severity: ['info', 'watch', 'alert', 'critical'].includes(raw.severity)
        ? raw.severity
        : 'watch',
      title: String(raw.title || '').slice(0, 140),
      detail: String(raw.detail || '').slice(0, 400),
      lat: Number.isFinite(raw.lat) ? raw.lat : null,
      lon: Number.isFinite(raw.lon) ? raw.lon : null,
      ref: raw.ref ? String(raw.ref).slice(0, 80) : null,
      score: Number.isFinite(raw.score) ? raw.score : null,
    };
    watchLog = [...watchLog, entry].slice(-WATCH_LOG_MAX);
    writeJson(localStorage, WATCH_LOG_KEY, watchLog);
    emit('watch-logged', entry);
    if (['alert', 'critical'].includes(entry.severity)) void notify(entry);
    return entry;
  }

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
    onTrip: (rule, result) => {
      const ring = rule.ring || [];
      logEvent({
        kind: 'alert',
        severity: 'alert',
        title: rule.label,
        detail: result.detail,
        lat: ring.length
          ? ring.reduce((s, p) => s + p[1], 0) / ring.length
          : null,
        lon: ring.length
          ? ring.reduce((s, p) => s + p[0], 0) / ring.length
          : null,
        ref: rule.id,
      });
      emit('alert-tripped', { rule, result });
    },
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

  // ── Zones: named areas the operator drew; alerts and Shepherd use them ──
  const cleanRing = (ring) =>
    (Array.isArray(ring) ? ring : [])
      .slice(0, 256)
      .map((p) => [Number(p?.[0]), Number(p?.[1])])
      .filter(
        ([lon, lat]) =>
          Number.isFinite(lon) &&
          Number.isFinite(lat) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180,
      );
  let zones = (readJson(localStorage, ZONES_KEY, []) || [])
    .map((z) => ({ ...z, ring: cleanRing(z?.ring) }))
    .filter((z) => z.id && z.ring.length >= 3)
    .slice(0, ZONES_MAX);
  const saveZones = () => {
    writeJson(localStorage, ZONES_KEY, zones);
    emit('zones-changed', zones);
  };

  // ── Findings: structured assessments that accumulate over a session ────
  let findings = (readJson(localStorage, FINDINGS_KEY, []) || []).slice(
    -FINDINGS_MAX,
  );
  const txt = (v, n) =>
    String(v ?? '')
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
      .slice(0, n);

  const patterns = createPatternWatch();
  let mission = readJson(localStorage, MISSION_KEY, null);

  function correlations() {
    return correlate(patterns.findings({ limit: 99 }), {
      military: getRecords('military'),
      now: now(),
    });
  }

  function triageItems({ limit = 12 } = {}) {
    const faults = layerRows()
      .filter(
        (l) => l.enabled && ['unavailable', 'stale'].includes(l.feedState),
      )
      .map((l) => ({
        id: l.id,
        name: l.name,
        state: l.feedState,
        age: l.ageLabel,
      }));
    const anomalies = service.anomalies({ limit: 6 }).map((a) => {
      const [s, w] = String(a.regionKey || '')
        .split(':')
        .map(Number);
      return Number.isFinite(s) ? { ...a, lat: s + 5, lon: w + 5 } : a;
    });
    return rankTriage({
      trips: alerts.activeTrips(),
      correlations: correlations(),
      exposure: assessExposure(getRecords, { now: now(), limit: 6 }),
      patterns: patterns.findings({ limit: 20 }),
      anomalies,
      faults,
      mission,
      now: now(),
    }).slice(0, limit);
  }
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

    /**
     * Record a finding: subject, location, time, confidence (0–1), source,
     * assessment, and the strongest alternative reading.
     */
    addFinding(raw = {}) {
      const conf = Number(raw.confidence);
      const f = {
        id: `F-${String(findings.length + 1).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6)}`,
        at: now(),
        subject: txt(raw.subject, 140) || 'untitled',
        location: {
          lat: Number.isFinite(raw.lat) ? raw.lat : null,
          lon: Number.isFinite(raw.lon) ? raw.lon : null,
          label: txt(raw.place, 120),
        },
        time: txt(raw.time, 60) || new Date(now()).toISOString(),
        confidence: Number.isFinite(conf)
          ? Math.max(0, Math.min(1, conf))
          : null,
        source: txt(raw.source, 300),
        assessment: txt(raw.assessment, 2000),
        alternative: txt(raw.alternative, 600),
        author: raw.author === 'operator' ? 'operator' : 'shepherd',
      };
      findings = [...findings, f].slice(-FINDINGS_MAX);
      writeJson(localStorage, FINDINGS_KEY, findings);
      emit('findings-changed', f);
      return f;
    },
    listFindings: () =>
      findings.map((f) => ({ ...f, location: { ...f.location } })),
    removeFinding(id) {
      const before = findings.length;
      findings = findings.filter((f) => f.id !== id);
      writeJson(localStorage, FINDINGS_KEY, findings);
      emit('findings-changed', null);
      return findings.length !== before;
    },
    listZones: () => zones.map((z) => ({ ...z, ring: z.ring.slice() })),
    zoneById: (id) => zones.find((z) => z.id === id || z.name === id) || null,
    addZone({ name = '', kind = 'polygon', ring = [], meta = {} } = {}) {
      const clean = cleanRing(ring);
      if (clean.length < 3 || zones.length >= ZONES_MAX) return null;
      const zone = {
        id: `zone-${Math.random().toString(36).slice(2, 9)}`,
        name:
          String(name || '')
            .replace(/[\u0000-\u001f<>]/g, '')
            .slice(0, 60) || `ZONE ${zones.length + 1}`,
        kind: ['polygon', 'circle', 'corridor'].includes(kind)
          ? kind
          : 'polygon',
        ring: clean,
        meta: {
          radiusKm: Number(meta.radiusKm) || null,
          widthKm: Number(meta.widthKm) || null,
          areaKm2: Number(meta.areaKm2) || null,
        },
        createdAt: now(),
      };
      zones = [...zones, zone];
      saveZones();
      return zone;
    },
    removeZone(id) {
      const before = zones.length;
      zones = zones.filter((z) => z.id !== id);
      if (zones.length !== before) saveZones();
      return zones.length !== before;
    },
    /** Append to the watch log (and notify for alert/critical). */
    logEvent,
    /** Watch log, newest first; filter by kind or since (ms epoch). */
    watchLog({ kind = null, since = 0, limit = 100 } = {}) {
      return watchLog
        .filter((e) => (!kind || e.kind === kind) && e.at >= since)
        .slice(-limit)
        .reverse();
    },
    clearWatchLog() {
      watchLog = [];
      writeJson(localStorage, WATCH_LOG_KEY, watchLog);
      emit('watch-logged', null);
    },
    /** Ranked next actions (decision support) from the watch items. */
    recommend({ limit = 6 } = {}) {
      return recommendActions(triageItems({ limit: 12 }), {
        mission,
        alertRings: alerts.list().map((r) => r.ring),
        pointInPolygon,
        limit,
      });
    },
    /** Live hazard risk per infrastructure asset, with its factors. */
    assetRisk: ({ limit = 10 } = {}) =>
      assetRisk(getRecords, { now: now(), limit }),
    /**
     * Predict a contact's track (dead reckoning with an uncertainty band)
     * and, given a zone id, when it would enter it.
     */
    predict({ layerKey, id, minutes = 240, zone = null } = {}) {
      const key = String(id || '')
        .trim()
        .toLowerCase();
      const match = (x) =>
        [x.mmsi, x.icao24, x.callsign, x.name, x.id].some(
          (v) => v != null && String(v).trim().toLowerCase() === key,
        );
      // No layer given: look through every contact layer.
      const layers = layerKey
        ? [layerKey]
        : ['ais-live-vessels', 'flights', 'military'];
      let r = null;
      for (const k of layers) {
        r = (getRecords(k) || []).find(match) || null;
        if (r) {
          layerKey = k;
          break;
        }
      }
      if (!r)
        return {
          ok: false,
          error: `${id} is not in ${layerKey || 'vessels, flights or military'} right now`,
        };
      const vessel = layerKey === 'ais-live-vessels';
      const track = predictTrack(
        {
          lat: r.lat,
          lon: r.lon,
          speedKts: vessel ? r.speedKts : (r.speedMps ?? NaN) * 1.943844,
          headingDeg: vessel ? r.courseDeg : r.heading,
          ageMs: Number.isFinite(r.lastSeenMs) ? now() - r.lastSeenMs : 0,
          domain: vessel ? 'vessel' : 'aircraft',
        },
        {
          horizonMin: Math.min(1440, Math.max(10, minutes)),
          stepMin: vessel ? 10 : 2,
        },
      );
      if (!track.length)
        return {
          ok: false,
          error: `${id} is stationary or has no course/speed`,
        };
      const name = r.name || r.callsign || r.id || id;
      const z = zone
        ? zones.find((q) => q.id === zone || q.name === zone)
        : null;
      const eta = z ? etaToZone(track, z.ring) : null;
      return {
        ok: true,
        name,
        layerKey,
        track,
        eta,
        sentence: z
          ? predictionSentence(name, eta, z.name)
          : `If ${name} holds course and speed it is ${Math.round(track.at(-1).min / 60)} h out at ${track.at(-1).lat.toFixed(3)}, ${track.at(-1).lon.toFixed(3)} (±${track.at(-1).radiusKm.toFixed(0)} km).`,
      };
    },
    /** Cross-layer correlations between behaviour findings and live contacts. */
    correlations,
    /** Everything worth attention, ranked 0–100 with a reason each. */
    triage: triageItems,
    /**
     * The operator's standing mission: plain words plus optional focus areas
     * ({lat, lon, radiusKm, label}); lifts matching items in triage.
     */
    setMission({ text = '', areas = [] } = {}) {
      const clean = String(text).slice(0, 500);
      mission =
        clean || areas.length
          ? {
              text: clean,
              words: missionWords(clean),
              areas: areas
                .filter(
                  (a) => Number.isFinite(a?.lat) && Number.isFinite(a?.lon),
                )
                .slice(0, 12)
                .map((a) => ({
                  lat: a.lat,
                  lon: a.lon,
                  radiusKm: Math.min(
                    2000,
                    Math.max(5, Number(a.radiusKm) || 100),
                  ),
                  label: String(a.label || '').slice(0, 60),
                })),
              at: now(),
            }
          : null;
      writeJson(localStorage, MISSION_KEY, mission);
      emit('mission-changed', mission);
      return mission;
    },
    getMission: () => (mission ? { ...mission } : null),

    /** Infrastructure (datacentres, dams) inside the reach of live quakes and strong fires. */
    exposure: ({ limit = 8 } = {}) =>
      assessExposure(getRecords, { now: now(), limit }),
    /** Held track history (~45 min) for rewind: range, positions at a time, one track. */
    rewind: {
      range: () => patterns.range(),
      snapshotAt: (at) => patterns.snapshotAt(at),
      trackOf: (layerKey, id) => patterns.trackOf(layerKey, id),
    },

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
