/**
 * Operator-supplied AI keys from the X-ADAM-Provider-Keys header (base64
 * JSON { providerId: key }). Used for the one request, never stored or
 * logged. A request with its own keys never uses the deployment's keys.
 */

// Kept standalone (no SDK import) so the access gate and voice route can use
// it; must match PROVIDERS[id].keyEnv in providers.js (a test pins this).
export const USER_KEY_ENVS = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  venice: 'VENICE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});

export const USER_KEYS_HEADER = 'x-adam-provider-keys';
const KEY_RE = /^[\x21-\x7e]{8,400}$/;

/** @returns {Record<string,string>} valid keys by provider id */
export function parseUserKeys(req) {
  const raw = req?.headers?.[USER_KEYS_HEADER];
  if (typeof raw !== 'string' || !raw || raw.length > 4096) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return {};
  }
  const out = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return out;
  for (const [id, key] of Object.entries(parsed)) {
    if (
      Object.hasOwn(USER_KEY_ENVS, id) &&
      typeof key === 'string' &&
      KEY_RE.test(key.trim())
    )
      out[id] = key.trim();
  }
  return out;
}

export function hasUserKeys(req) {
  return Object.keys(parseUserKeys(req)).length > 0;
}

/**
 * The environment a request runs with: unchanged without user keys; with
 * them, ONLY the user's provider keys (server provider keys removed).
 */
export function envForRequest(req, env = process.env) {
  const keys = parseUserKeys(req);
  if (!Object.keys(keys).length) return { env, userKeys: false };
  const out = { ...env };
  for (const name of Object.values(USER_KEY_ENVS)) delete out[name];
  delete out.GOOGLE_AI_API_KEY;
  for (const [id, key] of Object.entries(keys)) out[USER_KEY_ENVS[id]] = key;
  return { env: out, userKeys: true };
}
