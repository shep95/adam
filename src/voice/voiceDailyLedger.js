/**
 * Daily voice spend ledger (ADAM). Per-session caps already stop a session;
 * this adds a ceiling across the day on this device: each session's cap is
 * lowered to what remains of the day's budget, so the existing cap-stop path
 * ends the session when the day's budget is spent.
 *
 * Default daily ceiling $20; set VITE_ADAM_VOICE_DAILY_CAP_USD to change it
 * (0 or "off" disables). Pair it with a spend limit at the provider: this is
 * a guard on this browser, not a billing cap.
 */

const KEY = 'adam.voice.daily.v1';
export const DEFAULT_DAILY_CAP_USD = 20;
const MIN_CAP_USD = 0.0001;

export function dailyCapUsd(
  raw = import.meta.env?.VITE_ADAM_VOICE_DAILY_CAP_USD,
) {
  if (raw === undefined || raw === null || raw === '')
    return DEFAULT_DAILY_CAP_USD;
  if (String(raw).trim().toLowerCase() === 'off') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAILY_CAP_USD;
  return n > 0 ? n : Infinity;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function read(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) || 'null');
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.sessions &&
      typeof parsed.day === 'string'
    )
      return parsed;
  } catch {
    /* corrupt → fresh */
  }
  return { day: '', sessions: {} };
}

export function createVoiceDailyLedger({
  storage = globalThis.localStorage,
  cap = dailyCapUsd(),
  now = () => Date.now(),
} = {}) {
  const load = () => {
    const state = read(storage);
    if (state.day !== today(now())) return { day: today(now()), sessions: {} };
    return state;
  };
  const save = (state) => {
    try {
      storage?.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  };
  const spent = (state = load()) =>
    Object.values(state.sessions).reduce((s, v) => s + (Number(v) || 0), 0);
  return {
    cap,
    spentToday: () => spent(),
    remaining: () => (cap === Infinity ? Infinity : Math.max(0, cap - spent())),
    /** Record a session's running total (idempotent per session id). */
    record(sessionId, totalUsd) {
      if (!sessionId || !Number.isFinite(totalUsd)) return;
      const state = load();
      state.sessions[sessionId] = Math.max(
        Number(state.sessions[sessionId]) || 0,
        totalUsd,
      );
      save(state);
    },
    /** Session limits clamped to the day's remaining budget. */
    clampLimits(limits) {
      const remaining =
        cap === Infinity ? Infinity : Math.max(MIN_CAP_USD, cap - spent());
      const capUsd = Math.min(Number(limits?.capUsd ?? Infinity), remaining);
      const warnUsd = Math.min(
        Number(limits?.warnUsd ?? Infinity),
        remaining === Infinity ? Infinity : remaining * 0.8,
      );
      return {
        warnUsd: Number.isFinite(warnUsd) ? warnUsd : 'off',
        capUsd: Number.isFinite(capUsd) ? capUsd : 'off',
      };
    },
  };
}
