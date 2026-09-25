/**
 * Analyst actions: counting, ranking and filtering loaded contacts.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import {
  layerSnapshot,
  layerSnapshots,
  feedProvenanceEnvelope,
} from '../../data/layerSnapshot.js';
import * as Cesium from 'cesium';
import { createAnalystEngine } from '../../data/analystEngine.js';
import { unavailablePlaceSearch } from '../../search/placeSearch.js';
import * as defaultAnnotationResolver from '../../annotations/annotationResolver.js';
import { centerMatchesSubject } from './context.js';
import { clampNumber } from './vocabulary.js';
import { activityBaselineFor } from './intel.js';

/**
 * Answer an entity-centred "how many aircraft nearby" from the Contacts
 * engine, or null when the question is not that.
 *
 * Applies only when the requested radius centre IS the active Contacts
 * subject: that is precisely the case where the operator can see a number on
 * the panel, so the spoken answer must be that number. Everything else — an
 * explicit region, an arbitrary point, a named place — keeps the general
 * record engine, which is what those questions actually mean.
 * @param {object} args Tool arguments.
 * @param {object} result The general engine's result, reused for scope text.
 * @returns {object|null} A unified-count payload, or null.
 */
export function aircraftProximityWindowForQuery(dataManager, args, result) {
  const scope = args?.scope;
  if (String(scope?.kind || '').toLowerCase() !== 'radius') return null;
  const layers = Array.isArray(args.layers) ? args.layers : [];
  if (!layers.some((layer) => layer === 'flights' || layer === 'military'))
    return null;
  const snapshot = dataManager?.layers
    ?.get('military-awareness')
    ?.module?.getContextSnapshot?.();
  const subject = snapshot?.subject;
  if (!subject?.position) return null;
  // An explicit centre only qualifies when it IS the subject; otherwise the
  // operator asked about somewhere else and must get that answer.
  if (scope.center && !centerMatchesSubject(scope.center, subject.position))
    return null;
  const radiusM = Number.isFinite(scope.km)
    ? scope.km * 1000
    : snapshot.radiusM || 250_000;
  const window = dataManager.layers
    .get('military-awareness')
    .module.collectAircraftProximityWindow(subject.position, {
      radiusM,
      subject,
    });
  if (!window) return null;
  const label = subject.label || subject.id || 'the selected contact';
  const radiusKm = Math.round(radiusM / 1000);
  const wanted = new Set(layers);
  const items = [
    ...(wanted.has('flights')
      ? window.flights.map((item) => ({ ...item, layerKey: 'flights' }))
      : []),
    ...(wanted.has('military')
      ? window.military.map((item) => ({ ...item, layerKey: 'military' }))
      : []),
  ];
  const count = items.length;
  return {
    ok: true,
    action: 'analyst_query',
    count,
    scopeLabel: `within ${radiusKm} km of ${label}`,
    truncated: false,
    items: items
      .slice(0, Math.round(clampNumber(args.limit, 1, 50, 12)))
      .map((item) => ({
        layerKey: item.layerKey,
        id: item.id,
        ...(item.icao24 ? { icao24: item.icao24 } : {}),
        ...(item.callsign ? { callsign: item.callsign } : {}),
        ...(Number.isFinite(item.distance)
          ? { distanceKm: Math.round(item.distance / 100) / 10 }
          : {}),
      })),
    summary: { count },
    coverage: {
      layersQueried: result?.coverage?.layersQueried || [],
      scope: `window:${radiusKm}km@${label}`,
      followUp: false,
      note: 'Contacts window engine — the same computation and cohort the Contacts panel displays, so this count matches the panel exactly — counts cover loaded data; the flights layer loads by viewport.',
    },
    // (D) The answer always says whose window it is and which engine produced it.
    window: {
      engine: 'contacts-window',
      centeredOn: label,
      radiusKm,
      flights: window.flights.length,
      military: window.military.length,
      aircraft: window.aircraft,
    },
    ...(activeContactsWindow(dataManager)
      ? { contactsWindow: activeContactsWindow(dataManager) }
      : {}),
  };
}

