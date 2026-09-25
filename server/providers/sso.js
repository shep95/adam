/**
 * Single sign-on with any OpenID Connect provider (Google, Microsoft Entra,
 * Okta, Auth0, Keycloak…): authorization-code flow with PKCE.
 *
 *   GET /api/sso/login      redirect to the provider
 *   GET /api/sso/callback   code → tokens; the ID token's signature (JWKS),
 *                           issuer, audience, expiry and nonce are checked,
 *                           the email must be verified and allowed; then the
 *                           signed `adam_sso` session cookie is set
 *   GET /api/sso/logout     clear it
 *
 *   ADAM_SSO_ISSUER         e.g. https://accounts.google.com
 *   ADAM_SSO_CLIENT_ID / ADAM_SSO_CLIENT_SECRET
 *   ADAM_SSO_ALLOWED        comma list of emails and @domains
 *   ADAM_SSO_ROLE           'admin' (default) or a role from ADAM_ACCESS_ROLES
 *   ADAM_SSO_SECRET         signs the cookies (falls back to ADAM_ACCESS_TOKEN)
 */
import crypto from 'node:crypto';

export const SSO_COOKIE = 'adam_sso';
const FLOW_COOKIE = 'adam_sso_flow';
const SESSION_S = 12 * 3600;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function ssoConfig(env = process.env) {
  const issuer = String(env.ADAM_SSO_ISSUER || '')
    .trim()
    .replace(/\/+$/, '');
  const clientId = String(env.ADAM_SSO_CLIENT_ID || '').trim();
  const clientSecret = String(env.ADAM_SSO_CLIENT_SECRET || '').trim();
  const secret = String(
    env.ADAM_SSO_SECRET || env.ADAM_ACCESS_TOKEN || '',
  ).trim();
  if (!issuer || !clientId || !secret || secret.length < 16) return null;
  const allowed = String(env.ADAM_SSO_ALLOWED || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    issuer,
    clientId,
    clientSecret,
    secret,
    allowed,
    role: String(env.ADAM_SSO_ROLE || 'admin').trim() || 'admin',
  };
}

export function emailAllowed(email, allowed) {
  const e = String(email || '').toLowerCase();
  if (!e.includes('@') || !allowed.length) return false;
  const domain = e.slice(e.lastIndexOf('@'));
  return allowed.some((a) => a === e || (a.startsWith('@') && a === domain));
}

