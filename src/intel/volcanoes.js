/**
 * Volcanoes on land and under the sea, and what an eruption of a given size
 * reaches. The live catalogue is the Smithsonian Global Volcanism Program
 * (every Holocene volcano) with USGS elevated alert levels; the notable set
 * below ships with the app so the layer works offline.
 *
 * Hazard rings are illustrative distances by Volcanic Explosivity Index,
 * from the ranges in the volcanology literature (ballistics, pyroclastic
 * density currents, ash fall). Real reach depends on the vent, wind, terrain
 * and the eruption itself; the panel says so.
 */

/**
 * [name, lat, lon, country, setting, largest recorded VEI, last activity]
 * setting: 'land' | 'submarine'
 */
export const NOTABLE_VOLCANOES = [
  ['Kīlauea', 19.421, -155.287, 'United States', 'land', 1, '2024'],
  ['Mauna Loa', 19.475, -155.608, 'United States', 'land', 1, '2022'],
  ['Mount St. Helens', 46.2, -122.18, 'United States', 'land', 5, '2008'],
  ['Mount Rainier', 46.853, -121.76, 'United States', 'land', 4, '1450'],
  ['Yellowstone', 44.43, -110.67, 'United States', 'land', 8, '70,000 BP'],
  ['Redoubt', 60.485, -152.742, 'United States', 'land', 3, '2009'],
  ['Pavlof', 55.417, -161.894, 'United States', 'land', 3, '2022'],
  ['Popocatépetl', 19.023, -98.622, 'Mexico', 'land', 3, '2024'],
  ['Colima', 19.514, -103.62, 'Mexico', 'land', 4, '2019'],
  ['Fuego', 14.473, -90.88, 'Guatemala', 'land', 3, '2024'],
  ['Nevado del Ruiz', 4.892, -75.324, 'Colombia', 'land', 3, '2023'],
  ['Cotopaxi', -0.677, -78.436, 'Ecuador', 'land', 4, '2023'],
  ['Tungurahua', -1.467, -78.442, 'Ecuador', 'land', 3, '2016'],
  ['Villarrica', -39.42, -71.93, 'Chile', 'land', 2, '2024'],
  ['Soufrière Hills', 16.72, -62.18, 'Montserrat', 'land', 3, '2013'],
  ['Mount Pelée', 14.809, -61.165, 'Martinique', 'land', 4, '1932'],
  ['Hekla', 63.983, -19.7, 'Iceland', 'land', 4, '2000'],
  ['Katla', 63.633, -19.05, 'Iceland', 'land', 4, '1918'],
  ['Eyjafjallajökull', 63.633, -19.633, 'Iceland', 'land', 4, '2010'],
  ['Grímsvötn', 64.416, -17.316, 'Iceland', 'land', 4, '2011'],
  ['Reykjanes (Sundhnúkur)', 63.903, -22.273, 'Iceland', 'land', 1, '2025'],
  ['Teide', 28.271, -16.641, 'Spain', 'land', 3, '1909'],
  ['Cumbre Vieja', 28.57, -17.83, 'Spain', 'land', 2, '2021'],
  ['Etna', 37.748, 14.999, 'Italy', 'land', 2, '2025'],
  ['Stromboli', 38.789, 15.213, 'Italy', 'land', 2, '2025'],
  ['Vesuvius', 40.821, 14.426, 'Italy', 'land', 5, '1944'],
  ['Campi Flegrei', 40.827, 14.139, 'Italy', 'land', 7, '1538'],
  ['Santorini', 36.404, 25.396, 'Greece', 'land', 6, '1950'],
  ['Nyiragongo', -1.52, 29.25, 'DR Congo', 'land', 1, '2021'],
  ['Erta Ale', 13.6, 40.67, 'Ethiopia', 'land', 1, '2023'],
  ['Ol Doinyo Lengai', -2.764, 35.914, 'Tanzania', 'land', 3, '2013'],
  ['Piton de la Fournaise', -21.244, 55.708, 'Réunion', 'land', 1, '2023'],
  ['Mount Fuji', 35.361, 138.728, 'Japan', 'land', 5, '1707'],
  ['Sakurajima', 31.593, 130.657, 'Japan', 'land', 4, '2025'],
  ['Aso', 32.884, 131.104, 'Japan', 'land', 3, '2021'],
  ['Klyuchevskoy', 56.056, 160.642, 'Russia', 'land', 4, '2024'],
  ['Shiveluch', 56.653, 161.36, 'Russia', 'land', 4, '2024'],
  ['Merapi', -7.54, 110.446, 'Indonesia', 'land', 4, '2025'],
  ['Semeru', -8.108, 112.922, 'Indonesia', 'land', 3, '2024'],
  ['Anak Krakatau', -6.102, 105.423, 'Indonesia', 'land', 6, '2023'],
  ['Tambora', -8.25, 118.0, 'Indonesia', 'land', 7, '1967'],
  ['Agung', -8.343, 115.508, 'Indonesia', 'land', 5, '2019'],
  ['Sinabung', 3.17, 98.392, 'Indonesia', 'land', 2, '2021'],
  ['Taal', 14.002, 120.993, 'Philippines', 'land', 4, '2022'],
  ['Mayon', 13.257, 123.685, 'Philippines', 'land', 3, '2023'],
  ['Pinatubo', 15.13, 120.35, 'Philippines', 'land', 6, '1993'],
  ['Ruapehu', -39.28, 175.57, 'New Zealand', 'land', 3, '2007'],
  ['Whakaari / White Island', -37.52, 177.18, 'New Zealand', 'land', 2, '2019'],
  ['Erebus', -77.53, 167.17, 'Antarctica', 'land', 2, '2024'],
  [
    'Hunga Tonga-Hunga Haʻapai',
    -20.55,
    -175.385,
    'Tonga',
    'submarine',
    6,
    '2022',
  ],
  ['Home Reef', -18.992, -174.775, 'Tonga', 'submarine', 2, '2024'],
  ["Kick 'em Jenny", 12.3, -61.64, 'Grenada', 'submarine', 2, '2017'],
  [
    'Axial Seamount',
    45.95,
    -130.0,
    'United States (offshore)',
    'submarine',
    1,
    '2015',
  ],
  [
    'Kamaʻehuakanaloa (Lōʻihi)',
    18.92,
    -155.27,
    'United States (offshore)',
    'submarine',
    1,
    '1996',
  ],
  ['Kavachi', -8.991, 157.979, 'Solomon Islands', 'submarine', 2, '2023'],
  [
    'Monowai',
    -25.887,
    -177.188,
    'New Zealand (Kermadec)',
    'submarine',
    2,
    '2023',
  ],
  [
    'Havre Seamount',
    -31.08,
    -179.05,
    'New Zealand (Kermadec)',
    'submarine',
    4,
    '2012',
  ],
  ['Fukutoku-Okanoba', 24.285, 141.481, 'Japan', 'submarine', 4, '2021'],
  ['Nishinoshima', 27.247, 140.874, 'Japan', 'submarine', 3, '2023'],
  ['NW Rota-1', 14.601, 144.775, 'Mariana Islands', 'submarine', 1, '2010'],
  ['Ahyi', 20.42, 145.03, 'Mariana Islands', 'submarine', 1, '2023'],
  ['Kolumbo', 36.52, 25.49, 'Greece', 'submarine', 4, '1650'],
  [
    'Marsili',
    39.27,
    14.4,
    'Italy (Tyrrhenian Sea)',
    'submarine',
    1,
    'Holocene',
  ],
  ['Fani Maoré (Mayotte)', -12.9, 45.7, 'Mayotte', 'submarine', 1, '2021'],
  ['Tagoro (El Hierro)', 27.62, -18.0, 'Spain', 'submarine', 2, '2012'],
  [
    'Macdonald Seamount',
    -28.98,
    -140.25,
    'French Polynesia',
    'submarine',
    1,
    '1989',
  ],
].map(([name, lat, lon, country, setting, vei, last]) => ({
  name,
  lat,
  lon,
  country,
  submarine: setting === 'submarine',
  vei,
  lastActivity: last,
  source: 'notable',
}));

