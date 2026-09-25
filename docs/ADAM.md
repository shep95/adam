# ADAM — operator guide

ADAM (#houseofasher) is a live 3D intelligence console on a Cesium globe. This
page covers what ADAM adds beyond the upstream globe, the keys it needs, how to
deploy it privately, and what it deliberately will not do.

## Operator surfaces

The ops rail sits in its own lane under the top action bar:

| Chip      | Key | What it does                                                                                                                                          |
| --------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| BRIEF     | B   | Situational brief across every loaded layer, with baseline deviations                                                                                 |
| ALERTS    | A   | Alert triggers: contacts or speed in a zone, earthquakes M+ and satellite fire detections in a zone                                                   |
| FILTER    | G   | Time window, region, altitude band, vessel class                                                                                                      |
| HEALTH    | —   | Feeds down, stale or on fallback, degraded capabilities; pulses amber past one fault. Exports and imports the operator profile                        |
| SCENARIO  | —   | One action per watch type (port, airspace, chokepoints, storm, fire, quake, infrastructure, space): layers, and a mission line                        |
| REWIND    | R   | Scrub the last ~45 min of held tracks: ghost positions with 5-min tails, play at 30×                                                                  |
| SKY       | L   | Live environment at the view centre (see below)                                                                                                       |
| NATIONS   | N   | State institutions, national infrastructure, summit venues                                                                                            |
| BUILDINGS | —   | 3D buildings: photoreal tiles with a key, OSM footprints without                                                                                      |
| CAMERAS   | —   | Directory of every public camera: coverage by country and agency, search, nearest to view; CONNECT turns CCTV on, opens the live feed and projects it |
| KEYS      | ?   | Every shortcut live in the current mode                                                                                                               |
| SHEPHERD  | S   | The text analyst                                                                                                                                      |

The top action bar adds **snapshot** (PNG of the view with a caption strip),
**record** (the whole tab via screen capture, falling back to the globe canvas;
MP4 or WebM) and **interface scale** (80–140% for every panel; the globe is
untouched).

Captures are cleaned before download: no EXIF, text, timestamps, ICC
profile or encoder strings (PNG chunks stripped; WebM/MP4 dates and
application tags blanked). Snapshots switch to lossless WebP only when it
decodes to identical pixels and is smaller; recordings use a bitrate sized to
the picture.

**MEASURE** (ruler on the top bar): LINE (range and bearing per leg and
total), AREA (area and perimeter), RINGS (range rings) and CORRIDOR (a band
along a route), great circle or rhumb, in km, nm or mi. SAVE ZONE keeps any
shape as a named zone, drawn on the globe, selectable in ALERTS ("alert me
when any vessel enters this corridor") and known to Shepherd (`measure`,
`range_rings`, `create_zone`, `list_zones`, `create_alert_zone` with a zone).

Right-click the globe for: copy coordinates, drop pin, fly here, ask Shepherd
about here, live sky here, a 25 nm aircraft alert zone, and 3D buildings.
Location searches end on a precision pin. The local time at the camera sits
under the coordinate readout.

**Operator profile.** HEALTH → EXPORT writes alert rules, baselines, pins,
layer preferences, the scene project, panel positions, voice limits, CCTV
calibration and Shepherd preferences to one JSON file. It carries a SHA-256 of
its canonical body and, when `ADAM_ACCESS_TOKEN` is set, an HMAC from
`/api/access/sign`. IMPORT refuses edited files and signatures from another
deployment, writes only allow-listed settings, then reloads. No keys or tokens
ever enter the file.

**Scene conflicts.** Two windows editing the scene project no longer overwrite
each other silently: the other window's newer version is kept as a backup and
a toast says who saved and when.

**Behaviour patterns.** While flights, military and vessel layers are on,
ADAM keeps ~45 minutes of track history and watches for aircraft orbits
(≥ 2 turns inside 30 km), vessels going AIS-dark after reporting under way,
two slow vessels meeting in open water, and impossible position jumps. Each
finding shows in BRIEF (click to fly there) with a confidence and the plainest
alternative reading; Shepherd reads them with `get_patterns`.

**Infrastructure exposure.** With earthquakes or FIRMS fires on alongside
datacentres or dams, BRIEF lists assets inside each hazard's screening reach
(M4.5+ quakes in the last 48 h: 40–500 km by magnitude; fires ≥ 50 MW: 5 km).
It is a screening distance, not a damage estimate. Shepherd reads it with
`get_exposure`.

**Watch log.** Every alert trip and high-ranked watch item is logged with its time, location and reason (ALERTS → WATCH LOG, EXPORT CSV); Shepherd reads it with `get_watch_log`.

**WATCH and triage.** One ranked list (0–100, each with its reason) across
tripped alerts, cross-layer correlations (a vessel going AIS-dark near
military aircraft, an orbit over a vessel meeting or a dark vessel, clusters
of findings), infrastructure exposure, behaviour patterns, baseline surges
and feed faults. The top three stay visible in the WATCH strip under the
collection line whatever panel is open; items scoring 45+ are ringed on the
globe (MARKS toggles them); anything new at 65+ is posted into Shepherd
unasked. BRIEF opens with the same ranking and a MISSION line — state what
you are watching for and matching items rise. Shepherd sees the ranking in
every turn and reads it with `get_watch`; brief it in plain words and it
calls `set_mission`, then configures layers, zones and alerts.

**Decision support, prediction, risk.** BRIEF lists NEXT ACTIONS — arm a
watch on an uncovered finding, look through the nearest camera, track an
orbiting aircraft, arm your mission areas, check a degraded feed — each with
its reason and a DO button (Shepherd: `recommend_actions`,
`run_recommendation`). `predict_track` dead-reckons a vessel or aircraft at
its current course and speed with an uncertainty band that grows with time
and report age, draws it, and says when it would enter a zone ("enters the
exclusion zone in 4 h 12 m, ±6 km"). `asset_risk` scores mapped datacentres
and dams 0–100 from live quakes and fires, listing the factors.

**Findings and products.** Shepherd records each assessment as a structured
finding (subject, location, time, confidence, source, assessment,
alternative — `record_finding`). BRIEF → EXPORT PRODUCT (or `export_product`)
writes one printable HTML document: cover with dissemination marking top and
bottom, BLUF, assessment, a map extract of the view, findings, the watch at
export, contact log, event log, every action Shepherd took, sources and a
confidence key. Shepherd's own action log is under `log` in its header;
`2nd` asks it to challenge its last answer (alternatives, what was assumed,
what would change its confidence). Its pins and overlays survive reloads.

**Reach.** Shepherd can search the web (Claude provider, cited), plot
news-reported locations for any query from GDELT (`news_events`), draw any
public GeoJSON/KML/CSV URL (`load_url` — https, public hosts, no redirects,
5 MB), read feeds your own systems push to `/api/ingest/<feed>`
(`list_feeds`, `load_feed`) and read NOAA space weather — Kp, solar flux,
R/S/G scales and what they do to HF and GNSS (`space_weather`). Ingested
feeds live in server memory; use the standalone server for long-lived ones.

### MAPS (stacked map sources and the future coast)

The **maps** chip stacks other map sources over the base map. Each layer
has its own visibility, opacity and place in the stack (↑ ↓), and the stack
is remembered in the browser.

- **Future coast**: one sea-level control (0–100 m, square-root slider) with
  IPCC AR6 presets: 2050 (+0.2 m), 2100 low / middle / high emissions
  (+0.44 / +0.56 / +0.77 m), 2100 and 2150 ice-sheet collapse (+2 / +5 m),
  all of Greenland (+7.4 m), all land ice (+70 m). It drives two layers:
  _sea level rise · world_, computed in the browser from global elevation
  tiles (land above today's sea and below the new one, shaded by depth; a
  bathtub model with no connectivity, defences, subsidence or tides), and
  NOAA's US projection (0–10 ft, connected areas).
- **Base maps** to blend or compare: Esri satellite / streets / topographic /
  hillshade, National Geographic, OpenStreetMap, OSM humanitarian,
  OpenTopoMap, Carto dark / light, Sentinel-2 cloudless 2021.
- **Earth observation** (NASA GIBS, yesterday): VIIRS and MODIS true colour,
  sea surface temperature, snow cover, Black Marble night lights.
- **Reference overlays**: place names and borders, roads, OpenSeaMap sea
  marks, OpenRailwayMap.
- **Ocean floor**: GEBCO bathymetry, Esri ocean basemap.
- **Import a map**: paste an XYZ template (`{z}/{x}/{y}`, `{-y}`, `{s}`), a
  WMTS REST template, an ArcGIS MapServer URL or a WMS URL with `layers=`.
  HTTPS only.

Shepherd drives the same stack with `map_layers` (list, catalog, add,
remove, opacity, show/hide, raise/lower, import, sea_level).

### WHAT'S HERE (place dossier)

Right-click anywhere → **what's here · photos & pages**, or ask Shepherd
(`place_dossier`). The card pulls, for the streets, landmarks and buildings
around the point:

- Street View (server-proxied; needs a Google key) and Mapillary street-level
  photos (`MAPILLARY_TOKEN`)
- geotagged Wikimedia Commons photos, with author and licence on each
- Wikipedia articles about what stands there, nearest first
- named OpenStreetMap places with their websites and Wikipedia links
- a one-click web search through Shepherd for pages, images and documents
  about the site (heritage, planning, history, news)

Places and structures only: private homes are dropped from the OSM list and
nothing looks up who lives at or owns an address.

## Shepherd

A streaming chat analyst on the right edge. It reads a `[console]` block with
every turn (camera, local time, layers and counts, tracked and pinned contacts,
filters, alerts) and drives the console through the same action runner the
voice analyst uses, plus its own tools: bulk layer switching, flight tracking
by flight number / callsign / tail / hex, contact filters, alert zones, pins,
OSINT overlays with confidence tiers, report export (Markdown + GeoJSON), 3D
buildings, the live environment, and nation profiles.

- **Providers:** Claude, OpenAI, Gemini, Venice (100+ models) and OpenRouter.
  Shepherd routes by task, fails over when a provider errors, and lets you pick
  a provider and model in its settings.
- **Images:** drop, paste or attach a photo; "locate" predicts where it was
  taken, drops ranked candidates on the globe and flies to the best one.
- **Files:** drop a GeoJSON, KML or KMZ file to draw it on the globe as an
  overlay; drop a text document (txt, md, csv, json, html, xml) and Shepherd
  reads it, gives a BLUF summary and plots the places, facilities and routes
  it names. Files are read in the browser; only the document text you send
  goes to the AI provider.
- **Memory:** the conversation, preferences, last viewport and learned focus
  stay on this device (IndexedDB), never on the server.
- **Brain:** `server/shepherd/shepherd-brain.txt` is the system prompt, with an
  ADAM operator addendum in `server/shepherd/prompt.js`.

## Live environment (SKY)

The globe is lit by the real sun for the moment on the clock, everywhere:
lighting at every range, the day/night terminator with civil, nautical and
astronomical dusk lines, subsolar and sublunar markers, the star field, a
time-of-day colour grade (which also changes photoreal tiles), shadows below
15 km, fog from reported visibility, and rain, snow and thunder from the live
observation. The SKY card shows sun and moon position, rise/set, moon phase,
shadow bearing and length, bright stars and weather, with a sun-path dial.
Time can be scrubbed ±24 h, jumped to sunrise/noon/sunset/midnight, or played
at 60–3600×. Live contacts always keep their real positions.

**Flying into weather.** Below 30 km the console samples the radar
(MRMS reflectivity, CONUS), the global infrared cloud mosaic and lightning
density under the camera and on rings out to 25 km, every 400 ms as you
move. Effects ramp with distance to a cell and ease continuously: under the
cloud base the light drops, rain thickens and visibility closes to 1–2 km;
inside the cloud the view whites out to a few hundred metres with flashes;
above the tops the air clears and lightning glows below. Outside radar
coverage the point observation still drives the rain.

## More panels on the ops rail

Each is a chip on the rail (they wrap onto a second row on narrow screens),
each can be popped out into its own window with ⧉, and each has a Shepherd
tool of the same name.

| Chip      | What it does                                                                                                                                           | Sources                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| maps      | Stack other map sources and imports (XYZ, ArcGIS, WMS) with opacity and order; sea-level rise; heat layers and the thermal (ironbow) filter            | NASA GIBS, Esri, OSM, others as listed                  |
| volcanoes | 66 notable volcanoes (17 undersea) with VEI hazard rings, plus currently elevated volcanoes                                                            | Smithsonian GVP, USGS HANS                              |
| space     | Planets and the asteroid belt in the sky, near-Earth close approaches with impact-effect estimates                                                     | JPL elements, JPL CNEOS                                 |
| spectrum  | Frequency lookup (who uses a band), public SDR receivers, transmitters in view                                                                         | ITU allocations, KiwiSDR list, OpenStreetMap            |
| symbols   | Religious and esoteric landmarks and road geometry (crosses, stars, circles) in view                                                                   | OpenStreetMap                                           |
| crime     | Street-level incident heat map where police publish it, homicide rates by country, organized-crime reported activity by region (not territory)         | data.police.uk, city open data, World Bank/UNODC, ACLED |
| history   | War timeline from today back to antiquity, colour-coded by era, playable; battles on the globe                                                         | curated list, Wikidata                                  |
| resources | Richest countries by resource (oil, gas, coal, minerals, forests, gold and FX reserves, water, arable land); mines, wells, refineries, storage in view | World Bank, OpenStreetMap                               |
| leaders   | Chain of areas over any point (nation → state → county → city) with current heads of state and government; subdivisions of any area                    | OpenStreetMap boundaries, Wikidata                      |
| live      | Multi-operator session: share the view, pins, notes and overlays with other operators                                                                  | this server (memory or Upstash)                         |
| settings  | Fonts, lowercase or as-written text, language (23), your own logo image, fade hints, panel sizes                                                       | —                                                       |

NATIONS adds telecom links (cables, landing stations, IXPs) and **who owns
it** (ports, airports, power, dams, refineries by state, foreign or private
owner — institutions only). The aircraft card adds route and ETA, COCKPIT
and AHEAD (projected path), and SANCTIONS when OpenSanctions is keyed.
REWIND can reach 24 h back from the browser's own track archive.

**Cameras load faster.** The camera catalog answers from memory while it
refreshes in the background, a cold server serves whichever agency catalogs
answered within 5 s and merges the rest as they land, and a last-good
catalog on disk makes restarts instant. NYC DOT and the Hong Kong Transport
Department join the agency packs (Austin, Caltrans, TxDOT, DelDOT, TfL,
Ontario, DriveBC, Calgary, Fintraffic, Estonia, Warendorf, NSW). Only public
agency cameras are used; sharing or rotating one agency's key across
requests to get round its limits is not done.

Upstreams these panels read were not reachable from the build sandbox, so
they were tested against recorded payloads; check them once on your deploy.

## NATIONS

Profiles for 250 states (bundled from `world-countries`, ODbL), capital
geocoding, the government district around the capital from OpenStreetMap
(legislature, executive, ministries, courts, embassies), a one-click national
infrastructure layer preset, and publicly announced multilateral summit
venues. Summit dates marked ≈ are the host's announced window — confirm on the
host's site.

## Keys

Copy `.env.example` to `.env` (or set them in Vercel → Settings → Environment
Variables). Run `npm run validate:env` to see what each enables — values are
never printed.

| Variable                                                                                            | Enables                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAM_ACCESS_TOKEN`                                                                                 | **Required on any public host.** Locks every `/api` route behind a cookie issued after entering the token                                                |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `VENICE_API_KEY` / `OPENROUTER_API_KEY` | Shepherd (any one)                                                                                                                                       |
| `OPENAI_API_KEY`                                                                                    | Voice analyst                                                                                                                                            |
| `ADAM_ACCESS_ROLES`                                                                                 | Named roles, each with its own token and allowed `/api` prefixes; paid routes are audited to the server log (identity, route, outcome — never the token) |
| `ADAM_VOICE_SESSIONS_PER_DAY` / `VITE_ADAM_VOICE_DAILY_CAP_USD`                                     | Voice spend ceilings: server sessions per day (429 past it) and a per-browser daily USD cap (default 20)                                                 |
| `GOOGLE_MAPS_API_KEY` or `CESIUM_ION_TOKEN`                                                         | Photoreal 3D tiles (browser-exposed by design — restrict by referrer)                                                                                    |
| `FAA_NOTAM_CLIENT_ID` / `FAA_NOTAM_CLIENT_SECRET`                                                   | NOTAMs (Shepherd `notams`)                                                                                                                               |
| `ACLED_USERNAME` / `ACLED_PASSWORD` (or `ACLED_KEY` / `ACLED_EMAIL`)                                | Conflict events and CRIME → organized crime                                                                                                              |
| `OPENSANCTIONS_API_KEY`                                                                             | Sanctions checks on vessels, aircraft and companies                                                                                                      |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`                                               | Live sessions shared across serverless instances                                                                                                         |
| `ADAM_SSO_*`                                                                                        | Sign-on with any OIDC provider (see `.env.example`)                                                                                                      |

Without an access token on Vercel, the paid routes (`/api/shepherd`,
`/api/openai`, `/api/realtime`, `/api/google`) refuse to run, so a leaked URL
cannot spend your keys. Keyless data layers keep working.

## Deploy (Vercel)

1. Import the repository; the framework preset is read from `vercel.json`.
2. Set `ADAM_ACCESS_TOKEN` (`openssl rand -hex 32`) and at least one AI key.
3. Deploy. The build prints the environment report first.

## What ADAM will not do

ADAM maps aircraft, vessels, infrastructure, institutions and places. It does
not identify private individuals, find who lives at or owns an address, look up
passengers or seats on a flight, or track, predict or reconstruct where a
specific person — including heads of state and officials — is or how they are
travelling. Owner-of-record questions belong with the relevant public records
office.
