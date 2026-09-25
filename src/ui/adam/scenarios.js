/**
 * Scenario presets: one action sets up the console for a kind of watch —
 * the right layers on, everything else off (or added on top), a fitting
 * visual style hint, and a mission line so the watch ranking leans the same
 * way. Pure definitions + a small applier over the data manager.
 */

export const SCENARIOS = Object.freeze([
  {
    id: 'port-watch',
    label: 'PORT WATCH',
    summary: 'Vessels, road traffic, harbour CCTV, military air, radar',
    layers: [
      'ais-live-vessels',
      'traffic',
      'cctv',
      'military',
      'weather-radar',
      'maritime-zones',
    ],
    mission:
      'port approaches: vessels loitering, going dark or meeting; military air over the port',
  },
  {
    id: 'airspace',
    label: 'AIRSPACE WATCH',
    summary: 'All aircraft, military, FIRs and restricted areas, lightning',
    layers: [
      'flights',
      'military',
      'airspace-firs',
      'airspace-restricted',
      'weather-lightning',
      'weather-radar',
    ],
    mission:
      'airspace: orbits, military activity, aircraft near restricted areas, storms on routes',
  },
  {
    id: 'chokepoints',
    label: 'MARITIME CHOKEPOINTS',
    summary: 'Straits and canals, vessels, military, cables, maritime zones',
    layers: [
      'infra-chokepoints',
      'ais-live-vessels',
      'military',
      'telegeography-submarine-cables',
      'maritime-zones',
    ],
    mission:
      'chokepoints: dark vessels, meetings, military presence, cable landings',
  },
  {
    id: 'storm',
    label: 'STORM WATCH',
    summary: 'Radar, satellite IR, lightning, wind, cyclones, flights',
    layers: [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'wind',
      'weather-cyclones',
      'flights',
    ],
    mission:
      'severe weather: storm cells, lightning, cyclones and aircraft routing around them',
  },
  {
    id: 'fire',
    label: 'FIRE WATCH',
    summary: 'Satellite fires, perimeters, wind, dams, datacentres, power',
    layers: [
      'local-firms',
      'fire-perimeters',
      'wind',
      'local-dams',
      'local-datacenters',
      'infra-power-lines',
    ],
    mission:
      'wildfire: strong detections, perimeter growth, infrastructure within reach',
  },
  {
    id: 'quake',
    label: 'QUAKE WATCH',
    summary: 'Earthquakes with dams, datacentres, pipelines and power',
    layers: [
      'earthquakes',
      'local-dams',
      'local-datacenters',
      'infra-pipelines',
      'infra-power-lines',
    ],
    mission:
      'earthquakes: strong shocks and the infrastructure inside their reach',
  },
  {
    id: 'infrastructure',
    label: 'INFRASTRUCTURE',
    summary: 'Power, pipelines, IXPs, cables, datacentres, dams, borders',
    layers: [
      'infra-power-lines',
      'infra-pipelines',
      'infra-ixps',
      'telegeography-submarine-cables',
      'local-datacenters',
      'local-dams',
      'infra-border-crossings',
    ],
    mission:
      'national infrastructure: hazards and activity near power, pipelines, IXPs and cables',
  },
  {
    id: 'space',
    label: 'SPACE',
    summary: 'Satellites and launches',
    layers: ['satellites', 'rocket-launches'],
    mission: 'space: launches and satellite passes',
  },
]);

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id) || null;
}

/**
 * Apply a scenario. `replace` turns off every enabled layer not in it.
 * @returns {Promise<{ok:boolean, on:string[], off:string[], failed:string[]}>}
 */
export async function applyScenario(
  dataManager,
  id,
  { replace = true, intel = null } = {},
) {
  const scenario = scenarioById(id);
  if (!scenario) return { ok: false, error: `unknown scenario ${id}` };
  const known = new Set((dataManager?.getAll?.() || []).map((l) => l.id));
  const wanted = scenario.layers.filter((l) => !known.size || known.has(l));
  const off = [];
  if (replace)
    for (const layer of dataManager?.getAll?.() || [])
      if (
        layer.enabled &&
        !wanted.includes(layer.id) &&
        layer.id !== 'local-adsb'
      )
        off.push(layer.id);
  const failed = [];
  await Promise.all([
    ...off.map((l) =>
      Promise.resolve(
        dataManager.setEnabled(l, false, { origin: 'user' }),
      ).catch(() => failed.push(l)),
    ),
    ...wanted.map((l) =>
      Promise.resolve(
        dataManager.setEnabled(l, true, { origin: 'user' }),
      ).catch(() => failed.push(l)),
    ),
  ]);
  intel?.setMission?.({
    text: scenario.mission,
    areas: intel.getMission?.()?.areas || [],
  });
  return {
    ok: failed.length === 0,
    scenario: scenario.label,
    on: wanted,
    off,
    failed,
  };
}
