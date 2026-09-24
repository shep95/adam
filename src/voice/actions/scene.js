/**
 * Scene actions: visual style, panels, HUD, annotations and director scenes.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import {
  normalizeContextMode,
  normalizePanelId,
  normalizeStyle,
  withContextModeVocabulary,
} from './vocabulary.js';
import { activeContactsWindow } from './analyst.js';

// Abuse guards: a single tool call may not request more than this many marks,
// each route no more waypoints than this, and free-text fields are clamped so a
// runaway model call can't drive unbounded geocode/Overpass/OSRM/DOM work. These
// mirror the tool-schema caps (defense-in-depth: a direct or schema-ignoring call
// is still bounded here).
export const MAX_ANNOTATIONS_PER_CALL = 24;

export const MAX_ROUTE_POINTS = 12;

export const MAX_TARGET_LEN = 200;

export const MAX_LABEL_LEN = 120;

export function clampStr(value, max) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Bound the free-text + array sizes inside one annotation spec before it reaches the engine. */
export function sanitizeAnnotationSpec(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  const out = { ...spec };
  if (typeof out.target === 'string')
    out.target = clampStr(out.target, MAX_TARGET_LEN);
  if (typeof out.toTarget === 'string')
    out.toTarget = clampStr(out.toTarget, MAX_TARGET_LEN);
  if (typeof out.label === 'string')
    out.label = clampStr(out.label, MAX_LABEL_LEN);
  if (Array.isArray(out.points)) {
    out.points = out.points
      .slice(0, MAX_ROUTE_POINTS)
      .map((p) =>
        p && typeof p === 'object' && typeof p.target === 'string'
          ? { ...p, target: clampStr(p.target, MAX_TARGET_LEN) }
          : p,
      );
  }
  return out;
}

/**
 * Draw "whiteboard" annotations on the 3D world to point out what the agent is
 * talking about. Place names are resolved to real-world coordinates (and OSM
 * footprints) by the annotation engine, so the agent never has to guess pixels.
 */
export async function annotateMap(annotations, args = {}) {
  if (!annotations || typeof annotations.annotate !== 'function') {
    return {
      ok: false,
      action: 'annotate_map',
      error: 'Annotation engine unavailable',
    };
  }
  const raw = Array.isArray(args.annotations) ? args.annotations : [];
  if (!raw.length) {
    return {
      ok: false,
      action: 'annotate_map',
      error: 'No annotations supplied',
    };
  }
  if (raw.length > MAX_ANNOTATIONS_PER_CALL) {
    return {
      ok: false,
      action: 'annotate_map',
      error: `Too many annotations in one call (${raw.length}); max ${MAX_ANNOTATIONS_PER_CALL}. Mark fewer places, or split across calls.`,
    };
  }
  const requests = raw.map(sanitizeAnnotationSpec);
  const result = await annotations.annotate(requests, {
    // C1 invariant enforced in CODE (not just the prompt): the VOICE path NEVER clears as
    // a side effect of drawing — annotations accumulate/persist, and only an explicit
    // clear_annotations tool call wipes the board. (clearPrevious is intentionally ignored
    // here and removed from the annotate_map schema; the console/demo API still has it.)
    clearPrevious: false,
    persist: args.persist !== false,
    flyTo: Boolean(args.flyTo),
  });
  // Honesty: surface partial failure explicitly so the agent can tell the user
  // which place(s) it couldn't mark instead of implying everything appeared.
  const drewSome = result.drawn > 0;
  const someFailed = result.failed > 0;
  const failedLabels = [];
  for (const r of result.results || []) {
    if (r.ok) continue;
    // Route failures carry the specific missing waypoint name(s) in failedTargets;
    // everything else names its own label/target.
    if (Array.isArray(r.failedTargets) && r.failedTargets.length)
      failedLabels.push(...r.failedTargets);
    else failedLabels.push(r.target || r.label || 'an unnamed place'); // target (the place) before caption
  }
  return {
    ok: drewSome,
    action: 'annotate_map',
    drawn: result.drawn,
    failed: result.failed,
    partial: drewSome && someFailed,
    failedLabels: someFailed ? failedLabels : undefined,
    // A drawn route whose street routing was unavailable is a straight direct line,
    // not a real walking/driving route — flag it so the voice layer stays honest.
    routeFallback: (result.results || []).some((r) => r.ok && r.fallback),
    capped: Boolean(result.capped),
    // Progressive outlines: anchors are placed and returned immediately; footprints for
    // these items are still being traced and will appear on their own (or the mark
    // honestly stays a point). NOT a failure — the voice layer must not report it as one.
    outlinePending:
      (result.results || []).some((r) => r.ok && r.outlinePending) || undefined,
    items: result.results,
    // Keep `error` populated whenever ANYTHING failed (partial or total) so the
    // result never reads as a clean success — but keep it STATIC (no raw place text);
    // the actual names live only in the structured failedLabels DATA field, so the
    // model-facing prose can't carry injected instructions from a place name.
    error: someFailed ? 'Could not place one or more annotations' : null,
  };
}

