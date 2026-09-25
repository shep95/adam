/**
 * Shepherd HTTP surface.
 *
 *   GET  /api/shepherd/status               providers, which are configured, access state
 *   GET  /api/shepherd/models?provider=id   model list for a provider (Venice: 100+)
 *   POST /api/shepherd/chat                 NDJSON stream of text / tool_call / usage events
 *   POST /api/shepherd/geolocate            image → ranked coordinate candidates
 *
 * Tool calls are executed in the browser (they drive the globe); the client
 * posts results back as `tool` messages on the next request. The tool list is
 * fixed server-side (tools.js) — a client cannot add tools. A provider that
 * fails before producing output is skipped for the next configured one.
 */
import { readRequestBody } from '../providers/common/request.js';
import { makeRateLimiter, clientKey } from '../providers/common/rate-limit.js';
import {
  PROVIDERS,
  listProviderModels,
  providerKey,
  providerModel,
  routeProviders,
  streamProvider,
} from './providers.js';
import { shepherdSystemPrompt } from './prompt.js';
import { envForRequest } from './userKeys.js';
import { shepherdTools } from './tools.js';

const SHEPHERD_TOOLS = shepherdTools();

const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_TEXT = 60_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 6 * 1024 * 1024;
const MAX_CONSOLE = 8_000;
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

/** Validate and normalize an untrusted conversation. Throws on bad input. */
/** Claude's server-side web search for Shepherd; ADAM_SHEPHERD_WEB_SEARCH=off disables. */
export function webSearchEnabled(env = process.env) {
  return (
    String(env.ADAM_SHEPHERD_WEB_SEARCH || 'on')
      .trim()
      .toLowerCase() !== 'off'
  );
}

export function sanitizeConversation(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length || messages.length > MAX_MESSAGES)
    throw new RangeError(
      'messages must be a non-empty array of at most 80 turns',
    );
  const clean = [];
  for (const m of messages) {
    const text = typeof m?.text === 'string' ? m.text.slice(0, MAX_TEXT) : '';
    if (m?.role === 'user') {
      const images = (Array.isArray(m.images) ? m.images : [])
        .slice(0, MAX_IMAGES)
        .filter(
          (img) =>
            IMAGE_MIME.test(String(img?.mime || '')) &&
            typeof img.data === 'string' &&
            img.data.length <= MAX_IMAGE_B64 &&
            /^[A-Za-z0-9+/=]+$/.test(img.data),
        );
      clean.push({
        role: 'user',
        text,
        images: images.map((img) => ({ mime: img.mime, data: img.data })),
      });
    } else if (m?.role === 'assistant') {
      const toolCalls = (Array.isArray(m.toolCalls) ? m.toolCalls : [])
        .filter(
          (call) =>
            TOOL_NAME.test(String(call?.name || '')) &&
            typeof call.id === 'string',
        )
        .slice(0, 16)
        .map((call) => ({
          id: call.id.slice(0, 80),
          name: call.name,
          args: call.args && typeof call.args === 'object' ? call.args : {},
        }));
      clean.push({ role: 'assistant', text, toolCalls });
    } else if (m?.role === 'tool') {
      if (
        typeof m.toolCallId !== 'string' ||
        !TOOL_NAME.test(String(m.name || ''))
      )
        continue;
      clean.push({
        role: 'tool',
        toolCallId: m.toolCallId.slice(0, 80),
        name: m.name,
        result: String(m.result ?? '').slice(0, MAX_TEXT),
      });
    }
  }
  if (clean[0]?.role !== 'user')
    throw new RangeError('the first turn must be the operator');
  // Live console snapshot from the browser, attached to the newest operator
  // turn so the model reads what is on screen without a tool round-trip.
  const consoleState =
    typeof body?.console === 'string' ? body.console.slice(0, MAX_CONSOLE) : '';
  if (consoleState) {
    for (let i = clean.length - 1; i >= 0; i -= 1) {
      if (clean[i].role === 'user') {
        clean[i] = {
          ...clean[i],
          text: `[console]\n${consoleState}\n[/console]\n\n${clean[i].text}`,
        };
        break;
      }
    }
  }
  return { messages: clean };
}

