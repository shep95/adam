/**
 * Pattern watchers: behaviour over time, not a single snapshot.
 *
 * Keeps a short decimated position history per contact (aircraft by ICAO24,
 * vessels by MMSI) and runs four detectors over it:
 *
 *   orbit        aircraft turning ≥ 720° inside a 30 km circle in 25 min —
 *                holding, survey, training or an ISR orbit
 *   ais-dark     a vessel that was reporting under way stops reporting for
 *                20+ min (coverage gap, transponder off, or port arrival)
 *   meeting      two vessels ≤ 500 m apart, both ≤ 3 kt, for 20+ min, in
 *                open water — anchorage or a ship-to-ship transfer
 *   jump         a position change implying an impossible speed — a feed
 *                glitch or spoofed AIS
 *
 * Every finding carries a confidence and the plainest alternative reading;
 * none is a conclusion. Contacts are craft, never people.
 */

const EARTH_KM = 6371;
const RAD = Math.PI / 180;

export const PATTERN_DEFAULTS = Object.freeze({
  sampleEveryMs: 30_000,
  historyMs: 45 * 60_000,
  maxTracks: 6000,
  orbitWindowMs: 25 * 60_000,
  orbitMinTurnDeg: 720,
  orbitMaxRadiusKm: 30,
  darkAfterMs: 20 * 60_000,
  darkForgetMs: 6 * 3600_000,
  darkMinKts: 3,
  meetMaxKm: 0.5,
  meetMaxKts: 3,
  meetMinMs: 20 * 60_000,
  jumpMaxKtsVessel: 60,
  jumpMaxKtsAircraft: 1100,
});