/**
 * Analyst query — spoken questions over data already on the client
 * ("how many flights over Texas?", "biggest fire near LA?", "which ships
 * are headed to Oakland?"). The ENGINE (analystEngine.js) does the query
 * logic; this wiring supplies live providers and compacts the result for
 * the voice payload. One engine per runner keeps follow-up memory
 * ("which of those is closest?") scoped to the session.
 */
/** Layers whose loaded set follows the camera, so a loaded count is not a world count. */
export const VIEWPORT_LOADED_LAYERS = new Set(['flights']);

/**
 * The Contacts panel's own counts, or null when Contacts has no subject.
 * Read through the awareness snapshot the panel renders, so the two cannot
 * diverge no matter which surface asks.
 * @returns {object|null} Panel-equivalent window counts.
 */
export function activeContactsWindow(dataManager) {
  try {
    const layer = dataManager?.layers?.get('military-awareness')?.module;
    return (
      layer?.contactsWindowFromSnapshot?.(layer.getContextSnapshot?.()) ?? null
    );
  } catch {
    return null;
  }
}

export function analystProviders(
  viewer,
  dataManager,
  {
    recordLimitByLayer = null,
    placeSearch = unavailablePlaceSearch,
    resolveRegionRing = (name) =>
      defaultAnnotationResolver.resolveRegionRingForQuery(
        name,
        undefined,
        placeSearch,
      ),
  } = {},
) {
  return {
    getRecords(layerKey) {
      const layer = dataManager.layers.get(layerKey);
      if (!layer || !dataManager.isEnabled(layerKey)) return [];
      const mod = layer.module;
      if (typeof mod?.getAnalystRecords !== 'function') return [];
      const requestedLimit = recordLimitByLayer?.[layerKey];
      return Number.isFinite(requestedLimit)
        ? mod.getAnalystRecords(requestedLimit) || []
        : mod.getAnalystRecords() || [];
    },
    getLayerSnapshot(layerKey) {
      const row = dataManager.getAll?.().find((layer) => layer.id === layerKey);
      if (row) return layerSnapshot(row);
      const module = dataManager.layers?.get(layerKey)?.module;
      return layerSnapshot({
        id: layerKey,
        enabled: dataManager.isEnabled?.(layerKey),
        stats: module?.getStats?.() || {},
      });
    },
    getRecordCoverage(layerKey, rows) {
      if (
        !['satellites', 'local-datacenters', 'local-dams'].includes(layerKey)
      ) {
        // Any layer: disclose when the examined records are a sample of more.
        const loaded = dataManager.layers
          .get(layerKey)
          ?.module?.getStats?.().count;
        if (Number.isFinite(loaded) && loaded > rows.length)
          return {
            recordsExamined: rows.length,
            loadedCount: loaded,
            sourceTruncated: true,
          };
        return null;
      }
      const module = dataManager.layers.get(layerKey)?.module;
      const loaded = module?.getStats?.().count;
      return {
        basis: 'bounded-loaded-records',
        recordsExamined: rows.length,
        loadedCount: Number.isFinite(loaded) ? loaded : null,
        sourceTruncated: Number.isFinite(loaded) ? loaded > rows.length : null,
        note: 'Counts and ranks apply only to these examined loaded records, not all satellites or infrastructure; distance is ground great-circle distance.',
      };
    },
    resolveRegionRing,
    /**
     * The active Contacts subject, when there is one — the centre the operator
     * is reasoning about while Contacts is up. Null whenever Contacts is off,
     * so view-centred behaviour is unchanged outside it.
     * @returns {{lat: number, lon: number, label: string|null}|null} Subject centre.
     */
    getContextSubject() {
      const snapshot = dataManager?.layers
        ?.get('military-awareness')
        ?.module?.getContextSnapshot?.();
      const subject = snapshot?.subject;
      if (!subject?.position) return null;
      const carto = Cesium.Cartographic.fromCartesian(subject.position);
      if (!carto) return null;
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        label: subject.label || subject.id || null,
      };
    },
    getViewContext() {
      const carto = viewer.camera.positionCartographic;
      const altKm = carto.height / 1000;
      // View radius scales with altitude: street-level asks stay local,
      // country-level asks sweep wide. Clamped so "in view" is never absurd.
      const viewRadiusKm = Math.max(25, Math.min(2500, altKm * 1.6));
      return {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        viewRadiusKm,
      };
    },
  };
}