export const GEOLOCATE_INSTRUCTIONS = `
task: geolocate this photograph. read only what is in the image — terrain, vegetation, architecture, road markings and driving side, signage language and script, utility poles, vehicles, sun angle and shadows, coastline, skyline.
never identify or describe people. ignore faces entirely.
answer with one json object and nothing else:
{"candidates":[{"lat":number,"lon":number,"place":"string","confidence":0-1,"radiusKm":number}],"signals":["short evidence strings"],"unknown":["what would sharpen the read"]}
give 1 to 5 candidates, most probable first. confidence values across candidates should sum to at most 1.
`.trim();

/** Pull the first JSON object out of a model reply. */
export function parseGeolocation(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const candidates = (
    Array.isArray(parsed?.candidates) ? parsed.candidates : []
  )
    .map((c) => ({
      lat: Number(c?.lat),
      lon: Number(c?.lon),
      place: String(c?.place || '').slice(0, 160),
      confidence: Math.max(0, Math.min(1, Number(c?.confidence) || 0)),
      radiusKm: Math.max(0.05, Math.min(2000, Number(c?.radiusKm) || 25)),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.lat) &&
        Number.isFinite(c.lon) &&
        Math.abs(c.lat) <= 90 &&
        Math.abs(c.lon) <= 180,
    )
    .slice(0, 5)
    .sort((a, b) => b.confidence - a.confidence);
  if (!candidates.length) return null;
  const strings = (value) =>
    (Array.isArray(value) ? value : [])
      .map((s) => String(s).slice(0, 200))
      .slice(0, 12);
  return {
    candidates,
    signals: strings(parsed.signals),
    unknown: strings(parsed.unknown),
  };
}

/**
 * @param {{env?: object, fetchImpl?: Function, clientFactory?: Function}} [options]
 */
export function shepherdProxy({
  env: baseEnv = process.env,
  fetchImpl,
  clientFactory,
} = {}) {
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 40,
    globalMax: 400,
  });

  function status(env, userKeys) {
    return {
      keysFrom: userKeys ? 'browser' : 'server',
      providers: Object.values(PROVIDERS).map((spec) => ({
        id: spec.id,
        label: spec.label,
        configured: Boolean(providerKey(spec.id, env)),
        model: providerModel(spec.id, null, env),
        vision: spec.vision,
        keyEnv: spec.keyEnv,
      })),
      brain: true,
    };
  }

  async function chat(req, res, env) {
    let parsed;
    try {
      parsed = JSON.parse(await readRequestBody(req, MAX_BODY_BYTES));
    } catch (error) {
      return json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: 'invalid request body',
      });
    }
    let conversation;
    try {
      conversation = sanitizeConversation(parsed);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
    const task = ['chat', 'osint', 'vision', 'private'].includes(parsed.task)
      ? parsed.task
      : 'chat';
    const needsVision = conversation.messages.some((m) => m.images?.length);
    let order = routeProviders(
      needsVision ? 'vision' : task,
      parsed.provider,
      env,
    );
    if (needsVision) order = order.filter((id) => PROVIDERS[id].vision);
    if (!order.length)
      return json(res, 503, {
        error: needsVision
          ? 'no vision-capable ai provider is configured (add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)'
          : 'no ai provider is configured (add a key in settings → ai keys, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, VENICE_API_KEY or OPENROUTER_API_KEY)',
      });

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const write = (event) => res.write(`${JSON.stringify(event)}\n`);
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    for (const [index, id] of order.entries()) {
      const model = providerModel(
        id,
        parsed.provider === id ? parsed.model : null,
        env,
      );
      let produced = false;
      try {
        const stream = streamProvider(id, {
          key: providerKey(id, env),
          model,
          system: shepherdSystemPrompt({ mode: PROVIDERS[id].promptMode }),
          messages: conversation.messages,
          tools: SHEPHERD_TOOLS,
          webSearch: webSearchEnabled(env),
          signal: controller.signal,
          fetchImpl,
          clientFactory,
        });
        write({ type: 'meta', provider: id, model });
        for await (const event of stream) {
          produced = true;
          write(event);
        }
        write({ type: 'done' });
        return res.end();
      } catch (error) {
        if (controller.signal.aborted) return res.end();
        const reason = `${id}: ${error?.status ? `HTTP ${error.status}` : error?.message || 'failed'}`;
        if (!produced && index < order.length - 1) {
          write({ type: 'failover', from: id, reason });
          continue;
        }
        write({ type: 'error', error: reason });
        return res.end();
      }
    }
  }

  async function geolocate(req, res, env) {
    let parsed;
    try {
      parsed = JSON.parse(await readRequestBody(req, MAX_BODY_BYTES));
    } catch (error) {
      return json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, {
        error: 'invalid request body',
      });
    }
    const image = parsed?.image;
    if (
      !IMAGE_MIME.test(String(image?.mime || '')) ||
      typeof image?.data !== 'string' ||
      image.data.length > MAX_IMAGE_B64 ||
      !/^[A-Za-z0-9+/=]+$/.test(image.data)
    )
      return json(res, 400, {
        error: 'a png, jpeg, webp or gif image under 4 MB is required',
      });
    const hint =
      typeof parsed.hint === 'string' ? parsed.hint.slice(0, 500) : '';
    const order = routeProviders('vision', parsed.provider, env).filter(
      (id) => PROVIDERS[id].vision,
    );
    if (!order.length)
      return json(res, 503, {
        error:
          'no vision-capable ai provider is configured (GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY)',
      });
    const failures = [];
    for (const id of order) {
      try {
        const model = providerModel(id, null, env);
        let text = '';
        for await (const event of streamProvider(id, {
          key: providerKey(id, env),
          model,
          system: shepherdSystemPrompt({ mode: 'core' }),
          messages: [
            {
              role: 'user',
              text: `${GEOLOCATE_INSTRUCTIONS}${hint ? `\noperator hint: ${hint}` : ''}`,
              images: [{ mime: image.mime, data: image.data }],
            },
          ],
          tools: [],
          fetchImpl,
          clientFactory,
        })) {
          if (event.type === 'text') text += event.delta;
        }
        const result = parseGeolocation(text);
        if (result) return json(res, 200, { provider: id, model, ...result });
        failures.push(`${id}: unreadable answer`);
      } catch (error) {
        failures.push(
          `${id}: ${error?.status ? `HTTP ${error.status}` : error?.message || 'failed'}`,
        );
      }
    }
    return json(res, 502, { error: 'geolocation failed', failures });
  }

  function install(middlewares) {
    middlewares.use('/api/shepherd', async (req, res) => {
      if (!limiter(clientKey(req)))
        return json(res, 429, { error: 'rate limit exceeded' });
      const url = new URL(req.url, 'http://localhost');
      const route = url.pathname.replace(/^\/+|\/+$/g, '');
      // Keys saved in the operator's browser, for this request only.
      const { env, userKeys } = envForRequest(req, baseEnv);
      try {
        if (route === 'status' && req.method === 'GET')
          return json(res, 200, status(env, userKeys));
        if (route === 'models' && req.method === 'GET') {
          const id = url.searchParams.get('provider');
          if (!PROVIDERS[id])
            return json(res, 400, { error: 'unknown provider' });
          const key = providerKey(id, env);
          if (!key)
            return json(res, 404, {
              error: userKeys
                ? `no ${PROVIDERS[id].label} key saved in settings`
                : `${PROVIDERS[id].keyEnv} is not set`,
            });
          return json(res, 200, {
            provider: id,
            models: await listProviderModels(id, { key, fetchImpl }),
          });
        }
        if (route === 'chat' && req.method === 'POST')
          return await chat(req, res, env);
        if (route === 'geolocate' && req.method === 'POST')
          return await geolocate(req, res, env);
        return json(res, 404, { error: 'unknown shepherd route' });
      } catch (error) {
        if (!res.headersSent)
          json(res, 502, {
            error: 'shepherd upstream failed',
            reason: String(error?.message || error).slice(0, 200),
          });
        else res.end();
      }
    });
  }

  return {
    name: 'adam-shepherd',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
