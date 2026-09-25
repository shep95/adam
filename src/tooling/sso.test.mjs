import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createMiddlewareStack } from '../../server/vercel/gateway.js';
import { accessGate } from '../../server/providers/accessGate.js';
import {
  emailAllowed,
  openCookie,
  sealCookie,
  verifyIdToken,
} from '../../server/providers/sso.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'k1',
  alg: 'RS256',
  use: 'sig',
};
const ISSUER = 'https://idp.example';
const sign = (claims, key = privateKey, kid = 'k1') => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString(
    'base64url',
  );
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto
    .sign('sha256', Buffer.from(`${h}.${p}`), key)
    .toString('base64url');
  return `${h}.${p}.${s}`;
};
const claims = (extra = {}) => ({
  iss: ISSUER,
  aud: 'client-1',
  exp: Math.floor(Date.now() / 1000) + 600,
  email: 'ana@ops.example',
  email_verified: true,
  name: 'Ana',
  ...extra,
});

test('id tokens: signature, issuer, audience, expiry and nonce are enforced', () => {
  const jwks = { keys: [jwk] };
  const opts = { issuer: ISSUER, audience: 'client-1', nonce: 'n1' };
  assert.equal(
    verifyIdToken(sign(claims({ nonce: 'n1' })), jwks, opts).email,
    'ana@ops.example',
  );
  const other = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey;
  assert.throws(
    () => verifyIdToken(sign(claims({ nonce: 'n1' }), other), jwks, opts),
    /bad signature/,
  );
  assert.throws(
    () =>
      verifyIdToken(
        sign(claims({ nonce: 'n1', iss: 'https://evil' })),
        jwks,
        opts,
      ),
    /issuer/,
  );
  assert.throws(
    () => verifyIdToken(sign(claims({ nonce: 'n1', aud: 'x' })), jwks, opts),
    /audience/,
  );
  assert.throws(
    () => verifyIdToken(sign(claims({ nonce: 'n1', exp: 1 })), jwks, opts),
    /expired/,
  );
  assert.throws(
    () => verifyIdToken(sign(claims({ nonce: 'x' })), jwks, opts),
    /nonce/,
  );
});

test('allowlists and sealed cookies', () => {
  assert.equal(emailAllowed('ana@ops.example', ['@ops.example']), true);
  assert.equal(
    emailAllowed('eve@evil.example', ['@ops.example', 'bob@x.io']),
    false,
  );
  assert.equal(emailAllowed('bob@x.io', ['bob@x.io']), true);
  assert.equal(emailAllowed('ana@ops.example', []), false);
  const c = sealCookie(
    { email: 'a@b', exp: Math.floor(Date.now() / 1000) + 60 },
    'secret-secret-123',
  );
  assert.equal(openCookie(c, 'secret-secret-123').email, 'a@b');
  assert.equal(openCookie(c, 'another-secret-456'), null);
  assert.equal(openCookie(`${c.slice(0, -2)}xx`, 'secret-secret-123'), null);
});

test('full sign-in: login → provider → callback → gated API opens', async () => {
  let lastAuthorize = null;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const json = (b) => ({ ok: true, json: async () => b });
    if (u.endsWith('/.well-known/openid-configuration'))
      return json({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    if (u === `${ISSUER}/jwks`) return json({ keys: [jwk] });
    if (u === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init.body));
      assert.ok(form.get('code_verifier'), 'PKCE verifier is sent');
      return json({
        id_token: sign(claims({ nonce: lastAuthorize.get('nonce') })),
      });
    }
    throw new Error(u);
  };
  const env = {
    ADAM_SSO_ISSUER: ISSUER,
    ADAM_SSO_CLIENT_ID: 'client-1',
    ADAM_SSO_SECRET: 'a-long-cookie-secret',
    ADAM_SSO_ALLOWED: '@ops.example',
  };
  const gate = accessGate({ env, audit: () => {}, fetchImpl });
  const backend = {
    name: 'x',
    configureServer(s) {
      s.middlewares.use('/api/thing', (req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
    },
  };
  const { handle } = createMiddlewareStack([gate, backend]);
  const srv = http.createServer((req, res) => handle(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/thing`)).status, 401);
    const login = await fetch(`${base}/api/sso/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    lastAuthorize = new URL(login.headers.get('location')).searchParams;
    assert.equal(lastAuthorize.get('code_challenge_method'), 'S256');
    const flow = login.headers.get('set-cookie').split(';')[0];
    const cb = await fetch(
      `${base}/api/sso/callback?code=abc&state=${lastAuthorize.get('state')}`,
      { redirect: 'manual', headers: { cookie: flow } },
    );
    assert.equal(cb.status, 302);
    const session = cb.headers
      .getSetCookie()
      .find((c) => c.startsWith('adam_sso='))
      .split(';')[0];
    const ok = await fetch(`${base}/api/thing`, {
      headers: { cookie: session },
    });
    assert.equal(ok.status, 200);
    const status = await (
      await fetch(`${base}/api/sso/status`, { headers: { cookie: session } })
    ).json();
    assert.equal(status.email, 'ana@ops.example');
    const bad = await fetch(`${base}/api/sso/callback?code=abc&state=wrong`, {
      redirect: 'manual',
      headers: { cookie: flow },
    });
    assert.equal(bad.status, 400);
  } finally {
    srv.close();
  }
});
