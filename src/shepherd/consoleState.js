/**
 * The [console] block: a compact, honest reading of what the operator is
 * looking at, attached to each Shepherd turn so the model answers about the
 * screen without a tool round-trip. Counts come from the same layer snapshot
 * the Data Layers chips use.
 */
import { layerSnapshots } from '../data/layerSnapshot.js';
import { snapshotPresentation } from '../intel/contactPresentation.js';
import { formatZoneTime, zoneFor } from './localTime.js';

const RAD = 180 / Math.PI;

export function cameraReading(viewer) {
  const carto = viewer?.camera?.positionCartographic;
  if (!carto) return null;
  return {
    lat: +(carto.latitude * RAD).toFixed(4),
    lon: +(carto.longitude * RAD).toFixed(4),
    altM: Math.round(carto.height),
    headingDeg: Math.round(((viewer.camera.heading || 0) * RAD + 360) % 360),
    pitchDeg: Math.round((viewer.camera.pitch || 0) * RAD),
  };
}

function trackedLabel(viewer) {
  const entity = viewer?.trackedEntity;
  if (!entity) return null;
  return String(entity.name || entity.id || 'entity').slice(0, 80);
}

/**
 * @param {object} deps
 * @returns {object} structured state (also what get_console_state returns)
 */
export function readConsoleState({
  viewer,
  dataManager,
  intel,
  overlay,
  buildings,
  tzLookup,
  now = new Date(),
}) {
  const camera = cameraReading(viewer);
  const zone =
    camera && tzLookup ? zoneFor(tzLookup, camera.lat, camera.lon) : null;
  const local = formatZoneTime(zone, now);
  let layers = [];
  try {
    layers = layerSnapshots(dataManager?.getAll?.() || [])
      .filter((l) => l.enabled)
      .map((l) => ({
        id: l.id,
        count: l.count,
        feed: l.feedState,
        age: l.ageLabel || null,
      }));
  } catch {
    layers = [];
  }
  const presentation = snapshotPresentation?.() || {};
  const alerts = intel?.alerts?.list?.() || intel?.alerts?.rules?.() || [];
  return {
    utc: now.toISOString().replace(/\.\d+Z$/, 'Z'),
    camera,
    localTime: local
      ? `${local.abbr} ${local.time} (${local.zone}, ${local.date})`
      : null,
    tracking: trackedLabel(viewer),
    layers,
    pins: (intel?.getPins?.() || []).map((p) => `${p.layerKey}:${p.label}`),
    lastTracked: intel?.getLastTracked?.()?.label || null,
    filters: presentation,
    alertRules: Array.isArray(alerts) ? alerts.length : 0,
    overlay: overlay?.summary?.() || null,
    buildings3d: buildings?.state?.() || null,
    mission: intel?.getMission?.()?.text || null,
    zones: (intel?.listZones?.() || []).map(
      (z) => `${z.name} (${z.kind}, ${z.id})`,
    ),
    watch: (() => {
      try {
        return (intel?.triage?.({ limit: 5 }) || []).map(
          (t) => `${t.score} ${t.title}${t.label ? ` — ${t.label}` : ''}`,
        );
      } catch {
        return [];
      }
    })(),
  };
}

/** Render the structured state as the terse text block the model reads. */
export function formatConsoleBlock(state) {
  const lines = [`utc ${state.utc}`];
  if (state.camera)
    lines.push(
      `camera ${state.camera.lat},${state.camera.lon} alt ${state.camera.altM}m hdg ${state.camera.headingDeg} pitch ${state.camera.pitchDeg}`,
    );
  if (state.localTime) lines.push(`local time at view ${state.localTime}`);
  if (state.tracking) lines.push(`tracking ${state.tracking}`);
  lines.push(
    `layers on: ${
      state.layers.length
        ? state.layers
            .map(
              (l) =>
                `${l.id}=${l.count}${l.feed !== 'nominal' ? `(${l.feed})` : ''}`,
            )
            .join(' ')
        : 'none'
    }`,
  );
  if (state.pins.length) lines.push(`pinned: ${state.pins.join(', ')}`);
  if (state.lastTracked) lines.push(`last tracked: ${state.lastTracked}`);
  const f = state.filters || {};
  const filterBits = [];
  if (f.timeWindowMs)
    filterBits.push(`window ${Math.round(f.timeWindowMs / 60000)}m`);
  if (f.region) filterBits.push('region filter on');
  if (Array.isArray(f.altitudeBands) && f.altitudeBands.length < 5)
    filterBits.push(`alt ${f.altitudeBands.join('/')}`);
  if (f.staleness === false) filterBits.push('staleness fade off');
  if (filterBits.length) lines.push(`filters: ${filterBits.join(', ')}`);
  if (state.alertRules) lines.push(`alert rules: ${state.alertRules}`);
  if (state.overlay) lines.push(`overlay: ${state.overlay}`);
  if (state.buildings3d) lines.push(`3d buildings: ${state.buildings3d}`);
  if (state.mission) lines.push(`mission: ${state.mission}`);
  if (state.zones?.length) lines.push(`zones: ${state.zones.join(', ')}`);
  if (state.watch?.length)
    lines.push(`watch (ranked 0-100):\n  ${state.watch.join('\n  ')}`);
  return lines.join('\n');
}
