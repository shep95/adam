/**
 * Place dossier: what the open web shows of a spot — photos and pages about
 * the streets, landmarks and buildings there.
 *
 *   GET /api/place?lat=&lon=&radius=     Wikipedia articles near the point
 *                                        (extract, thumbnail, link, distance),
 *                                        geotagged Wikimedia Commons photos
 *                                        (licence and author), Street View
 *                                        (when a Google key is set) and
 *                                        Mapillary street-level images (when
 *                                        MAPILLARY_TOKEN is set)
 *   GET /api/place/streetview?lat=&lon=&heading=   Street View image, proxied
 *                                        so the key never reaches the browser
 *
 * Places and structures only: nothing here looks up who lives at or owns an
 * address. 30-minute cache per ~100 m cell.
 */
import { googleServerApiKey } from './places/google-key.js';
import { makeRateLimiter } from './common/rate-limit.js';

const UA = 'ADAM/1 (place dossier; https://github.com/shep95/adam)';
const CACHE_MS = 30 * 60_000;

const send = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export function wikipediaUrl(lat, lon, radius, lang = 'en') {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  u.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(radius),
    ggslimit: '12',
    prop: 'coordinates|pageimages|extracts|info',
    piprop: 'thumbnail',
    pithumbsize: '480',
    exintro: '1',
    explaintext: '1',
    exsentences: '2',
    exlimit: '12',
    inprop: 'url',
    origin: '*',
  }).toString();
  return u.href;
}

export function commonsUrl(lat, lon, radius) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'geosearch',
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(Math.min(radius, 1000)),
    ggsnamespace: '6',
    ggslimit: '24',
    prop: 'imageinfo|coordinates',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: '640',
    origin: '*',
  }).toString();
  return u.href;
}

export function normalizeWikipedia(body, lat, lon) {
  const pages = Object.values(body?.query?.pages || {});
  return pages
    .map((p) => {
      const c = p.coordinates?.[0];
      return {
        title: p.title,
        extract: String(p.extract || '').slice(0, 400),
        url: p.fullurl || `https://en.wikipedia.org/?curid=${p.pageid}`,
        thumb: p.thumbnail?.source || null,
        lat: c?.lat ?? null,
        lon: c?.lon ?? null,
        distanceM: c ? Math.round(haversineM(lat, lon, c.lat, c.lon)) : null,
      };
    })
    .sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
}

export function normalizeCommons(body, lat, lon) {
  const pages = Object.values(body?.query?.pages || {});
  return pages
    .filter((p) => /^image\/(jpeg|png|webp)/.test(p.imageinfo?.[0]?.mime || ''))
    .map((p) => {
      const ii = p.imageinfo[0];
      const md = ii.extmetadata || {};
      const c = p.coordinates?.[0];
      return {
        title: String(p.title || '').replace(/^File:/, ''),
        thumb: ii.thumburl || ii.url,
        url: ii.descriptionurl,
        license: stripHtml(md.LicenseShortName?.value) || null,
        author: stripHtml(md.Artist?.value).slice(0, 80) || null,
        date: stripHtml(md.DateTimeOriginal?.value).slice(0, 20) || null,
        description:
          stripHtml(md.ImageDescription?.value).slice(0, 200) || null,
        distanceM: c ? Math.round(haversineM(lat, lon, c.lat, c.lon)) : null,
      };
    })
    .sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
}

export function normalizeMapillary(body) {
  return (body?.data || []).slice(0, 12).map((d) => ({
    id: d.id,
    thumb: d.thumb_1024_url || d.thumb_256_url || null,
    url: `https://www.mapillary.com/app/?pKey=${encodeURIComponent(d.id)}`,
    capturedAt: d.captured_at
      ? new Date(d.captured_at).toISOString().slice(0, 10)
      : null,
    heading: Number.isFinite(d.compass_angle)
      ? Math.round(d.compass_angle)
      : null,
  }));
}