export function clearAnnotations(annotations) {
  if (!annotations || typeof annotations.clear !== 'function') {
    return {
      ok: false,
      action: 'clear_annotations',
      error: 'Annotation engine unavailable',
    };
  }
  annotations.clear();
  return { ok: true, action: 'clear_annotations' };
}

/**
 * Voice scene playback control. Playback is fire-and-forget: startScene
 * sequences shots for minutes and must not block the realtime tool loop.
 */
export function controlScene(sceneDirector, args = {}) {
  if (!sceneDirector) {
    return {
      ok: false,
      action: 'control_scene',
      error: 'Scene director unavailable',
    };
  }
  const sceneAction = String(args.action || '').toLowerCase();

  if (sceneAction === 'list') {
    return {
      ok: true,
      action: 'control_scene',
      scenes: sceneDirector.listScenes(),
      ...sceneDirector.getPlaybackStatus(),
    };
  }
  if (sceneAction === 'status') {
    return {
      ok: true,
      action: 'control_scene',
      ...sceneDirector.getPlaybackStatus(),
    };
  }
  if (sceneAction === 'stop') {
    sceneDirector.stopScene('Stopped by voice');
    return { ok: true, action: 'control_scene', running: false };
  }
  if (sceneAction === 'next') {
    sceneDirector.runNextScene();
    return { ok: true, action: 'control_scene', advanced: true };
  }
  if (sceneAction === 'play') {
    if (sceneDirector.running) {
      return {
        ok: false,
        action: 'control_scene',
        error: 'A scene is already running — stop it first',
      };
    }
    const scene = args.sceneId
      ? sceneDirector.findSceneByQuery(args.sceneId)
      : sceneDirector.listScenes()[0] || null;
    if (!scene) {
      return {
        ok: false,
        action: 'control_scene',
        error: `No scene matched "${args.sceneId || ''}"`,
        scenes: sceneDirector.listScenes(),
      };
    }
    void sceneDirector.startScene(scene.id, { single: true });
    return {
      ok: true,
      action: 'control_scene',
      playing: scene.title,
      shots: scene.shots,
    };
  }
  throw new Error(`Unknown scene action: ${args.action || 'missing'}`);
}

export function setPanelOpen(styleManager, panelId, open) {
  if (styleManager && typeof styleManager.setPanelCollapsed === 'function') {
    styleManager.setPanelCollapsed(panelId, !open, { explicit: true });
  } else {
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.toggle('collapsed', !open);
  }
}

/** Voice action `set_visual_style`. */
export async function handleSetVisualStyle(ctx) {
  const { styleManager, args } = ctx;
  const style = normalizeStyle(args.style);
  if (!style)
    throw new Error(`Unknown visual style: ${args.style || 'missing'}`);
  styleManager.setStyle(style);
  return { ok: true, action: 'set_visual_style', style };
}

/** Voice action `set_panel_open`. */
export async function handleSetPanelOpen(ctx) {
  const { styleManager, args } = ctx;
  const panelId = normalizePanelId(args.panelId || args.panel);
  if (!panelId)
    throw new Error(
      `Unknown panel: ${args.panelId || args.panel || 'missing'}`,
    );
  const open = args.open !== false;
  setPanelOpen(styleManager, panelId, open);
  return { ok: true, action: 'set_panel_open', panelId, open };
}

