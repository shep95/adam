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

/**
 * Named roles from ADAM_ACCESS_ROLES (JSON). Either
 *   {"analyst": {"token": "…", "allow": ["/shepherd", "/flight-lookup"]}}
 * or the short form {"<token>": ["/api/shepherd", "/api/cctv"]}.
 * `allow` lists /api route prefixes ("*" = everything). The admin token
 * (ADAM_ACCESS_TOKEN) always allows everything.
 * @returns {Map<string, {token: string, allow: string[]}>}
 */
export function parseAccessRoles(raw) {
  const roles = new Map();
  if (!raw) return roles;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return roles;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return roles;
  const norm = (prefix) => {
    const p = String(prefix || '').trim();
    if (p === '*') return '*';
    const stripped = p.replace(/^\/?api(?=\/|$)/, '');
    return stripped.startsWith('/')
      ? stripped.replace(/\/+$/, '')
      : `/${stripped.replace(/\/+$/, '')}`;
  };
  for (const [key, value] of Object.entries(parsed)) {
    let name;
    let token;
    let allow;
    if (Array.isArray(value)) {
      token = key;
      allow = value;
      name = `role-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
    } else if (value && typeof value === 'object') {
      name = key;
      token = value.token;
      allow = value.allow;
    }
    token = String(token || '').trim();
    if (
      !/^[A-Za-z0-9._-]{1,40}$/.test(name || '') ||
      token.length < 12 ||
      !Array.isArray(allow)
    )
      continue;
    roles.set(name, { token, allow: allow.map(norm).filter(Boolean) });
  }
  return roles;
}

export function roleAllows(role, path) {
  if (!role) return false;
  return role.allow.some(
    (p) => p === '*' || path === p || path.startsWith(`${p}/`),
  );
}

function roleCookieValue(name, token) {
  return `${name}.${crypto.createHmac('sha256', String(token)).update(`adam-role-v1:${name}`).digest('hex')}`;
}

/** Which identity a request's cookie proves: 'admin', a role name, or null. */
export function identifyRequest(req, adminToken, roles) {
  const cookie = readCookie(req.headers?.cookie, COOKIE);
  if (!cookie) return null;
  if (adminToken && safeEqual(cookie, accessCookieValue(adminToken)))
    return 'admin';
  const dot = cookie.indexOf('.');
  if (dot > 0) {
    const name = cookie.slice(0, dot);
    const role = roles.get(name);
    if (role && safeEqual(cookie, roleCookieValue(name, role.token)))
      return name;
  }
  return null;
}

/** HMAC over an operator-profile digest, keyed by the deployment's admin token. */
export function profileSignature(secret, digest) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`adam-profile-v1:${digest}`)
    .digest('hex');
}

export function profileKeyId(secret) {
  return crypto
    .createHash('sha256')
    .update(`adam-profile-key:${secret}`)
    .digest('hex')
    .slice(0, 12);
}

/** Routes worth an audit line (cost-bearing or sensitive). */
const AUDITED = [
  '/shepherd',
  '/openai',
  '/realtime',
  '/google',
  '/cctv',
  '/flight-lookup',
  '/access',
  '/notify',
  '/ingest',
  '/fetch-geo',
];

export function accessGate({
  env = process.env,
  audit = (entry) => console.log(JSON.stringify(entry)),
} = {}) {
  const attempts = makeRateLimiter({
    windowMs: 15 * 60_000,
    max: 10,
    globalMax: 200,
  });
  const token = () => String(env.ADAM_ACCESS_TOKEN || '').trim();
  const roles = () => parseAccessRoles(env.ADAM_ACCESS_ROLES);

  const send = (res, status, payload, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  };

  const log = (req, path, identity, outcome) => {
    if (!AUDITED.some((p) => path === p || path.startsWith(`${p}/`))) return;
    try {
      audit({
        audit: 'adam-access',
        at: new Date().toISOString(),
        identity: identity || 'anonymous',
        method: req.method,
        path: `/api${path}`,
        outcome,
      });
    } catch {
      /* audit must never break a request */
    }
  };

  function install(middlewares) {
    middlewares.use('/api', async (req, res, next) => {
      const path = String(req.url || '/').split('?')[0];
      const secret = token();
      const roleMap = roles();
      const gated = Boolean(secret) || roleMap.size > 0;
      if (path === '/access' || path === '/access/') {
        const identity = identifyRequest(req, secret, roleMap);
        if (req.method === 'GET')
          return send(res, 200, {
            required: gated,
            granted: !gated || Boolean(identity),
            identity: identity || null,
            allow:
              identity === 'admin' ? ['*'] : roleMap.get(identity)?.allow || [],
          });
        if (req.method === 'DELETE') {
          log(req, path, identity, 'signed-out');
          return send(
            res,
            200,
            { granted: false },
            {
              'Set-Cookie': `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
            },
          );
        }
        if (req.method !== 'POST')
          return send(res, 405, { error: 'method not allowed' });
        if (!gated) return send(res, 200, { required: false, granted: true });
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
        const offered = String(body.token || '');
        const secure = isHttps(req) ? '; Secure' : '';
        const cookieAttrs = `; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure}`;
        if (secret && safeEqual(offered, secret)) {
          log(req, path, 'admin', 'signed-in');
          return send(
            res,
            200,
            { granted: true, identity: 'admin' },
            {
              'Set-Cookie': `${COOKIE}=${accessCookieValue(secret)}${cookieAttrs}`,
            },
          );
        }
        for (const [name, role] of roleMap) {
          if (safeEqual(offered, role.token)) {
            log(req, path, name, 'signed-in');
            return send(
              res,
              200,
              { granted: true, identity: name, allow: role.allow },
              {
                'Set-Cookie': `${COOKIE}=${roleCookieValue(name, role.token)}${cookieAttrs}`,
              },
            );
          }
        }
        log(req, path, null, 'denied-bad-token');
        return send(res, 401, { error: 'wrong access token' });
      }
      if (!gated) {
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
      // External senders push to /api/ingest with their own bearer token
      // (checked by the ingest route itself); they hold no session cookie.
      if (
        req.method === 'POST' &&
        path.startsWith('/ingest/') &&
        String(req.headers?.authorization || '').startsWith('Bearer ')
      ) {
        log(req, path, 'ingest-token', 'forwarded');
        return next();
      }
      const identity = identifyRequest(req, secret, roleMap);
      if (!identity) {
        log(req, path, null, 'denied-no-session');
        return send(res, 401, { error: 'access token required', access: true });
      }
      if (path === '/access/sign' || path === '/access/verify') {
        if (req.method !== 'POST')
          return send(res, 405, { error: 'method not allowed' });
        if (!secret)
          return send(res, 404, {
            error: 'profile signing needs ADAM_ACCESS_TOKEN',
          });
        let body = {};
        try {
          body = JSON.parse(await readRequestBody(req, 4096));
        } catch {
          body = {};
        }
        const digest = String(body.digest || '');
        if (!/^[0-9a-f]{64}$/.test(digest))
          return send(res, 400, { error: 'digest must be 64 hex characters' });
        const sig = profileSignature(secret, digest);
        const keyId = profileKeyId(secret);
        log(req, path, identity, path.endsWith('sign') ? 'signed' : 'verified');
        if (path === '/access/sign')
          return send(res, 200, {
            alg: 'HMAC-SHA256',
            keyId,
            signer: identity,
            sig,
          });
        return send(res, 200, {
          valid:
            String(body.keyId || '') === keyId &&
            safeEqual(String(body.sig || ''), sig),
          keyId,
        });
      }
      if (identity !== 'admin' && !roleAllows(roleMap.get(identity), path)) {
        log(req, path, identity, 'denied-by-role');
        return send(res, 403, {
          error: `role ${identity} may not use /api${path}`,
        });
      }
      log(req, path, identity, 'allowed');
      return next();
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