function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371008.8;
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) *
      Math.cos(bLat * r) *
      Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parsePoint(url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  const radius = Math.max(
    50,
    Math.min(5000, Number(url.searchParams.get('radius')) || 600),
  );
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5), radius };
}

export function placeMediaProxy({
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  googleKey = googleServerApiKey,
} = {}) {
  const cache = new Map();
  const limit = makeRateLimiter({ windowMs: 60_000, max: 40, globalMax: 200 });
  const getJson = async (url, headers = {}) => {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return res.json();
  };

  async function dossier({ lat, lon, radius }) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${radius}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const token = String(env.MAPILLARY_TOKEN || '').trim();
    const gkey = googleKey?.();
    const d = radius / 111_320;
    const [wiki, commons, mapillary, sv] = await Promise.allSettled([
      getJson(wikipediaUrl(lat, lon, Math.min(radius, 10_000))),
      getJson(commonsUrl(lat, lon, radius)),
      token
        ? getJson(
            `https://graph.mapillary.com/images?fields=id,thumb_1024_url,captured_at,compass_angle&limit=12&bbox=${lon - d},${lat - d},${lon + d},${lat + d}`,
            { Authorization: `OAuth ${token}` },
          )
        : Promise.resolve(null),
      gkey
        ? getJson(
            `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lon}&radius=${Math.min(radius, 200)}&source=outdoor&key=${encodeURIComponent(gkey)}`,
          )
        : Promise.resolve(null),
    ]);
    const value = {
      lat,
      lon,
      radius,
      wikipedia:
        wiki.status === 'fulfilled'
          ? normalizeWikipedia(wiki.value, lat, lon)
          : [],
      photos:
        commons.status === 'fulfilled'
          ? normalizeCommons(commons.value, lat, lon)
          : [],
      streetLevel:
        mapillary.status === 'fulfilled' && mapillary.value
          ? normalizeMapillary(mapillary.value)
          : [],
      streetView:
        sv.status === 'fulfilled' && sv.value?.status === 'OK'
          ? {
              date: sv.value.date || null,
              lat: sv.value.location?.lat ?? lat,
              lon: sv.value.location?.lng ?? lon,
            }
          : null,
      sources: {
        wikipedia: wiki.status === 'fulfilled',
        commons: commons.status === 'fulfilled',
        mapillary: token
          ? mapillary.status === 'fulfilled'
          : 'no MAPILLARY_TOKEN',
        streetView: gkey ? sv.status === 'fulfilled' : 'no Google key',
      },
    };
    cache.set(key, { at: now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  }

  function install(middlewares) {
    middlewares.use('/api/place', async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const point = parsePoint(url);
      if (!point) return send(res, 400, { error: 'lat and lon required' });
      if (!limit('place')) return send(res, 429, { error: 'rate limited' });
      if (url.pathname === '/streetview') {
        const gkey = googleKey?.();
        if (!gkey)
          return send(res, 404, { error: 'Street View needs a Google key' });
        const heading = Number(url.searchParams.get('heading'));
        const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
        sv.search = new URLSearchParams({
          size: '640x400',
          location: `${point.lat},${point.lon}`,
          fov: '90',
          heading: String(Number.isFinite(heading) ? heading : 0),
          source: 'outdoor',
          return_error_code: 'true',
          key: gkey,
        }).toString();
        try {
          const img = await fetchImpl(sv.href, {
            signal: AbortSignal.timeout(12_000),
          });
          if (!img.ok) return send(res, 404, { error: 'no Street View here' });
          res.writeHead(200, {
            'Content-Type': img.headers.get('content-type') || 'image/jpeg',
            'Cache-Control': 'private, max-age=3600',
          });
          return res.end(Buffer.from(await img.arrayBuffer()));
        } catch (error) {
          return send(res, 502, {
            error: `Street View failed (${error.message})`,
          });
        }
      }
      try {
        return send(res, 200, await dossier(point));
      } catch (error) {
        return send(res, 502, {
          error: `place lookup failed (${error.message})`,
        });
      }
    });
  }

  return {
    name: 'adam-place-media',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