/** Voice action `set_context_mode`. */
export async function handleSetContextMode(ctx) {
  const { styleManager, dataManager, args, current, runOptions } = ctx;
  if (!styleManager?.setContextMode) {
    return {
      ok: false,
      action: 'set_context_mode',
      error: 'Context mode control unavailable',
    };
  }
  const mode = normalizeContextMode(args.mode || args.contextMode);
  if (
    mode === null &&
    args.mode != null &&
    String(args.mode || '').trim() !== 'off'
  ) {
    return {
      ok: false,
      action: 'set_context_mode',
      error: `Unknown context mode: ${args.mode || 'missing'}`,
    };
  }
  const cancellationState = () =>
    withContextModeVocabulary(
      typeof styleManager.getContextModeState === 'function'
        ? styleManager.getContextModeState()
        : {},
    );
  if (!current()) {
    return {
      ok: false,
      action: 'set_context_mode',
      cancelled: true,
      error: 'Context request was cancelled before it could run',
      ...cancellationState(),
    };
  }
  if (mode && mode !== 'off') {
    setPanelOpen(styleManager, 'global-context-panel', true);
  }
  const result = await styleManager.setContextMode(
    mode === 'off' ? null : mode,
    {
      signal: runOptions.signal,
      isCurrent: runOptions.isCurrent,
    },
  );
  if (!current() && result?.ok !== true) {
    return {
      ...withContextModeVocabulary(result),
      ok: false,
      action: 'set_context_mode',
      cancelled: true,
      error:
        result?.error || 'Context request was cancelled before it completed',
      ...cancellationState(),
    };
  }
  const contactsWindow = ['contacts', 'flights'].includes(mode)
    ? activeContactsWindow(dataManager)
    : null;
  return {
    ...withContextModeVocabulary(result),
    ...(contactsWindow ? { contactsWindow } : {}),
  };
}

/** Voice action `set_hud`. */
export async function handleSetHud(ctx) {
  const { styleManager, args } = ctx;
  const out = { ok: true, action: 'set_hud' };
  if (args.layout != null) {
    const result = styleManager.setHudLayout(args.layout);
    if (!result.ok) return { ...result, action: 'set_hud' };
    Object.assign(out, result);
  }
  if (args.visible != null) {
    const result = styleManager.setHudVisible(args.visible);
    if (!result.ok) return { ...result, action: 'set_hud' };
    Object.assign(out, result);
  }
  return { ...out, hud: styleManager.getControlState().hud };
}

/** Voice action `set_cyber_sonar`. */
export async function handleSetCyberSonar(ctx) {
  const { styleManager, args } = ctx;
  if (typeof styleManager?.setCyberSonar !== 'function') {
    return {
      ok: false,
      action: 'set_cyber_sonar',
      error: 'Cyber sonar controls are unavailable.',
    };
  }
  return { action: 'set_cyber_sonar', ...styleManager.setCyberSonar(args) };
}

/** Voice action `set_detection`. */
export async function handleSetDetection(ctx) {
  const { styleManager, args } = ctx;
  const result = styleManager.setDetection({
    enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
    mode: typeof args.mode === 'string' ? args.mode : undefined,
    densityPct: Number.isFinite(Number(args.densityPct))
      ? Number(args.densityPct)
      : undefined,
    allocationStrategy:
      typeof args.allocationStrategy === 'string'
        ? args.allocationStrategy
        : undefined,
  });
  return { action: 'set_detection', ...result };
}

/** Voice action `set_post_processing`. */
export async function handleSetPostProcessing(ctx) {
  const { styleManager, args } = ctx;
  const out = { ok: true, action: 'set_post_processing' };
  if (args.bloom && typeof args.bloom === 'object') {
    Object.assign(
      out,
      styleManager.setBloom({
        enabled:
          typeof args.bloom.enabled === 'boolean'
            ? args.bloom.enabled
            : undefined,
        intensityPct: Number.isFinite(Number(args.bloom.intensityPct))
          ? Number(args.bloom.intensityPct)
          : undefined,
      }),
    );
  }
  if (args.sharpen && typeof args.sharpen === 'object') {
    Object.assign(
      out,
      styleManager.setSharpen({
        enabled:
          typeof args.sharpen.enabled === 'boolean'
            ? args.sharpen.enabled
            : undefined,
        intensityPct: Number.isFinite(Number(args.sharpen.intensityPct))
          ? Number(args.sharpen.intensityPct)
          : undefined,
      }),
    );
  }
  return out;
}

/** Voice action `control_scene`. */
export async function handleControlScene(ctx) {
  const { sceneDirector, args } = ctx;
  return controlScene(sceneDirector, args);
}

/** Voice action `annotate_map`. */
export async function handleAnnotateMap(ctx) {
  const { annotations, args } = ctx;
  return annotateMap(annotations, args);
}

/** Voice action `clear_annotations`. */
export async function handleClearAnnotations(ctx) {
  const { annotations } = ctx;
  return clearAnnotations(annotations);
}

/** Action name → handler for this domain. */
export const SCENE_ACTIONS = Object.freeze({
  set_visual_style: handleSetVisualStyle,
  set_panel_open: handleSetPanelOpen,
  set_context_mode: handleSetContextMode,
  set_hud: handleSetHud,
  set_cyber_sonar: handleSetCyberSonar,
  set_detection: handleSetDetection,
  set_post_processing: handleSetPostProcessing,
  control_scene: handleControlScene,
  annotate_map: handleAnnotateMap,
  clear_annotations: handleClearAnnotations,
});
