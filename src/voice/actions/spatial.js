/**
 * Spatial actions: camera navigation, zoom, routes and orbital passes.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import * as Cesium from 'cesium';
import {
  CITY_POIS,
  findPoiByName,
  flyToGlobeView,
  flyToLandmark,
  flyToPOI,
  flyToPresetLocation,
  GLOBE_VIEW,
  searchAndFlyTo,
} from '../../locations.js';
import {
  moveCamera,
  flyRoute,
  interruptCameraMotion,
} from '../../cameraVerbs.js';
import { isPickedWorldPosition } from '../../data/scenePick.js';
import { unavailablePlaceSearch } from '../../search/placeSearch.js';
import { clampNumber, compassDir, normalizeLocationId } from './vocabulary.js';
import { stopAllTracking } from './cockpit.js';

export const serviceCaches = new WeakMap();

export function cachesFor(service) {
  service.signal?.throwIfAborted();
  let caches = serviceCaches.get(service);
  if (!caches) {
    caches = {
      reverseGeocodeCache: new Map(),
      reverseGeocodeInFlight: new Map(),
      nearbyPlacesCache: new Map(),
      nearbyPlacesInFlight: new Map(),
    };
    serviceCaches.set(service, caches);
    service.signal?.addEventListener(
      'abort',
      () => {
        for (const cache of Object.values(caches)) cache.clear();
      },
      { once: true },
    );
  }
  return caches;
}

export const BASEMAP_CONTEXT_WAIT_MS = 1500;

export const viewTargetCache = new WeakMap();

/** Run one validated voice camera mutation through the UI-owned authority seam. */
export function runManagedVoiceNavigation(
  styleManager,
  noun,
  action,
  navigate,
  releaseOptions = undefined,
) {
  if (typeof styleManager?.runImmediateNavigation !== 'function') {
    return { ok: false, action, error: 'Camera navigation policy unavailable' };
  }
  const result = styleManager.runImmediateNavigation(
    noun,
    navigate,
    releaseOptions,
  );
  if (result !== false) return result;
  return {
    ok: false,
    action,
    error: 'Camera navigation is unavailable in the current view',
  };
}

export function installViewTargetPrewarm(viewer) {
  if (viewer.__gevViewTargetPrewarmInstalled) return;
  viewer.__gevViewTargetPrewarmInstalled = true;
  let timer = null;
  let reportedPrewarmFailure = false;
  viewer.camera.moveEnd.addEventListener(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      // Belt and braces. Validating the pick is the fix; this catch exists
      // because an idle callback is an UNCAUGHT context — nothing above it can
      // handle a surprise from the scene graph, and a red console error on a
      // plain camera flight is worse than a cold cache. Reported once per
      // viewer so a repeating cause cannot spam the console.
      const warm = () => {
        try {
          getViewTargetCartographic(viewer);
        } catch (error) {
          if (reportedPrewarmFailure) return;
          reportedPrewarmFailure = true;
          console.debug(
            '[Voice] view-target prewarm skipped:',
            error?.message || error,
          );
        }
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(warm, { timeout: 500 });
      } else {
        warm();
      }
    }, 120);
  });
}

