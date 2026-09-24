/**
 * Rolling activity baselines per layer, per geographic region, per hour of day.
 *
 * The analyst can count what is loaded; this module knows whether that count
 * is normal. Every sample bins a layer's loaded records into fixed-size
 * lat/lon cells ("regions"). Each (layer, region, UTC hour) key keeps one
 * running mean per day for the trailing seven days. The baseline for "now" is
 * the mean of the previous days' means for the same hour, so today's samples
 * never inflate their own baseline.
 *
 * Storage is injected (localStorage in the browser, a Map in tests). Only
 * aggregate counts are stored, never identities or tracks.
 */

export const BASELINE_WINDOW_DAYS = 7;
export const BASELINE_CELL_DEG = 10;
export const BASELINE_STORAGE_KEY = 'adam.intel.baselines.v1';
const MIN_BASELINE_DAYS = 2;
const MAX_KEYS = 6000;
const DAY_MS = 86_400_000;

/**
 * Region key for a coordinate: the south-west corner of its grid cell.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {number} [cellDeg]
 * @returns {?string}
 */
export function regionKeyFor(lat, lon, cellDeg = BASELINE_CELL_DEG) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const clampedLat = Math.max(-90, Math.min(89.999, lat));
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const south = Math.floor(clampedLat / cellDeg) * cellDeg;
  const west = Math.floor(wrappedLon / cellDeg) * cellDeg;
  return `${south}:${west}`;
}

/**
 * Human label for a region key ("30N–40N, 100W–90W").
 *
 * @param {string} key
 * @param {number} [cellDeg]
 * @returns {string}
 */
export function regionLabel(key, cellDeg = BASELINE_CELL_DEG) {
  const [south, west] = String(key).split(':').map(Number);
  if (!Number.isFinite(south) || !Number.isFinite(west)) return String(key);
  const lat = (v) => `${Math.abs(v)}${v >= 0 ? 'N' : 'S'}`;
  const lon = (v) => `${Math.abs(v)}${v >= 0 ? 'E' : 'W'}`;
  return `${lat(south)}–${lat(south + cellDeg)}, ${lon(west)}–${lon(west + cellDeg)}`;
}

/**
 * Bin records with finite lat/lon into region counts.
 *
 * @param {Array<{lat?: number, lon?: number}>} records
 * @param {number} [cellDeg]
 * @returns {Map<string, number>}
 */
