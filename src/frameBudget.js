/**
 * Frame budget: sheds cosmetic post-processing when the GPU cannot keep up.
 *
 * Measures frame time only while the scene renders continuously (idle
 * request-render frames are gaps, not work). When the smoothed frame time
 * stays over budget, effects go to REDUCED: the ambient colour grade turns off
 * and animated style shaders (CRT/film grain) freeze, which also drops their
 * continuous-render hold. After a back-off the budget probes FULL again and
 * re-measures; a failed probe doubles the back-off (up to two minutes).
 *
 * Operator-chosen styles stay on — only their animation and the cosmetic
 * grade are shed. `localStorage['adam.fx.budget'] = 'off'` disables it.
 */

const DEFAULTS = Object.freeze({
  highMs: 34, // below ~30 fps
  lowMs: 24,
  enterAfterMs: 3000,
  probeAfterMs: 15_000,
  maxProbeMs: 120_000,
  maxGapMs: 250,
});

/**
 * Pure hysteresis state machine.
 * @param {Partial<typeof DEFAULTS>} [options]
 */
export function createFrameBudget(options = {}) {
  const o = { ...DEFAULTS, ...options };
  let ema = null;
  let overSince = null;
  let reduced = false;
  let reducedAt = 0;
  let probeMs = o.probeAfterMs;
  let probing = false;

  return {
    /** Feed one frame interval; returns whether effects are reduced. */
    sample(frameMs, now) {
      if (reduced) return reduced;
      if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > o.maxGapMs)
        return reduced;
      ema = ema == null ? frameMs : ema * 0.9 + frameMs * 0.1;
      if (ema > o.highMs) {
        overSince ??= now;
        if (now - overSince >= o.enterAfterMs) {
          reduced = true;
          reducedAt = now;
          if (probing) probeMs = Math.min(o.maxProbeMs, probeMs * 2);
          probing = false;
          overSince = null;
        }
      } else {
        overSince = null;
        if (ema < o.lowMs && probing) {
          probing = false;
          probeMs = o.probeAfterMs;
        }
      }
      return reduced;
    },
    /** Called on a timer; ends a reduced period once the back-off elapses. */
    tick(now) {
      if (reduced && now - reducedAt >= probeMs) {
        reduced = false;
        probing = true;
        ema = null;
      }
      return reduced;
    },
    get reduced() {
      return reduced;
    },
    get probeMs() {
      return probeMs;
    },
    get emaMs() {
      return ema;
    },
  };
}

// ── Shared instance ────────────────────────────────────────────────────────
let budget = createFrameBudget();
const listeners = new Set();

export function isEffectsReduced() {
  return budget.reduced;
}

export function subscribeEffectsBudget(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(budget.reduced);
    } catch {
      /* a listener must not break the others */
    }
  }
}

function disabledByOperator() {
  try {
    return globalThis.localStorage?.getItem('adam.fx.budget') === 'off';
  } catch {
    return false;
  }
}

/**
 * Attach to a viewer. Returns a detach function.
 * @param {{scene: object}} viewer
 * @param {{now?: () => number}} [options]
 */
export function installFrameBudget(
  viewer,
  { now = () => performance.now() } = {},
) {
  const scene = viewer?.scene;
  if (!scene?.postRender || disabledByOperator()) return () => {};
  budget = createFrameBudget();
  let last = null;
  const onFrame = () => {
    const t = now();
    const continuous = scene.requestRenderMode === false;
    if (continuous && last != null) {
      const before = budget.reduced;
      if (budget.sample(t - last, t) !== before) emit();
    }
    last = continuous ? t : null;
  };
  const remove = scene.postRender.addEventListener(onFrame);
  const timer = setInterval(() => {
    const before = budget.reduced;
    if (budget.tick(now()) !== before) emit();
  }, 1000);
  return () => {
    remove?.();
    clearInterval(timer);
  };
}

export function frameBudgetStatus() {
  return {
    reduced: budget.reduced,
    frameMs: budget.emaMs == null ? null : Math.round(budget.emaMs * 10) / 10,
    probeMs: budget.probeMs,
  };
}
