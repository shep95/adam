/**
 * Flight lookup: GET /api/flight-lookup?q=<callsign | IATA flight | registration | hex>
 *
 * Resolves "UA 1234", "UAL1234", "N12345", "G-EUPT" or "a1b2c3" to the live
 * ADS-B position through adsb.lol, so the console can fly to the aircraft and
 * lock the follow camera. Aircraft only — no passenger or crew data exists
 * here and none is sought.
 */
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseTextCapped } from './common/http.js';

const ADSB_LOL = 'https://api.adsb.lol/v2';
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 8_000;

/** IATA → ICAO airline designators for the carriers people type most. */
export const IATA_TO_ICAO = Object.freeze({
  AA: 'AAL',
  UA: 'UAL',
  DL: 'DAL',
  WN: 'SWA',
  AS: 'ASA',
  B6: 'JBU',
  NK: 'NKS',
  F9: 'FFT',
  HA: 'HAL',
  G4: 'AAY',
  SY: 'SCX',
  AC: 'ACA',
  WS: 'WJA',
  AM: 'AMX',
  Y4: 'VOI',
  VB: 'VIV',
  BA: 'BAW',
  VS: 'VIR',
  U2: 'EZY',
  FR: 'RYR',
  LH: 'DLH',
  AF: 'AFR',
  KL: 'KLM',
  IB: 'IBE',
  AZ: 'ITY',
  LX: 'SWR',
  OS: 'AUA',
  SN: 'BEL',
  SK: 'SAS',
  AY: 'FIN',
  EI: 'EIN',
  TP: 'TAP',
  LO: 'LOT',
  TK: 'THY',
  PC: 'PGT',
  W6: 'WZZ',
  VY: 'VLG',
  EW: 'EWG',
  DY: 'NOZ',
  D8: 'NSZ',
  EK: 'UAE',
  QR: 'QTR',
  EY: 'ETD',
  SV: 'SVA',
  GF: 'GFA',
  WY: 'OMA',
  MS: 'MSR',
  RJ: 'RJA',
  ET: 'ETH',
  KQ: 'KQA',
  SA: 'SAA',
  AT: 'RAM',
  LY: 'ELY',
  FZ: 'FDB',
  G9: 'ABY',
  J9: 'JZR',
  SQ: 'SIA',
  CX: 'CPA',
  QF: 'QFA',
  VA: 'VOZ',
  NZ: 'ANZ',
  JL: 'JAL',
  NH: 'ANA',
  KE: 'KAL',
  OZ: 'AAR',
  CI: 'CAL',
  BR: 'EVA',
  CA: 'CCA',
  MU: 'CES',
  CZ: 'CSN',
  HU: 'CHH',
  TG: 'THA',
  MH: 'MAS',
  GA: 'GIA',
  PR: 'PAL',
  VN: 'HVN',
  AI: 'AIC',
  '6E': 'IGO',
  UK: 'VTI',
  AK: 'AXM',
  LA: 'LAN',
  AV: 'AVA',
  CM: 'CMP',
  AR: 'ARG',
  G3: 'GLO',
  AD: 'AZU',
  FX: 'FDX',
  '5X': 'UPS',
});

/**
 * Candidate adsb.lol lookups for a free-text query, most specific first.
 * @param {string} raw
 * @returns {Array<{kind: 'hex'|'reg'|'callsign', value: string}>}
 */
export function flightQueryCandidates(raw) {
  const q = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!q || q.length > 12 || !/^[A-Z0-9-]+$/.test(q)) return [];
  const out = [];
  const add = (kind, value) => {
    if (value && !out.some((c) => c.kind === kind && c.value === value))
      out.push({ kind, value });
  };
  if (/^[0-9A-F]{6}$/.test(q)) add('hex', q.toLowerCase());
  const iata = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(q);
  if (iata && IATA_TO_ICAO[iata[1]])
    add('callsign', `${IATA_TO_ICAO[iata[1]]}${iata[2]}`);
  if (/^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/.test(q)) add('callsign', q);
  if (/^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/.test(q) || /^N\d{1,5}[A-Z]{0,2}$/.test(q))
    add('reg', q);
  if (/^[A-Z0-9]{3,8}$/.test(q)) add('callsign', q);
  return out.slice(0, 4);
}

/** Normalize one adsb.lol aircraft row. */
export function normalizeAdsbAircraft(ac) {
  const lat = Number(ac?.lat ?? ac?.lastPosition?.lat);
  const lon = Number(ac?.lon ?? ac?.lastPosition?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altFt =
    ac.alt_baro === 'ground' ? 0 : Number(ac.alt_geom ?? ac.alt_baro);
  return {
    icao24: String(ac.hex || '')
      .replace(/^~/, '')
      .toLowerCase(),
    callsign: String(ac.flight || '').trim() || null,
    registration: String(ac.r || '').trim() || null,
    type: String(ac.t || '').trim() || null,
    description: String(ac.desc || '').trim() || null,
    operator: String(ac.ownOp || '').trim() || null,
    lat,
    lon,
    altitudeFt: Number.isFinite(altFt) ? altFt : null,
    onGround: ac.alt_baro === 'ground',
    groundSpeedKts: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : null,
    trackDeg: Number.isFinite(Number(ac.track)) ? Number(ac.track) : null,
    verticalRateFpm: Number.isFinite(Number(ac.baro_rate))
      ? Number(ac.baro_rate)
      : null,
    squawk: String(ac.squawk || '') || null,
    seenSec: Number.isFinite(Number(ac.seen_pos ?? ac.seen))
      ? Number(ac.seen_pos ?? ac.seen)
      : null,
  };
}

export function flightLookupProxy({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 240,
  });
  const cache = new Map();

  async function lookup(candidate) {
    const key = `${candidate.kind}:${candidate.value}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchImpl(
        `${ADSB_LOL}/${candidate.kind}/${encodeURIComponent(candidate.value)}`,
        {
          headers: {
            'User-Agent':
              'adam-flight-lookup/1.0 (+https://github.com/shep95/adam)',
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      );
      const text = await readResponseTextCapped(response, MAX_BYTES);
      if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
      const rows = (JSON.parse(text)?.ac || [])
        .map(normalizeAdsbAircraft)
        .filter(Boolean);
      cache.set(key, { at: Date.now(), rows });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  function send(res, status, payload) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
  }

  function install(middlewares) {
    middlewares.use('/api/flight-lookup', async (req, res) => {
      if (req.method !== 'GET')
        return send(res, 405, { error: 'method not allowed' });
      if (!limiter(clientKey(req)))
        return send(res, 429, { error: 'rate limit exceeded' });
      const q = new URL(req.url, 'http://localhost').searchParams.get('q');
      const candidates = flightQueryCandidates(q);
      if (!candidates.length)
        return send(res, 400, {
          error:
            'enter a flight number (UA1234), callsign (UAL1234), tail number (N12345) or hex (a1b2c3)',
        });
      const tried = [];
      for (const candidate of candidates) {
        try {
          const rows = await lookup(candidate);
          tried.push(`${candidate.kind}:${candidate.value}`);
          if (rows.length)
            return send(res, 200, {
              query: q,
              matchedBy: candidate,
              aircraft: rows.slice(0, 5),
            });
        } catch (error) {
          tried.push(
            `${candidate.kind}:${candidate.value} (${error?.message || 'failed'})`,
          );
        }
      }
      return send(res, 404, {
        error:
          'no live aircraft matched — it may not be airborne or broadcasting ads-b yet',
        tried,
      });
    });
  }

  return {
    name: 'adam-flight-lookup',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
