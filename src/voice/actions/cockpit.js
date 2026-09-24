/**
 * Cockpit actions: tracking, cockpit control and overhead framing.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import * as Cesium from 'cesium';
import { flyToLandmark } from '../../locations.js';
import { getSelectedEntityContext } from '../../data/contextStore.js';
import { createAnalystEngine } from '../../data/analystEngine.js';
import { layerFeedState } from '../../data/feedState.js';
import {
  getViewTargetCartesian,
  runManagedVoiceNavigation,
} from './spatial.js';
import {
  FRAME_TARGETS,
  TRACKABLE_FAMILIES,
  clampNumber,
  normalizeAircraftClassFilter,
  normalizeCockpitAction,
  normalizeCockpitNavigationHints,
  normalizeCockpitTargetLayer,
  normalizeLayerId,
  withContextModeVocabulary,
} from './vocabulary.js';
import { analystProviders } from './analyst.js';

export function selectedCockpitTarget(dataManager) {
  const selected = getSelectedEntityContext({ dataManager });
  if (!selected || !['flights', 'military'].includes(selected.layerId))
    return null;
  const module = dataManager?.layers?.get(selected.layerId)?.module;
  if (!module?.trackById || typeof module.trackById !== 'function') return null;
  const id = String(selected.id || '').trim();
  return id ? { layerId: selected.layerId, id } : null;
}

/**
 * Spoken name for a tracked entity descriptor.
 *
 * Aircraft follow the flight layers' label convention — callsign →
 * registration → icao24 — so the narrated name matches the readout and the
 * detection card instead of speaking a raw hex at a contact the UI is calling
 * `N123AB`. Vessels and satellites carry no `registration`, so that link
 * simply falls through to their own name/mmsi/noradId links.
 * @param {object} found - Layer descriptor from `findByQuery`.
 * @param {string} query - The spoken query, used as the last resort.
 * @returns {string} A non-empty display name.
 */
export function formatTrackedEntityLabel(found, query = '') {
  const text = (v) => String(v ?? '').trim();
  return (
    text(found?.callsign) ||
    text(found?.registration) ||
    text(found?.name) ||
    text(found?.icao24) ||
    text(found?.mmsi) ||
    text(found?.noradId) ||
    String(query)
  );
}

/** Finds and tracks/selects an entity by spoken query across layer families. */
export async function trackEntity(
  viewer,
  dataManager,
  styleManager,
  args = {},
) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('track_entity needs a query');

  // Fire queries route to the FIRMS layer's strongest detection
  if (/\bfires?\b/i.test(query)) {
    if (!dataManager.isEnabled('local-firms')) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'The FIRMS fires layer is not enabled',
      };
    }
    const firms = dataManager.layers.get('local-firms')?.module;
    const strongest = firms?.getStrongestFire?.();
    if (!strongest) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'No fire detections loaded yet',
      };
    }
    if (
      !Number.isFinite(strongest.latitude) ||
      !Number.isFinite(strongest.longitude)
    ) {
      return {
        ok: false,
        action: 'track_entity',
        query,
        error: 'The strongest fire has no usable position',
      };
    }
    return runManagedVoiceNavigation(
      styleManager,
      'fire',
      'track_entity',
      () => {
        flyToLandmark(viewer, strongest.latitude, strongest.longitude, {
          range: 14000,
          pitch: -50,
          heading: 0,
          buildingHeight: 0,
          duration: 2.2,
        });
        return {
          ok: true,
          action: 'track_entity',
          kind: 'fire',
          layerId: 'local-firms',
          label: strongest.label || 'Strongest fire',
          latitude: strongest.latitude,
          longitude: strongest.longitude,
          frp: strongest.frp ?? null,
        };
      },
    );
  }

  const requested = args.layerId ? normalizeLayerId(args.layerId) : null;
  const families = TRACKABLE_FAMILIES.filter(
    (family) => !requested || family.layerId === requested,
  );
  const skippedDisabled = [];

  for (const family of families) {
    if (!dataManager.isEnabled(family.layerId)) {
      skippedDisabled.push(family.layerId);
      continue;
    }
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module || typeof module.findByQuery !== 'function') continue;
    const found = module.findByQuery(query);
    if (!found) continue;

    if (
      family.kind === 'vessel' &&
      (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude))
    ) {
      return {
        ok: false,
        action: 'track_entity',
        layerId: family.layerId,
        kind: family.kind,
        error: 'The matched vessel has no usable position',
      };
    }

    return runManagedVoiceNavigation(
      styleManager,
      family.kind,
      'track_entity',
      () => {
        let trackedOk = false;
        if (family.kind === 'vessel') {
          trackedOk = !!module.selectById?.(found.mmsi);
          flyToLandmark(viewer, found.latitude, found.longitude, {
            range: 6000,
            pitch: -45,
            heading: 0,
            buildingHeight: 0,
            duration: 2.0,
          });
        } else if (family.kind === 'satellite') {
          trackedOk = !!module.trackById?.(found.noradId, { origin: 'voice' });
        } else {
          trackedOk = !!module.trackById?.(found.icao24, { origin: 'voice' });
        }

        return {
          ok: trackedOk,
          action: 'track_entity',
          layerId: family.layerId,
          kind: family.kind,
          // Aircraft follow the flight layers' label convention (callsign →
          // registration → icao24) so the spoken name matches what the UI shows;
          // `registration` is absent on vessels/satellites and simply falls
          // through to their own name/id links.
          label: formatTrackedEntityLabel(found, query),
          latitude: found.latitude ?? null,
          longitude: found.longitude ?? null,
          altitudeM: Number.isFinite(found.altitudeM)
            ? Math.round(found.altitudeM)
            : null,
          error: trackedOk ? null : 'Match found but tracking failed',
        };
      },
    );
  }

  const disabledNote = skippedDisabled.length
    ? ` (disabled layers skipped: ${skippedDisabled.join(', ')})`
    : '';
  return {
    ok: false,
    action: 'track_entity',
    query,
    error: `Nothing matched "${query}"${disabledNote}`,
  };
}

