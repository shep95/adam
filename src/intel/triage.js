/**
 * Triage: one ranked list of what deserves attention first, across every
 * source the console has — tripped alerts, cross-layer correlations,
 * infrastructure exposure, behaviour patterns, baseline surges, feed faults.
 *
 * Scores are 0–100 and explainable (each item says why it ranks). The
 * operator's mission focus (plain words and/or areas) lifts matching items.
 */
import { distanceKm } from './patternWatch.js';

const HOUR = 3600_000;

const ageDecay = (since, now, halfLifeH = 2) =>
  Number.isFinite(since)
    ? 0.5 ** Math.max(0, (now - since) / (halfLifeH * HOUR))
    : 1;

function missionBoost(item, mission) {
  if (!mission) return 0;
  let boost = 0;
  const text = `${item.title} ${item.label} ${item.kind}`.toLowerCase();
  if ((mission.words || []).some((w) => w && text.includes(w))) boost += 12;
  if (
    Number.isFinite(item.lat) &&
    (mission.areas || []).some(
      (a) =>
        distanceKm(a.lat, a.lon, item.lat, item.lon) <= (a.radiusKm || 100),
    )
  )
    boost += 15;
  return boost;
}

/**
 * @param {{trips?: object[], correlations?: object[], exposure?: object[],
 *   patterns?: object[], anomalies?: object[], faults?: object[],
 *   mission?: {words?: string[], areas?: object[]}|null, now?: number}} input
 * @returns {Array<{id:string, kind:string, title:string, label:string,
 *   lat:number|null, lon:number|null, score:number, why:string, since:number|null}>}
 */
export function triage({
  trips = [],
  correlations = [],
  exposure = [],
  patterns = [],
  anomalies = [],
  faults = [],
  mission = null,
  now = Date.now(),
} = {}) {
  const items = [];
  const push = (item) => {
    const boost = missionBoost(item, mission);
    items.push({
      ...item,
      score: Math.round(Math.min(100, item.score + boost)),
      why: boost ? `${item.why} · matches mission` : item.why,
    });
  };

  for (const t of trips) {
    const ring = t.rule?.ring || [];
    const c = ring.length
      ? {
          lon: ring.reduce((s, p) => s + p[0], 0) / ring.length,
          lat: ring.reduce((s, p) => s + p[1], 0) / ring.length,
        }
      : { lat: null, lon: null };
    push({
      id: `alert:${t.rule?.id}`,
      kind: 'alert',
      title: `ALERT · ${String(t.rule?.label || '').toUpperCase()}`,
      label: t.result?.detail || '',
      ...c,
      since: t.trippedAt ?? null,
      score: 70 + 25 * ageDecay(t.trippedAt, now, 1),
      why: 'operator trigger tripped',
    });
  }
  for (const c of correlations)
    push({
      id: `corr:${c.kind}:${(c.members || []).join(',')}`,
      kind: c.kind,
      title: c.title,
      label: c.label,
      lat: c.lat,
      lon: c.lon,
      since: c.since ?? null,
      score: 45 + 45 * c.confidence * ageDecay(c.since, now, 3),
      why: `cross-layer correlation, conf ${c.confidence.toFixed(2)} · or: ${c.alternative}`,
    });
  for (const x of exposure)
    push({
      id: `exposure:${x.hazard.kind}:${x.hazard.lat.toFixed(2)},${x.hazard.lon.toFixed(2)}`,
      kind: 'exposure',
      title: `EXPOSURE · ${x.hazard.label.toUpperCase()}`,
      label: x.statement,
      lat: x.hazard.lat,
      lon: x.hazard.lon,
      since: null,
      score: Math.min(85, 40 + 6 * Math.log2(1 + (x.score || 1))),
      why: 'infrastructure inside hazard reach (screening radius)',
    });
  for (const p of patterns)
    push({
      id: `pattern:${p.kind}:${p.id}`,
      kind: p.kind,
      title: p.title || p.kind.toUpperCase(),
      label: `${p.label} · ${p.detail}`,
      lat: p.lat,
      lon: p.lon,
      since: p.since ?? null,
      score: 25 + 45 * p.confidence * ageDecay(p.since, now, 2),
      why: `behaviour pattern, conf ${p.confidence.toFixed(2)} · or: ${p.alternative}`,
    });
  for (const a of anomalies) {
    if (a.level === 'quiet') continue;
    push({
      id: `baseline:${a.layerKey}:${a.regionKey}`,
      kind: 'baseline',
      title: `${a.level === 'surge' ? 'SURGE' : 'DROP'} · ${String(a.layerKey).toUpperCase()}`,
      label: a.statement || '',
      lat: a.lat ?? null,
      lon: a.lon ?? null,
      since: null,
      score:
        a.level === 'surge'
          ? 45 + Math.min(20, Math.abs((a.ratio || 1) - 1) * 10)
          : 35,
      why: 'deviation from the 7-day baseline for this hour',
    });
  }
  for (const f of faults)
    push({
      id: `fault:${f.id}`,
      kind: 'fault',
      title: `FEED ${String(f.state).toUpperCase()} · ${String(f.name || f.id).toUpperCase()}`,
      label: f.age ? `last data ${f.age}` : '',
      lat: null,
      lon: null,
      since: null,
      score: f.state === 'unavailable' ? 30 : 20,
      why: 'the picture is incomplete here',
    });

  const seen = new Set();
  return items
    .filter((i) => (seen.has(i.id) ? false : seen.add(i.id)))
    .sort((a, b) => b.score - a.score);
}

/** Parse a plain-language mission into focus words (areas come from tools). */
export function missionWords(text = '') {
  const stop = new Set(
    'the a an and or of to in on at for with any all watch watching today me my i we our is are be for from near around over this that what when show keep eye'.split(
      ' ',
    ),
  );
  return [
    ...new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((w) => w.length > 2 && !stop.has(w)),
    ),
  ].slice(0, 24);
}
