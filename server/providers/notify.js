/**
 * Outbound notifications: when an alert trips or the watch ranks something
 * high, ADAM can post it to the operator's own channels — Slack, Teams,
 * Discord or any JSON webhook.
 *
 *   GET  /api/notify   → { configured: <number of destinations> }
 *   POST /api/notify   { title, text, severity, lat, lon, at } → fan-out
 *
 * Destinations come only from ADAM_ALERT_WEBHOOKS (comma-separated https
 * URLs) on the server; the browser never names a destination. Rate-limited
 * and sits behind the access gate like every /api route.
 */
import { readRequestBody } from './common/request.js';
import { makeRateLimiter } from './common/rate-limit.js';

const MAX_DESTINATIONS = 8;

export function parseWebhookList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' && !u.username && !u.password;
      } catch {
        return false;
      }
    })
    .slice(0, MAX_DESTINATIONS);
}

const clean = (v, n) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .slice(0, n);

/** One payload most webhook receivers accept (Slack/Teams `text`, Discord `content`). */
export function notificationPayload(body) {
  const severity = ['info', 'watch', 'alert', 'critical'].includes(
    body?.severity,
  )
    ? body.severity
    : 'alert';
  const title = clean(body?.title, 140) || 'ADAM alert';
  const text = clean(body?.text, 900);
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  const where =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? ` · ${lat.toFixed(4)}, ${lon.toFixed(4)}`
      : '';
  const at = clean(body?.at, 40) || new Date().toISOString();
  const line = `[ADAM · ${severity.toUpperCase()}] ${title}${where}\n${text}\n${at}`;
  return {
    text: line,
    content: line.slice(0, 1900),
    adam: {
      severity,
      title,
      text,
      lat: where ? lat : null,
      lon: where ? lon : null,
      at,
    },
  };
}

export function notifyProxy({
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  const limit = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 60 });
  const send = (res, status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  };
  function install(middlewares) {
    middlewares.use('/api/notify', async (req, res) => {
      const destinations = parseWebhookList(env.ADAM_ALERT_WEBHOOKS);
      if (req.method === 'GET')
        return send(res, 200, { configured: destinations.length });
      if (req.method !== 'POST')
        return send(res, 405, { error: 'method not allowed' });
      if (!destinations.length)
        return send(res, 404, {
          error: 'set ADAM_ALERT_WEBHOOKS to enable notifications',
        });
      if (!limit('notify')) return send(res, 429, { error: 'rate limited' });
      let body = {};
      try {
        body = JSON.parse(await readRequestBody(req, 8192));
      } catch {
        return send(res, 400, { error: 'invalid JSON' });
      }
      const payload = notificationPayload(body);
      const results = await Promise.allSettled(
        destinations.map((url) =>
          fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(8000),
            redirect: 'error',
          }),
        ),
      );
      const delivered = results.filter(
        (r) => r.status === 'fulfilled' && r.value.ok,
      ).length;
      return send(res, 200, { delivered, destinations: destinations.length });
    });
  }
  return {
    name: 'adam-notify',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