/** Releases tracking/selection on every entity layer family. */
export function stopAllTracking(viewer, dataManager) {
  const released = [];
  const failed = new Set();
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      if (family.kind === 'vessel') {
        if (module.getSelectedInfo?.()) {
          if (
            typeof module.clearSelection !== 'function' ||
            module.clearSelection() === false
          ) {
            failed.add(family.layerId);
          } else {
            released.push(family.layerId);
          }
        }
      } else if (module.getTrackedInfo?.()) {
        if (
          typeof module.stopTracking !== 'function' ||
          module.stopTracking({ origin: 'voice' }) === false
        ) {
          failed.add(family.layerId);
        } else {
          released.push(family.layerId);
        }
      }
    } catch {
      failed.add(family.layerId);
    }
  }
  for (const [layerId, key] of [
    ['flights', 'selectedFlightsTrackingId'],
    ['military', 'selectedMilitaryTrackingId'],
    ['satellites', 'selectedSatTrackingId'],
  ]) {
    try {
      if (
        dataManager.setLayerParams(
          layerId,
          { [key]: null },
          { origin: 'voice' },
        ) === false
      ) {
        failed.add(layerId);
      }
    } catch {
      failed.add(layerId);
    }
  }
  if (viewer) viewer.trackedEntity = undefined;
  if (failed.size) {
    const failedLayerIds = [...failed];
    return {
      ok: false,
      action: 'stop_tracking',
      released,
      failedLayerIds,
      error: `Tracking could not be cleared for: ${failedLayerIds.join(', ')}`,
    };
  }
  return { ok: true, action: 'stop_tracking', released };
}

/**
 * Frames entities near the current view target with a cinematic pull-back:
 * oblique high pitch for aircraft/ships, shallow wide pitch for satellites.
 * When entries are found and detection is OFF, auto-enables panoptic
 * detection so the framed entities are labeled, and reports
 * detectionEnabled so the voice agent can mention labels are on.
 */
