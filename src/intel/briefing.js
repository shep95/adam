/**
 * Situational brief: one structured read across every loaded layer.
 *
 * "Brief me on what's active" → aircraft, vessels, fires, quakes, satellites,
 * anything anomalous against the rolling baseline, tripped alert triggers and
 * feeds that are not live. The brief is built from the same analyst records
 * and layer snapshots the rest of the app reads, so its numbers match the
 * panels.
 */

const MPS_TO_KTS = 1.943844;

const LAYER_LABELS = Object.freeze({
  flights: 'Aircraft',
  military: 'Military aircraft',
  'ais-live-vessels': 'Vessels',
  'local-firms': 'Active fires',
  earthquakes: 'Earthquakes',
  satellites: 'Satellites',
  'fire-perimeters': 'Fire perimeters',
});

function finite(values) {
  return values.filter((v) => Number.isFinite(v));
}

function max(values) {
  const nums = finite(values);
  return nums.length ? Math.max(...nums) : null;
}

/**
 * Summarize one layer's records into brief lines.
 *
 * @param {string} layerKey
 * @param {Array<object>} records
 * @returns {{count: number, facts: Array<string>}}
 */
export function summarizeLayer(layerKey, records) {
  const rows = Array.isArray(records) ? records : [];
  const count = rows.length;
  const facts = [];
  if (layerKey === 'flights' || layerKey === 'military') {
    const airborne = rows.filter((r) => r.onGround !== true).length;
    if (count)
      facts.push(`${airborne} airborne, ${count - airborne} on ground`);
    const military = rows.filter((r) => r.military === true).length;
    if (layerKey === 'flights' && military) facts.push(`${military} military`);
    const highest = max(rows.map((r) => r.altitudeM));
    if (highest !== null)
      facts.push(
        `highest ${Math.round(highest * 3.28084).toLocaleString()} ft`,
      );
  } else if (layerKey === 'ais-live-vessels') {
    const speeds = rows.map((r) =>
      Number.isFinite(r.speedKts)
        ? r.speedKts
        : Number.isFinite(r.speedMps)
          ? r.speedMps * MPS_TO_KTS
          : null,
    );
    const underway = speeds.filter((s) => Number.isFinite(s) && s > 1).length;
    if (count) facts.push(`${underway} underway`);
    const fast = speeds.filter((s) => Number.isFinite(s) && s > 25).length;
    if (fast) facts.push(`${fast} faster than 25 kt`);
  } else if (layerKey === 'local-firms') {
    const hottest = max(rows.map((r) => r.frp));
    if (hottest !== null) facts.push(`peak FRP ${Math.round(hottest)} MW`);
    const high = rows.filter((r) =>
      /^(h|high)$/i.test(String(r.confidence || '')),
    ).length;
    if (high) facts.push(`${high} high-confidence`);
  } else if (layerKey === 'earthquakes') {
    const strongest = rows.reduce(
      (best, r) =>
        Number.isFinite(r.magnitude) &&
        r.magnitude > (best?.magnitude ?? -Infinity)
          ? r
          : best,
      null,
    );
    if (strongest)
      facts.push(
        `strongest M${strongest.magnitude.toFixed(1)}${strongest.place ? ` ${strongest.place}` : ''}`,
      );
    const significant = rows.filter((r) => r.magnitude >= 5).length;
    if (significant) facts.push(`${significant} at M5+`);
  } else if (layerKey === 'satellites') {
    const groups = new Map();
    for (const r of rows) {
      const g = r.satelliteClass || r.group;
      if (g) groups.set(g, (groups.get(g) || 0) + 1);
    }
    const top = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (top.length) facts.push(top.map(([g, n]) => `${n} ${g}`).join(', '));
  }
  return { count, facts };
}

/**
 * Build the brief.
 *
 * @param {{
 *   layers: Array<{id: string, name?: string, enabled: boolean, feedState: string, ageLabel?: string|null}>,
 *   getRecords: (layerKey: string) => Array<object>,
 *   baselineStore?: ?{anomalies: Function},
 *   alertTrips?: Array<{rule: object, result: object}>,
 *   now?: number,
 * }} input
 */
export function buildSituationBrief({
  layers = [],
  getRecords,
  baselineStore = null,
  alertTrips = [],
  now = Date.now(),
}) {
  const enabled = layers.filter((l) => l.enabled);
  const sections = [];
  const anomalies = [];
  for (const layer of enabled) {
    const records = getRecords?.(layer.id) || [];
    const hasRecords = Object.hasOwn(LAYER_LABELS, layer.id);
    const summary = hasRecords
      ? summarizeLayer(layer.id, records)
      : { count: Number(layer.count) || 0, facts: [] };
    sections.push({
      layerKey: layer.id,
      label: LAYER_LABELS[layer.id] || layer.name || layer.id,
      count: summary.count,
      facts: summary.facts,
      feedState: layer.feedState,
      ageLabel: layer.ageLabel || null,
    });
    if (baselineStore && hasRecords && records.length) {
      anomalies.push(
        ...baselineStore.anomalies(layer.id, records, { limit: 2 }),
      );
    }
  }
  const feedIssues = enabled
    .filter((l) => l.feedState && !['nominal', 'off'].includes(l.feedState))
    .map((l) => ({
      layerKey: l.id,
      label: LAYER_LABELS[l.id] || l.name || l.id,
      feedState: l.feedState,
      ageLabel: l.ageLabel || null,
    }));
  const alerts = alertTrips.map(({ rule, result }) => ({
    id: rule.id,
    label: rule.label,
    detail: result?.detail || '',
  }));

  const headlineBits = sections
    .filter((s) => LAYER_LABELS[s.layerKey])
    .map((s) => `${s.count.toLocaleString()} ${s.label.toLowerCase()}`);
  const headline = enabled.length
    ? headlineBits.join(' · ') || `${enabled.length} layers active`
    : 'No data layers are active.';

  const spokenParts = [];
  if (!enabled.length) {
    spokenParts.push(
      'Nothing is loaded right now. Turn on a layer and ask again.',
    );
  } else {
    for (const s of sections) {
      const facts = s.facts.length ? `, ${s.facts.join(', ')}` : '';
      const state =
        s.feedState && s.feedState !== 'nominal'
          ? ` (${String(s.feedState).toUpperCase()})`
          : '';
      spokenParts.push(`${s.label}: ${s.count}${facts}${state}.`);
    }
    if (alerts.length)
      spokenParts.push(
        `${alerts.length} alert trigger${alerts.length === 1 ? '' : 's'} tripped: ${alerts
          .map((a) => a.label)
          .join('; ')}.`,
      );
    const notable = anomalies.filter((a) => a.level !== 'quiet');
    if (notable.length)
      spokenParts.push(
        `Anomalous: ${notable.map((a) => a.statement).join(' ')}`,
      );
    if (feedIssues.length)
      spokenParts.push(
        `Not live: ${feedIssues
          .map((f) => `${f.label} ${String(f.feedState).toUpperCase()}`)
          .join(', ')}.`,
      );
  }

  return {
    generatedAt: new Date(now).toISOString(),
    headline,
    sections,
    anomalies,
    alerts,
    feedIssues,
    spoken: spokenParts.join(' '),
  };
}