export function countByRegion(records, cellDeg = BASELINE_CELL_DEG) {
  const counts = new Map();
  for (const record of records || []) {
    const key = regionKeyFor(record?.lat, record?.lon, cellDeg);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Classify a count against its baseline.
 *
 * @param {number} count
 * @param {?number} mean
 * @param {number} days - Days of history behind the mean.
 * @returns {{level: 'insufficient'|'quiet'|'normal'|'elevated'|'surge', ratio: ?number}}
 */
export function classifyActivity(count, mean, days) {
  if (!Number.isFinite(mean) || days < MIN_BASELINE_DAYS) {
    return { level: 'insufficient', ratio: null };
  }
  const ratio = mean > 0 ? count / mean : count > 0 ? Infinity : 1;
  const delta = count - mean;
  if (ratio >= 3 && delta >= 5) return { level: 'surge', ratio };
  if (ratio >= 1.5 && delta >= 3) return { level: 'elevated', ratio };
  if (ratio <= 0.4 && mean >= 5) return { level: 'quiet', ratio };
  return { level: 'normal', ratio };
}

/** Sentence fragment the analyst can speak verbatim. */
export function describeActivity(assessment) {
  const { level, ratio, layerKey, regionName, count, mean } = assessment;
  const where = regionName ? ` in ${regionName}` : '';
  const what = layerKey || 'activity';
  if (level === 'insufficient') {
    return `No baseline yet for ${what}${where} at this hour; ADAM needs at least ${MIN_BASELINE_DAYS} days of observation.`;
  }
  const times = Number.isFinite(ratio) ? `${ratio.toFixed(1)}x` : 'far above';
  const avg = Number.isFinite(mean) ? mean.toFixed(1) : '?';
  if (level === 'surge' || level === 'elevated') {
    return `${what}${where} is ${level === 'surge' ? 'surging' : 'elevated'}: ${count} now vs a ${avg} average for this hour over the last ${assessment.days} days (${times}).`;
  }
  if (level === 'quiet') {
    return `${what}${where} is unusually quiet: ${count} now vs a ${avg} average for this hour (${times}).`;
  }
  return `${what}${where} is normal for this hour: ${count} now vs a ${avg} average.`;
}

/**
 * @param {{storage?: {getItem: Function, setItem: Function}|null, now?: () => number, cellDeg?: number}} [options]
 */
export function createBaselineStore({
  storage = null,
  now = () => Date.now(),
  cellDeg = BASELINE_CELL_DEG,
} = {}) {
  /** @type {Map<string, Array<{day: number, mean: number, n: number}>>} */
  let entries = new Map();
  let dirty = false;

  const load = () => {
    if (!storage) return;
    try {
      const raw = storage.getItem(BASELINE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      entries = new Map(
        Object.entries(parsed)
          .filter(([, days]) => Array.isArray(days))
          .map(([key, days]) => [
            key,
            days
              .filter(
                (d) =>
                  Number.isInteger(d?.day) &&
                  Number.isFinite(d?.mean) &&
                  Number.isInteger(d?.n) &&
                  d.n > 0,
              )
              .slice(-BASELINE_WINDOW_DAYS - 1),
          ]),
      );
    } catch {
      entries = new Map();
    }
  };

  const persist = () => {
    if (!storage || !dirty) return;
    dirty = false;
    try {
      storage.setItem(
        BASELINE_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries)),
      );
    } catch {
      /* quota or private mode: the in-memory baseline still works */
    }
  };

  const keyOf = (layerKey, regionKey, hour) =>
    `${layerKey}|${regionKey}|${hour}`;

  const prune = (today) => {
    const oldest = today - BASELINE_WINDOW_DAYS;
    for (const [key, days] of entries) {
      const kept = days.filter((d) => d.day >= oldest);
      if (kept.length) entries.set(key, kept);
      else entries.delete(key);
    }
    if (entries.size > MAX_KEYS) {
      // Drop the least-observed keys first.
      const ranked = [...entries].sort(
        (a, b) =>
          a[1].reduce((s, d) => s + d.n, 0) - b[1].reduce((s, d) => s + d.n, 0),
      );
      for (const [key] of ranked.slice(0, entries.size - MAX_KEYS))
        entries.delete(key);
    }
  };

  const clock = (at = now()) => {
    const date = new Date(at);
    return { day: Math.floor(at / DAY_MS), hour: date.getUTCHours() };
  };

  load();

  return {
    /**
     * Record one observation of a layer's loaded records.
     * Regions with no records this sample are recorded as zero only when they
     * already have history, so quiet periods lower the mean.
     *
     * @param {string} layerKey
     * @param {Array<{lat?: number, lon?: number}>} records
     */
    sample(layerKey, records) {
      if (!layerKey) return;
      const { day, hour } = clock();
      const counts = countByRegion(records, cellDeg);
      const prefix = `${layerKey}|`;
      const suffix = `|${hour}`;
      for (const key of entries.keys()) {
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        const regionKey = key.slice(prefix.length, key.length - suffix.length);
        if (!counts.has(regionKey)) counts.set(regionKey, 0);
      }
      for (const [regionKey, count] of counts) {
        const key = keyOf(layerKey, regionKey, hour);
        const days = entries.get(key) || [];
        const last = days[days.length - 1];
        if (last?.day === day) {
          last.mean = last.mean + (count - last.mean) / (last.n + 1);
          last.n += 1;
        } else {
          days.push({ day, mean: count, n: 1 });
        }
        entries.set(key, days);
      }
      prune(day);
      dirty = true;
    },

    /**
     * Baseline for (layer, region) at the current UTC hour, excluding today.
     *
     * @returns {{mean: ?number, days: number}}
     */
    baseline(layerKey, regionKey, at = now()) {
      const { day, hour } = clock(at);
      const days = (entries.get(keyOf(layerKey, regionKey, hour)) || []).filter(
        (d) => d.day < day && d.day >= day - BASELINE_WINDOW_DAYS,
      );
      if (!days.length) return { mean: null, days: 0 };
      const mean = days.reduce((s, d) => s + d.mean, 0) / days.length;
      return { mean, days: days.length };
    },

    /**
     * Assess a current count for a region against its baseline.
     */
    assess(layerKey, regionKey, count, { regionName = null } = {}) {
      const { mean, days } = this.baseline(layerKey, regionKey);
      const { level, ratio } = classifyActivity(count, mean, days);
      const assessment = {
        layerKey,
        regionKey,
        regionName: regionName || regionLabel(regionKey, cellDeg),
        count,
        mean,
        days,
        level,
        ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : ratio,
      };
      assessment.statement = describeActivity(assessment);
      return assessment;
    },

    /**
     * Assess every region a layer's current records occupy and return the
     * anomalous ones, strongest first.
     */
    anomalies(layerKey, records, { limit = 5 } = {}) {
      const counts = countByRegion(records, cellDeg);
      const out = [];
      for (const [regionKey, count] of counts) {
        const assessment = this.assess(layerKey, regionKey, count);
        if (
          assessment.level === 'elevated' ||
          assessment.level === 'surge' ||
          assessment.level === 'quiet'
        )
          out.push(assessment);
      }
      out.sort(
        (a, b) => Math.abs((b.ratio || 0) - 1) - Math.abs((a.ratio || 0) - 1),
      );
      return out.slice(0, limit);
    },

    regionKeyFor: (lat, lon) => regionKeyFor(lat, lon, cellDeg),
    persist,
    size: () => entries.size,
    clear() {
      entries.clear();
      dirty = true;
      persist();
    },
  };
}
