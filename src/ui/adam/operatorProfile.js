/**
 * Operator profile: everything an operator has tuned, as one portable file.
 *
 *   alert rules, baselines, pins, layer prefs, scene project, UI scale,
 *   panel positions, voice limits, CCTV calibration, Shepherd prefs
 *
 * The file carries a SHA-256 of its canonical body (integrity: any edit is
 * caught on import) and, when the deployment has ADAM_ACCESS_TOKEN, an
 * HMAC-SHA256 from /api/access/sign (provenance: this deployment issued it).
 * Import writes only allow-listed keys. Secrets never enter the file — keys
 * and tokens live server-side or in the browser's own key store.
 */

export const PROFILE_FORMAT = 'adam-operator-profile';
export const PROFILE_VERSION = 1;

/** Exact keys and key prefixes a profile may carry. */
export const PROFILE_KEYS = Object.freeze([
  'adam.intel.alerts.v1',
  'adam.intel.baselines.v1',
  'adam.intel.baselines.fine.v1',
  'adam.intel.pins.v1',
  'adam.intel.mission.v1',
  'adam.intel.watchlog.v1',
  'adam.ui.scale',
  'gev:layer-state:v2',
  'godsEyeView.sceneProject.v2',
  'godsEyeView.cockpitWeatherEffects.enabled',
  'godsEyeView.voiceCost.tier',
  'godsEyeView.voiceCost.limits',
  'godsEyeView.cctv.calibration.v2',
]);
export const PROFILE_PREFIXES = Object.freeze(['godsEyeView.v6.panelPos.']);

const SECRETISH = /(key|token|secret|password|auth)/i;

export function profileKeyAllowed(key) {
  const k = String(key || '');
  if (!k || SECRETISH.test(k)) return false;
  return (
    PROFILE_KEYS.includes(k) || PROFILE_PREFIXES.some((p) => k.startsWith(p))
  );
}

/** Stable JSON: object keys sorted at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('SHA-256 is unavailable in this browser');
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function storageKeys(storage) {
  const out = [];
  try {
    for (let i = 0; i < (storage?.length || 0); i += 1) {
      const k = storage.key(i);
      if (k != null) out.push(k);
    }
  } catch {
    /* storage blocked */
  }
  return out;
}

/**
 * @param {{storage?: Storage, shepherdPrefs?: object|null, label?: string, now?: Date}} [o]
 */
export function collectProfile({
  storage = globalThis.localStorage,
  shepherdPrefs = null,
  label = '',
  now = new Date(),
} = {}) {
  const keys = {};
  for (const k of storageKeys(storage).sort()) {
    if (!profileKeyAllowed(k)) continue;
    try {
      const v = storage.getItem(k);
      if (v != null) keys[k] = v;
    } catch {
      /* skip */
    }
  }
  const body = {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    exportedAt: now.toISOString(),
    label: String(label || '').slice(0, 80),
    keys,
  };
  if (shepherdPrefs && typeof shepherdPrefs === 'object')
    body.shepherd = { prefs: stripSecrets(shepherdPrefs) };
  return body;
}

function stripSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!SECRETISH.test(k)) out[k] = v;
  return out;
}

/**
 * Seal a profile body: integrity digest plus an optional server signature.
 * @param {object} body
 * @param {{sign?: (digest: string) => Promise<object|null>, subtle?: SubtleCrypto}} [o]
 */
export async function sealProfile(body, { sign, subtle } = {}) {
  const digest = await sha256Hex(canonicalJson(body), subtle);
  let signature = null;
  if (sign) {
    try {
      signature = (await sign(digest)) || null;
    } catch {
      signature = null;
    }
  }
  return { ...body, integrity: { alg: 'SHA-256', digest }, signature };
}

/**
 * Check a parsed profile file.
 * @returns {Promise<{ok: boolean, reason?: string, digest?: string,
 *   signed: boolean, verified: boolean|null, keys: string[]}>}
 */
export async function verifyProfile(doc, { verify, subtle } = {}) {
  const fail = (reason) => ({
    ok: false,
    reason,
    signed: false,
    verified: null,
    keys: [],
  });
  if (!doc || typeof doc !== 'object') return fail('not a profile file');
  if (doc.format !== PROFILE_FORMAT)
    return fail('not an ADAM operator profile');
  if (doc.version !== PROFILE_VERSION)
    return fail(`unsupported profile version ${doc.version}`);
  if (!doc.keys || typeof doc.keys !== 'object')
    return fail('profile has no settings');
  const { integrity, signature, ...body } = doc;
  const digest = await sha256Hex(canonicalJson(body), subtle);
  if (integrity?.digest !== digest)
    return fail('checksum mismatch — the file was edited or damaged');
  let verified = null;
  if (signature?.sig && verify) {
    try {
      verified = Boolean(await verify(digest, signature));
    } catch {
      verified = null;
    }
  }
  return {
    ok: verified !== false,
    reason:
      verified === false
        ? 'signature does not match this deployment'
        : undefined,
    digest,
    signed: Boolean(signature?.sig),
    verified,
    keys: Object.keys(doc.keys).filter(profileKeyAllowed),
  };
}

/**
 * Write a verified profile's allow-listed keys. Returns the keys written.
 * @param {object} doc
 * @param {{storage?: Storage}} [o]
 */
export function applyProfile(doc, { storage = globalThis.localStorage } = {}) {
  const written = [];
  for (const [k, v] of Object.entries(doc?.keys || {})) {
    if (!profileKeyAllowed(k) || typeof v !== 'string') continue;
    try {
      storage.setItem(k, v);
      written.push(k);
    } catch {
      /* quota or blocked */
    }
  }
  return written;
}

/** Server signing hooks over /api/access/{sign,verify}; null when unavailable. */
export function serverSigner(fetchImpl = (...a) => globalThis.fetch(...a)) {
  const post = async (path, payload) => {
    const res = await fetchImpl(`/api/access/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return res.json();
  };
  return {
    sign: (digest) => post('sign', { digest }),
    verify: async (digest, signature) => {
      const r = await post('verify', {
        digest,
        sig: signature.sig,
        keyId: signature.keyId,
      });
      return r ? r.valid : null;
    },
  };
}
