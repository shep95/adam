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

/** Compact snapshot of a brief, kept to compute the next brief's changes. */
export function briefSnapshot(brief) {
  return {
    at: brief.generatedAt,
    counts: Object.fromEntries(
      brief.sections.map((s) => [s.layerKey, s.count]),
    ),
    labels: Object.fromEntries(
      brief.sections.map((s) => [s.layerKey, s.label]),
    ),
    anomalies: brief.anomalies
      .filter((a) => a.level !== 'quiet')
      .map((a) => `${a.layerKey}|${a.regionKey}|${a.level}`),
    alerts: brief.alerts.map((a) => a.id),
  };
}

/**
 * What changed between a previous brief snapshot and this brief: count
 * movement per layer, new and cleared anomalies, new and cleared alerts.
 */
export function briefDelta(previous, brief) {
  if (!previous?.at) return null;
  const now = briefSnapshot(brief);
  const keys = new Set([
    ...Object.keys(previous.counts || {}),
    ...Object.keys(now.counts),
  ]);
  const counts = [...keys]
    .map((layerKey) => {
      const before = previous.counts?.[layerKey] ?? 0;
      const after = now.counts[layerKey] ?? 0;
      return {
        layerKey,
        label: now.labels[layerKey] || previous.labels?.[layerKey] || layerKey,
        before,
        after,
        change: after - before,
      };
    })
    .filter((c) => c.change !== 0);
  const setDiff = (a = [], b = []) => a.filter((x) => !b.includes(x));
  const delta = {
    since: previous.at,
    counts,
    newAnomalies: setDiff(now.anomalies, previous.anomalies),
    clearedAnomalies: setDiff(previous.anomalies, now.anomalies),
    newAlerts: setDiff(now.alerts, previous.alerts),
    clearedAlerts: setDiff(previous.alerts, now.alerts),
  };
  const mins = Math.max(
    0,
    Math.round(
      (Date.parse(brief.generatedAt) - Date.parse(previous.at)) / 60000,
    ),
  );
  const parts = counts.map(
    (c) =>
      `${c.label} ${c.change > 0 ? 'up' : 'down'} ${Math.abs(c.change)} to ${c.after}`,
  );
  if (delta.newAnomalies.length)
    parts.push(
      `${delta.newAnomalies.length} new anomal${delta.newAnomalies.length === 1 ? 'y' : 'ies'}`,
    );
  if (delta.clearedAnomalies.length)
    parts.push(`${delta.clearedAnomalies.length} cleared`);
  if (delta.newAlerts.length)
    parts.push(
      `${delta.newAlerts.length} new alert${delta.newAlerts.length === 1 ? '' : 's'} tripped`,
    );
  delta.spoken = parts.length
    ? `Since the last brief ${mins} minutes ago: ${parts.join('; ')}.`
    : `No change since the last brief ${mins} minutes ago.`;
  return delta;
}

/** Written product: BLUF first, supporting detail, provenance, confidence. */
export function formatBriefMarkdown(brief, delta = null) {
  const lines = [];
  const notable = brief.anomalies.filter((a) => a.level !== 'quiet');
  const bluf = [brief.headline];
  if (brief.alerts.length)
    bluf.push(`${brief.alerts.length} alert trigger(s) tripped`);
  if (notable.length) bluf.push(notable[0].statement);
  if (delta && delta.counts.length) bluf.push(delta.spoken);
  lines.push(
    `# Situation brief — ${brief.generatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`,
    '',
  );
  lines.push(`**BLUF:** ${bluf.join(' — ')}`, '');
  lines.push('## Activity');
  for (const s of brief.sections) {
    const state =
      s.feedState && s.feedState !== 'nominal'
        ? ` _(${String(s.feedState).toUpperCase()}${s.ageLabel ? `, ${s.ageLabel}` : ''})_`
        : '';
    lines.push(
      `- **${s.label}:** ${s.count.toLocaleString('en-US')}${s.facts.length ? ` — ${s.facts.join(', ')}` : ''}${state}`,
    );
  }
  if (!brief.sections.length) lines.push('- No data layers are active.');
  if (delta) {
    lines.push(
      '',
      `## Change since ${delta.since.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`,
    );
    if (
      !delta.counts.length &&
      !delta.newAnomalies.length &&
      !delta.newAlerts.length
    )
      lines.push('- No change.');
    for (const c of delta.counts)
      lines.push(
        `- ${c.label}: ${c.before} → ${c.after} (${c.change > 0 ? '+' : ''}${c.change})`,
      );
    if (delta.newAnomalies.length)
      lines.push(`- New anomalies: ${delta.newAnomalies.length}`);
    if (delta.clearedAnomalies.length)
      lines.push(`- Cleared anomalies: ${delta.clearedAnomalies.length}`);
    if (delta.newAlerts.length)
      lines.push(`- New alerts: ${delta.newAlerts.length}`);
  }
  if (notable.length) {
    lines.push('', '## Anomalies (vs 7-day baseline, same hour)');
    for (const a of notable) lines.push(`- ${a.statement}`);
  }
  if (brief.alerts.length) {
    lines.push('', '## Alerts tripped');
    for (const a of brief.alerts)
      lines.push(`- ${a.label}${a.detail ? ` — ${a.detail}` : ''}`);
  }
  if (brief.feedIssues.length) {
    lines.push('', '## Feed status');
    for (const f of brief.feedIssues)
      lines.push(
        `- ${f.label}: ${String(f.feedState).toUpperCase()}${f.ageLabel ? ` (${f.ageLabel})` : ''}`,
      );
  }
  lines.push('', '## Coverage');
  lines.push(
    '- Counts cover data loaded by enabled layers, not the whole world.',
  );
  lines.push(
    `- Baselines: ${brief.baselineScale || '10° cells'}; a baseline needs at least two days of history for the same hour.`,
  );
  const signal = brief.feedIssues.length ? 'moderate' : 'strong';
  const conf = brief.feedIssues.length ? 0.65 : 0.85;
  lines.push(
    '',
    `confidence: ${conf.toFixed(2)} · signal: ${signal} · evidence: live layer counts and rolling baselines · unknown: coverage outside loaded feeds`,
  );
  return lines.join('\n');
}
