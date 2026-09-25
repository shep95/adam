/**
 * Decision support: what to do next, not just what is there.
 *
 * Turns the ranked watch items (triage.js) plus the operator's mission into
 * a short ranked list of concrete console actions, each with the reasoning
 * and a machine action the UI or Shepherd can execute:
 *
 *   fly          look at it
 *   arm-alert    put a trigger on the area so it cannot change unnoticed
 *   cctv         connect the nearest public camera
 *   track        follow the aircraft involved
 *   scenario     switch the console to the fitting watch setup
 *   health       open HEALTH when the picture itself is degraded
 */

const ACTION_WEIGHT = {
  'arm-alert': 1,
  cctv: 0.9,
  track: 0.95,
  fly: 0.8,
  scenario: 0.7,
  health: 0.75,
};

/**
 * @param {Array<object>} items Triage items.
 * @param {{mission?: object|null, alertRings?: Array<Array<[number, number]>>,
 *   pointInPolygon?: Function, limit?: number}} [ctx]
 */
export function recommendActions(items = [], ctx = {}) {
  const {
    mission = null,
    alertRings = [],
    pointInPolygon = null,
    limit = 6,
  } = ctx;
  const covered = (lat, lon) =>
    pointInPolygon && alertRings.some((r) => pointInPolygon(r, lon, lat));
  const out = [];
  const add = (a) =>
    out.push({
      ...a,
      rank: Math.round(a.base * (ACTION_WEIGHT[a.action.type] || 0.7)),
    });

  for (const it of items) {
    const at = Number.isFinite(it.lat) ? { lat: it.lat, lon: it.lon } : null;
    if (it.kind === 'fault') {
      add({
        title: `Check ${it.title.replace(/^FEED \w+ · /, '').toLowerCase()} feed`,
        why: `${it.title}: the picture is incomplete — judge absence of contacts accordingly.`,
        action: { type: 'health' },
        base: it.score,
        source: it.id,
      });
      continue;
    }
    if (at && !covered(at.lat, at.lon) && it.kind !== 'alert')
      add({
        title: `Arm a watch on ${it.title.toLowerCase()}`,
        why: `${it.label || it.title} is not covered by any alert zone; a trigger logs and notifies if it grows.`,
        action: {
          type: 'arm-alert',
          lat: at.lat,
          lon: at.lon,
          radiusNm: it.kind === 'exposure' ? 25 : 30,
          layer: /vessel|dark|meeting/.test(it.kind)
            ? 'ais-live-vessels'
            : 'military',
        },
        base: it.score,
        source: it.id,
      });
    if (
      at &&
      [
        'alert',
        'meeting',
        'ais-dark',
        'dark-near-military',
        'exposure',
      ].includes(it.kind)
    )
      add({
        title: `Look through the nearest camera`,
        why: `A public camera near ${it.title.toLowerCase()} may confirm what the data suggests.`,
        action: { type: 'cctv', lat: at.lat, lon: at.lon },
        base: it.score - 10,
        source: it.id,
      });
    if (['orbit', 'orbit-over-meeting', 'orbit-over-dark'].includes(it.kind))
      add({
        title: 'Track the orbiting aircraft',
        why: 'Following it shows whether the orbit holds, shifts or breaks off toward something.',
        action: { type: 'track', lat: at?.lat, lon: at?.lon, ref: it.id },
        base: it.score,
        source: it.id,
      });
    if (at)
      add({
        title: `Go to ${it.title.toLowerCase()}`,
        why: it.why,
        action: { type: 'fly', lat: at.lat, lon: at.lon },
        base: it.score - 15,
        source: it.id,
      });
  }
  if (mission?.areas?.length)
    for (const a of mission.areas)
      if (!covered(a.lat, a.lon))
        add({
          title: `Arm the mission area${a.label ? ` ${a.label}` : ''}`,
          why: 'Your mission names this area but no trigger watches it.',
          action: {
            type: 'arm-alert',
            lat: a.lat,
            lon: a.lon,
            radiusNm: Math.round((a.radiusKm || 100) / 1.852),
            layer: 'military',
          },
          base: 60,
          source: 'mission',
        });

  // One action per (type, place); best first.
  const seen = new Set();
  return out
    .sort((a, b) => b.rank - a.rank)
    .filter((a) => {
      const key = `${a.action.type}:${Math.round((a.action.lat ?? 0) * 10)}:${Math.round((a.action.lon ?? 0) * 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