export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(aLat, aLon, bLat, bLon) {
  const y = Math.sin((bLon - aLon) * RAD) * Math.cos(bLat * RAD);
  const x =
    Math.cos(aLat * RAD) * Math.sin(bLat * RAD) -
    Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos((bLon - aLon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const turn = (a, b) => ((b - a + 540) % 360) - 180;

/** Total signed turning of a track in degrees (headings or derived bearings). */
export function cumulativeTurnDeg(points) {
  const headings = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (Number.isFinite(p.heading)) headings.push(p.heading);
    else if (i > 0) {
      const q = points[i - 1];
      if (distanceKm(q.lat, q.lon, p.lat, p.lon) > 0.2)
        headings.push(bearingDeg(q.lat, q.lon, p.lat, p.lon));
    }
  }
  let total = 0;
  for (let i = 1; i < headings.length; i += 1)
    total += turn(headings[i - 1], headings[i]);
  return total;
}

function centroid(points) {
  let lat = 0;
  let x = 0;
  let y = 0;
  for (const p of points) {
    lat += p.lat;
    x += Math.cos(p.lon * RAD);
    y += Math.sin(p.lon * RAD);
  }
  return { lat: lat / points.length, lon: Math.atan2(y, x) / RAD };
}

const KIND_LABEL = {
  orbit: 'ORBIT',
  'ais-dark': 'AIS DARK',
  meeting: 'VESSEL MEETING',
  jump: 'POSITION JUMP',
};

function identity(layerKey, r) {
  if (layerKey === 'ais-live-vessels') return r.mmsi || null;
  return r.icao24 || null;
}

/**
 * @param {Partial<typeof PATTERN_DEFAULTS>} [options]
 */
export function createPatternWatch(options = {}) {
  const o = { ...PATTERN_DEFAULTS, ...options };
  /** @type {Map<string, {layerKey:string,id:string,label:string,points:object[],lastSeenMs:number|null,movingAt:number|null}>} */
  const tracks = new Map();
  const jumps = new Map();
  const meetings = new Map();
  let lastSampleAt = -Infinity;

  function trackFor(layerKey, id, label) {
    const key = `${layerKey}:${id}`;
    let t = tracks.get(key);
    if (!t) {
      if (tracks.size >= o.maxTracks) tracks.delete(tracks.keys().next().value);
      t = { layerKey, id, label, points: [], lastSeenMs: null, movingAt: null };
      tracks.set(key, t);
    }
    t.label = label || t.label;
    return t;
  }

  function observe(layerKey, records, now) {
    const vessel = layerKey === 'ais-live-vessels';
    const maxKts = vessel ? o.jumpMaxKtsVessel : o.jumpMaxKtsAircraft;
    for (const r of records || []) {
      const id = identity(layerKey, r);
      if (!id || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      if (!vessel && r.onGround) continue;
      const t = trackFor(layerKey, id, r.name || r.callsign || r.id || id);
      const seen = Number.isFinite(r.lastSeenMs) ? r.lastSeenMs : now;
      const prev = t.points[t.points.length - 1];
      if (prev && seen <= prev.t) continue;
      if (prev) {
        const hours = (seen - prev.t) / 3600_000;
        const km = distanceKm(prev.lat, prev.lon, r.lat, r.lon);
        if (hours > 0 && km > 2 && km / 1.852 / hours > maxKts)
          jumps.set(`${layerKey}:${id}`, {
            kind: 'jump',
            layerKey,
            id,
            label: t.label,
            lat: r.lat,
            lon: r.lon,
            since: seen,
            confidence: 0.5,
            detail: `${km.toFixed(1)} km in ${Math.max(1, Math.round(hours * 60))} min (≈${Math.round(km / 1.852 / hours)} kt)`,
            alternative: 'feed glitch or mixed-up identity',
          });
      }
      const kts = vessel
        ? r.speedKts
        : Number.isFinite(r.speedMps)
          ? r.speedMps * 1.943844
          : null;
      t.points.push({
        t: seen,
        lat: r.lat,
        lon: r.lon,
        heading: vessel ? r.courseDeg : r.heading,
        kts,
      });
      t.lastSeenMs = seen;
      if (vessel && Number.isFinite(kts) && kts >= o.darkMinKts)
        t.movingAt = seen;
      const cutoff = now - o.historyMs;
      while (t.points.length && t.points[0].t < cutoff) t.points.shift();
    }
  }

  function detectOrbits(now) {
    const out = [];
    for (const t of tracks.values()) {
      if (t.layerKey === 'ais-live-vessels') continue;
      const pts = t.points.filter((p) => p.t >= now - o.orbitWindowMs);
      if (pts.length < 6 || now - pts[pts.length - 1].t > 5 * 60_000) continue;
      const c = centroid(pts);
      const radius = Math.max(
        ...pts.map((p) => distanceKm(c.lat, c.lon, p.lat, p.lon)),
      );
      if (radius > o.orbitMaxRadiusKm) continue;
      const turned = Math.abs(cumulativeTurnDeg(pts));
      if (turned < o.orbitMinTurnDeg) continue;
      out.push({
        kind: 'orbit',
        layerKey: t.layerKey,
        id: t.id,
        label: t.label,
        lat: c.lat,
        lon: c.lon,
        since: pts[0].t,
        confidence: Math.min(0.9, 0.5 + (turned - o.orbitMinTurnDeg) / 2000),
        detail: `${Math.round(turned / 360)} turns within ${radius.toFixed(1)} km`,
        alternative: 'holding pattern, training or survey',
      });
    }
    return out;
  }

  function detectDark(now) {
    const out = [];
    for (const [key, t] of tracks) {
      if (t.layerKey !== 'ais-live-vessels' || t.movingAt == null) continue;
      const silent = now - t.lastSeenMs;
      if (silent > o.darkForgetMs) {
        tracks.delete(key);
        continue;
      }
      if (silent < o.darkAfterMs || t.movingAt < t.lastSeenMs - 10 * 60_000)
        continue;
      const reports = t.points.length;
      if (reports < 3) continue;
      const last = t.points[t.points.length - 1];
      out.push({
        kind: 'ais-dark',
        layerKey: t.layerKey,
        id: t.id,
        label: t.label,
        lat: last.lat,
        lon: last.lon,
        since: t.lastSeenMs,
        confidence: silent > 2 * o.darkAfterMs ? 0.6 : 0.4,
        detail: `silent ${Math.round(silent / 60_000)} min after ${Math.round(last.kts ?? 0)} kt`,
        alternative: 'receiver coverage gap or arrival in port',
      });
    }
    return out;
  }

  function detectMeetings(now, records) {
    const slow = (records || []).filter(
      (r) =>
        r.mmsi &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        Number.isFinite(r.speedKts) &&
        r.speedKts <= o.meetMaxKts,
    );
    // 0.01° buckets keep this near-linear for thousands of slow vessels.
    const grid = new Map();
    for (const r of slow) {
      const k = `${Math.floor(r.lat * 100)}:${Math.floor(r.lon * 100)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(r);
    }
    const close = new Set();
    for (const r of slow) {
      const bi = Math.floor(r.lat * 100);
      const bj = Math.floor(r.lon * 100);
      for (let di = -1; di <= 1; di += 1)
        for (let dj = -1; dj <= 1; dj += 1)
          for (const s of grid.get(`${bi + di}:${bj + dj}`) || []) {
            if (s.mmsi <= r.mmsi) continue;
            if (distanceKm(r.lat, r.lon, s.lat, s.lon) > o.meetMaxKm) continue;
            const key = `${r.mmsi}|${s.mmsi}`;
            close.add(key);
            const m = meetings.get(key) || { since: now };
            m.lat = (r.lat + s.lat) / 2;
            m.lon = (r.lon + s.lon) / 2;
            m.labels = [r.name || r.mmsi, s.name || s.mmsi];
            m.crowd =
              (grid.get(`${bi}:${bj}`) || []).length > 6 ? 'crowded' : 'open';
            meetings.set(key, m);
          }
    }
    for (const key of meetings.keys())
      if (!close.has(key)) meetings.delete(key);
    const out = [];
    for (const [key, m] of meetings) {
      if (now - m.since < o.meetMinMs || m.crowd === 'crowded') continue;
      out.push({
        kind: 'meeting',
        layerKey: 'ais-live-vessels',
        id: key,
        label: m.labels.join(' + '),
        lat: m.lat,
        lon: m.lon,
        since: m.since,
        confidence: 0.35,
        detail: `≤${Math.round(o.meetMaxKm * 1000)} m apart, both ≤${o.meetMaxKts} kt for ${Math.round((now - m.since) / 60_000)} min`,
        alternative: 'shared anchorage, pilot boarding or bunkering',
      });
    }
    return out;
  }

  let findings = [];

  return {
    /**
     * Feed the latest records; decimates to one sample per sampleEveryMs.
     * @param {(layerKey: string) => object[]} getRecords
     * @param {number} now
     */
    sample(getRecords, now) {
      if (now - lastSampleAt < o.sampleEveryMs) return false;
      lastSampleAt = now;
      const vessels = getRecords('ais-live-vessels') || [];
      observe('ais-live-vessels', vessels, now);
      for (const layerKey of ['flights', 'military'])
        observe(layerKey, getRecords(layerKey) || [], now);
      for (const [key, j] of jumps)
        if (now - j.since > 30 * 60_000) jumps.delete(key);
      findings = [
        ...detectOrbits(now),
        ...detectDark(now),
        ...detectMeetings(now, vessels),
        ...jumps.values(),
      ].sort((a, b) => b.confidence - a.confidence);
      return true;
    },
    findings({ kind = null, limit = 20 } = {}) {
      return findings
        .filter((f) => !kind || f.kind === kind)
        .slice(0, limit)
        .map((f) => ({ ...f, title: KIND_LABEL[f.kind] || f.kind }));
    },
    trackCount: () => tracks.size,
    clear() {
      tracks.clear();
      jumps.clear();
      meetings.clear();
      findings = [];
    },
  };
}
