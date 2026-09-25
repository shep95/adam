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
      'Create an alert trigger around a point: count-in-zone fires when more than `threshold` contacts of the layer are inside; speed-in-zone fires when any contact exceeds maxSpeedKts inside; quake-in-zone fires on an earthquake of at least minMagnitude in the last 24 h (layer ignored, earthquakes switched on); fire-in-zone fires on more than `threshold` satellite fire detections of at least minFrp MW (layer ignored, FIRMS switched on). Use for "tell me when any military aircraft enters 50nm of this point" (count-in-zone, layer military, threshold 0, radiusNm 50) or "alert me to any M6 quake within 500 nm of Tokyo" (quake-in-zone, minMagnitude 6, radiusNm 500).',
    parameters: obj(
      {
        kind: {
          type: 'string',
          enum: [
            'count-in-zone',
            'speed-in-zone',
            'quake-in-zone',
            'fire-in-zone',
          ],
        },
        layer: {
          type: 'string',
          enum: ['flights', 'military', 'ais-live-vessels'],
        },
        lat: { type: 'number' },
        lon: { type: 'number' },
        radiusNm: { type: 'number' },
        zone: { type: 'string' },
        threshold: { type: 'number' },
        maxSpeedKts: { type: 'number' },
        minMagnitude: { type: 'number' },
        minFrp: { type: 'number' },
        label: { type: 'string' },
      },
      ['kind'],
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
    name: 'nation_profile',
    description:
      'Open a country in the NATIONS panel: official name, capital, region, area, land borders, UN membership. capital = fly to the seat of government; government = map institutions around the capital from OpenStreetMap (legislature, executive offices, ministries, courts, embassies) as an overlay with counts by kind; infrastructure = switch on the infrastructure layers (military installations, power lines, pipelines, border crossings, IXPs, chokepoints, submarine cables, datacentres, dams, FIRs, maritime zones) and frame the country. Institutions only, never the whereabouts of a person.',
    parameters: obj(
      {
        country: { type: 'string' },
        capital: { type: 'boolean' },
        government: { type: 'boolean' },
        infrastructure: { type: 'boolean' },
      },
      ['country'],
    ),
  },
  {
    name: 'show_summits',
    description:
      'Put publicly announced multilateral summit venues (G7, G20, NATO, UNGA, COP, APEC, BRICS, SCO, WEF, Munich Security Conference, Shangri-La Dialogue) on the globe and return them with dates and status (held, live, upcoming). Venues and dates only.',
    parameters: obj({}),
  },
  {
    name: 'console_command',
    description:
      'Command-centre control over every ADAM surface. open_panel/close_panel: brief, alerts, filter, health, scenario, sky, nations, shepherd, display, keys, data_layers. scope: on|off. snapshot: save a PNG of the view. record_start / record_stop: capture the view. ui_scale: 0.8-1.4. share_view: copy a share link of the current view. clear_overlays: remove Shepherd overlays and pins. unpin_all: clear the pinned-contact rail. system_status: layer health (on, count, feed state), faults (down, stale, on fallback, degraded capabilities) plus AI, recording and scale state. rewind: value = minutes ago (1-45) to show where tracked aircraft and vessels were, or live to return. profile_export: download the operator profile (alert rules, baselines, pins, layers, scene, prefs) as a signed JSON file; importing needs the operator to pick the file in HEALTH.',
    parameters: obj(
      {
        command: {
          type: 'string',
          enum: [
            'open_panel',
            'close_panel',
            'scope',
            'snapshot',
            'record_start',
            'record_stop',
            'ui_scale',
            'share_view',
            'clear_overlays',
            'unpin_all',
            'system_status',
            'profile_export',
            'rewind',
          ],
        },
        panel: {
          type: 'string',
          enum: [
            'brief',
            'alerts',
            'filter',
            'health',
            'scenario',
            'sky',
            'nations',
            'shepherd',
            'display',
            'keys',
            'data_layers',
          ],
        },
        value: { type: 'string' },
      },
      ['command'],
    ),
  },
  {
    name: 'get_traffic_snapshot',
    description:
      'Structured road conditions in view from the live TomTom flow: the most congested segments (closures first) with road class, flow ratio (current/free-flow speed, 1 = free flowing), coordinates and length, plus coverage. Needs the traffic layer on; without a TomTom key the layer is a simulation and this returns live=false.',
    parameters: obj({ limit: { type: 'number' } }),
  },
  {
    name: 'export_fires',
    description:
      'Export the loaded NASA FIRMS hotspots (satellite, confidence, FRP, acquisition time, position), optionally only those in view, as a CSV or JSON download, and return a summary (count, strongest, newest, by satellite).',
    parameters: obj({
      format: { type: 'string', enum: ['csv', 'json'] },
      inViewOnly: { type: 'boolean' },
    }),
  },
  {
    name: 'space_weather',
    description:
      'Current space weather from NOAA SWPC: planetary Kp, F10.7 solar flux and the NOAA R/S/G scales, with what they mean for HF radio, GNSS accuracy and satellite operations.',
    parameters: obj({}),
  },
  {
    name: 'news_events',
    description:
      'News-reported locations for a query from GDELT (global news, geocoded) over a timespan such as 24h, 72h or 7d, plotted on the globe with counts and a source link. Reporting density, not verified events; say so.',
    parameters: obj(
      {
        query: { type: 'string' },
        timespan: { type: 'string' },
      },
      ['query'],
    ),
  },
  {
    name: 'list_feeds',
    description:
      "External data feeds pushed into ADAM at /api/ingest/<name> (GeoJSON from operators' own systems): names, feature counts, last update.",
    parameters: obj({}),
  },
  {
    name: 'load_feed',
    description: 'Draw an ingested feed on the globe.',
    parameters: obj({ name: { type: 'string' } }, ['name']),
  },
  {
    name: 'load_url',
    description:
      'Pull a public GeoJSON, KML or CSV (lat/lon columns) URL and draw it on the globe. https and public hosts only.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
  },
  {
    name: 'record_finding',
    description:
      'Record a structured finding for the session product: subject, place (name) and lat/lon, time (ISO or plain), confidence 0-1, source (which layers/feeds/documents), assessment, and the strongest alternative reading. Record each distinct assessment you make; findings accumulate and export with export_product.',
    parameters: obj(
      {
        subject: { type: 'string' },
        place: { type: 'string' },
        lat: { type: 'number' },
        lon: { type: 'number' },
        time: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        source: { type: 'string' },
        assessment: { type: 'string' },
        alternative: { type: 'string' },
      },
      ['subject', 'assessment', 'confidence', 'source'],
    ),
  },
  {
    name: 'list_findings',
    description:
      'The findings recorded this session (and earlier, until cleared).',
    parameters: obj({}),
  },
  {
    name: 'export_product',
    description:
      'Export a finished intelligence product the operator can hand to someone who was not in the session: cover with dissemination marking, BLUF, situation and assessment, map extract of the current view, findings table, watch at export, contact log, event log, analyst action log, sources and a confidence key. Write the BLUF and assessment yourself; marking defaults to UNCLASSIFIED — use what the operator specifies.',
    parameters: obj(
      {
        title: { type: 'string' },
        bluf: { type: 'string' },
        assessment: { type: 'string' },
        marking: { type: 'string' },
        periodHours: { type: 'integer', minimum: 1, maximum: 720 },
      },
      ['title', 'bluf'],
    ),
  },
  {
    name: 'get_action_log',
    description:
      'The audit trail of tools you ran (time, tool, arguments, ok/failed) — for reporting what was done in the session.',
    parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 300 } }),
  },
  {
    name: 'recommend_actions',
    description:
      'Decision support: ranked next actions for what is on the globe now (arm a watch on an uncovered finding, look through the nearest camera, track an orbiting aircraft, go there, check a degraded feed, arm the mission areas), each with its reasoning. Present them as recommendations; run one with run_recommendation when the operator agrees or asked you to act.',
    parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 10 } }),
  },
  {
    name: 'run_recommendation',
    description:
      'Run recommendation number `index` (1-based) from the latest recommend_actions list.',
    parameters: obj({ index: { type: 'integer', minimum: 1 } }, ['index']),
  },
  {
    name: 'predict_track',
    description:
      'Where a vessel or aircraft is going if it holds course and speed: dead-reckoned track with an uncertainty band that grows with time and report age, drawn on the globe; with zone (id or name from list_zones) it gives the time it would enter it, e.g. "enters the exclusion zone in 4 h 12 m (±6 km)". layer: ais-live-vessels, flights or military; id: MMSI, ICAO24, callsign or name.',
    parameters: obj(
      {
        layer: {
          type: 'string',
          enum: ['ais-live-vessels', 'flights', 'military'],
        },
        id: { type: 'string' },
        minutes: { type: 'integer', minimum: 10, maximum: 1440 },
        zone: { type: 'string' },
      },
      ['layer', 'id'],
    ),
  },
  {
    name: 'asset_risk',
    description:
      'Live natural-hazard risk (0-100) for mapped datacentres and dams, with the factors (quake shaking reach, nearby strong fires). A resilience screen, not a damage estimate. Needs those layers and earthquakes/FIRMS on.',
    parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 30 } }),
  },
  {
    name: 'measure',
    description:
      'Measure range and bearing along points [{lat, lon}] (2+), great circle by default or rhumb=true; draws it on the globe with per-leg labels. unit km|nm|mi.',
    parameters: obj(
      {
        points: {
          type: 'array',
          items: obj({ lat: { type: 'number' }, lon: { type: 'number' } }, [
            'lat',
            'lon',
          ]),
        },
        rhumb: { type: 'boolean' },
        unit: { type: 'string', enum: ['km', 'nm', 'mi'] },
      },
      ['points'],
    ),
  },
  {
    name: 'range_rings',
    description:
      'Draw labelled range rings around a point (km: 10/25/50/100, nm or mi: 5/10/25/50).',
    parameters: obj(
      {
        lat: { type: 'number' },
        lon: { type: 'number' },
        unit: { type: 'string', enum: ['km', 'nm', 'mi'] },
      },
      ['lat', 'lon'],
    ),
  },
  {
    name: 'create_zone',
    description:
      'Save a named zone the operator and alerts can use: kind circle (center + radiusKm), polygon (points), or corridor (points along a route + widthKm half-width). Returns its id for create_alert_zone.',
    parameters: obj(
      {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['circle', 'polygon', 'corridor'] },
        lat: { type: 'number' },
        lon: { type: 'number' },
        radiusKm: { type: 'number' },
        widthKm: { type: 'number' },
        points: {
          type: 'array',
          items: obj({ lat: { type: 'number' }, lon: { type: 'number' } }, [
            'lat',
            'lon',
          ]),
        },
      },
      ['name', 'kind'],
    ),
  },
  {
    name: 'list_zones',
    description: 'List saved zones (id, name, kind, area).',
    parameters: obj({}),
  },
  {
    name: 'apply_scenario',
    description:
      'Set the console up for a kind of watch in one action (layers on, the rest off unless replace=false, and a matching mission line): port-watch, airspace, chokepoints, storm, fire, quake, infrastructure, space.',
    parameters: obj(
      {
        id: {
          type: 'string',
          enum: [
            'port-watch',
            'airspace',
            'chokepoints',
            'storm',
            'fire',
            'quake',
            'infrastructure',
            'space',
          ],
        },
        replace: { type: 'boolean' },
      },
      ['id'],
    ),
  },
  {
    name: 'get_watch_log',
    description:
      'The timestamped watch log: every alert trip and every high-ranked watch item since it was cleared (newest first). Filter by kind; since is an ISO time.',
    parameters: obj({
      kind: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
  },
  {
    name: 'get_watch',
    description:
      'The ranked picture (0-100): tripped alerts, cross-layer correlations (AIS-dark near military air, orbits over vessel meetings or dark vessels, pattern clusters), infrastructure exposure, behaviour patterns, baseline surges and feed faults, each with why it ranks and the plain alternative. Start here when asked what matters, what to look at, or what changed.',
    parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 20 } }),
  },
  {
    name: 'set_mission',
    description:
      'Record the operator\'s mission for the session in plain words, plus focus areas ({lat, lon, radiusKm, label}); it lifts matching items in the watch ranking. When the operator briefs you ("today I\'m watching Hormuz for..."), call set_mission, then configure the console for it: set_layers, create_alert_zone for the areas, filters, and fly there.',
    parameters: obj(
      {
        text: { type: 'string' },
        areas: {
          type: 'array',
          items: obj(
            {
              lat: { type: 'number' },
              lon: { type: 'number' },
              radiusKm: { type: 'number' },
              label: { type: 'string' },
            },
            ['lat', 'lon'],
          ),
        },
      },
      ['text'],
    ),
  },
  {
    name: 'cctv_find',
    description:
      'Search the public CCTV catalog (traffic and city cameras published by transport agencies — US, Canada, UK, Finland, Estonia, Germany, Australia). query matches road, junction, city, agency or country; omit it for the cameras nearest the view. Returns ids for cctv_connect. Use cctv_find with coverage=true to list countries and agencies.',
    parameters: obj({
      query: { type: 'string' },
      coverage: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }),
  },
  {
    name: 'cctv_connect',
    description:
      'Connect to one public camera: turns CCTV on, selects it, flies there, opens its live feed and projects the frame onto the ground. Pass an id from cctv_find, or nearest=true for the camera closest to the view.',
    parameters: obj({
      id: { type: 'string' },
      nearest: { type: 'boolean' },
    }),
  },
  {
    name: 'notams',
    description:
      "FAA NOTAMs (temporary flight restrictions, closures, hazards) for an airport (icao) or around a point (lat, lon, radius_nm up to 100), drawn on the globe in amber. Needs the operator's FAA API key; if the tool says so, tell them which env vars to set.",
    parameters: obj({
      icao: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_nm: { type: 'integer', minimum: 1, maximum: 100 },
    }),
  },
  {
    name: 'conflict_events',
    description:
      "ACLED political violence and protest events for a country, or around a point (lat, lon, radius_km), over the last days (default 30), drawn on the globe in red, with counts by type and reported fatalities. Needs the operator's ACLED account. Cite ACLED.",
    parameters: obj({
      country: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_km: { type: 'integer', minimum: 5, maximum: 1000 },
      days: { type: 'integer', minimum: 1, maximum: 365 },
    }),
  },
  {
    name: 'sanctions_check',
    description:
      'Check a vessel (name, IMO or MMSI), aircraft, company or organisation against sanctions and watch lists (OpenSanctions). schema narrows it: Vessel, Airplane, Company, Organization. Not for people: person results are never returned. A name match is not an identification; say so and give the list and link.',
    parameters: obj(
      {
        query: { type: 'string' },
        schema: {
          type: 'string',
          enum: ['Vessel', 'Airplane', 'Company', 'Organization'],
        },
      },
      ['query'],
    ),
  },
  {
    name: 'telecom_links',
    description:
      "A country's international connectivity from public data: submarine cables landing there, landing stations, the countries each cable links it to (drawn as links from the country), and internet exchanges (PeeringDB). Counts and lists as TeleGeography and PeeringDB publish them; do not rank individual sites as targets or single points of failure.",
    parameters: obj({ country: { type: 'string' } }, ['country']),
  },
  {
    name: 'infrastructure_ownership',
    description:
      "Who owns and operates a country's ports, airports, power stations, dams or refineries, from Wikidata: each site coloured state-owned (cyan), foreign state (red), foreign company (amber) or private (grey), with counts by owner country and the largest owners. Institutions only; coverage is what Wikidata editors recorded, so say it is incomplete.",
    parameters: obj(
      {
        country: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['ports', 'airports', 'power', 'dams', 'refineries'],
        },
      },
      ['country'],
    ),
  },
  {
    name: 'heat',
    description:
      'Heat on the globe. action: where (satellite heat detections from NASA FIRMS over 24 h summed by country and the ten hottest places, marked on the globe; fires, gas flares, volcanoes and industry all count), thermal (thermal-camera filter on or off with on=true/false), night_vision (green night vision on the night side, on=true/false), layer (add a heat map: activity-heat = night lights as heat, lst-day / lst-night = measured land surface temperature).',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['where', 'thermal', 'night_vision', 'layer'],
        },
        on: { type: 'boolean' },
        layer: {
          type: 'string',
          enum: ['activity-heat', 'lst-day', 'lst-night'],
        },
      },
      ['action'],
    ),
  },
  {
    name: 'volcano',
    description:
      'Volcanoes on land and under the sea. With name (or lat/lon for the nearest), fly there and draw eruption hazard rings — explosion (ballistic blocks), pyroclastic flows, heavy and light ash, lava — for eruption size vei (0–8; default its largest recorded). Returns the distances; say they are illustrative. With show_all=true, put every Holocene volcano on the globe (orange land, blue undersea) and list USGS volcanoes on alert now.',
    parameters: obj({
      name: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      vei: { type: 'integer', minimum: 0, maximum: 8 },
      show_all: { type: 'boolean' },
    }),
  },
  {
    name: 'space',
    description:
      'The solar system. action: planets (distance, light-time, and whether each is up from the centre of the view), asteroids (near-Earth asteroids passing within 0.05 AU in the next 60 days from NASA/JPL, with size, speed, miss distance and if-it-hit energy), impact (draw a hypothetical impact footprint for diameter_m and velocity_kms at lat/lon or the view centre: severe damage, burns, windows; it is scaling from energy, not a forecast), open (the SPACE panel with the orrery and belt).',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['planets', 'asteroids', 'impact', 'open'],
        },
        diameter_m: { type: 'number', minimum: 1, maximum: 20000 },
        velocity_kms: { type: 'number', minimum: 5, maximum: 75 },
        lat: { type: 'number' },
        lon: { type: 'number' },
      },
      ['action'],
    ),
  },
  {
    name: 'symbols_scan',
    description:
      "Symbols from the sky for a city area (lat, lon, radius_km up to 15; defaults to the view centre): sacred sites of every faith with counts by religion, esoteric sites (Masonic and similar lodges, obelisks, pyramids, megaliths), and shapes read from above — cruciform church plans, star forts, pentagons, and star junctions where many streets radiate from one roundabout. Marks them on the globe. It reports what is mapped and measured, not hidden meanings; say so, and don't speculate about individuals.",
    parameters: obj({
      lat: { type: 'number' },
      lon: { type: 'number' },
      radius_km: { type: 'number', minimum: 0.5, maximum: 15 },
    }),
  },
  {
    name: 'spectrum',
    description:
      "Spectrum awareness from public sources. action: lookup (frequency like '1090', '156.8 MHz', '2.4 GHz', '518 kHz' → allocation and common uses, simplified ITU), receivers (public KiwiSDR web receivers on the globe; anyone can tune them live), masts (broadcast, mobile and radar masts in the view from OpenStreetMap; needs a regional view), open.",
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['lookup', 'receivers', 'masts', 'open'],
        },
        frequency: { type: 'string' },
      },
      ['action'],
    ),
  },
  {
    name: 'live_session',
    description:
      'Work the picture with other operators. action: start (create a room; returns the invite link to give people), status (who is in the room and where each is looking), follow (your camera follows an operator by name; empty name stops), pin (drop a pin at the view centre for everyone, optional label), note (send text to the room), share_overlay (send the current Shepherd overlay to everyone), leave.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: [
            'start',
            'status',
            'follow',
            'pin',
            'note',
            'share_overlay',
            'leave',
          ],
        },
        name: { type: 'string' },
        label: { type: 'string' },
        text: { type: 'string' },
      },
      ['action'],
    ),
  },
  {
    name: 'crime',
    description:
      'Crime from open data. action: near (street-level incidents around lat/lon or the view centre as a heat map with categories and the hottest spots — covered: England, Wales, Northern Ireland, Chicago, New York, Los Angeles, San Francisco), homicide_rates (intentional homicides per 100,000 by country, World Bank/UNODC, on the globe), organized (armed groups ACLED reports active in a country, by region, with the outline of their reported events; needs the ACLED account; it is reported activity, not territory — say so, and never name or speculate about individuals).',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: ['near', 'homicide_rates', 'organized', 'open'],
        },
        lat: { type: 'number' },
        lon: { type: 'number' },
        country: { type: 'string' },
        days: { type: 'integer', minimum: 7, maximum: 730 },
      },
      ['action'],
    ),
  },
  {
    name: 'war_history',
    description:
      'The war-history timeline (present back to antiquity, colour-coded by era). action: year (jump to a year, negative for BC; returns the wars being fought with sides, strategies and battles, and shows them on the globe with Wikidata battles of those years), war (find a war by name and jump to it), play (animate back into the past with direction -1, or forward with 1), open. Ongoing wars are as of 2025 — say so.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['year', 'war', 'play', 'open'] },
        year: { type: 'integer', minimum: -3000, maximum: 2100 },
        name: { type: 'string' },
        direction: { type: 'integer', enum: [-1, 1] },
      },
      ['action'],
    ),
  },
  {
    name: 'resources',
    description:
      'Natural wealth (RESOURCES panel). action: rank (countries ranked by a resource type, drawn on the globe: total, oil, gas, coal, minerals, forest — World Bank rents in dollars; gold — value of gold reserves; fx — foreign exchange reserves; water — renewable freshwater km³/yr; arable — arable land), sites (mines, wells, refineries, LNG terminals, fuel storage and power plants in the current view from OpenStreetMap; the view must be about 300 km across or less), open. Rents are value above extraction cost, not reserves in the ground — say so.',
    parameters: obj(
      {
        action: { type: 'string', enum: ['rank', 'sites', 'open'] },
        type: {
          type: 'string',
          enum: [
            'total',
            'oil',
            'gas',
            'coal',
            'minerals',
            'forest',
            'gold',
            'fx',
            'water',
            'arable',
          ],
        },
      },
      ['action'],
    ),
  },
  {
    name: 'map_layers',
    description:
      'Stack other map sources over the base map (MAPS panel). action: list (the stack and sea level), catalog (sources you can add), add (id from catalog), remove, opacity (id, opacity 0-1), show / hide (id), raise / lower (id), import (url of an XYZ template, ArcGIS MapServer or WMS with layers=; optional label), sea_level (rise_m 0-100: the future coast — adds the world sea-level layer if needed; IPCC AR6 2100 medians are 0.44 m low, 0.56 m middle, 0.77 m high emissions; 2 m by 2100 and 5 m by 2150 are the low-likelihood ice-sheet cases; 7.4 m is all of Greenland, ~70 m all land ice), open. The world layer is a bathtub model on global elevation; say so when you use it.',
    parameters: obj(
      {
        action: {
          type: 'string',
          enum: [
            'list',
            'catalog',
            'add',
            'remove',
            'opacity',
            'show',
            'hide',
            'raise',
            'lower',
            'import',
            'sea_level',
            'open',
          ],
        },
        id: { type: 'string' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        url: { type: 'string' },
        label: { type: 'string' },
        rise_m: { type: 'number', minimum: 0, maximum: 100 },
      },
      ['action'],
    ),
  },
  {
    name: 'place_dossier',
    description:
      "Open WHAT'S HERE for a point: public photos of the street, landmarks and buildings (Wikimedia Commons, Street View, Mapillary), Wikipedia articles about what stands there, and named OpenStreetMap places with their websites. Returns titles, links and counts. Places and structures only — never use it to find who lives at or owns an address.",
    parameters: obj(
      {
        lat: { type: 'number' },
        lon: { type: 'number' },
        radius: { type: 'integer', minimum: 50, maximum: 5000 },
      },
      ['lat', 'lon'],
    ),
  },
  {
    name: 'get_exposure',
    description:
      'Infrastructure exposure: mapped datacentres and dams inside the screening reach of live hazards — earthquakes M4.5+ in the last 48 h (40-500 km by magnitude) and satellite fires ≥50 MW (5 km). Needs the earthquakes / FIRMS and datacentre / dam layers on. Reach is a screening distance, not damage; say so.',
    parameters: obj({ limit: { type: 'integer', minimum: 1, maximum: 20 } }),
  },
  {
    name: 'get_patterns',
    description:
      'Behaviour patterns seen over the last ~45 minutes of live data: orbit (aircraft circling ≥2 turns in 30 km), ais-dark (vessel under way stopped reporting 20+ min), meeting (two slow vessels ≤500 m apart 20+ min in open water), jump (impossible position change). Each has a confidence and an alternative reading; report both. Needs flights/military/vessels layers on for a while.',
    parameters: obj({
      kind: { type: 'string', enum: ['orbit', 'ais-dark', 'meeting', 'jump'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
  },
  {
    name: 'list_alerts',
    description:
      'List the operator alert rules with their state (armed, tripped, last result).',
    parameters: obj({}),
  },
  {
    name: 'remove_alert',
    description: 'Remove an alert rule by id, or disable/enable it.',
    parameters: obj({ id: { type: 'string' }, enabled: { type: 'boolean' } }, [
      'id',
    ]),
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
