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
export function imageryLine(altM, gsdM) {
  const mode = viewModeFor(altM).id;
  if (mode !== 'surface') return '';
  const gsd =
    gsdM >= 1000 ? `${(gsdM / 1000).toFixed(1)} km` : `${gsdM.toFixed(2)} m`;
  return `~${gsd} per pixel`;
}

/**
 * Provenance line: where the picture comes from, stated plainly. Everything
 * on screen is public data; say how many live feeds are on and whether any
 * is degraded.
 */
export function provenanceLine(liveFeeds = 0, degraded = null) {
  const feeds =
    liveFeeds > 0
      ? `${liveFeeds} live feed${liveFeeds === 1 ? '' : 's'}`
      : 'no feeds on';
  return `public data · ${feeds}${degraded ? ` · ${degraded}` : ''}`;
}

/**
 * The coordinate readout that means something at this scale: MGRS and DMS
 * near the ground, three decimals regionally, one from orbit.
 */
export function coordinateText(latDeg, lonDeg, altM) {
  const mode = viewModeFor(altM).id;
  const ns = latDeg >= 0 ? 'N' : 'S';
  const ew = lonDeg >= 0 ? 'E' : 'W';
  const dp = mode === 'orbital' ? 1 : 3;
  return `${Math.abs(latDeg).toFixed(dp)}°${ns} ${Math.abs(lonDeg).toFixed(dp)}°${ew}`;
}

/** Degrees-minutes-seconds with the carry done (no 60.00"). */
export function toDMS(decimal, type) {
  const abs = Math.abs(decimal);
  let totalHundredths = Math.round(abs * 360000);
  const deg = Math.floor(totalHundredths / 360000);
  totalHundredths -= deg * 360000;
  const min = Math.floor(totalHundredths / 6000);
  const sec = (totalHundredths - min * 6000) / 100;
  const dir =
    type === 'lat' ? (decimal >= 0 ? 'N' : 'S') : decimal >= 0 ? 'E' : 'W';
  const degStr = String(deg).padStart(type === 'lon' ? 3 : 2, '0');
  return `${degStr}°${String(min).padStart(2, '0')}'${sec.toFixed(2).padStart(5, '0')}"${dir}`;
}

/** AIS is a sea-level signal: shown only near the surface and when populated. */
export function showAisField(altM, text) {
  return (
    viewModeFor(altM).id === 'surface' &&
    !/:\s*-+\s*$/.test(String(text || '').trim())
  );
}