export async function frameOverhead(
  viewer,
  dataManager,
  styleManager,
  args = {},
) {
  const targetRaw = String(args.target || 'flights').toLowerCase();
  const layerId =
    FRAME_TARGETS.get(targetRaw) || normalizeLayerId(targetRaw) || 'flights';
  if (!dataManager.layers.has(layerId)) {
    return {
      ok: false,
      action: 'frame_overhead',
      error: `Unknown target layer: ${args.target}`,
    };
  }
  if (!dataManager.isEnabled(layerId)) {
    return {
      ok: false,
      action: 'frame_overhead',
      layerId,
      error: `The ${layerId} layer is not enabled`,
    };
  }
  const module = dataManager.layers.get(layerId)?.module;
  const isSatellites = layerId === 'satellites';
  const defaultRadiusKm = isSatellites
    ? 3000
    : layerId === 'ais-live-vessels'
      ? 120
      : 150;
  const radiusKm = clampNumber(args.radiusKm, 10, 20000, defaultRadiusKm);
  const center = getViewTargetCartesian(viewer) || viewer.camera.positionWC;

  let entries = [];
  if (typeof module.getNearby === 'function') {
    entries = module.getNearby(center, radiusKm * 1000, 80) || [];
  } else if (typeof module.getAllPositions === 'function') {
    entries = (module.getAllPositions(800) || [])
      .filter((entry) => entry.position)
      .map((entry) => ({
        ...entry,
        distance: Cesium.Cartesian3.distance(center, entry.position),
      }))
      .filter((entry) => entry.distance <= radiusKm * 1000)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 80);
  }
  if (!entries.length) {
    return {
      ok: false,
      action: 'frame_overhead',
      layerId,
      radiusKm: Math.round(radiusKm),
      count: 0,
      error: `No ${targetRaw} within ${Math.round(radiusKm)} km of the current view`,
    };
  }

  const sphere = Cesium.BoundingSphere.fromPoints(
    entries.map((entry) => entry.position),
  );
  sphere.radius = Math.max(sphere.radius * 1.25, 8000);
  const pitch = Cesium.Math.toRadians(isSatellites ? -35 : -62);
  return runManagedVoiceNavigation(
    styleManager,
    'frame',
    'frame_overhead',
    () => {
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: 2.0,
        offset: new Cesium.HeadingPitchRange(
          viewer.camera.heading,
          pitch,
          sphere.radius * 2.4,
        ),
      });

      let detectionEnabled = false;
      try {
        const detectionState = styleManager?.getDetectionState?.();
        if (detectionState?.detectionMode === 'OFF') {
          const detectionResult = styleManager.setDetection({ mode: 'dense' });
          detectionEnabled = detectionResult?.ok === true;
        } else if (detectionState) {
          detectionEnabled = true;
        }
      } catch {
        // detection facade unavailable; framing still succeeded
      }

      return {
        ok: true,
        action: 'frame_overhead',
        layerId,
        radiusKm: Math.round(radiusKm),
        count: entries.length,
        detectionEnabled,
        nearest: entries.slice(0, 5).map((entry) => ({
          id: entry.id || entry.icao24 || entry.mmsi || null,
          label: entry.label || entry.callsign || entry.name || null,
        })),
      };
    },
  );
}

/** Gathers tracked/selected entities across layer families for read-back. */
export function collectTrackedEntities(dataManager) {
  const tracked = [];
  for (const family of TRACKABLE_FAMILIES) {
    const module = dataManager.layers.get(family.layerId)?.module;
    if (!module) continue;
    try {
      const info =
        family.kind === 'vessel'
          ? module.getSelectedInfo?.()
          : module.getTrackedInfo?.();
      if (info)
        tracked.push({ kind: family.kind, layerId: family.layerId, ...info });
    } catch {
      // layer not ready
    }
  }
  return tracked;
}