export function adjustCameraZoom(viewer, args) {
  const direction = String(args.direction || '').toLowerCase();
  if (direction !== 'in' && direction !== 'out') {
    throw new Error('adjust_camera_zoom direction must be "in" or "out"');
  }

  const amount = String(args.amount || 'little').toLowerCase();
  const fraction = {
    little: 0.25,
    medium: 0.55,
    lot: 1.0,
  }[amount];
  if (!fraction) throw new Error(`Unknown zoom amount: ${args.amount}`);

  const camera = viewer.camera;
  const beforePosition = Cesium.Cartesian3.clone(camera.positionWC);
  const beforeHeightM = camera.positionCartographic.height;
  const target = getViewTargetCartesian(viewer);
  const targetDistanceM = target
    ? Cesium.Cartesian3.distance(beforePosition, target)
    : Math.max(100, beforeHeightM);
  const minimumDistanceM = direction === 'in' ? 20 : 50;
  const movementM = Math.max(minimumDistanceM, targetDistanceM * fraction);

  camera.cancelFlight();
  if (direction === 'out') {
    camera.zoomOut(movementM);
  } else {
    const safeMovementM = Math.min(
      movementM,
      Math.max(0, targetDistanceM - 25),
    );
    if (safeMovementM <= 0) {
      return {
        ok: false,
        action: 'adjust_camera_zoom',
        direction,
        amount,
        error: 'Camera is already at the minimum target distance',
      };
    }
    camera.zoomIn(safeMovementM);
  }
  viewer.scene.requestRender();

  const afterPosition = camera.positionWC;
  const movedM = Cesium.Cartesian3.distance(beforePosition, afterPosition);
  const afterHeightM = camera.positionCartographic.height;
  const moved = movedM >= 0.5;
  return {
    ok: moved,
    action: 'adjust_camera_zoom',
    direction,
    amount,
    movementRequestedM: Math.round(movementM),
    movementActualM: Math.round(movedM),
    beforeHeightM: Math.round(beforeHeightM),
    afterHeightM: Math.round(afterHeightM),
    error: moved ? null : 'Cesium camera position did not change',
  };
}

