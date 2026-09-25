import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './openai/hud-summary.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import { createRealtimeTokenHandler } from './openai/realtime.js';

/**
 * Hard server-side ceiling on voice sessions minted per UTC day
 * (ADAM_VOICE_SESSIONS_PER_DAY; unset = no ceiling). Counted per server
 * instance — on serverless hosts pair it with a provider spend limit.
 */
export function sessionCeiling({
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let day = '';
  let count = 0;
  return (req, res, next) => {
    const limit = Math.floor(Number(env.ADAM_VOICE_SESSIONS_PER_DAY));
    if (!(limit > 0) || req.method === 'OPTIONS') return next();
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      count = 0;
    }
    if (count >= limit) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: `daily voice session limit (${limit}) reached; resets at 00:00 UTC`,
        }),
      );
      return;
    }
    count += 1;
    next();
  };
}

/**
 * Vite plugin: OpenAI Realtime ephemeral client secret.
 *
 * Keeps OPENAI_API_KEY server-side while the browser connects to the
 * Realtime API over WebRTC with a short-lived secret.
 */
function openAiRealtimeProxy({
  sourceRoot = defaultSourceRoot,
  annotationGuidance,
  realtime = {},
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/openai/hud-summary', handleHudSummary);

    middlewares.use(
      '/api/realtime/debug-log',
      createDebugLogHandler({ sourceRoot }),
    );

    middlewares.use('/api/realtime/token', sessionCeiling());
    middlewares.use(
      '/api/realtime/token',
      createRealtimeTokenHandler({ ...realtime, annotationGuidance }),
    );
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { openAiRealtimeProxy };
