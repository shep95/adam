/**
 * The tools Shepherd holds: every voice-control action (same schemas and
 * wording as the realtime voice session) plus Shepherd's own console tools.
 * The browser executes all of them; this list is authoritative, so a client
 * cannot widen what the model may call.
 */
import { GEV_REALTIME_TOOLS } from '../providers/openai/tools.js';

const obj = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

export const SHEPHERD_EXTRA_TOOLS = Object.freeze([
  {
    name: 'get_console_state',
    description:
      'Read the live console: camera, local time at view centre, enabled layers with counts and feed state, tracked and pinned contacts, filters, alerts, 3d buildings. Call before answering questions about "what is on screen" when the [console] block is not enough.',
    parameters: obj({}),
  },
  {
    name: 'set_layers',
    description:
      'Turn any data layers on or off, including the infrastructure and airspace layers: infra-power-lines, infra-pipelines, infra-border-crossings, infra-chokepoints, infra-ixps, maritime-zones, airspace-firs, airspace-restricted, telegeography-submarine-cables, local-datacenters, local-dams, military-installations, flights, military, ais-live-vessels, satellites, earthquakes, local-firms, cctv, radio, traffic, weather-radar and others.',
    parameters: obj(
      {
        layers: {
          type: 'array',
          items: obj({ id: { type: 'string' }, enabled: { type: 'boolean' } }, [
            'id',
            'enabled',
          ]),
        },
      },
      ['layers'],
    ),
  },
  {
    name: 'track_flight',
    description:
      'Find a live aircraft by airline flight number (UA1234), ICAO callsign (UAL1234), tail number (N12345, G-EUPT) or 24-bit hex (a1b2c3); fly to it, lock the follow camera and pin its telemetry. Aircraft only — never passenger data.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'set_contact_filter',
    description:
      'Filter aircraft and vessels on the globe. timeWindow hides contacts not heard from within it. altitudeBands keeps only those bands (surface, low <10k ft, medium 10-25k, high 25-45k, strato >45k). vesselTypes keeps only those classes (cargo, tanker, passenger, military, fishing, other, unknown). reset clears everything first.',
    parameters: obj({
      reset: { type: 'boolean' },
      timeWindow: { type: 'string', enum: ['all', '10m', '1h', '6h'] },
      altitudeBands: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['surface', 'low', 'medium', 'high', 'strato'],
        },
      },
      vesselTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'cargo',
            'tanker',
            'passenger',
            'military',
            'fishing',
            'other',
            'unknown',
          ],
        },
      },
      staleness: { type: 'boolean' },
      regionCenter: obj({ lat: { type: 'number' }, lon: { type: 'number' } }),
      regionRadiusKm: { type: 'number' },
      clearRegion: { type: 'boolean' },
    }),
  },
  {
    name: 'create_alert_zone',
    description:
      'Create an alert trigger around a point: count-in-zone fires when more than `threshold` contacts of the layer are inside; speed-in-zone fires when any contact exceeds maxSpeedKts inside. Use for "tell me when any military aircraft enters 50nm of this point" (count-in-zone, layer military, threshold 0, radiusNm 50).',
    parameters: obj(
      {
        kind: { type: 'string', enum: ['count-in-zone', 'speed-in-zone'] },
        layer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels'],
        },
        lat: { type: 'number' },
        lon: { type: 'number' },
        radiusNm: { type: 'number' },
        threshold: { type: 'number' },
        maxSpeedKts: { type: 'number' },
        label: { type: 'string' },
      },
      ['kind', 'layer', 'lat', 'lon', 'radiusNm'],
    ),
  },
  {
    name: 'drop_pin',
    description: 'Plant a labelled precision pin on the surface and fly to it.',
    parameters: obj(
      {
        lat: { type: 'number' },
        lon: { type: 'number' },
        label: { type: 'string' },
        fly: { type: 'boolean' },
      },
      ['lat', 'lon'],
    ),
  },
  {
    name: 'osint_overlay',
    description:
      'Draw an intelligence overlay on the globe: entity nodes (place, facility, aircraft, vessel, infrastructure, organisation) with confidence, and labelled links between them. Replaces the previous overlay unless append is true. Never place nodes for private individuals.',
    parameters: obj(
      {
        title: { type: 'string' },
        append: { type: 'boolean' },
        nodes: {
          type: 'array',
          items: obj(
            {
              id: { type: 'string' },
              label: { type: 'string' },
              lat: { type: 'number' },
              lon: { type: 'number' },
              kind: { type: 'string' },
              confidence: { type: 'number' },
              note: { type: 'string' },
            },
            ['id', 'label', 'lat', 'lon'],
          ),
        },
        links: {
          type: 'array',
          items: obj(
            {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string' },
            },
            ['from', 'to'],
          ),
        },
        fly: { type: 'boolean' },
      },
      ['nodes'],
    ),
  },
  {
    name: 'clear_osint_overlay',
    description: 'Remove Shepherd overlays and pins from the globe.',
    parameters: obj({}),
  },
  {
    name: 'export_report',
    description:
      'Save a written product (sitrep, osint brief, pattern analysis) as a markdown file the operator downloads, with the current overlay as geojson alongside. Sitrep order: executive summary, entity counts, elevated activity, threat indicators, missing information, recommended next focus.',
    parameters: obj(
      { title: { type: 'string' }, markdown: { type: 'string' } },
      ['title', 'markdown'],
    ),
  },
  {
    name: 'set_environment',
    description:
      'Live environment at the view centre: real sun lighting, cast shadows, sun/moon/star field, and the scene clock. mode live = real time; offset = hoursFromNow (negative = past, up to ±168); jump = the next sunrise, solar noon, sunset or midnight at the view centre; play = run time at speed (60, 600, 3600×); pause; read = change nothing. Returns local time, day phase, sun and moon position, rise/set times, moon phase, shadow direction and length ratio, bright stars up, and current weather. Live contacts keep real positions whatever the clock shows.',
    parameters: obj({
      mode: {
        type: 'string',
        enum: ['live', 'offset', 'jump', 'play', 'pause', 'read'],
      },
      hoursFromNow: { type: 'number' },
      jump: { type: 'string', enum: ['sunrise', 'noon', 'sunset', 'midnight'] },
      speed: { type: 'number', enum: [60, 600, 3600] },
      lighting: { type: 'boolean' },
      shadows: { type: 'boolean' },
      sky: { type: 'boolean' },
      openPanel: { type: 'boolean' },
    }),
  },
  {
    name: 'set_3d_buildings',
    description: 'Show or hide photorealistic 3D buildings and terrain.',
    parameters: obj({ enabled: { type: 'boolean' } }, ['enabled']),
  },
]);

export function shepherdTools() {
  return [
    ...GEV_REALTIME_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters,
    })),
    ...SHEPHERD_EXTRA_TOOLS,
  ];
}