export async function flyToRequestedLocation(
  viewer,
  args,
  {
    placeSearch = unavailablePlaceSearch,
    searchNavigation = searchAndFlyTo,
    signal,
    onStart = null,
    runImmediate = null,
    beginDeferred = null,
    reassertDeferred = null,
  } = {},
) {
  const requestedRangeM = Number(args.rangeM);
  const rangeM = Number.isFinite(requestedRangeM)
    ? clampNumber(requestedRangeM, 100, 20000000, 900)
    : null;
  const locationId = normalizeLocationId(args.locationId || args.query);
  const immediate = (navigate) =>
    typeof runImmediate === 'function' ? runImmediate(navigate) : navigate();
  const immediateOnStart = typeof runImmediate === 'function' ? null : onStart;
  const cancelled = (label) => ({
    ok: false,
    cancelled: true,
    action: 'fly_to_location',
    label,
  });
  let settleArrival = null;
  const arrival =
    args.waitForArrival === true
      ? new Promise((resolve) => {
          settleArrival = resolve;
        })
      : null;
  const arrivalHooks = arrival
    ? {
        onComplete: () => settleArrival?.('arrived'),
        onCancel: () => settleArrival?.('cancelled'),
      }
    : {};
  const afterArrival = async (result, label) => {
    if (!arrival || result?.ok !== true) return result;
    const status = await arrival;
    settleArrival = null;
    return status === 'arrived'
      ? { ...result, arrived: true }
      : cancelled(label);
  };

  if (locationId) {
    const result = immediate(() =>
      flyToPresetLocation(viewer, locationId, {
        ...(rangeM || args.viewMode === 'close'
          ? { range: rangeM || 250 }
          : { viewMode: 'overview' }),
        duration: 2.2,
        onStart: immediateOnStart,
        ...arrivalHooks,
      }),
    );
    if (result === false)
      return cancelled(CITY_POIS[locationId]?.name || locationId);
    const response = {
      ok: Boolean(result),
      action: 'fly_to_location',
      locationId,
      label: CITY_POIS[locationId]?.name || locationId,
      rangeM: result?.range ? Math.round(result.range) : rangeM || null,
      navigationMode: rangeM
        ? 'explicit-range'
        : args.viewMode === 'close'
          ? 'city-close'
          : result?.navigationMode || 'city-overview',
    };
    return afterArrival(response, response.label);
  }

  const latitude = Number(args.latitude);
  const longitude = Number(args.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const result = immediate(() =>
      flyToLandmark(viewer, latitude, longitude, {
        range: rangeM || 250,
        pitch: -35,
        heading: 0,
        buildingHeight: 0,
        duration: 2.2,
        onStart: immediateOnStart,
        ...arrivalHooks,
      }),
    );
    if (result === false)
      return cancelled(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
    const response = {
      ok: true,
      action: 'fly_to_location',
      latitude,
      longitude,
      label: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      rangeM: Math.round(rangeM || 250),
      navigationMode: rangeM ? 'explicit-range' : 'close-coordinate',
    };
    return afterArrival(response, response.label);
  }

  const query = String(args.query || '').trim();
  if (query) {
    // A query that names a curated preset POI ("the Texas State Capitol", "Golden Gate Bridge")
    // flies to its hand-tuned camera pose — the same beautiful framing as clicking the LOCATIONS
    // panel button — instead of generic geocode framing. An explicit rangeM still overrides distance.
    const poiMatch = findPoiByName(query);
    if (poiMatch) {
      const result = immediate(() =>
        flyToPOI(viewer, poiMatch.cityId, poiMatch.index, {
          duration: 2.2,
          onStart: immediateOnStart,
          ...arrivalHooks,
          ...(rangeM ? { range: rangeM } : {}),
        }),
      );
      const poi = CITY_POIS[poiMatch.cityId]?.pois?.[poiMatch.index];
      if (result === false) return cancelled(poi?.name || query);
      const response = {
        ok: Boolean(result),
        action: 'fly_to_location',
        query,
        label: poi?.name || query,
        navigationMode: rangeM ? 'preset-poi-range' : 'preset-poi',
        rangeM: result?.range ? Math.round(result.range) : rangeM || null,
      };
      return afterArrival(response, response.label);
    }

    const generation =
      typeof beginDeferred === 'function' ? beginDeferred() : null;
    if (generation === false) return cancelled(query);
    const managedDeferred = typeof reassertDeferred === 'function';
    const destination = await searchNavigation(viewer, query, {
      placeSearch,
      signal,
      ...(rangeM ? { range: rangeM } : {}),
      forceClose: args.viewMode === 'close',
      // 'overview' frames the geocode viewport even for precise-place results —
      // previously dropped here, so "overview of Zilker Park" flew to a rooftop.
      viewMode: args.viewMode || null,
      duration: 2.2,
      ...arrivalHooks,
      beforeFly: managedDeferred ? () => reassertDeferred(generation) : null,
      onStart: managedDeferred ? null : onStart,
    });
    if (destination?.cancelled) return cancelled(query);
    const response = {
      ok: Boolean(destination),
      action: 'fly_to_location',
      query,
      label: destination?.label || query,
      navigationMode: destination?.navigationMode || null,
      rangeM: destination?.rangeM || rangeM || null,
    };
    return afterArrival(response, response.label);
  }

  throw new Error(
    'fly_to_location needs a locationId, query, or latitude/longitude',
  );
}

export function nextIssPass(viewer, dataManager, args) {
  let latDeg = Number.isFinite(args.latitude) ? args.latitude : null;
  let lonDeg = Number.isFinite(args.longitude) ? args.longitude : null;
  if (latDeg == null || lonDeg == null) {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) throw new Error('Camera position unavailable');
    latDeg = Cesium.Math.toDegrees(carto.latitude);
    lonDeg = Cesium.Math.toDegrees(carto.longitude);
  }
  const minElevDeg = Number.isFinite(args.minElevationDeg)
    ? args.minElevationDeg
    : 10;
  const result = dataManager?.layers
    ?.get('satellites')
    ?.module?.getNextIssPass?.({ latDeg, lonDeg, minElevDeg }) ?? {
    status: 'no-tle',
  };
  if (result.status === 'no-tle') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error:
        'ISS orbital elements not loaded yet — enable the satellites layer once, then ask again.',
    };
  }
  if (result.status === 'none') {
    return {
      ok: false,
      action: 'next_iss_pass',
      error: `No ISS pass above ${minElevDeg}° in the next 24 hours for this location.`,
    };
  }
  const { pass } = result;
  return {
    ok: true,
    action: 'next_iss_pass',
    observer: { latitude: latDeg, longitude: lonDeg },
    riseIso: new Date(pass.riseMs).toISOString(),
    minutesFromNow: Math.round((pass.riseMs - Date.now()) / 60000),
    durationMin: Math.max(1, Math.round((pass.setMs - pass.riseMs) / 60000)),
    peakElevationDeg: Math.round(pass.maxElevDeg),
    riseDirection: compassDir(pass.riseAzDeg),
    visible: typeof pass.visible === 'boolean' ? pass.visible : null,
    visibilityNote:
      'Geometric illumination estimate only; weather, brightness and orbital-element age affect actual visibility.',
    setIso: new Date(pass.setMs).toISOString(),
    peakIso: new Date(pass.maxElevMs).toISOString(),
  };
}

