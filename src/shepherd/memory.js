/**
 * Shepherd memory: what survives a reload on this device.
 *
 *   thread       the running conversation (last 60 turns, images dropped)
 *   prefs        provider, model, open state, sound
 *   focus        learned attention — which layers and regions the operator
 *                keeps returning to, decayed so old habits fade
 *   viewport     where the camera was when the page closed
 *
 * IndexedDB is the store; localStorage is the fallback when IndexedDB is
 * blocked (private windows, some embedded browsers). Everything is local —
 * nothing here is sent anywhere except the thread, when the operator chats.
 */

const DB_NAME = 'adam-shepherd';
const STORE = 'kv';
const LS_PREFIX = 'adam.shepherd.';
export const THREAD_LIMIT = 60;
const FOCUS_HALF_LIFE_MS = 7 * 86_400_000;
const FOCUS_LIMIT = 40;

function openDb(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve) => {
    if (!indexedDB) return resolve(null);
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function lsGet(key) {
  try {
    const raw = globalThis.localStorage?.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function lsSet(key, value) {
  try {
    globalThis.localStorage?.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or disabled */
  }
}

/** A small async key/value store. */
export function createKvStore({ indexedDB } = {}) {
  const ready = openDb(indexedDB);
  const run = async (mode, fn) => {
    const db = await ready;
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  };
  return {
    async get(key) {
      const value = await run('readonly', (s) => s.get(key));
      return value === undefined ? lsGet(key) : value;
    },
    async set(key, value) {
      const db = await ready;
      if (!db) return lsSet(key, value);
      await run('readwrite', (s) => s.put(value, key));
    },
    async delete(key) {
      try {
        globalThis.localStorage?.removeItem(LS_PREFIX + key);
      } catch {
        /* ignore */
      }
      await run('readwrite', (s) => s.delete(key));
    },
  };
}

/** Strip a turn down to what is worth keeping on disk. */
export function storableTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  const out = {
    role: turn.role,
    text: String(turn.text || '').slice(0, 20_000),
  };
  if (turn.role === 'user' && turn.images?.length)
    out.imageNote = `${turn.images.length} image(s)`;
  if (turn.role === 'assistant' && turn.toolCalls?.length)
    out.toolCalls = turn.toolCalls;
  if (turn.role === 'tool') {
    out.toolCallId = turn.toolCallId;
    out.name = turn.name;
    out.result = String(turn.result || '').slice(0, 4000);
  }
  if (turn.role === 'user' && turn.display)
    out.display = String(turn.display).slice(0, 400);
  if (turn.at) out.at = turn.at;
  return out;
}

/**
 * Trim a thread so it starts on an operator turn and never splits a tool
 * call from its results.
 */
export function trimThread(thread, limit = THREAD_LIMIT) {
  let out = thread.slice(-limit);
  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}

/** Decay-weighted attention counter. */
export function bumpFocus(focus, key, now = Date.now()) {
  const next = { ...(focus || {}) };
  for (const [k, entry] of Object.entries(next)) {
    const age = now - (entry.at || now);
    next[k] = { w: entry.w * 0.5 ** (age / FOCUS_HALF_LIFE_MS), at: now };
    if (next[k].w < 0.05) delete next[k];
  }
  next[key] = { w: (next[key]?.w || 0) + 1, at: now };
  const ranked = Object.entries(next)
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, FOCUS_LIMIT);
  return Object.fromEntries(ranked);
}

export function topFocus(focus, limit = 5) {
  return Object.entries(focus || {})
    .sort((a, b) => b[1].w - a[1].w)
    .slice(0, limit)
    .map(([key]) => key);
}

export function createShepherdMemory({ store = createKvStore() } = {}) {
  let focus = {};
  const loaded = store.get('focus').then((value) => {
    if (value && typeof value === 'object') focus = value;
  });
  return {
    loaded,
    async loadThread() {
      const thread = await store.get('thread');
      return Array.isArray(thread)
        ? trimThread(thread.map(storableTurn).filter(Boolean))
        : [];
    },
    async saveThread(thread) {
      await store.set(
        'thread',
        trimThread(thread.map(storableTurn).filter(Boolean)),
      );
    },
    async clearThread() {
      await store.delete('thread');
    },
    async loadPrefs() {
      const prefs = await store.get('prefs');
      return prefs && typeof prefs === 'object' ? prefs : {};
    },
    async savePrefs(prefs) {
      await store.set('prefs', prefs);
    },
    async loadViewport() {
      return (await store.get('viewport')) || null;
    },
    async saveViewport(viewport) {
      await store.set('viewport', viewport);
    },
    noteFocus(key) {
      if (!key) return;
      focus = bumpFocus(focus, String(key).slice(0, 60));
      void store.set('focus', focus);
    },
    topFocus: (limit) => topFocus(focus, limit),
  };
}