/** `payload.sig` with an HMAC; the payload is base64url JSON. */
export function sealCookie(obj, secret) {
  const body = b64url(JSON.stringify(obj));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`adam-sso-v1:${body}`)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function openCookie(value, secret, now = Date.now()) {
  const [body, sig] = String(value || '').split('.');
  if (!body || !sig) return null;
  const want = crypto
    .createHmac('sha256', secret)
    .update(`adam-sso-v1:${body}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return obj.exp && obj.exp * 1000 > now ? obj : null;
  } catch {
    return null;
  }
}

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

/** Verify an ID token (RS256/ES256/PS256) against a JWKS and the expected claims. */
export function verifyIdToken(
  idToken,
  jwks,
  { issuer, audience, nonce, now = Date.now() },
) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const header = JSON.parse(
    Buffer.from(parts[0], 'base64url').toString('utf8'),
  );
  const claims = JSON.parse(
    Buffer.from(parts[1], 'base64url').toString('utf8'),
  );
  const jwk =
    (jwks?.keys || []).find((k) => k.kid === header.kid) ||
    (jwks?.keys?.length === 1 ? jwks.keys[0] : null);
  if (!jwk) throw new Error('signing key not found');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  if (header.alg === 'RS256') ok = crypto.verify('sha256', data, key, sig);
  else if (header.alg === 'PS256')
    ok = crypto.verify(
      'sha256',
      data,
      { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      sig,
    );
  else if (header.alg === 'ES256')
    ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  else throw new Error(`unsupported alg ${header.alg}`);
  if (!ok) throw new Error('bad signature');
  if (String(claims.iss).replace(/\/+$/, '') !== issuer)
    throw new Error('wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new Error('wrong audience');
  if (!(claims.exp * 1000 > now - 60_000)) throw new Error('expired');
  if (nonce && claims.nonce !== nonce) throw new Error('nonce mismatch');
  return claims;
}

/** Who an `adam_sso` cookie proves, or null. */
export function ssoIdentity(req, cfg, readCookie) {
  if (!cfg) return null;
  const s = openCookie(readCookie(req.headers?.cookie, SSO_COOKIE), cfg.secret);
  return s ? { email: s.email, name: s.name, role: s.role } : null;
}

function isHttps(req) {
  return (
    req.socket?.encrypted === true ||
    String(req.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() === 'https'
  );
}

function origin(req) {
  const proto = isHttps(req) ? 'https' : 'http';
  const host = String(
    req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost',
  )
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

/** Handle /sso/* inside the access gate. Returns true when it answered. */
export async function handleSso(
  req,
  res,
  path,
  { cfg, readCookie, fetchImpl = (...a) => fetch(...a), log = () => {} },
) {
  const redirect = (to, cookies = []) => {
    res.writeHead(302, {
      Location: to,
      'Cache-Control': 'no-store',
      'Set-Cookie': cookies,
    });
    res.end();
    return true;
  };
  const json = (status, payload, cookies = []) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookies,
    });
    res.end(JSON.stringify(payload));
    return true;
  };
  const secure = isHttps(req) ? '; Secure' : '';
  if (path === '/sso/status') {
    const who = ssoIdentity(req, cfg, readCookie);
    return json(200, {
      enabled: Boolean(cfg),
      signedIn: Boolean(who),
      email: who?.email || null,
      name: who?.name || null,
    });
  }
  if (!cfg)
    return json(404, {
      error:
        'single sign-on is not configured (ADAM_SSO_ISSUER, ADAM_SSO_CLIENT_ID)',
    });
  if (path === '/sso/logout') {
    log('signed-out');
    return redirect('/', [
      `${SSO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    ]);
  }
  const discovery = await (
    await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`)
  ).json();
  const callback = `${origin(req)}/api/sso/callback`;
  if (path === '/sso/login') {
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const flow = sealCookie(
      { verifier, state, nonce, exp: Math.floor(Date.now() / 1000) + 600 },
      cfg.secret,
    );
    const u = new URL(discovery.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: callback,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return redirect(u.href, [
      `${FLOW_COOKIE}=${flow}; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
    ]);
  }
  if (path === '/sso/callback') {
    const url = new URL(req.url, 'http://x');
    const flow = openCookie(
      readCookie(req.headers?.cookie, FLOW_COOKIE),
      cfg.secret,
    );
    const clear = `${FLOW_COOKIE}=; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    if (!flow || url.searchParams.get('state') !== flow.state) {
      log('denied-bad-state');
      return json(
        400,
        { error: 'sign-in expired or was tampered with; start again' },
        [clear],
      );
    }
    const tokenRes = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code') || '',
        redirect_uri: callback,
        client_id: cfg.clientId,
        ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
        code_verifier: flow.verifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.id_token) {
      log('denied-token-exchange');
      return json(401, { error: 'the provider refused the sign-in' }, [clear]);
    }
    let claims;
    try {
      const jwks = await (await fetchImpl(discovery.jwks_uri)).json();
      claims = verifyIdToken(tokens.id_token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.clientId,
        nonce: flow.nonce,
      });
    } catch (error) {
      log(`denied-${error.message}`);
      return json(
        401,
        { error: `sign-in could not be verified (${error.message})` },
        [clear],
      );
    }
    if (
      claims.email_verified === false ||
      !emailAllowed(claims.email, cfg.allowed)
    ) {
      log(`denied-not-allowed:${claims.email || 'no-email'}`);
      return json(
        403,
        {
          error: `${claims.email || 'this account'} is not allowed on this deployment`,
        },
        [clear],
      );
    }
    const session = sealCookie(
      {
        email: claims.email,
        name: claims.name || null,
        role: cfg.role,
        exp: Math.floor(Date.now() / 1000) + SESSION_S,
      },
      cfg.secret,
    );
    log(`signed-in:${claims.email}`);
    return redirect('/', [
      clear,
      `${SSO_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_S}${secure}`,
    ]);
  }
  return false;
}