/** Voice action `select_nearest_aircraft`. */
export async function handleSelectNearestAircraft(ctx) {
  const {
    viewer,
    styleManager,
    dataManager,
    placeSearch,
    resolveRegionRing,
    args,
    current,
    runOptions,
    name,
  } = ctx;
  const layerId = normalizeLayerId(args.layerId || 'flights');
  if (!['flights', 'military'].includes(layerId)) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      error:
        'Nearest-aircraft selection supports Flights or Military Flights only',
    };
  }
  const hasLocationId = Boolean(String(args.locationId || '').trim());
  const hasLocationQuery = Boolean(String(args.locationQuery || '').trim());
  const hasCoordinates =
    args.latitude != null &&
    args.longitude != null &&
    Number.isFinite(Number(args.latitude)) &&
    Number.isFinite(Number(args.longitude));
  if (!hasLocationId && !hasLocationQuery && !hasCoordinates) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'location',
      error:
        'Nearest-aircraft selection needs a preset, place name, or latitude and longitude',
    };
  }
  const locationArgs = {
    waitForArrival: true,
    ...(args.locationId ? { locationId: args.locationId } : {}),
    ...(args.locationQuery ? { query: args.locationQuery } : {}),
    ...(hasCoordinates
      ? {
          latitude: Number(args.latitude),
          longitude: Number(args.longitude),
        }
      : {}),
  };
  const layer = await ctx.run(
    'set_layer_visibility',
    {
      layerId,
      enabled: true,
    },
    runOptions,
  );
  if (layer?.ok !== true || !current()) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'layer',
      cancelled: !current() || Boolean(layer?.cancelled),
      error: layer?.error || `${layerId} could not be enabled`,
      layer,
    };
  }

  const location = await ctx.run('fly_to_location', locationArgs, runOptions);
  if (location?.ok !== true || !current()) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'location',
      cancelled: !current() || Boolean(location?.cancelled),
      error:
        location?.error ||
        `Could not arrive at ${location?.label || args.locationQuery || args.locationId || 'the requested place'}`,
      location,
      layer,
    };
  }

  const layerModule = dataManager.layers.get(layerId)?.module || null;
  let refreshed = false;
  try {
    if (typeof dataManager.refreshLayer === 'function') {
      refreshed = await dataManager.refreshLayer(layerId, {
        signal: runOptions.signal,
      });
    } else if (typeof layerModule?.update === 'function') {
      refreshed =
        (await layerModule.update(viewer, {
          signal: runOptions.signal,
        })) !== false;
    }
  } catch {
    refreshed = false;
  }
  if (!refreshed || !current()) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'refresh',
      cancelled: !current(),
      error: !current()
        ? 'Nearest-aircraft refresh was cancelled'
        : `${layer.label || layerId} is enabled, but its destination refresh did not complete`,
      location,
      layer,
    };
  }
  const stats = layerModule?.getStats?.() || {};
  const source =
    String(stats.source || layerModule?.source || '').trim() || null;
  const feed = {
    state: layerFeedState({ ...stats, source }),
    source,
    count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : null,
  };

  const nearest = await createAnalystEngine(
    analystProviders(viewer, dataManager, {
      recordLimitByLayer: { [layerId]: Number.MAX_SAFE_INTEGER },
      placeSearch,
      resolveRegionRing,
    }),
  ).query({
    layers: [layerId],
    scope: { kind: 'view' },
    filters: [{ field: 'onGround', op: 'eq', value: false }],
    sortBy: 'distance',
    sortDir: 'asc',
    limit: 1,
  });
  const aircraft = nearest?.items?.[0] || null;
  if (!aircraft || !current()) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'nearest',
      cancelled: !current(),
      error: !current()
        ? 'Nearest-aircraft selection was cancelled'
        : feed.state === 'unavailable'
          ? `${layer.label || layerId} is enabled, but ${feed.source || 'its aircraft feed'} is unavailable`
          : `${layer.label || layerId} is enabled${feed.state === 'fallback' ? ` on the ${feed.source || 'fallback'} feed` : ''}, but no airborne aircraft is loaded in the ${location.label || 'destination'} view yet`,
      location,
      layer,
      feed,
      count: nearest?.count || 0,
    };
  }

  const stableAircraftId = aircraft.icao24 || aircraft.id;
  const selection = await trackEntity(viewer, dataManager, styleManager, {
    query: stableAircraftId,
    layerId,
  });
  if (selection?.ok !== true) {
    return {
      ok: false,
      action: 'select_nearest_aircraft',
      stage: 'selection',
      error:
        selection?.error ||
        'The nearest airborne aircraft could not be selected',
      location,
      layer,
      feed,
      selection,
    };
  }
  return {
    ok: true,
    action: 'select_nearest_aircraft',
    location: location.label,
    layerId,
    label: selection.label,
    feed,
    aircraft: {
      id: stableAircraftId,
      callsign: aircraft.callsign || null,
      altitudeM: aircraft.altitudeM ?? null,
      distanceKm: aircraft.distanceKm ?? null,
      onGround: false,
    },
  };
}

