/**
 * 24-hour track archive. Every few minutes the positions of tracked aircraft
 * and vessels are written to IndexedDB, so REWIND can go back a day, not just
 * the ~45 minutes the pattern watcher holds in memory. It records while ADAM
 * is open in this browser; older than 24 h is pruned.
 */

export const ARCHIVE_LAYERS = ['flights', 'military', 'ais-live-vessels'];
export const ARCHIVE_MS = 24 * 3600_000;
export const SAMPLE_MS = 3 * 60_000;
const DB_NAME = 'adam-archive';
const STORE = 'snapshots';
const PER_LAYER = 1500;

const IDS = ['icao24', 'mmsi', 'id', 'callsign'];

/** Records by layer → one compact snapshot. */
export function packSnapshot(recordsByLayer, t) {
  const rows = [];
  for (const [layerKey, records] of Object.entries(recordsByLayer || {})) {
    for (const r of (records || []).slice(0, PER_LAYER)) {
      if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) continue;
      const id = IDS.map((k) => r[k]).find(
        (v) => v != null && String(v).trim(),
      );
      if (!id) continue;
      rows.push([
        layerKey,
        String(id).trim(),
        +r.lat.toFixed(4),
        +r.lon.toFixed(4),
      ]);
    }
  }
  return { t, rows };
}

export function unpackRows(snapshot) {
  return (snapshot?.rows || []).map(([layerKey, id, lat, lon]) => ({
    layerKey,
    id,
    lat,
    lon,
  }));
}

/** Index of the timestamp closest to `t` in a sorted list. */
export function nearestIndex(times, t) {
  if (!times.length) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t))
    return lo - 1;
  return lo;
}

function openDb(indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: 't' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (db, mode, fn) =>
  new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function createTrackArchive({
  intel,
  indexedDB = globalThis.indexedDB,
  now = () => Date.now(),
  sampleMs = SAMPLE_MS,
} = {}) {
  let db = null;
  let times = [];
  let timer = null;
  const cache = new Map();

  async function ready() {
    if (db || !indexedDB) return db;
    db = await openDb(indexedDB);
    times = (await tx(db, 'readonly', (s) => request(s.getAllKeys()))).sort(
      (a, b) => a - b,
    );
    return db;
  }

  async function prune() {
    const cutoff = now() - ARCHIVE_MS;
    const old = times.filter((t) => t < cutoff);
    if (!old.length) return;
    await tx(db, 'readwrite', (s) => old.forEach((t) => s.delete(t)));
    times = times.filter((t) => t >= cutoff);
    for (const t of old) cache.delete(t);
  }

  async function sample() {
    if (!(await ready())) return null;
    const byLayer = {};
    for (const k of ARCHIVE_LAYERS) byLayer[k] = intel?.getRecords?.(k) || [];
    const snap = packSnapshot(byLayer, now());
    if (!snap.rows.length) return null;
    await tx(db, 'readwrite', (s) => s.put(snap));
    times.push(snap.t);
    await prune();
    return snap.rows.length;
  }

  async function snapshotAt(t) {
    if (!(await ready())) return [];
    const i = nearestIndex(times, t);
    if (i < 0) return [];
    const key = times[i];
    if (!cache.has(key)) {
      const snap = await tx(db, 'readonly', (s) => request(s.get(key)));
      cache.set(key, unpackRows(snap));
      if (cache.size > 30) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }

  return {
    start() {
      if (timer || !indexedDB) return;
      void ready()
        .then(() => sample())
        .catch(() => {});
      timer = setInterval(() => void sample().catch(() => {}), sampleMs);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    sample,
    snapshotAt,
    range: () =>
      times.length
        ? { from: times[0], to: times.at(-1), snapshots: times.length }
        : null,
    async clear() {
      if (!(await ready())) return;
      await tx(db, 'readwrite', (s) => s.clear());
      times = [];
      cache.clear();
    },
  };
}
