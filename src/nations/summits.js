/**
 * Publicly announced multilateral summits and their venues.
 *
 * Venues and dates come from the hosts' public announcements. They are events,
 * not people: nothing here tracks where any individual is or how they travel.
 * Dates marked `approx` are the host's announced window; confirm on the
 * host's official site before relying on them.
 */

/**
 * @typedef {{id: string, name: string, host: string, venue: string,
 *   lat: number, lon: number, start: string, end: string, approx?: boolean,
 *   series: string}} Summit
 */

/** @type {ReadonlyArray<Summit>} */
export const SUMMITS = Object.freeze([
  {
    id: 'wef-2025',
    series: 'WEF',
    name: 'World Economic Forum annual meeting',
    host: 'Switzerland',
    venue: 'Davos',
    lat: 46.8027,
    lon: 9.836,
    start: '2025-01-20',
    end: '2025-01-24',
  },
  {
    id: 'msc-2025',
    series: 'MSC',
    name: 'Munich Security Conference',
    host: 'Germany',
    venue: 'Hotel Bayerischer Hof, Munich',
    lat: 48.1405,
    lon: 11.5733,
    start: '2025-02-14',
    end: '2025-02-16',
  },
  {
    id: 'sld-2025',
    series: 'Shangri-La',
    name: 'Shangri-La Dialogue',
    host: 'Singapore',
    venue: 'Shangri-La Hotel, Singapore',
    lat: 1.3106,
    lon: 103.8263,
    start: '2025-05-30',
    end: '2025-06-01',
  },
  {
    id: 'g7-2025',
    series: 'G7',
    name: 'G7 Leaders’ Summit',
    host: 'Canada',
    venue: 'Kananaskis, Alberta',
    lat: 50.9277,
    lon: -115.1253,
    start: '2025-06-15',
    end: '2025-06-17',
  },
  {
    id: 'nato-2025',
    series: 'NATO',
    name: 'NATO Summit',
    host: 'Netherlands',
    venue: 'World Forum, The Hague',
    lat: 52.093,
    lon: 4.283,
    start: '2025-06-24',
    end: '2025-06-25',
  },
  {
    id: 'brics-2025',
    series: 'BRICS',
    name: 'BRICS Summit',
    host: 'Brazil',
    venue: 'Rio de Janeiro',
    lat: -22.9136,
    lon: -43.172,
    start: '2025-07-06',
    end: '2025-07-07',
  },
  {
    id: 'sco-2025',
    series: 'SCO',
    name: 'SCO Heads of State Council',
    host: 'China',
    venue: 'Tianjin',
    lat: 39.0842,
    lon: 117.2009,
    start: '2025-08-31',
    end: '2025-09-01',
  },
  {
    id: 'unga-80',
    series: 'UNGA',
    name: 'UN General Assembly high-level week (80th)',
    host: 'United Nations',
    venue: 'UN Headquarters, New York',
    lat: 40.7489,
    lon: -73.968,
    start: '2025-09-22',
    end: '2025-09-30',
    approx: true,
  },
  {
    id: 'apec-2025',
    series: 'APEC',
    name: 'APEC Economic Leaders’ Week',
    host: 'South Korea',
    venue: 'Gyeongju',
    lat: 35.8562,
    lon: 129.2247,
    start: '2025-10-31',
    end: '2025-11-01',
  },
  {
    id: 'cop30',
    series: 'COP',
    name: 'UN Climate Change Conference (COP30)',
    host: 'Brazil',
    venue: 'Belém',
    lat: -1.4558,
    lon: -48.4902,
    start: '2025-11-10',
    end: '2025-11-21',
  },
  {
    id: 'g20-2025',
    series: 'G20',
    name: 'G20 Leaders’ Summit',
    host: 'South Africa',
    venue: 'Nasrec Expo Centre, Johannesburg',
    lat: -26.2365,
    lon: 27.9868,
    start: '2025-11-22',
    end: '2025-11-23',
  },
  {
    id: 'wef-2026',
    series: 'WEF',
    name: 'World Economic Forum annual meeting',
    host: 'Switzerland',
    venue: 'Davos',
    lat: 46.8027,
    lon: 9.836,
    start: '2026-01-19',
    end: '2026-01-23',
  },
  {
    id: 'msc-2026',
    series: 'MSC',
    name: 'Munich Security Conference',
    host: 'Germany',
    venue: 'Hotel Bayerischer Hof, Munich',
    lat: 48.1405,
    lon: 11.5733,
    start: '2026-02-13',
    end: '2026-02-15',
  },
  {
    id: 'sld-2026',
    series: 'Shangri-La',
    name: 'Shangri-La Dialogue',
    host: 'Singapore',
    venue: 'Shangri-La Hotel, Singapore',
    lat: 1.3106,
    lon: 103.8263,
    start: '2026-05-29',
    end: '2026-05-31',
    approx: true,
  },
  {
    id: 'g7-2026',
    series: 'G7',
    name: 'G7 Leaders’ Summit',
    host: 'France',
    venue: 'Évian-les-Bains',
    lat: 46.4008,
    lon: 6.5897,
    start: '2026-06-14',
    end: '2026-06-16',
  },
  {
    id: 'nato-2026',
    series: 'NATO',
    name: 'NATO Summit',
    host: 'Türkiye',
    venue: 'Ankara',
    lat: 39.9334,
    lon: 32.8597,
    start: '2026-07-07',
    end: '2026-07-08',
  },
  {
    id: 'unga-81',
    series: 'UNGA',
    name: 'UN General Assembly high-level week (81st)',
    host: 'United Nations',
    venue: 'UN Headquarters, New York',
    lat: 40.7489,
    lon: -73.968,
    start: '2026-09-22',
    end: '2026-09-29',
    approx: true,
  },
  {
    id: 'apec-2026',
    series: 'APEC',
    name: 'APEC Economic Leaders’ Week',
    host: 'China',
    venue: 'Shenzhen',
    lat: 22.5431,
    lon: 114.0579,
    start: '2026-11-01',
    end: '2026-11-30',
    approx: true,
  },
  {
    id: 'cop31',
    series: 'COP',
    name: 'UN Climate Change Conference (COP31)',
    host: 'Türkiye',
    venue: 'Antalya',
    lat: 36.8969,
    lon: 30.7133,
    start: '2026-11-09',
    end: '2026-11-20',
    approx: true,
  },
  {
    id: 'g20-2026',
    series: 'G20',
    name: 'G20 Leaders’ Summit',
    host: 'United States',
    venue: 'Doral, Miami',
    lat: 25.8127,
    lon: -80.3385,
    start: '2026-12-14',
    end: '2026-12-15',
    approx: true,
  },
]);

const DAY = 86_400_000;

/** 'live' during, 'upcoming' before, 'held' after. */
export function summitStatus(summit, now = Date.now()) {
  const start = Date.parse(`${summit.start}T00:00:00Z`);
  const end = Date.parse(`${summit.end}T23:59:59Z`);
  if (now < start) return 'upcoming';
  if (now > end) return 'held';
  return 'live';
}

/** Live first, then upcoming soonest-first, then held most-recent-first. */
export function orderedSummits(now = Date.now(), summits = SUMMITS) {
  const rank = { live: 0, upcoming: 1, held: 2 };
  return summits
    .map((s) => ({
      ...s,
      status: summitStatus(s, now),
      daysAway: Math.round((Date.parse(`${s.start}T00:00:00Z`) - now) / DAY),
    }))
    .sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.status === 'held'
          ? b.start.localeCompare(a.start)
          : a.start.localeCompare(b.start)),
    );
}