/**
 * Illustrative hazard distances (km) by VEI.
 *   ballistic   blocks thrown from the vent (explosion radius)
 *   flows       pyroclastic density currents: lethal, destroys what it reaches
 *   heavyAsh    ~10 cm+ ash fall: roof collapse, crops, power and water
 *   lightAsh    ~1 mm ash: airports close, breathing and engine hazard
 *   lava        effusive eruptions: how far lava flows commonly run
 */
export const VEI_HAZARD = {
  0: { ballistic: 0.2, flows: 0, heavyAsh: 0, lightAsh: 2, lava: 8 },
  1: { ballistic: 0.5, flows: 0, heavyAsh: 1, lightAsh: 10, lava: 15 },
  2: { ballistic: 1, flows: 2, heavyAsh: 5, lightAsh: 30, lava: 10 },
  3: { ballistic: 2, flows: 5, heavyAsh: 15, lightAsh: 80, lava: 0 },
  4: { ballistic: 4, flows: 10, heavyAsh: 40, lightAsh: 200, lava: 0 },
  5: { ballistic: 5, flows: 20, heavyAsh: 100, lightAsh: 500, lava: 0 },
  6: { ballistic: 6, flows: 40, heavyAsh: 250, lightAsh: 1000, lava: 0 },
  7: { ballistic: 8, flows: 80, heavyAsh: 600, lightAsh: 2500, lava: 0 },
  8: { ballistic: 10, flows: 150, heavyAsh: 1500, lightAsh: 5000, lava: 0 },
};