export function nextSatellitePass(viewer, dataManager, args) {
  const layer = dataManager?.layers?.get('satellites')?.module;
  const identity = layer?.resolveSatelliteForPass?.(args.target) || {
    status: 'not-found',
  };
  if (identity.status !== 'ok')
    return {
      ok: false,
      action: 'next_satellite_pass',
      ...identity,
      error:
        identity.status === 'ambiguous'
          ? 'Several loaded satellites match. Choose a NORAD ID from candidates.'
          : 'No loaded satellite matches. Enable satellites and use an exact name or NORAD ID.',
    };
  // Reuse the legacy location fallback and result formatting, substituting only
  // this explicitly resolved catalog identity and the optional visibility filter.
  const adapter = {
    layers: new Map([
      [
        'satellites',
        {
          module: {
            getNextIssPass: (options) =>
              layer.getNextSatellitePass(identity.noradId, {
                ...options,
                requireVisible: args.visibleOnly === true,
              }),
          },
        },
      ],
    ]),
  };
  const result = nextIssPass(viewer, adapter, args);
  if (result.error) {
    result.error = result.error.replace(
      /ISS/g,
      identity.name || String(identity.noradId),
    );
    if (args.visibleOnly === true)
      result.error +=
        ' Search required estimated illumination under a dark sky.';
  }
  return {
    ...result,
    action: 'next_satellite_pass',
    noradId: identity.noradId,
    name: identity.name,
    visibleOnly: args.visibleOnly === true,
    horizonHours: 24,
  };
}

export function getViewTargetCartographic(viewer) {
  const signature = cameraViewSignature(viewer);
  const cached = viewTargetCache.get(viewer);
  if (
    cached?.signature === signature &&
    performance.now() - cached.cachedAt < 2500
  ) {
    return cached.target;
  }
  const position = getViewTargetCartesian(viewer);
  // `fromCartesian` still returns undefined for a point too near the ellipsoid
  // center to project; normalize that to the same "no target" null the callers
  // already handle for a missed pick.
  const target = position
    ? Cesium.Cartographic.fromCartesian(position) || null
    : null;
  viewTargetCache.set(viewer, {
    signature,
    target,
    cachedAt: performance.now(),
  });
  return target;
}

export function cameraViewSignature(viewer) {
  const camera = viewer.camera;
  const cartographic = camera.positionCartographic;
  return [
    Cesium.Math.toDegrees(cartographic.latitude).toFixed(5),
    Cesium.Math.toDegrees(cartographic.longitude).toFixed(5),
    Math.round(cartographic.height / 2),
    camera.heading.toFixed(3),
    camera.pitch.toFixed(3),
  ].join(':');
}

/**
 * World position under the center of the viewport, or null when the view has no
 * target. Each stage of the cascade is validated before it is accepted: a depth
 * pick over empty sky can return a NaN or center-of-the-earth Cartesian, and
 * converting one of those throws deep inside Cesium. A degenerate pick is a
 * MISSED pick, so it falls through to the next stage rather than poisoning
 * every caller downstream.
 */
export function getViewTargetCartesian(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const center = new Cesium.Cartesian2(width / 2, height / 2);
  let position = null;

  if (scene.pickPositionSupported && typeof scene.pickPosition === 'function') {
    try {
      position = scene.pickPosition(center);
    } catch {
      position = null;
    }
  }

  if (
    !isPickedWorldPosition(position) &&
    viewer.camera &&
    typeof viewer.camera.pickEllipsoid === 'function'
  ) {
    try {
      position = viewer.camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
    } catch {
      position = null;
    }
  }

  if (
    !isPickedWorldPosition(position) &&
    viewer.camera &&
    typeof viewer.camera.getPickRay === 'function'
  ) {
    try {
      const ray = viewer.camera.getPickRay(center);
      position = scene.globe?.pick(ray, scene) || null;
    } catch {
      position = null;
    }
  }

  return isPickedWorldPosition(position) ? position : null;
}

