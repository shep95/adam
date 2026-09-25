/**
 * Cross-layer correlation: behaviour in one domain lining up in space and
 * time with behaviour in another. Single-layer findings come from the pattern
 * watcher; this looks at how they sit together.
 *
 *   dark-near-military   a vessel went AIS-dark within 80 km of military
 *                        aircraft that are there now
 *   orbit-over-meeting   an aircraft orbit within 60 km of a vessel meeting
 *   orbit-over-dark      an aircraft orbit within 80 km of an AIS-dark vessel
 *   pattern-cluster      three or more findings of any kind within 60 km
 *
 * Every correlation is a lead with a plain alternative, never a conclusion.
 */
import { distanceKm } from './patternWatch.js';

const within = (a, b, km) =>
  Number.isFinite(a?.lat) &&
  Number.isFinite(b?.lat) &&
  distanceKm(a.lat, a.lon, b.lat, b.lon) <= km;

/**
 * @param {Array<object>} findings Pattern findings (patternWatch.findings()).
 * @param {{military?: object[], now?: number}} [context]
 */
export function correlate(
  findings = [],
  { military = [], now = Date.now() } = {},
) {
  const out = [];
  const byKind = (k) => findings.filter((f) => f.kind === k);
  const dark = byKind('ais-dark');
  const orbits = byKind('orbit');
  const meetings = byKind('meeting');

  for (const d of dark) {
    const near = military.filter((m) => !m.onGround && within(d, m, 80));
    if (near.length)
      out.push({
        kind: 'dark-near-military',
        title: 'AIS DARK NEAR MILITARY AIR',
        label: `${d.label} dark · ${near.length} military aircraft within 80 km`,
        lat: d.lat,
        lon: d.lon,
        since: d.since,
        confidence: Math.min(0.75, 0.35 + 0.1 * near.length),
        members: [d.id, ...near.slice(0, 4).map((m) => m.icao24 || m.id)],
        alternative: 'coverage gap during routine exercise or patrol traffic',
      });
  }
  for (const o of orbits) {
    for (const m of meetings)
      if (within(o, m, 60))
        out.push({
          kind: 'orbit-over-meeting',
          title: 'ORBIT OVER VESSEL MEETING',
          label: `${o.label} orbiting near ${m.label}`,
          lat: (o.lat + m.lat) / 2,
          lon: (o.lon + m.lon) / 2,
          since: Math.max(o.since, m.since),
          confidence: Math.min(0.7, (o.confidence + m.confidence) / 2 + 0.15),
          members: [o.id, m.id],
          alternative: 'survey or SAR training near an anchorage',
        });
    for (const d of dark)
      if (within(o, d, 80))
        out.push({
          kind: 'orbit-over-dark',
          title: 'ORBIT NEAR AIS-DARK VESSEL',
          label: `${o.label} orbiting near ${d.label} (dark)`,
          lat: (o.lat + d.lat) / 2,
          lon: (o.lon + d.lon) / 2,
          since: Math.max(o.since, d.since),
          confidence: Math.min(0.75, (o.confidence + d.confidence) / 2 + 0.2),
          members: [o.id, d.id],
          alternative: 'maritime patrol on a routine track, receiver gap',
        });
  }
  // Clusters: greedy grouping of findings within 60 km.
  const used = new Set();
  for (const f of findings) {
    if (used.has(f)) continue;
    const group = findings.filter((g) => !used.has(g) && within(f, g, 60));
    if (group.length >= 3) {
      group.forEach((g) => used.add(g));
      out.push({
        kind: 'pattern-cluster',
        title: 'PATTERN CLUSTER',
        label: `${group.length} behaviour findings within 60 km (${[...new Set(group.map((g) => g.kind))].join(', ')})`,
        lat: group.reduce((s, g) => s + g.lat, 0) / group.length,
        lon: group.reduce((s, g) => s + g.lon, 0) / group.length,
        since: Math.min(...group.map((g) => g.since || now)),
        confidence: Math.min(0.8, 0.3 + 0.1 * group.length),
        members: group.map((g) => g.id),
        alternative:
          'a busy area (port approach, training range) rather than one event',
      });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
