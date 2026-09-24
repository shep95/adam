/**
 * Vercel gateway: runs every local provider plugin inside one serverless
 * function so a Vercel deploy serves the same `/api/*` surface as `vite
 * preview`.
 *
 * The providers are Vite plugins that register connect middleware in
 * `configurePreviewServer` (or `configureServer`). This module hands each one
 * a minimal stand-in server whose `middlewares.use()` records the mount, then
 * dispatches an incoming request through the recorded stack with connect's
 * prefix-stripping semantics (`req.url` is made relative to the mount path and
 * `req.originalUrl` keeps the full URL).
 *
 * Differences from a local run, all deliberate:
 * - Provider Settings (`/api/setup/*`) is never mounted. A hosted deploy takes
 *   its keys from the Vercel project's environment variables; the client
 *   removes the POWER UP editor when the status route is absent.
 * - OpenAI cost endpoints default to a per-IP rate limit, because a public
 *   deploy spends the owner's key on every visitor's voice session.
 * - Disk caches write under the platform's writable temp directory.
 */

/** Default per-minute OpenAI budget for a public deploy (per client IP). */
export const HOSTED_OPENAI_RATE_LIMIT_PER_MIN = '6';

/** Plugins that must never run on a shared host. */
const HOSTED_EXCLUDED_PLUGINS = new Set(['gev-key-setup']);

/**
 * Return true when `pathname` falls under connect mount `route`.
 *
 * @param {string} pathname
 * @param {string} route
 * @returns {boolean}
 */
export function mountMatches(pathname, route) {
  if (!route || route === '/') return true;
  if (!pathname.startsWith(route)) return false;
  const next = pathname.charAt(route.length);
  return next === '' || next === '/' || next === '?' || next === '.';
}

/**
 * Build a connect-compatible middleware stack from Vite provider plugins.
 *
 * @param {Array<object>} plugins - Vite plugins (the local provider set).
 * @returns {{stack: Array<{route: string, handle: Function}>, handle: (req: object, res: object) => Promise<void>}}
 */
export function createMiddlewareStack(plugins) {
  /** @type {Array<{route: string, handle: Function}>} */
  const stack = [];
  const middlewares = {
    use(route, handle) {
      if (typeof route === 'function') {
        stack.push({ route: '/', handle: route });
      } else if (typeof handle === 'function') {
        const normalized =
          route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
        stack.push({ route: normalized, handle });
      }
      return middlewares;
    },
  };
  const server = {
    middlewares,
    httpServer: null,
    config: { command: 'serve', isPreview: true },
    restart: async () => {},
  };
  for (const plugin of plugins.flat()) {
    if (!plugin || HOSTED_EXCLUDED_PLUGINS.has(plugin.name)) continue;
    const hook = plugin.configurePreviewServer || plugin.configureServer;
    if (typeof hook !== 'function') continue;
    const post = hook.call(plugin, server);
    // Vite runs a returned function after its internal middleware; with no
    // internal middleware here it simply installs next.
    if (typeof post === 'function') post();
  }

  const handle = (req, res) =>
    new Promise((resolve) => {
      const originalUrl = req.originalUrl || req.url || '/';
      const pathname = originalUrl.split('?')[0];
      req.originalUrl = originalUrl;
      if (res.writableEnded) return resolve();
      res.once('finish', resolve);
      res.once('close', resolve);
      const send = (status, error) => {
        if (res.headersSent || res.writableEnded) {
          if (!res.writableEnded) res.end();
          return;
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error }));
      };
      let index = 0;
      const next = (error) => {
        if (error) {
          console.error('[gateway] provider failed:', error?.message || error);
          send(500, 'Provider failed');
          return;
        }
        while (index < stack.length) {
          const layer = stack[index++];
          if (!mountMatches(pathname, layer.route)) continue;
          const rest = originalUrl.slice(
            layer.route === '/' ? 0 : layer.route.length,
          );
          req.url = rest.startsWith('/') ? rest : `/${rest}`;
          try {
            const result = layer.handle(req, res, next);
            if (result && typeof result.then === 'function') {
              result.catch((err) => next(err));
            }
          } catch (err) {
            next(err);
          }
          return;
        }
        send(404, 'Unknown API route');
      };
      next();
    });

  return { stack, handle };
}

/**
 * Recover the public `/api/...` URL from a request that reached the gateway
 * through the `vercel.json` rewrite (`/api/gateway?__path=...`).
 *
 * @param {string} url - `req.url` as the function received it.
 * @returns {string}
 */
export function restoreApiUrl(url) {
  const parsed = new URL(url || '/', 'http://gateway.local');
  if (!parsed.pathname.startsWith('/api/gateway')) {
    return `${parsed.pathname}${parsed.search}`;
  }
  const routed = parsed.searchParams.get('__path') || '';
  parsed.searchParams.delete('__path');
  const search = parsed.searchParams.toString();
  const pathname = `/api/${routed.replace(/^\/+/, '')}`;
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * Prepare process state for a hosted run: default the OpenAI limiter and move
 * the working directory to a writable location for provider disk caches.
 *
 * @param {{env?: object, chdir?: (dir: string) => void, tmpdir?: () => string}} [deps]
 */
export function prepareHostedEnvironment({
  env = process.env,
  chdir = (dir) => process.chdir(dir),
  tmpdir = () => '/tmp',
} = {}) {
  if (env.GEV_RATELIMIT_OPENAI_PER_MIN === undefined) {
    env.GEV_RATELIMIT_OPENAI_PER_MIN = HOSTED_OPENAI_RATE_LIMIT_PER_MIN;
  }
  try {
    chdir(tmpdir());
  } catch {
    /* read-only fallback: caches degrade to memory-only */
  }
}