export async function runAnalystQuery(
  analystEngine,
  dataManager,
  args = {},
  _layerEnabledAt,
) {
  const result = await analystEngine.query({
    layers: Array.isArray(args.layers) ? args.layers : undefined,
    scope: args.scope,
    filters: Array.isArray(args.filters) ? args.filters : [],
    sortBy: args.sortBy || null,
    sortDir: args.sortDir,
    limit: args.limit,
    followUp: Boolean(args.followUp),
  });
  if (!result.ok)
    return {
      ok: false,
      action: 'analyst_query',
      ...(result.code ? { code: result.code } : {}),
      error: result.error,
      coverage: result.coverage,
    };
  // Compact payload for the voice model: identity + the fields queries sort/
  // filter on. The full record set stays engine-side for follow-ups.
  //
  // `icao24`/`mmsi` ride along because the tool instructions tell the model to
  // hand this result straight to track_entity, and `id` is a DISPLAY label
  // (callsign, else registration, else hex). A callsign-less contact therefore
  // handed track_entity a tail number the lookup could not resolve, and the
  // model burned the turn on retries (owner field session 2026-08-21, 23:48).
  const items = result.items.map((r) => {
    const compact = { layerKey: r.layerKey, id: r.id };
    for (const k of [
      'icao24',
      'mmsi',
      'registration',
      'label',
      'callsign',
      'name',
      'altitudeM',
      'speedMps',
      'speedKts',
      'frp',
      'magnitude',
      'shipType',
      'destination',
      'operator',
      'routeOrigin',
      'routeDestination',
      'aircraftClass',
      'military',
      'onGround',
      'distanceKm',
      'confidence',
      'place',
      'noradId',
      'satelliteClass',
      'group',
      'river',
      'output',
      'capacity',
    ]) {
      if (r[k] !== null && r[k] !== undefined) compact[k] = r[k];
    }
    return compact;
  });
  // Warm-up honesty: a layer enabled seconds ago hasn't finished its first
  // poll (entity layers render one interval behind live BY DESIGN) — tell the
  // model so a low count is narrated as "still loading", not as fact.
  const warming = (result.coverage?.layersQueried || [])
    .filter((l) => {
      const at = _layerEnabledAt.get(l.layerKey);
      return at && Date.now() - at < 45_000;
    })
    .map((l) => l.layerKey);
  if (warming.length) {
    result.coverage.warmup = `${warming.join(', ')} enabled moments ago — data is still loading; counts will rise for ~30-45s. Say so.`;
  }
  // A radius/view count over a viewport-loaded layer counts what is LOADED, and
  // the flights layer reloads as the camera moves — so this number can sit well
  // under the Contacts cohort without either being wrong. Say which is which.
  const scopeKind = String(args.scope?.kind || 'view').toLowerCase();
  const viewportScoped =
    (scopeKind === 'radius' || scopeKind === 'view') &&
    (result.coverage?.layersQueried || []).some((l) =>
      VIEWPORT_LOADED_LAYERS.has(l.layerKey),
    );
  if (viewportScoped && result.coverage) {
    result.coverage.note = `${result.coverage.note} — counts cover loaded data; the flights layer loads by viewport`;
  }
  // ENTITY-CENTRED NEARBY: answered by the SAME engine that fills the Contacts
  // panel, so the spoken number and the panel readout for one centre cannot
  // differ. The generic record/scope engine still owns explicit regions and
  // arbitrary points — only "how many aircraft around <this contact>" is
  // unified, because that is the question the panel is already answering.
  const entityWindow = aircraftProximityWindowForQuery(
    dataManager,
    args,
    result,
  );
  if (entityWindow) {
    const provenance = feedProvenanceEnvelope(
      layerSnapshots(dataManager.getAll?.() || []).filter(
        (layer) => layer.enabled && ['flights', 'military'].includes(layer.id),
      ),
    );
    return {
      ...entityWindow,
      feedProvenance: provenance,
      feedState: provenance.overall,
    };
  }

  const contactsWindow = activeContactsWindow(dataManager);
  const aircraftQueried = (result.coverage?.layersQueried || []).some(
    (l) => l.layerKey === 'flights' || l.layerKey === 'military',
  );
  // Both numbers, and which one answers the question. The window counts have
  // ridden along in `contactsWindow` for a while, and the owner's trial showed
  // that is not enough on its own: with Contacts active and a DATACENTER in
  // the selection slot, the model centred a radius on the datacenter, answered
  // 15, and then explained away the 111 sitting in the same payload ("that
  // number is from the Contacts window, and I wasn't using Contacts as the
  // source"). So the payload now states the relationship instead of leaving it
  // to be inferred from two bare numbers.
  const windowAircraft = Number.isFinite(contactsWindow?.aircraft)
    ? contactsWindow.aircraft
    : null;
  const proximityScoped = scopeKind === 'radius' || scopeKind === 'view';
  const countsReconciliation =
    contactsWindow &&
    aircraftQueried &&
    proximityScoped &&
    windowAircraft !== null
      ? `Contacts is ACTIVE: its window holds ${windowAircraft} aircraft within ` +
        `${contactsWindow.radiusKm} km of ${contactsWindow.centeredOn}, and that is the answer to a bare ` +
        `"how many aircraft are nearby". This query measured something else — ${result.count} ${result.scopeLabel}. ` +
        'Give this one only if the operator asked about that specific area, and name both scopes if you give both.'
      : null;
  return {
    ok: true,
    action: 'analyst_query',
    count: result.count,
    // Every count names its scope in words; a bare number is what made two
    // honest answers look like a contradiction.
    scopeLabel: result.scopeLabel,
    truncated: result.truncated,
    items,
    summary: result.summary,
    coverage: result.coverage,
    feedProvenance: result.coverage?.feedProvenance || null,
    feedState: result.coverage?.feedProvenance?.overall || null,
    // The panel's own numbers, carried so the answer can match what the
    // operator is looking at regardless of how the model reads the note.
    // Flattened alongside the object so the count and its subject cannot be
    // missed inside a nested shape.
    ...(contactsWindow && aircraftQueried
      ? {
          contactsWindow,
          contactsWindowCount: windowAircraft,
          contactsWindowSubject: contactsWindow.centeredOn || null,
        }
      : {}),
    ...(countsReconciliation ? { countsReconciliation } : {}),
  };
}

/** Voice action `analyst_query`. */
export async function handleAnalystQuery(ctx) {
  const {
    viewer,
    dataManager,
    placeSearch,
    _layerEnabledAt,
    resolveRegionRing,
    args,
  } = ctx;
  ctx.state.analystEngine ||= createAnalystEngine(
    analystProviders(viewer, dataManager, {
      placeSearch,
      resolveRegionRing,
    }),
  );
  const result = await runAnalystQuery(
    ctx.state.analystEngine,
    dataManager,
    args,
    _layerEnabledAt,
  );
  // Pattern layer: how the count compares with this region's rolling
  // baseline for the hour ("activity in this corridor is elevated").
  if (result?.ok) {
    const activityBaseline = activityBaselineFor(viewer, args);
    if (activityBaseline) result.activityBaseline = activityBaseline;
  }
  return result;
}

/** Action name → handler for this domain. */
export const ANALYST_ACTIONS = Object.freeze({
  analyst_query: handleAnalystQuery,
});