/** Voice action `control_cockpit`. */
export async function handleControlCockpit(ctx) {
  const { styleManager, dataManager, args, current, runOptions } = ctx;
  if (!styleManager?.controlCockpit) {
    return {
      ok: false,
      action: 'control_cockpit',
      error: 'Cockpit control unavailable',
    };
  }
  const rawAction = args.action || args.command;
  const action = normalizeCockpitAction(rawAction);
  const notificationToken = args.notificationToken || null;
  if (!action) {
    return {
      ok: false,
      action: 'control_cockpit',
      error: `Unknown cockpit action: ${args.action || args.command || 'missing'}`,
    };
  }
  const inferred = normalizeCockpitNavigationHints(rawAction);
  const targetLayer = normalizeCockpitTargetLayer(
    args.targetLayer || inferred.targetLayer || args.layer || args.layerId,
  );
  const aircraftClass = normalizeAircraftClassFilter(
    args.aircraftClass ||
      inferred.aircraftClass ||
      args.type ||
      args.filterType,
  );
  let contextChangedForEntry = false;
  let priorContextMode = null;
  let rollbackTarget = null;
  if (action === 'enter' && typeof styleManager.setContextMode === 'function') {
    if (!current()) {
      return {
        ok: false,
        action: 'control_cockpit',
        cancelled: true,
        error: 'Cockpit entry was cancelled before it could run',
        state: styleManager.getCockpitState?.() || null,
      };
    }
    rollbackTarget = styleManager.getAircraftTrackingTarget?.() || null;
    const contextState =
      typeof styleManager.getContextModeState === 'function'
        ? styleManager.getContextModeState()
        : {};
    priorContextMode = contextState?.mode || null;
    const contactsReady =
      contextState?.mode === 'flights' &&
      contextState?.active !== false &&
      contextState?.changing !== true;
    if (!contactsReady) {
      const contextResult = await styleManager.setContextMode('flights', {
        signal: runOptions.signal,
        isCurrent: runOptions.isCurrent,
        // Cockpit entry establishes Contacts as its own precondition. That
        // is internal choreography, not an operator Context request, so it
        // must stay inert: claiming here would cancel a pending shared
        // style/detection restore the operator never overrode.
        claimVisualAuthority: false,
      });
      contextChangedForEntry = contextResult?.ok === true;
      if (contextResult?.ok !== true || !current()) {
        const contextRollback = contextChangedForEntry
          ? await styleManager.setContextMode(priorContextMode, {
              claimVisualAuthority: false,
            })
          : null;
        return {
          ok: false,
          action: 'control_cockpit',
          cancelled: !current() || Boolean(contextResult?.cancelled),
          error:
            contextResult?.error ||
            'Contacts context could not be established for Cockpit entry',
          context: contextResult
            ? withContextModeVocabulary(contextResult)
            : null,
          contextRollback: withContextModeVocabulary(contextRollback),
          state: styleManager.getCockpitState?.() || null,
        };
      }
    }
  }
  // Contacts activation can adopt a newer explicit aircraft selection.
  // Sample only after that transaction settles so an older voice snapshot
  // cannot overwrite the operator's newer choice.
  const selectedTarget =
    action === 'enter' ? selectedCockpitTarget(dataManager) : null;
  let cockpitResult;
  try {
    cockpitResult = await styleManager.controlCockpit(action, {
      notificationToken,
      targetLayer,
      aircraftClass,
      selectedTarget,
      rollbackTarget,
    });
  } catch (error) {
    cockpitResult = {
      ok: false,
      action: 'control_cockpit',
      error: error instanceof Error ? error.message : String(error),
      state: styleManager.getCockpitState?.() || null,
    };
  }
  if (
    action === 'enter' &&
    cockpitResult?.ok !== true &&
    contextChangedForEntry
  ) {
    const contextRollback = await styleManager.setContextMode(
      priorContextMode,
      {
        // Undoing this action's own precondition — still choreography.
        claimVisualAuthority: false,
        ...(current()
          ? {
              signal: runOptions.signal,
              isCurrent: runOptions.isCurrent,
            }
          : {}),
      },
    );
    return {
      ...cockpitResult,
      contextRollback: withContextModeVocabulary(contextRollback),
    };
  }
  return cockpitResult;
}

/** Voice action `track_entity`. */
export async function handleTrackEntity(ctx) {
  const { viewer, styleManager, dataManager, args } = ctx;
  return trackEntity(viewer, dataManager, styleManager, args);
}

/** Voice action `stop_tracking`. */
export async function handleStopTracking(ctx) {
  const { viewer, dataManager } = ctx;
  return stopAllTracking(viewer, dataManager);
}

/** Voice action `frame_overhead`. */
export async function handleFrameOverhead(ctx) {
  const { viewer, styleManager, dataManager, args } = ctx;
  return frameOverhead(viewer, dataManager, styleManager, args);
}

/** Action name → handler for this domain. */
export const COCKPIT_ACTIONS = Object.freeze({
  select_nearest_aircraft: handleSelectNearestAircraft,
  control_cockpit: handleControlCockpit,
  track_entity: handleTrackEntity,
  stop_tracking: handleStopTracking,
  frame_overhead: handleFrameOverhead,
});
