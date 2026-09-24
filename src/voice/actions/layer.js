/**
 * Layer actions: data layer visibility, map stacks, CCTV and radio.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import { readLayerLifecycleSummary } from '../layerSummary.js';
import { CITY_POIS } from '../../locations.js';
import { CCTV_FOCUS_RESULT } from '../../layers/cctv/index.js';
import { unavailablePlaceSearch } from '../../search/placeSearch.js';
import { normalizeRadioCountryInput } from '../../data/radioCountry.js';
import {
  normalizeLayerId,
  normalizeLocationId,
  normalizeStackId,
} from './vocabulary.js';
import { setPanelOpen } from './scene.js';

/** Voice CCTV control over the cctv layer module's public surface. */
export async function controlCctv(dataManager, args = {}, styleManager = null) {
  const action = String(args.action || '').toLowerCase();
  const cctv = dataManager.layers.get('cctv')?.module;
  if (!cctv) {
    return {
      ok: false,
      action: 'control_cctv',
      error: 'CCTV layer unavailable',
    };
  }

  if (action === 'enable' || action === 'disable') {
    await dataManager.setEnabled('cctv', action === 'enable', {
      origin: 'voice',
    });
    return {
      ok: true,
      action: 'control_cctv',
      enabled: dataManager.isEnabled('cctv'),
    };
  }
  if (!dataManager.isEnabled('cctv')) {
    return {
      ok: false,
      action: 'control_cctv',
      error: 'CCTV layer is off — enable it first',
    };
  }

  const summarize = () => {
    const ui = cctv.getUIState?.() || {};
    return {
      activeCameraId: ui.activeCameraId || null,
      activeCamera: ui.activeCamera?.name || ui.activeCamera?.id || null,
      cameraCount: Array.isArray(ui.cameras)
        ? ui.cameras.length
        : ui.count || 0,
      showCoverage: !!ui.showCoverage,
      coverageMode: ui.coverageMode || (ui.showCoverage ? 'on' : 'off'),
      showProjection: !!ui.showProjection,
      calibrationMode: !!ui.calibrationMode,
      autoHop: !!ui.autoHop,
    };
  };

  if (action === 'select') {
    const query = String(args.cameraQuery || '')
      .trim()
      .toLowerCase();
    if (!query) throw new Error('control_cctv select needs cameraQuery');
    const cams = cctv.getUIState?.()?.cameras || [];
    const match =
      cams.find((cam) => String(cam.id || '').toLowerCase() === query) ||
      cams.find((cam) => String(cam.name || '').toLowerCase() === query) ||
      cams.find((cam) =>
        String(cam.name || '')
          .toLowerCase()
          .includes(query),
      );
    if (!match) {
      return {
        ok: false,
        action: 'control_cctv',
        error: `No camera matched "${args.cameraQuery}"`,
        ...summarize(),
      };
    }
    styleManager?.supersedeDeferredNavigation?.();
    const selected = cctv.selectCamera(match.id);
    const focusResult = selected
      ? cctv.focusCamera(match.id, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      selected: match.name || match.id,
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!selected }),
    };
  }
  if (action === 'next' || action === 'prev') {
    styleManager?.supersedeDeferredNavigation?.();
    const nextId = cctv.cycleCamera(action === 'next' ? 1 : -1);
    const focusResult = nextId
      ? cctv.focusCamera(nextId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nextId }),
    };
  }
  if (action === 'nearest') {
    styleManager?.supersedeDeferredNavigation?.();
    const nearestId = cctv.focusNearest({ focus: false });
    const focusResult = nearestId
      ? cctv.focusCamera(nearestId, 1.8)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult, { cameraSelected: !!nearestId }),
    };
  }
  if (action === 'focus') {
    const activeId = cctv.getUIState?.()?.activeCameraId;
    if (activeId) styleManager?.supersedeDeferredNavigation?.();
    const focusResult = activeId
      ? cctv.focusCamera(activeId)
      : CCTV_FOCUS_RESULT.NO_ACTIVE_CAMERA;
    return {
      action: 'control_cctv',
      ...summarize(),
      ...cctvVoiceFocusOutcome(focusResult),
    };
  }
  if (action === 'viewshed') {
    // Color-coded coverage volumes; enabled:false drops back to plain
    // coverage wireframes (not off — "hide coverage" is the coverage action).
    const next =
      typeof args.enabled === 'boolean' && !args.enabled ? 'on' : 'viewshed';
    dataManager.setLayerParams(
      'cctv',
      { coverageMode: next },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'adjust') {
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean'
        ? args.enabled
        : !current.calibrationMode;
    dataManager.setLayerParams(
      'cctv',
      { calibrationMode: next },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'coverage') {
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean' ? args.enabled : !current.showCoverage;
    dataManager.setLayerParams(
      'cctv',
      { coverageMode: next ? 'on' : 'off' },
      { origin: 'voice' },
    );
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  if (action === 'projection' || action === 'autohop') {
    const key = action === 'projection' ? 'showProjection' : 'autoHop';
    const current = summarize();
    const next =
      typeof args.enabled === 'boolean' ? args.enabled : !current[key];
    dataManager.setLayerParams('cctv', { [key]: next }, { origin: 'voice' });
    return { ok: true, action: 'control_cctv', ...summarize() };
  }
  throw new Error(`Unknown CCTV action: ${args.action || 'missing'}`);
}

/**
 * Maps a CCTV focus code to an honest voice-tool result.
 * @param {string|boolean} focusResult CCTV focus result code.
 * @param {Object} [options]
 * @param {boolean} [options.cameraSelected=false] Whether this action first selected a camera.
 * @returns {{ok: boolean, error: string|null}} Voice-facing result fields.
 */
export function cctvVoiceFocusOutcome(
  focusResult,
  { cameraSelected = false } = {},
) {
  if (focusResult === CCTV_FOCUS_RESULT.FOCUSED || focusResult === true) {
    return { ok: true, error: null };
  }
  if (focusResult === CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; tracking holds the view — say untrack to fly'
        : 'Camera active; tracking holds the view — say untrack first',
    };
  }
  if (focusResult === CCTV_FOCUS_RESULT.COCKPIT_ACTIVE) {
    return {
      ok: false,
      error: cameraSelected
        ? 'Camera selected; in cockpit — exit cockpit to fly to it'
        : 'In cockpit — exit cockpit to fly to a camera',
    };
  }
  return { ok: false, error: 'No active camera to focus' };
}

export const RADIO_COUNTRY_CENTERS = new Map([
  ['us', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  ['usa', { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' }],
  [
    'united states',
    { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' },
  ],
  [
    'united states of america',
    { lat: 39.8, lon: -98.6, country: 'US', label: 'United States' },
  ],
]);

/** Resolve curated cities and common country requests without moving the camera. */
export function knownRadioLocation(query, locationId = '') {
  const requestedId =
    normalizeLocationId(locationId) || normalizeLocationId(query);
  const city = requestedId ? CITY_POIS[requestedId] : null;
  if (city) {
    const bounds = city.viewBounds;
    return {
      lat: bounds
        ? (bounds.southwest.lat + bounds.northeast.lat) / 2
        : city.pois[0]?.lat,
      lon: bounds
        ? (bounds.southwest.lng + bounds.northeast.lng) / 2
        : city.pois[0]?.lon,
      label: city.name,
      country: '',
    };
  }
  return (
    RADIO_COUNTRY_CENTERS.get(
      String(query || '')
        .trim()
        .toLowerCase(),
    ) || null
  );
}

export function radioCoordinatePair(args = {}) {
  const latitudeProvided = Object.hasOwn(args, 'latitude');
  const longitudeProvided = Object.hasOwn(args, 'longitude');
  const provided = latitudeProvided || longitudeProvided;
  const latitude = args.latitude;
  const longitude = args.longitude;
  const valid =
    latitudeProvided &&
    longitudeProvided &&
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  return { provided, valid, latitude, longitude };
}

export function radioActionIsCurrent(options = {}) {
  return (
    !options.signal?.aborted &&
    (typeof options.isCurrent !== 'function' || options.isCurrent())
  );
}

export function radioAbortError() {
  const error = new Error('Radio request was superseded by a newer voice turn');
  error.name = 'AbortError';
  return error;
}

export async function resolveRadioLocation(
  args = {},
  coordinates = radioCoordinatePair(args),
  options = {},
) {
  if (!radioActionIsCurrent(options)) throw radioAbortError();
  if (coordinates.valid) {
    const { latitude, longitude } = coordinates;
    return {
      lat: latitude,
      lon: longitude,
      label: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`,
      country: '',
    };
  }
  const query = String(args.locationQuery || '').trim();
  const known = knownRadioLocation(query, args.locationId);
  if (known) return known;
  if (!query) return null;
  const { placeSearch = unavailablePlaceSearch, signal } = options;
  const { place } = await placeSearch.geocode(query, { signal });
  if (!radioActionIsCurrent(options)) throw radioAbortError();
  if (!place) return null;
  // Localized provider country labels must not become station country filters.
  return {
    lat: place.lat,
    lon: place.lng,
    label: place.label || query,
    country: '',
  };
}

/** Voice Radio controls over the Radio layer's public player surface. */
export async function controlRadio(
  viewer,
  dataManager,
  args = {},
  options = {},
) {
  const requestedAction = String(args.action || '')
    .trim()
    .toLowerCase();
  const coordinates = radioCoordinatePair(args);
  const hasSelectionCriteria = Boolean(
    args.category ||
    args.locationId ||
    args.locationQuery ||
    coordinates.provided ||
    args.country ||
    args.stationQuery,
  );
  // Realtime models can reasonably interpret "play news near Austin" as Play
  // plus qualifiers. Play cannot honor those qualifiers, so normalize that
  // equivalent tool shape to Select instead of silently choosing the current
  // viewport's nearest station.
  const action =
    requestedAction === 'play' && hasSelectionCriteria
      ? 'select'
      : requestedAction;

  const readRadioLifecycle = () =>
    readLayerLifecycleSummary(dataManager, 'radio');

  const radio = dataManager.layers.get('radio')?.module;
  if (!radio) {
    return {
      ok: false,
      action: 'control_radio',
      error: 'Radio layer unavailable',
      ...readRadioLifecycle(),
    };
  }
  const normalizedCountry = normalizeRadioCountryInput(args.country);
  let lastIntentOutcome = null;
  let lastIntentError = null;

  const intentSummary = () =>
    lastIntentOutcome
      ? {
          phase: lastIntentOutcome.phase,
          cancellationReason: lastIntentOutcome.cancellationReason || null,
          successorIntentEpoch: lastIntentOutcome.successorIntentEpoch ?? null,
          successorEnabled: lastIntentOutcome.successorEnabled ?? null,
          successorOrigin: lastIntentOutcome.successorOrigin ?? null,
        }
      : {};

  const cancelled = (summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: true,
    error: 'Radio request was superseded by a newer voice turn',
    ...intentSummary(),
    ...summarize(),
  });

  const radioLifecycleIsSettled = (shouldEnable) => {
    const lifecycle = readRadioLifecycle();
    return (
      lifecycle.enabled === shouldEnable &&
      lifecycle.lifecycleState === (shouldEnable ? 'enabled' : 'disabled') &&
      !lifecycle.lifecycleUncertain
    );
  };

  const setRadioEnabled = async (shouldEnable) => {
    lastIntentOutcome = null;
    lastIntentError = null;
    if (!radioActionIsCurrent(options)) return false;
    const enableOptions = { origin: 'voice' };
    // Both lifecycle directions can await module work. Let the manager own
    // the complete transaction so barge-in cancels it before a settled
    // visibility event can record explicit Context intent.
    if (options.signal) enableOptions.signal = options.signal;
    let result = false;
    try {
      if (typeof dataManager._setEnabledWithIntent === 'function') {
        const intent = dataManager._setEnabledWithIntent(
          'radio',
          shouldEnable,
          enableOptions,
        );
        result = await intent.promise;
        if (Number.isInteger(intent.intentEpoch)) {
          lastIntentOutcome = await dataManager._waitForVisibilityIntent?.(
            'radio',
            intent.intentEpoch,
          );
        }
      } else {
        result = await dataManager.setEnabled(
          'radio',
          shouldEnable,
          enableOptions,
        );
      }
    } catch (error) {
      lastIntentError = error;
      return false;
    }
    if (lastIntentOutcome?.succeeded === false) return false;
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true)
      return false;
    return result !== false && radioLifecycleIsSettled(shouldEnable);
  };

  const lifecycleFailure = (message, summarize) => ({
    ok: false,
    action: 'control_radio',
    cancelled: Boolean(lastIntentOutcome?.cancellationReason),
    error: lastIntentError?.message || message,
    ...intentSummary(),
    ...summarize(),
  });

  const authorizeRadioPlayerMutation = async ({ enableIfOff = false } = {}) => {
    const lifecycle = readRadioLifecycle();
    if (radioLifecycleIsSettled(true)) return true;
    if (
      !enableIfOff &&
      !lifecycle.enabled &&
      lifecycle.lifecycleState === 'disabled' &&
      !lifecycle.lifecycleUncertain
    )
      return false;
    const reconciled = await setRadioEnabled(true);
    return reconciled && radioLifecycleIsSettled(true);
  };

  const summarize = () => {
    const state = radio.getUIState?.() || {};
    return {
      radioAction: action,
      ...readRadioLifecycle(),
      stationId: state.selected?.id || null,
      category: state.filter || 'all',
      audioState: state.audioState || 'stopped',
      volumePct: Math.round((state.volume ?? 0.8) * 100),
      mutedForVoice: Boolean(state.voiceDucked),
    };
  };

  if (!normalizedCountry.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error:
        'Radio country must be a recognized code or country name (80 characters maximum)',
      ...summarize(),
    };
  }

  if (coordinates.provided && !coordinates.valid) {
    return {
      ok: false,
      action: 'control_radio',
      error:
        'Radio coordinates require a complete numeric latitude/longitude pair in range',
      ...summarize(),
    };
  }

  if (!radioActionIsCurrent(options)) return cancelled(summarize);

  if (action === 'enable' || action === 'disable') {
    const shouldEnable = action === 'enable';
    const changed = await setRadioEnabled(shouldEnable);
    if (!radioActionIsCurrent(options) && lastIntentOutcome?.succeeded !== true)
      return cancelled(summarize);
    if (!changed) {
      return lifecycleFailure(
        `Radio could not be ${shouldEnable ? 'enabled' : 'disabled'}`,
        summarize,
      );
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'status')
    return { ok: true, action: 'control_radio', ...summarize() };
  if (action === 'volume') {
    const volumePct = Number(args.volumePct);
    if (!Number.isFinite(volumePct) || volumePct < 0 || volumePct > 100) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio volume must be from 0 to 100',
        ...summarize(),
      };
    }
    const authorized = await authorizeRadioPlayerMutation();
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (!authorized) {
      return lifecycleFailure(
        'Radio must be fully enabled before changing volume',
        summarize,
      );
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const volumeApplied =
      typeof dataManager.setLayerParams === 'function'
        ? dataManager.setLayerParams(
            'radio',
            { volume: volumePct / 100 },
            { origin: 'voice' },
          )
        : radio.setVolume(volumePct / 100);
    if (volumeApplied === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio must be fully enabled before changing volume',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'stop') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    let stopped = false;
    try {
      stopped = await radio.stopPlayback({ origin: 'voice' });
    } catch (error) {
      return {
        ok: false,
        action: 'control_radio',
        error: error?.message || 'Radio could not be stopped',
        ...summarize(),
      };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (stopped === false) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be stopped',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', ...summarize() };
  }
  if (action === 'pause') {
    // Pause is a playback-only control. In particular, a Pause sibling must
    // never resurrect a layer that an explicit Disable just turned off. Keep
    // its established cancellation authority while an enable is in flight:
    // the controller commits a successful Pause by aborting that older work.
    const lifecycle = readRadioLifecycle();
    if (!lifecycle.enabled && lifecycle.lifecycleState !== 'enabling') {
      return {
        ok: true,
        action: 'control_radio',
        changed: false,
        ...summarize(),
      };
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const paused = radio.pause?.({ origin: 'voice' }) || false;
    if (!paused) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'Radio could not be paused',
        ...summarize(),
      };
    }
    return { ok: true, action: 'control_radio', changed: true, ...summarize() };
  }
  let resolvedLocation = null;
  if (action === 'select') {
    try {
      // Resolve asynchronous user input before enabling Radio. That keeps an
      // interrupted lookup from mutating layer or station state after barge-in.
      resolvedLocation = await resolveRadioLocation(args, coordinates, options);
    } catch (error) {
      if (error?.name === 'AbortError' || !radioActionIsCurrent(options))
        return cancelled(summarize);
      throw error;
    }
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if ((args.locationQuery || args.locationId) && !resolvedLocation) {
      return {
        ok: false,
        action: 'control_radio',
        error: `Could not resolve Radio location "${args.locationQuery || args.locationId}"`,
        ...summarize(),
      };
    }
  }
  const authorized = await authorizeRadioPlayerMutation({ enableIfOff: true });
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!authorized) {
    return lifecycleFailure('Radio could not be enabled', summarize);
  }
  const state = radio.getUIState?.() || {};
  if (!radioActionIsCurrent(options)) return cancelled(summarize);
  if (!state.stationCount) {
    return {
      ok: false,
      action: 'control_radio',
      error: state.error || 'No healthy Radio stations are available',
      ...summarize(),
    };
  }
  if (action === 'play' || action === 'resume') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const prepared = state.selected
      ? true
      : radio.cycleStation?.(1, { focus: false, autoplay: false });
    return {
      ok: Boolean(prepared),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(prepared),
      ...summarize(),
    };
  }
  if (action === 'next' || action === 'previous') {
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    if (args.category) {
      if (typeof dataManager.setLayerParams === 'function') {
        dataManager.setLayerParams(
          'radio',
          { filter: String(args.category) },
          { origin: 'voice' },
        );
      } else {
        radio.setFilter(String(args.category));
      }
    }
    const selected = radio.cycleStation?.(action === 'next' ? 1 : -1, {
      focus: false,
      autoplay: false,
    });
    return {
      ok: Boolean(selected),
      action: 'control_radio',
      radioPlaybackRequested: Boolean(selected),
      ...summarize(),
    };
  }
  if (action === 'select') {
    const location = resolvedLocation;
    if (!radioActionIsCurrent(options)) return cancelled(summarize);
    const station = radio.selectRequestedStation?.(
      {
        categoryId: String(args.category || 'all'),
        anchor: location ? { lat: location.lat, lon: location.lon } : null,
        country: normalizedCountry.empty
          ? String(location?.country || '')
          : normalizedCountry.code,
        stationQuery: String(args.stationQuery || ''),
      },
      { autoplay: false },
    );
    if (!station) {
      return {
        ok: false,
        action: 'control_radio',
        error: 'No Radio station matched that location and category',
        ...summarize(),
      };
    }
    return {
      ok: true,
      action: 'control_radio',
      radioPlaybackRequested: true,
      requestedLocation: location?.label || null,
      ...summarize(),
    };
  }
  throw new Error(`Unknown Radio action: ${args.action || 'missing'}`);
}

export function focusDataLayerRow(layerId) {
  const row = document.querySelector(
    `#data-toggles [data-layer-id="${CSS.escape(layerId)}"]`,
  );
  if (!row) return null;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('gev-voice-focus');
  void row.offsetWidth;
  row.classList.add('gev-voice-focus');
  window.setTimeout(() => row.classList.remove('gev-voice-focus'), 3000);
  const name = row.querySelector('.data-name')?.textContent?.trim() || layerId;
  return { id: layerId, name };
}

/** Voice action `set_layer_visibility`. */
export async function handleSetLayerVisibility(ctx) {
  const { styleManager, dataManager, _layerEnabledAt, args, runOptions } = ctx;
  const layerId = normalizeLayerId(args.layerId);
  if (!layerId) {
    throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
  }
  if (!dataManager.layers.has(layerId)) {
    if (layerId === 'radio') {
      return {
        ok: false,
        action: 'set_layer_visibility',
        layerId,
        error: 'Radio layer unavailable',
        ...readLayerLifecycleSummary(dataManager, layerId),
      };
    }
    throw new Error(`Unknown data layer: ${args.layerId || 'missing'}`);
  }
  const enabled = Boolean(args.enabled);
  const changeOptions = { origin: 'voice' };
  if (runOptions.signal) changeOptions.signal = runOptions.signal;
  let changed = false;
  let changeError = null;
  let intentOutcome = null;
  try {
    if (typeof dataManager._setEnabledWithIntent === 'function') {
      const intent = dataManager._setEnabledWithIntent(
        layerId,
        enabled,
        changeOptions,
      );
      changed = await intent.promise;
      if (Number.isInteger(intent.intentEpoch)) {
        intentOutcome = await dataManager._waitForVisibilityIntent?.(
          layerId,
          intent.intentEpoch,
        );
      }
    } else {
      changed = await dataManager.setEnabled(layerId, enabled, changeOptions);
    }
    if (layerId === 'rocket-launches' || layerId === 'satellites') {
      await styleManager?._waitForContextLayerSettlement?.();
    }
  } catch (error) {
    changeError = error;
  }
  const lifecycleSummary = readLayerLifecycleSummary(dataManager, layerId);
  if (intentOutcome?.succeeded === false && intentOutcome.cancellationReason) {
    return {
      ok: false,
      action: 'set_layer_visibility',
      layerId,
      cancelled: true,
      phase: intentOutcome.phase,
      cancellationReason: intentOutcome.cancellationReason,
      successorIntentEpoch: intentOutcome.successorIntentEpoch,
      successorEnabled: intentOutcome.successorEnabled,
      successorOrigin: intentOutcome.successorOrigin,
      ...lifecycleSummary,
    };
  }
  const intentCommitted = intentOutcome?.succeeded === true;
  const current =
    !runOptions.signal?.aborted &&
    (typeof runOptions.isCurrent !== 'function' || runOptions.isCurrent());
  if (!current && !intentCommitted) {
    return {
      ok: false,
      action: 'set_layer_visibility',
      layerId,
      cancelled: true,
      error: 'Layer request was superseded by a newer voice turn',
      ...lifecycleSummary,
    };
  }
  const settledEnabled = lifecycleSummary.enabled;
  const lifecycleSettled =
    lifecycleSummary.lifecycleState === (enabled ? 'enabled' : 'disabled') &&
    !lifecycleSummary.lifecycleUncertain;
  if (changeError) {
    return {
      ok: false,
      action: 'set_layer_visibility',
      layerId,
      error:
        changeError?.message ||
        `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
      ...lifecycleSummary,
    };
  }
  if (changed === false || settledEnabled !== enabled || !lifecycleSettled) {
    return {
      ok: false,
      action: 'set_layer_visibility',
      layerId,
      error: `Could not ${enabled ? 'enable' : 'disable'} the requested layer`,
      ...lifecycleSummary,
    };
  }
  if (enabled) _layerEnabledAt.set(layerId, Date.now());
  const layer = dataManager.getAll().find((item) => item.id === layerId);
  return {
    ok: true,
    action: 'set_layer_visibility',
    layerId,
    label: layer?.name || layerId,
    ...lifecycleSummary,
  };
}

/** Voice action `show_data_layers_menu`. */
export async function handleShowDataLayersMenu(ctx) {
  const { styleManager, dataManager, args, name } = ctx;
  const layerId = normalizeLayerId(args.layerId || args.layer);
  setPanelOpen(styleManager, 'data-panel', true);
  const focusedLayer =
    layerId && dataManager.layers.has(layerId)
      ? focusDataLayerRow(layerId)
      : null;
  return {
    ok: true,
    action: 'show_data_layers_menu',
    panelId: 'data-panel',
    focusedLayer,
    layers: dataManager
      .getAll()
      .filter((layer) => layer.showInTogglePanel !== false)
      .map((layer) => ({
        id: layer.id,
        name: layer.name,
        enabled: layer.enabled,
        count: layer.stats?.count || 0,
      })),
  };
}

/** Voice action `set_map_stack`. */
export async function handleSetMapStack(ctx) {
  const { styleManager, args } = ctx;
  const stackId = normalizeStackId(args.stack);
  if (!stackId)
    throw new Error(`Unknown map stack: ${args.stack || 'missing'}`);
  const result = await styleManager.setMapStack(stackId);
  return { action: 'set_map_stack', requested: stackId, ...result };
}

/** Voice action `control_cctv`. */
export async function handleControlCctv(ctx) {
  const { styleManager, dataManager, args } = ctx;
  return controlCctv(dataManager, args, styleManager);
}

/** Voice action `control_radio`. */
export async function handleControlRadio(ctx) {
  const { viewer, dataManager, placeSearch, args, runOptions } = ctx;
  return controlRadio(viewer, dataManager, args, {
    ...runOptions,
    placeSearch,
  });
}

/** Action name → handler for this domain. */
export const LAYER_ACTIONS = Object.freeze({
  set_layer_visibility: handleSetLayerVisibility,
  show_data_layers_menu: handleShowDataLayersMenu,
  set_map_stack: handleSetMapStack,
  control_cctv: handleControlCctv,
  control_radio: handleControlRadio,
});
