# ADAM — operator guide

ADAM (#houseofasher) is a live 3D intelligence console on a Cesium globe. This
page covers what ADAM adds beyond the upstream globe, the keys it needs, how to
deploy it privately, and what it deliberately will not do.

## Operator surfaces

The ops rail sits in its own lane under the top action bar:

| Chip      | Key | What it does                                                                                                                   |
| --------- | --- | ------------------------------------------------------------------------------------------------------------------------------ |
| BRIEF     | B   | Situational brief across every loaded layer, with baseline deviations                                                          |
| ALERTS    | A   | Alert triggers: contacts in a zone, speed in a zone                                                                            |
| FILTER    | G   | Time window, region, altitude band, vessel class                                                                               |
| HEALTH    | —   | Feeds down, stale or on fallback, degraded capabilities; pulses amber past one fault. Exports and imports the operator profile |
| SKY       | L   | Live environment at the view centre (see below)                                                                                |
| NATIONS   | N   | State institutions, national infrastructure, summit venues                                                                     |
| BUILDINGS | —   | 3D buildings: photoreal tiles with a key, OSM footprints without                                                               |
| KEYS      | ?   | Every shortcut live in the current mode                                                                                        |
| SHEPHERD  | S   | The text analyst                                                                                                               |

The top action bar adds **snapshot** (PNG of the view with a caption strip),
**record** (the whole tab via screen capture, falling back to the globe canvas;
MP4 or WebM) and **interface scale** (80–140% for every panel; the globe is
untouched).

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
