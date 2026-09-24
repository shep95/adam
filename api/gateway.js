/**
 * Vercel entry point for every `/api/*` route (see vercel.json rewrites and
 * server/vercel/gateway.js). Providers are loaded once per warm instance.
 */
import {
  createMiddlewareStack,
  prepareHostedEnvironment,
  restoreApiUrl,
} from '../server/vercel/gateway.js';

let stackPromise = null;

function loadStack() {
  if (!stackPromise) {
    prepareHostedEnvironment();
    stackPromise = import('../server/providers/local.js').then(
      ({ localProviderPlugins }) => createMiddlewareStack(localProviderPlugins()),
    );
  }
  return stackPromise;
}

export default async function handler(req, res) {
  const { handle } = await loadStack();
  req.url = restoreApiUrl(req.url);
  req.originalUrl = req.url;
  await handle(req, res);
}

export const config = {
  // Vercel must not consume the request stream: providers read bodies
  // themselves with their own size caps.
  api: { bodyParser: false },
};
