/**
 * Spectrum awareness from public sources: what a frequency is used for, who
 * is listening (public web SDR receivers anyone can tune), and where the
 * masts are. The allocation table is simplified from the ITU Radio
 * Regulations and common national plans; national tables differ between
 * ITU Regions 1–3, and the panel says so.
 */

/** [fromMHz, toMHz, service, typical uses] */
export const BANDS = [
  [0.003, 0.03, 'VLF', 'submarine communication, time signals'],
  [
    0.03,
    0.1485,
    'LF',
    'time signals (WWVB 60 kHz, MSF, DCF77 77.5 kHz), eLoran 100 kHz',
  ],
  [0.1485, 0.2835, 'long wave broadcast', 'AM broadcasting (ITU Region 1)'],
  [
    0.2835,
    0.5265,
    'aeronautical & maritime',
    'non-directional beacons (NDB), navtex 518 kHz',
  ],
  [0.5265, 1.705, 'medium wave broadcast', 'AM radio'],
  [1.8, 2.0, 'amateur 160 m', 'ham radio'],
  [2.1735, 2.1905, 'maritime distress', '2182 kHz voice, 2187.5 kHz DSC'],
  [2.85, 22.0, 'HF aeronautical', 'oceanic air traffic voice (HF), volmet'],
  [3.5, 4.0, 'amateur 80 m', 'ham radio'],
  [
    4.0,
    27.5,
    'HF maritime & broadcast',
    'ship–shore, shortwave broadcasting bands',
  ],
  [7.0, 7.3, 'amateur 40 m', 'ham radio'],
  [14.0, 14.35, 'amateur 20 m', 'ham radio, long distance'],
  [26.965, 27.405, 'citizens band', 'CB radio'],
  [28.0, 29.7, 'amateur 10 m', 'ham radio'],
  [50.0, 54.0, 'amateur 6 m', 'ham radio'],
  [54.0, 88.0, 'VHF television', 'TV channels 2–6 (Region 2), band I'],
  [87.5, 108.0, 'FM broadcast', 'FM radio'],
  [108.0, 117.975, 'aeronautical radionavigation', 'VOR, ILS localizer'],
  [
    117.975,
    137.0,
    'aeronautical mobile',
    'airband voice, 121.5 MHz emergency, ACARS',
  ],
  [137.0, 138.0, 'weather satellites', 'NOAA/Meteor APT and LRPT imagery'],
  [144.0, 148.0, 'amateur 2 m', 'ham radio, APRS 144.39/144.8'],
  [
    156.0,
    162.025,
    'maritime VHF',
    'channel 16 (156.8), DSC ch70, AIS 161.975/162.025',
  ],
  [162.4, 162.55, 'weather radio', 'NOAA weather radio (US)'],
  [174.0, 240.0, 'band III', 'VHF TV, DAB digital radio'],
  [
    225.0,
    400.0,
    'military aviation',
    'NATO UHF air band, 243 MHz military emergency',
  ],
  [406.0, 406.1, 'distress beacons', 'COSPAS-SARSAT EPIRB/ELT/PLB'],
  [420.0, 450.0, 'amateur 70 cm & radiolocation', 'ham radio, radars'],
  [433.05, 434.79, 'ISM (Region 1)', 'key fobs, sensors, LPD radios'],
  [470.0, 698.0, 'UHF television', 'digital TV, wireless microphones'],
  [698.0, 960.0, 'cellular', '4G/5G low bands, GSM 900'],
  [863.0, 870.0, 'short range devices (Europe)', 'LoRa EU868, alarms, IoT'],
  [902.0, 928.0, 'ISM (Region 2)', 'LoRa US915, RFID, IoT'],
  [
    960.0,
    1215.0,
    'aeronautical radionavigation',
    'DME/TACAN, SSR 1030 MHz, ADS-B/Mode S 1090 MHz',
  ],
  [1164.0, 1215.0, 'satellite navigation', 'GPS L5, Galileo E5'],
  [
    1215.0,
    1300.0,
    'satellite navigation & radar',
    'GPS L2, Galileo E6, long-range radar',
  ],
  [1525.0, 1559.0, 'mobile satellite', 'Inmarsat L-band downlink'],
  [
    1559.0,
    1610.0,
    'satellite navigation',
    'GPS L1 1575.42, Galileo E1, GLONASS, BeiDou B1',
  ],
  [1616.0, 1626.5, 'mobile satellite', 'Iridium'],
  [1710.0, 2200.0, 'cellular', '3G/4G/5G mid bands (AWS, PCS, UMTS)'],
  [2400.0, 2483.5, 'ISM 2.4 GHz', 'Wi-Fi, Bluetooth, microwave ovens, drones'],
  [2500.0, 2690.0, 'cellular', '4G/5G band 7/41'],
  [2700.0, 3000.0, 'radar', 'airport surveillance radar, NEXRAD weather radar'],
  [
    3300.0,
    4200.0,
    'cellular & satellite',
    '5G n77/n78, C-band satellite downlink',
  ],
  [4200.0, 4400.0, 'radio altimeters', 'aircraft radar altimeters'],
  [5150.0, 5850.0, 'Wi-Fi 5 GHz & radar', 'Wi-Fi, TDWR weather radar 5.6 GHz'],
  [5925.0, 7125.0, 'Wi-Fi 6E & fixed links', 'Wi-Fi 6E, microwave backhaul'],
  [8000.0, 12000.0, 'X band', 'marine and military radar, satellite links'],
  [10700.0, 12750.0, 'Ku downlink', 'satellite TV, VSAT'],
  [12750.0, 14500.0, 'Ku uplink', 'satellite uplinks, VSAT'],
  [
    17700.0,
    21200.0,
    'Ka downlink',
    'high-throughput satellites (Starlink, OneWeb)',
  ],
  [
    24250.0,
    29500.0,
    '5G mmWave & Ka uplink',
    '5G n257/n258/n261, satellite uplinks',
  ],
  [76000.0, 81000.0, 'automotive radar', 'car collision-avoidance radar'],
].map(([from, to, service, uses]) => ({ from, to, service, uses }));

