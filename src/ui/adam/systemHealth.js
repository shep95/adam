/**
 * System health: one read of what is down, stale or running on a fallback.
 *
 * Pure — takes layer snapshots (src/data/layerSnapshot.js) plus a few
 * capability facts and returns a level for the HEALTH chip and the rows for
 * its panel. The chip pulses amber when more than one layer is UNAVAILABLE or
 * STALE; a single fault shows a count without the pulse.
 */

const DOWN = new Set(['unavailable']);
const STALE = new Set(['stale']);
const FALLBACK = new Set(['fallback', 'partial', 'degraded']);

/**
 * @param {Array<object>} snapshots Layer snapshots (enabled layers only are read).
 * @param {{online?: boolean, photoreal?: boolean|null, shepherd?: {configured:number}|null,
 *          voice?: boolean|null, webgl?: boolean}} [capabilities]
 * @returns {{level: 'nominal'|'watch'|'degraded', faults: number,
 *            down: object[], stale: object[], fallback: object[],
 *            capabilities: Array<{id:string,label:string,ok:boolean,detail:string}>}}
 */
export function assessHealth(snapshots = [], capabilities = {}) {
  const enabled = (Array.isArray(snapshots) ? snapshots : []).filter(
    (s) => s && s.enabled !== false && s.feedState && s.feedState !== 'off',
  );
  const row = (s) => ({
    id: s.id,
    name: s.name || s.id,
    state: s.feedState,
    age: s.ageLabel || null,
    source: s.source || null,
    error: s.error || null,
  });
  const down = enabled.filter((s) => DOWN.has(s.feedState)).map(row);
  const stale = enabled.filter((s) => STALE.has(s.feedState)).map(row);
  const fallback = enabled.filter((s) => FALLBACK.has(s.feedState)).map(row);

  const caps = [];
  const cap = (id, label, ok, detail) => caps.push({ id, label, ok, detail });
  if (capabilities.online === false)
    cap('network', 'NETWORK', false, 'browser reports offline');
  if (capabilities.webgl === false)
    cap('webgl', 'WEBGL', false, 'context lost — reload to recover');
  if (capabilities.effectsReduced)
    cap('render', 'RENDER', false, 'reduced effects — GPU under frame budget');
  if (capabilities.photoreal === false)
    cap('photoreal', '3D TILES', false, 'keyless imagery + OSM extrusion');
  else if (capabilities.photoreal === true)
    cap('photoreal', '3D TILES', true, 'photoreal');
  if (capabilities.shepherd) {
    const n = Number(capabilities.shepherd.configured) || 0;
    cap(
      'shepherd',
      'SHEPHERD',
      n > 0,
      n > 0 ? `${n} provider${n === 1 ? '' : 's'}` : 'no provider key',
    );
  } else if (capabilities.shepherd === null) {
    cap('shepherd', 'SHEPHERD', false, 'status unreachable');
  }

  const hardFaults = down.length + stale.length;
  const capFaults = caps.filter(
    (c) => !c.ok && ['network', 'webgl'].includes(c.id),
  ).length;
  const faults = hardFaults + fallback.length + capFaults;
  const level =
    hardFaults > 1 || capFaults > 0
      ? 'degraded'
      : faults > 0
        ? 'watch'
        : 'nominal';
  return { level, faults, down, stale, fallback, capabilities: caps };
}

/** One line for Shepherd / the brief. */
export function healthLine(health) {
  if (!health || health.level === 'nominal') return 'all enabled feeds nominal';
  const bits = [];
  if (health.down.length)
    bits.push(`down: ${health.down.map((r) => r.id).join(', ')}`);
  if (health.stale.length)
    bits.push(`stale: ${health.stale.map((r) => r.id).join(', ')}`);
  if (health.fallback.length)
    bits.push(`fallback: ${health.fallback.map((r) => r.id).join(', ')}`);
  for (const c of health.capabilities)
    if (!c.ok) bits.push(`${c.label.toLowerCase()}: ${c.detail}`);
  return bits.join(' · ');
}
