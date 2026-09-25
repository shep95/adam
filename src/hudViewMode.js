/**
 * View mode from camera altitude, and the metrics that make sense in it.
 * Surface imagery metrics (GSD, NIIRS) and surface signals (AIS) are only
 * meaningful near the ground; from orbit the HUD shows scale instead of a
 * zeroed-out imagery grade.
 */

export const VIEW_MODES = Object.freeze([
  { id: 'surface', label: 'SURFACE', maxAltM: 60_000 },
  { id: 'near-space', label: 'NEAR-SPACE', maxAltM: 2_000_000 },
  { id: 'orbital', label: 'ORBITAL', maxAltM: Infinity },
]);

/** @returns {{id: string, label: string}} */
export function viewModeFor(altM) {
  const alt = Number.isFinite(altM) ? altM : 0;
  const mode = VIEW_MODES.find((m) => alt < m.maxAltM) || VIEW_MODES.at(-1);
  return { id: mode.id, label: mode.label };
}

/** Altitude with units that stay readable from 3 m to 400,000 km. */
export function formatAltitude(altM) {
  if (!Number.isFinite(altM)) return '--';
  if (Math.abs(altM) < 10_000) return `${Math.round(altM)}m`;
  return `${Math.round(altM / 1000).toLocaleString('en-US')}km`;
}

/**
 * The imagery line for the current view: GSD + NIIRS at the surface, GSD
 * only near space (NIIRS has zeroed out), scale from orbit.
 */
export function imageryLine(altM, gsdM, niirs) {
  const mode = viewModeFor(altM).id;
  if (mode === 'orbital') return 'SCALE: GLOBAL';
  const gsd =
    gsdM >= 1000 ? `${(gsdM / 1000).toFixed(1)}KM` : `${gsdM.toFixed(2)}M`;
  if (mode === 'near-space' || !(niirs >= 0.5))
    return `GSD: ${gsd}  SCALE: REGIONAL`;
  return `GSD: ${gsd}  NIIRS: ${niirs.toFixed(1)}`;
}

/** Collection context line under the classification, per view mode. */
export function collectionLine(altM, missionId, sensorId) {
  const mode = viewModeFor(altM).id;
  if (mode === 'surface') return `${missionId}  ${sensorId} · EO SURFACE`;
  if (mode === 'near-space') return `${missionId}  ${sensorId} · WIDE AREA`;
  return `GLOBAL WATCH · ${sensorId}`;
}

/** AIS is a sea-level signal: shown only near the surface and when populated. */
export function showAisField(altM, text) {
  return (
    viewModeFor(altM).id === 'surface' &&
    !/:\s*-+\s*$/.test(String(text || '').trim())
  );
}