/** Parse "1090", "1090 MHz", "7.1 mhz", "2.4 GHz", "518 kHz" → MHz. */
export function parseFrequency(text) {
  const m = /^\s*([\d.]+)\s*(hz|khz|mhz|ghz)?\s*$/i.exec(String(text || ''));
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'hz') return v / 1e6;
  if (unit === 'khz') return v / 1e3;
  if (unit === 'ghz') return v * 1e3;
  if (unit === 'mhz') return v;
  // Bare numbers: > 30,000 reads as kHz typed without unit is rare; treat as MHz.
  return v;
}

/** Every band containing the frequency, narrowest first. */
export function bandsFor(mhz) {
  if (!Number.isFinite(mhz)) return [];
  return BANDS.filter((b) => mhz >= b.from && mhz <= b.to).sort(
    (a, b) => a.to - a.from - (b.to - b.from),
  );
}

export function formatMHz(mhz) {
  if (mhz >= 1000) return `${+(mhz / 1000).toFixed(3)} GHz`;
  if (mhz < 1) return `${+(mhz * 1000).toFixed(1)} kHz`;
  return `${+mhz.toFixed(3)} MHz`;
}

/**
 * KiwiSDR public list (rx.linkfanel.net/kiwisdr_com.js) → receivers.
 * The file is a JS assignment of an array; parse the array part only.
 */
export function parseKiwiList(text) {
  const start = String(text || '').indexOf('[');
  const end = String(text || '').lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1'));
  } catch {
    return [];
  }
  const out = [];
  for (const r of arr) {
    const m = /\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?/.exec(
      String(r.gps || ''),
    );
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;
    if (!/^https?:\/\//.test(String(r.url || ''))) continue;
    out.push({
      name: String(r.name || 'KiwiSDR').slice(0, 120),
      lat,
      lon,
      url: String(r.url),
      antenna: String(r.antenna || '').slice(0, 120) || null,
      bands: String(r.bands || '') || null,
      users: Number(r.users) || 0,
      usersMax: Number(r.users_max) || null,
      offline:
        String(r.offline || '') === 'yes' ||
        String(r.status || '') === 'offline',
    });
  }
  return out;
}

export function transmitterQuery([s, w, n, e], cap = 600) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:30];(
nwr["man_made"~"^(mast|tower)$"]["tower:type"~"communication|broadcast|radar"](${b});
nwr["communication:radio"](${b});
nwr["communication:television"](${b});
nwr["communication:mobile_phone"="yes"](${b});
);out tags center ${cap};`;
}

export function normalizeTransmitters(json) {
  return (json?.elements || [])
    .map((el) => {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const uses = [
        t['communication:radio'] && 'radio',
        t['communication:television'] && 'television',
        t['communication:mobile_phone'] === 'yes' && 'mobile',
        t['tower:type'] === 'radar' && 'radar',
      ].filter(Boolean);
      return {
        name: t.name || t.operator || null,
        operator: t.operator || null,
        kind: t['tower:type'] || t.man_made || 'transmitter',
        uses,
        heightM: Number(t.height) || null,
        lat,
        lon,
      };
    })
    .filter(Boolean);
}
