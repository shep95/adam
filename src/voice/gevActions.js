/**
 * Voice action runner. Validated tool calls from the realtime voice session
 * (and scripted callers) are dispatched by name to the domain modules in
 * ./actions/: spatial, context, cockpit, scene, layer and analyst, with the
 * shared vocabulary in ./actions/vocabulary.js.
 */
import { searchAndFlyTo } from '../locations.js';
import {
  initCameraVerbs,
  interruptCameraMotion,
  adjustOrbitRange,
} from '../cameraVerbs.js';
import * as defaultFloorServices from '../data/groundFloor.js';
import { unavailablePlaceSearch } from '../search/placeSearch.js';
import * as defaultAnnotationResolver from '../annotations/annotationResolver.js';
import {
  getViewTargetCartesian,
  installViewTargetPrewarm,
} from './actions/spatial.js';
import { stopAllTracking } from './actions/cockpit.js';
import { LAYER_ACTIONS } from './actions/layer.js';
import { SCENE_ACTIONS } from './actions/scene.js';
import { SPATIAL_ACTIONS } from './actions/spatial.js';
import { COCKPIT_ACTIONS } from './actions/cockpit.js';
import { ANALYST_ACTIONS } from './actions/analyst.js';
import { CONTEXT_ACTIONS } from './actions/context.js';
import { INTEL_ACTIONS } from './actions/intel.js';

export { readLayerLifecycleSummary } from './layerSummary.js';
export { normalizeStackId } from './actions/vocabulary.js';
export {
  controlCctv,
  knownRadioLocation,
  controlRadio,
  cctvVoiceFocusOutcome,
} from './actions/layer.js';
export { formatTrackedEntityLabel } from './actions/cockpit.js';
export { getBasemapLabelContext } from './actions/context.js';

/**
 * Every voice action handler, keyed by tool name. Domain modules own the
 * handlers; this runner owns only cross-cutting pre-dispatch policy (camera
 * interrupts, orbit zoom) and the per-runner state.
 */
const ACTION_HANDLERS = Object.freeze({
  ...LAYER_ACTIONS,
  ...SCENE_ACTIONS,
  ...SPATIAL_ACTIONS,
  ...COCKPIT_ACTIONS,
  ...ANALYST_ACTIONS,
  ...CONTEXT_ACTIONS,
  ...INTEL_ACTIONS,
});

/** Create application actions over the supplied scene and services. */
export function createGevActionRunner({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations = null,
  placeSearch = unavailablePlaceSearch,
  floorServices = defaultFloorServices,
  annotationResolver = defaultAnnotationResolver,
  searchNavigation = searchAndFlyTo,
}) {
  // Voice enable times and analyst follow-up memory belong to this runner.
  const _layerEnabledAt = new Map();
  const resolveRegionRing = (name) =>
    annotationResolver.resolveRegionRingForQuery(name, undefined, placeSearch);
  installViewTargetPrewarm(viewer);
  initCameraVerbs(viewer, getViewTargetCartesian);
  const state = { analystEngine: undefined };
  return async function runGevAction(name, rawArgs = {}, runOptions = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

    const current = () =>
      !runOptions.signal?.aborted &&
      (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());

    // Navigation tools interrupt any continuous camera motion (spec §1.1) —
    // checked FIRST because each handler returns.
    if (name === 'zoom_to_globe') {
      interruptCameraMotion(`nav:${name}`);
    }

    // Explicit navigation while TRACKING supersedes the follow camera —
    // otherwise the tracker drags the view back and "I flew there but can't
    // do anything" (field finding). track_entity manages its own handoff.
    if (name === 'zoom_to_globe' && viewer.trackedEntity) {
      stopAllTracking(viewer, dataManager);
    }

    // Zoom during an active orbit adjusts the orbit RADIUS (spiral in/out) —
    // a straight camera move would be snapped back by the per-frame lookAt.
    if (name === 'adjust_camera_zoom') {
      const zoomOut = String(args.direction || '').toLowerCase() === 'out';
      const amt = String(args.amount || 'medium').toLowerCase();
      const factor = { little: 1.25, medium: 1.6, lot: 2.4 }[amt] || 1.6;
      if (adjustOrbitRange(zoomOut ? factor : 1 / factor)) {
        return {
          ok: true,
          action: 'adjust_camera_zoom',
          direction: zoomOut ? 'out' : 'in',
          amount: amt,
          orbitRadiusAdjusted: true,
        };
      }
    }

    const handler = Object.hasOwn(ACTION_HANDLERS, name)
      ? ACTION_HANDLERS[name]
      : null;
    if (!handler) throw new Error(`Unknown GEV tool: ${name}`);
    return handler({
      name,
      args,
      rawArgs,
      runOptions,
      current,
      state,
      viewer,
      styleManager,
      dataManager,
      sceneDirector,
      annotations,
      placeSearch,
      floorServices,
      annotationResolver,
      searchNavigation,
      _layerEnabledAt,
      resolveRegionRing,
      run: runGevAction,
    });
  };
}
