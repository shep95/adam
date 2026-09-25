/**
 * Bring-your-own AI keys, kept in this browser only.
 *
 * Keys are saved in localStorage and sent with each Shepherd (and voice
 * token) request in one header. The server uses them for that request only,
 * never stores or logs them, and a request that carries your keys never
 * falls back to the deployment's own keys.
 */
export const USER_KEYS_STORE = 'adam.aiKeys.v1';
export const USER_KEYS_HEADER = 'X-ADAM-Provider-Keys';
export const USER_KEYS_EVENT = 'adam:ai-keys-changed';

export const KEY_PROVIDERS = Object.freeze([
  {
    id: 'anthropic',
    label: 'claude (anthropic)',
    placeholder: 'sk-ant-…',
    url: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'openai (also voice)',
    placeholder: 'sk-…',
    url: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    label: 'gemini (google)',
    placeholder: 'AIza…',
    url: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'venice',
    label: 'venice',
    placeholder: 'venice key',
    url: 'https://venice.ai/settings/api',
  },
  {
    id: 'openrouter',
    label: 'openrouter',
    placeholder: 'sk-or-…',
    url: 'https://openrouter.ai/settings/keys',
  },
]);

const KEY_RE = /^[\x21-\x7e]{8,400}$/;
const IDS = new Set(KEY_PROVIDERS.map((p) => p.id));

export function isPlausibleKey(key) {
  return KEY_RE.test(String(key || '').trim());
}

function storageOf(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** { providerId: key } for every valid saved key. */
export function readUserKeys(storage) {
  const s = storageOf(storage);
  if (!s) return {};
  try {
    const parsed = JSON.parse(s.getItem(USER_KEYS_STORE) || '{}');
    const out = {};
    for (const [id, key] of Object.entries(parsed || {}))
      if (IDS.has(id) && isPlausibleKey(key)) out[id] = String(key).trim();
    return out;
  } catch {
    return {};
  }
}

function writeUserKeys(keys, storage) {
  const s = storageOf(storage);
  if (!s) return false;
  try {
    if (Object.keys(keys).length)
      s.setItem(USER_KEYS_STORE, JSON.stringify(keys));
    else s.removeItem(USER_KEYS_STORE);
  } catch {
    return false;
  }
  try {
    globalThis.dispatchEvent?.(new Event(USER_KEYS_EVENT));
  } catch {
    /* no window (tests) */
  }
  return true;
}

/** Save (or with an empty key, remove) one provider's key. */
export function saveUserKey(id, key, storage) {
  if (!IDS.has(id)) return { ok: false, error: 'unknown provider' };
  const keys = readUserKeys(storage);
  const clean = String(key || '').trim();
  if (!clean) delete keys[id];
  else if (!isPlausibleKey(clean))
    return { ok: false, error: 'that does not look like an api key' };
  else keys[id] = clean;
  return writeUserKeys(keys, storage)
    ? { ok: true }
    : { ok: false, error: 'this browser blocks local storage' };
}

export function clearUserKeys(storage) {
  return writeUserKeys({}, storage);
}

/** "sk-ant-…9f3a" style preview; never the whole key. */
export function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return '••••';
  return `${k.slice(0, Math.min(6, k.length - 4))}…${k.slice(-4)}`;
}

/** Request headers carrying the saved keys (empty when there are none). */
export function userKeyHeaders(storage) {
  const keys = readUserKeys(storage);
  if (!Object.keys(keys).length) return {};
  return { [USER_KEYS_HEADER]: btoa(JSON.stringify(keys)) };
}