export const HAZARD_LABELS = {
  ballistic: 'explosion · ballistic blocks',
  flows: 'pyroclastic flows · lethal',
  heavyAsh: 'heavy ash · roof collapse, crops, power',
  lightAsh: 'light ash · airports close',
  lava: 'lava flows',
};

export const HAZARD_COLORS = {
  ballistic: '#FF3B30',
  flows: '#FF6B2C',
  heavyAsh: '#FFB454',
  lightAsh: '#C9C27A',
  lava: '#FF4D00',
};

export function clampVei(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : 3;
}

/** Rings to draw for an eruption of `vei`, largest first. */
export function hazardRings(vei, { submarine = false } = {}) {
  const h = VEI_HAZARD[clampVei(vei)];
  const rings = Object.entries(h)
    .filter(([, km]) => km > 0)
    .map(([kind, km]) => ({
      kind,
      km,
      label: HAZARD_LABELS[kind],
      color: HAZARD_COLORS[kind],
    }))
    .sort((a, b) => b.km - a.km);
  const notes = [];
  if (submarine) {
    notes.push(
      clampVei(vei) >= 4
        ? 'undersea: a large eruption can breach the surface explosively and send tsunamis across the basin'
        : 'undersea: most activity stays below the surface; pumice rafts and discoloured water are common',
    );
  }
  if (clampVei(vei) >= 7)
    notes.push('VEI 7–8 ash and aerosols affect climate worldwide');
  return { vei: clampVei(vei), rings, notes };
}

const pick = (o, ...keys) => {
  for (const k of keys) {
    const hit = Object.keys(o || {}).find(
      (x) => x.toLowerCase() === k.toLowerCase(),
    );
    if (hit && o[hit] != null && o[hit] !== '') return o[hit];
  }
  return null;
};

/** Smithsonian GVP WFS GeoJSON → volcano records. */
export function normalizeGvp(fc) {
  const out = [];
  for (const f of fc?.features || []) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [
      pick(p, 'Longitude'),
      pick(p, 'Latitude'),
    ];
    if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) continue;
    const type = String(
      pick(p, 'Primary_Volcano_Type', 'PrimaryVolcanoType') || '',
    );
    const elev = Number(pick(p, 'Elevation', 'Elevation_m'));
    out.push({
      name: String(pick(p, 'Volcano_Name', 'VolcanoName', 'Name') || 'volcano'),
      number: pick(p, 'Volcano_Number', 'VolcanoNumber'),
      lat: +lat,
      lon: +lon,
      country: pick(p, 'Country') || null,
      type: type || null,
      elevationM: Number.isFinite(elev) ? elev : null,
      submarine: /submarine/i.test(type) || (Number.isFinite(elev) && elev < 0),
      lastActivity: pick(p, 'Last_Eruption_Year', 'LastEruptionYear') ?? null,
      vei: null,
      source: 'GVP',
    });
  }
  return out;
}

/** USGS HANS elevated volcanoes → alert records. */
export function normalizeHans(json) {
  const rows = Array.isArray(json) ? json : json?.volcanoes || json?.data || [];
  return rows
    .map((r) => ({
      name: pick(r, 'volcano_name', 'volcanoName', 'name'),
      lat: Number(pick(r, 'latitude', 'lat')),
      lon: Number(pick(r, 'longitude', 'long', 'lon')),
      color:
        String(pick(r, 'color_code', 'colorCode') || '').toUpperCase() || null,
      alert:
        String(pick(r, 'alert_level', 'alertLevel') || '').toUpperCase() ||
        null,
      observatory: pick(r, 'obs_abbr', 'obs_fullname', 'observatory'),
      notice: pick(r, 'notice_url', 'noticeUrl'),
      sent: pick(r, 'sent_utc', 'sentUtc', 'notice_date'),
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/** Search the notable + live lists by name or country. */
export function findVolcanoes(list, query, limit = 12) {
  const q = String(query || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  if (!q) return list.slice(0, limit);
  const norm = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  return list
    .map((v) => {
      const n = norm(v.name);
      const score =
        n === q
          ? 3
          : n.startsWith(q)
            ? 2
            : n.includes(q) || norm(v.country).includes(q)
              ? 1
              : 0;
      return [score, v];
    })
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, v]) => v);
}
