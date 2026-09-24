import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  createMiddlewareStack,
  mountMatches,
  prepareHostedEnvironment,
  restoreApiUrl,
} from '../../server/vercel/gateway.js';

test('mount matching follows connect prefix rules', () => {
  assert.equal(mountMatches('/api/firms', '/api/firms'), true);
  assert.equal(mountMatches('/api/firms/status', '/api/firms'), true);
  assert.equal(mountMatches('/api/firmsx', '/api/firms'), false);
  assert.equal(mountMatches('/anything', '/'), true);
});

test('rewritten gateway URLs restore the public API path and query', () => {
  assert.equal(
    restoreApiUrl('/api/gateway?__path=firms/status&x=1'),
    '/api/firms/status?x=1',
  );
  assert.equal(restoreApiUrl('/api/gateway?__path=firms'), '/api/firms');
  assert.equal(restoreApiUrl('/api/firms?x=1'), '/api/firms?x=1');
});

test('hosted environment defaults the OpenAI limiter without overriding it', () => {
  const env = {};
  prepareHostedEnvironment({ env, chdir: () => {}, tmpdir: () => '/tmp' });
  assert.equal(env.GEV_RATELIMIT_OPENAI_PER_MIN, '6');
  const explicit = { GEV_RATELIMIT_OPENAI_PER_MIN: '0' };
  prepareHostedEnvironment({ env: explicit, chdir: () => {} });
  assert.equal(explicit.GEV_RATELIMIT_OPENAI_PER_MIN, '0');
});

async function request(handle, path) {
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.text() };
  } finally {
    server.close();
  }
}

test('stack strips mount prefixes, skips key setup, and 404s unknown routes', async () => {
  const seen = [];
  const plugins = [
    {
      name: 'demo',
      configurePreviewServer(server) {
        server.middlewares.use('/api/demo', (req, res) => {
          seen.push([req.url, req.originalUrl]);
          res.end('demo');
        });
      },
    },
    {
      name: 'passes',
      configureServer(server) {
        server.middlewares.use('/api/pass', (_req, _res, next) =>
          setTimeout(next, 1),
        );
      },
    },
    {
      name: 'gev-key-setup',
      configureServer(server) {
        server.middlewares.use('/api/setup/status', (_req, res) =>
          res.end('leak'),
        );
      },
    },
  ];
  const { handle } = createMiddlewareStack(plugins);
  assert.deepEqual(await request(handle, '/api/demo/status?q=1'), {
    status: 200,
    body: 'demo',
  });
  assert.deepEqual(seen, [['/status?q=1', '/api/demo/status?q=1']]);
  assert.equal((await request(handle, '/api/pass')).status, 404);
  assert.equal((await request(handle, '/api/setup/status')).status, 404);
});

test('every real local provider mounts under /api without throwing', async () => {
  const { localProviderPlugins } = await import('../../server/providers/local.js');
  const { stack } = createMiddlewareStack(localProviderPlugins());
  assert.ok(stack.length > 20, `expected >20 mounts, got ${stack.length}`);
  assert.ok(stack.every(({ route }) => route.startsWith('/api')));
  assert.ok(!stack.some(({ route }) => route.startsWith('/api/setup')));
});