export function sampleViewportCartographics(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  if (!width || !height) return [];

  const points = [
    [0.5, 0.5],
    [0.25, 0.35],
    [0.75, 0.35],
    [0.25, 0.65],
    [0.75, 0.65],
    [0.5, 0.25],
    [0.5, 0.75],
  ];

  const samples = [];
  for (const [x, y] of points) {
    const cartesian = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(width * x, height * y),
      Cesium.Ellipsoid.WGS84,
    );
    if (!isPickedWorldPosition(cartesian)) continue;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) continue;
    samples.push({
      latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(4)),
      longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(4)),
    });
  }
  return samples;
}

/** Voice action `fly_to_location`. */
export async function handleFlyToLocation(ctx) {
  const {
    viewer,
    styleManager,
    dataManager,
    placeSearch,
    searchNavigation,
    args,
    runOptions,
  } = ctx;
  return flyToRequestedLocation(viewer, args, {
    placeSearch,
    searchNavigation,
    signal: runOptions.signal,
    runImmediate:
      typeof styleManager?.runImmediateLocationNavigation === 'function'
        ? (navigate) => styleManager.runImmediateLocationNavigation(navigate)
        : null,
    beginDeferred:
      typeof styleManager?.beginDeferredLocationNavigation === 'function'
        ? () => styleManager.beginDeferredLocationNavigation()
        : null,
    reassertDeferred:
      typeof styleManager?.reassertDeferredLocationNavigation === 'function'
        ? (generation) =>
            styleManager.reassertDeferredLocationNavigation(generation)
        : null,
    onStart: () => {
      if (typeof styleManager?.beginLocationNavigation === 'function') {
        styleManager.beginLocationNavigation();
        return;
      }
      interruptCameraMotion('nav:fly_to_location');
      if (viewer.trackedEntity) stopAllTracking(viewer, dataManager);
    },
  });
}

/** Voice action `adjust_camera_zoom`. */
export async function handleAdjustCameraZoom(ctx) {
  const { viewer, args } = ctx;
  return adjustCameraZoom(viewer, args);
}

/** Voice action `zoom_to_globe`. */
export async function handleZoomToGlobe(ctx) {
  const { viewer, styleManager } = ctx;
  if (typeof styleManager?.resetToGlobeView === 'function') {
    return styleManager.resetToGlobeView();
  }
  const result = flyToGlobeView(viewer);
  return {
    ok: true,
    action: 'zoom_to_globe',
    heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
    centeredOn: {
      latitude: Number(result.latitude.toFixed(2)),
      longitude: Number(result.longitude.toFixed(2)),
    },
  };
}

/** Voice action `next_satellite_pass`. */
export async function handleNextSatellitePass(ctx) {
  const { viewer, dataManager, args } = ctx;
  return nextSatellitePass(viewer, dataManager, args);
}

/** Voice action `next_iss_pass`. */
export async function handleNextIssPass(ctx) {
  const { viewer, dataManager, args } = ctx;
  return nextIssPass(viewer, dataManager, args);
}

/** Voice action `move_camera`. */
export async function handleMoveCamera(ctx) {
  const { styleManager, args } = ctx;
  return moveCamera(args, (navigate, releaseOptions) =>
    runManagedVoiceNavigation(
      styleManager,
      'camera',
      'move_camera',
      navigate,
      releaseOptions,
    ),
  );
}

/** Voice action `fly_route`. */
export async function handleFlyRoute(ctx) {
  const { styleManager, annotations, floorServices, args } = ctx;
  return flyRoute(
    annotations?.list?.() || [],
    args,
    (lat, lon) => floorServices.cachedGroundFloor(lat, lon),
    (navigate) =>
      runManagedVoiceNavigation(styleManager, 'route', 'fly_route', navigate),
    (cells) => floorServices.warmGroundFloor(cells),
  );
}

/** Action name → handler for this domain. */
export const SPATIAL_ACTIONS = Object.freeze({
  fly_to_location: handleFlyToLocation,
  adjust_camera_zoom: handleAdjustCameraZoom,
  zoom_to_globe: handleZoomToGlobe,
  next_satellite_pass: handleNextSatellitePass,
  next_iss_pass: handleNextIssPass,
  move_camera: handleMoveCamera,
  fly_route: handleFlyRoute,
});
