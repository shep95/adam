/**
 * Private-deployment gate for every /api route.
 *
 * With ADAM_ACCESS_TOKEN unset (local development) the gate is open. When it
 * is set, API calls need the `adam_access` cookie, which is issued only after
 * POST /api/access with the correct token. The cookie carries an HMAC of the
 * token rather than the token itself, is HttpOnly and SameSite=Strict, and is
 * compared in constant time.
 *
 *   GET  /api/access  → {required, granted}
 *   POST /api/access  {token} → sets the cookie
 *   DELETE /api/access → clears it
 */
import crypto from 'node:crypto';
import { readRequestBody } from './common/request.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

const COOKIE = 'adam_access';
/** Routes that spend the operator's provider credit. */
export const PAID_PREFIXES = Object.freeze([
  '/shepherd',
  '/openai',
  '/realtime',
  '/google',
]);

/** Serverless/public hosting, where "no token" must not mean "open". */
export function isPublicHost(env = process.env) {
  return Boolean(
    env.VERCEL ||
    env.VERCEL_ENV ||
    env.NETLIFY ||
    env.RENDER ||
    env.ADAM_PUBLIC_HOST,
  );
}
const MAX_AGE_S = 30 * 86_400;

export function accessCookieValue(token) {
  return crypto
    .createHmac('sha256', String(token))
    .update('adam-access-v1')
    .digest('hex');
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function accessGranted(req, token) {
  if (!token) return true;
  return safeEqual(
    readCookie(req.headers?.cookie, COOKIE),
    accessCookieValue(token),
  );
}

function isHttps(req) {
  return (
    req.socket?.encrypted === true ||
    String(req.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https'
  );
}

export function accessGate({ env = process.env } = {}) {
  const attempts = makeRateLimiter({
    windowMs: 15 * 60_000,
    max: 10,
    globalMax: 200,
  });
  const token = () => String(env.ADAM_ACCESS_TOKEN || '').trim();

  const send = (res, status, payload, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  };

  function install(middlewares) {
    middlewares.use('/api', async (req, res, next) => {
      const path = String(req.url || '/').split('?')[0];
      const secret = token();
      if (path === '/access' || path === '/access/') {
        if (req.method === 'GET')
          return send(res, 200, {
            required: Boolean(secret),
            granted: accessGranted(req, secret),
          });
        if (req.method === 'DELETE')
          return send(
            res,
            200,
            { granted: false },
            {
              'Set-Cookie': `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
            },
          );
        if (req.method !== 'POST')
          return send(res, 405, { error: 'method not allowed' });
        if (!secret) return send(res, 200, { required: false, granted: true });
        if (!attempts(clientKey(req)))
          return send(res, 429, {
            error: 'too many attempts; wait 15 minutes',
          });
        let body = {};
        try {
          body = JSON.parse(await readRequestBody(req, 4096));
        } catch {
          body = {};
        }
        if (!safeEqual(String(body.token || ''), secret))
          return send(res, 401, { error: 'wrong access token' });
        const secure = isHttps(req) ? '; Secure' : '';
        return send(
          res,
          200,
          { granted: true },
          {
            'Set-Cookie': `${COOKIE}=${accessCookieValue(secret)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure}`,
          },
        );
      }
      if (!secret) {
        // Fail closed for paid endpoints on a public host with no token:
        // otherwise anyone holding the URL spends the operator's AI keys.
        if (
          isPublicHost(env) &&
          PAID_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
        )
          return send(res, 503, {
            error:
              'set ADAM_ACCESS_TOKEN on this deployment to enable AI features',
            access: false,
          });
        return next();
      }
      if (accessGranted(req, secret)) return next();
      return send(res, 401, { error: 'access token required', access: true });
    });
  }

  return {
    name: 'adam-access-gate',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
