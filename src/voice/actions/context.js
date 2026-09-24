/**
 * Context actions: what is in view, the selected entity and basemap labels.
 *
 * Split out of src/voice/gevActions.js; the runner there dispatches by
 * action name to the handlers exported here.
 */
import {
  layerSnapshot,
  layerSnapshots,
  feedProvenanceEnvelope,
} from '../../data/layerSnapshot.js';
import { defaultGeospatial } from '../../search/defaults.js';
import * as Cesium from 'cesium';
import { CITY_POIS } from '../../locations.js';
import {
  getContextStore,
  getSelectedEntityContext,
  isContextRecordActive,
} from '../../data/contextStore.js';
import {
  BASEMAP_CONTEXT_WAIT_MS,
  cachesFor,
  getViewTargetCartographic,
  sampleViewportCartographics,
} from './spatial.js';
import {
  approximateCoordinateDistanceSq,
  clampNumber,
  cleanText,
  dominantValue,
  haversineKm,
  layerTitle,
  logSlowContext,
  normalizeLayerId,
  resolveWithin,
  uniqueStrings,
  withContextModeVocabulary,
} from './vocabulary.js';
import { activeContactsWindow } from './analyst.js';
import { collectTrackedEntities } from './cockpit.js';

export const VISIBLE_ENTITY_SHORTLIST = 64;

export async function getBasemapLabelContext(
  viewer,
  service = defaultGeospatial,
  { cachedOnly = false } = {},
) {
  const { reverseGeocodeCache, nearbyPlacesCache } = cachesFor(service);
  const samples = sampleViewportCartographics(viewer);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const target = getViewTargetCartographic(viewer);
  if (!target) {
    return {
      placeLabels: [],
      streetLabels: [],
      nearbyPlaceLabels: [],
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const cachedViewportPlaces = viewportPlacesFromCache(
    samples,
    cameraHeightM,
    service,
  );
  const viewportPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : cachedOnly
      ? Promise.resolve(null)
      : reverseGeocodeViewportSamples(samples, cameraHeightM, service);
  const placePromise = shouldReverseGeocode(cameraHeightM)
    ? cachedOnly
      ? Promise.resolve(
          reverseGeocodeCache.get(
            reverseGeocodeKey(latitude, longitude, service),
          ) || null,
        )
      : reverseGeocode(latitude, longitude, service)
    : Promise.resolve(null);
  const nearbyPromise = shouldFetchNearbyPlaces(cameraHeightM)
    ? cachedOnly
      ? Promise.resolve(
          nearbyPlacesCache.get(
            nearbyPlacesCacheKey(latitude, longitude, cameraHeightM, service),
          ) || [],
        )
      : fetchNearbyPlaces(latitude, longitude, cameraHeightM, service)
    : Promise.resolve([]);
  const [viewportPlaces, place, nearbyPlaces] = await Promise.all([
    resolveWithin(
      viewportPromise,
      BASEMAP_CONTEXT_WAIT_MS,
      cachedViewportPlaces,
    ),
    resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, null),
    resolveWithin(nearbyPromise, BASEMAP_CONTEXT_WAIT_MS, []),
  ]);

  return {
    placeLabels: uniqueStrings([
      place?.formattedAddress,
      place?.locality,
      place?.region,
      place?.country,
      ...(place?.labels || []),
      ...(viewportPlaces?.visibleLabels || []),
    ]).slice(0, 24),
    streetLabels: uniqueStrings([
      ...(place?.streetLabels || []),
      ...(viewportPlaces?.streetLabels || []),
    ]).slice(0, 16),
    nearbyPlaceLabels: uniqueStrings(
      (nearbyPlaces || []).flatMap((nearbyPlace) => [
        nearbyPlace.name,
        nearbyPlace.address,
      ]),
    ).slice(0, 24),
  };
}

export function getCurrentViewState(
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
) {
  const cartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  return {
    ok: true,
    action: 'get_current_view_state',
    camera: {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
      heightM: cartographic.height,
    },
    style: styleManager.activeStyle || 'normal',
    context:
      typeof styleManager.getContextModeState === 'function'
        ? {
            ...withContextModeVocabulary(styleManager.getContextModeState()),
            // The numbers on the operator's Contacts panel, so a window/count
            // question can be answered from what they are looking at.
            ...(activeContactsWindow(dataManager)
              ? { contactsWindow: activeContactsWindow(dataManager) }
              : {}),
          }
        : null,
    cockpit:
      typeof styleManager.getCockpitState === 'function'
        ? styleManager.getCockpitState()
        : null,
    controls:
      typeof styleManager.getControlState === 'function'
        ? styleManager.getControlState()
        : null,
    scenePlayback: sceneDirector?.getPlaybackStatus?.() || null,
    tracked: collectTrackedEntities(dataManager),
    layers: dataManager.getAll().map((layer) => ({
      id: layer.id,
      name: layer.name,
      enabled: layer.enabled,
      count: layer.stats?.count || 0,
      error: layer.stats?.error || null,
      feedState: layerSnapshot(layer).feedState,
      source: layerSnapshot(layer).source,
      lastUpdate: layerSnapshot(layer).lastUpdate,
    })),
    feedProvenance: feedProvenanceEnvelope(
      layerSnapshots(dataManager.getAll()).filter((layer) => layer.enabled),
    ),
  };
}

export async function getEntityContext(
  viewer,
  dataManager,
  styleManager,
  args = {},
  service = defaultGeospatial,
) {
  const startedAt = performance.now();
  const scope = String(args.scope || 'auto').toLowerCase();
  const layerId = normalizeLayerId(args.layerId || args.layer);
  const limit = Math.round(clampNumber(args.limit, 1, 12, 5));
  const selected = selectedEntityContext(dataManager);
  const cameraHeightM = viewer.camera.positionCartographic.height;
  const viewTarget = getViewTargetCartographic(viewer);
  const scenePromise = getSceneContext(
    viewer,
    styleManager,
    dataManager,
    viewTarget,
    service,
  );
  const selectedWillBeReturned =
    selected && (scope === 'selected' || scope === 'auto');
  const visible =
    !selectedWillBeReturned && shouldScanVisibleEntities(cameraHeightM)
      ? visibleEntityContexts(viewer, dataManager, {
          layerId,
          limit,
          target: viewTarget,
        })
      : [];
  const scene = await scenePromise;

  if ((scope === 'selected' || scope === 'auto') && selected) {
    logSlowContext(startedAt, 'selected');
    return {
      ok: true,
      action: 'get_entity_context',
      scope: 'selected',
      scene,
      selected,
    };
  }

  logSlowContext(startedAt, 'in_view');
  return {
    ok: true,
    action: 'get_entity_context',
    scope: 'in_view',
    scene,
    selected: selected || null,
    visible,
    count: visible.length,
    visibleScanSkipped: !shouldScanVisibleEntities(cameraHeightM),
  };
}

/**
 * Radius within which a requested centre counts as the Contacts subject's own
 * position. Generous enough to absorb the fix-vs-display offset between what
 * the model read off a card and where the contact is now, tight enough that a
 * neighbouring landmark is never mistaken for the subject.
 */
export const SUBJECT_CENTER_TOLERANCE_KM = 1;

/**
 * Is this requested centre the Contacts subject's own position?
 *
 * Measured as true ground distance. A lat/lon delta box was wrong in a way
 * that hid at the equator and widened toward it: a degree of longitude is
 * ~111 km at the equator and ~78 km at 45°, so a fixed 0.01° box spans a
 * different real distance at every latitude, and its diagonal admitted centres
 * ~1.5 km away — far enough to be a different place, close enough to slip
 * through and get answered as the subject's window.
 * @param {{lat: number, lon: number}} center Requested centre.
 * @param {Cesium.Cartesian3} subjectPosition Subject's world position.
 * @returns {boolean} True when the two are the same place.
 */
export function centerMatchesSubject(center, subjectPosition) {
  if (!Number.isFinite(center?.lat) || !Number.isFinite(center?.lon))
    return false;
  const carto = Cesium.Cartographic.fromCartesian(subjectPosition);
  if (!carto) return false;
  const subjectLat = Cesium.Math.toDegrees(carto.latitude);
  const subjectLon = Cesium.Math.toDegrees(carto.longitude);
  return (
    haversineKm(subjectLat, subjectLon, center.lat, center.lon) <=
    SUBJECT_CENTER_TOLERANCE_KM
  );
}

export function shouldScanVisibleEntities(cameraHeightM) {
  return cameraHeightM <= 100000;
}

export function selectedEntityContext(dataManager) {
  const record = getSelectedEntityContext({ dataManager });
  if (!record) return null;
  return summarizeContextRecord(record, { includeProperties: true });
}

export function visibleEntityContexts(
  viewer,
  dataManager,
  { layerId = null, limit = 5, target = null } = {},
) {
  const nearbyRecords = [];
  const canvas = viewer.scene.canvas;
  const width = canvas.clientWidth || canvas.width || 0;
  const height = canvas.clientHeight || canvas.height || 0;
  const centerX = width / 2;
  const centerY = height / 2;
  const targetLat = target ? Cesium.Math.toDegrees(target.latitude) : null;
  const targetLon = target ? Cesium.Math.toDegrees(target.longitude) : null;
  const store = getContextStore();
  const enabledLayerIds = new Set(
    dataManager
      .getAll()
      .filter((layer) => layer.enabled)
      .map((layer) => layer.id),
  );

  for (const record of store.entities.values()) {
    if (layerId && record.layerId !== layerId) continue;
    if (record.layerId && !enabledLayerIds.has(record.layerId)) continue;
    if (record.entity?.show === false || record.dataSource?.show === false)
      continue;
    if (!Number.isFinite(record.latitude) || !Number.isFinite(record.longitude))
      continue;
    insertNearestRecord(
      nearbyRecords,
      {
        record,
        distanceScore: target
          ? approximateCoordinateDistanceSq(
              targetLat,
              targetLon,
              record.latitude,
              record.longitude,
            )
          : 0,
      },
      VISIBLE_ENTITY_SHORTLIST,
    );
  }

  const candidates = [];
  for (const { record } of nearbyRecords) {
    const position = record.entity?.__localBaseCartesian;
    if (!position) continue;
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      position,
    );
    if (
      !screen ||
      screen.x < 0 ||
      screen.y < 0 ||
      screen.x > width ||
      screen.y > height
    )
      continue;
    const dx = screen.x - centerX;
    const dy = screen.y - centerY;
    candidates.push({
      summary: summarizeContextRecord(record, { includeProperties: true }),
      distancePx: Math.sqrt(dx * dx + dy * dy),
    });
  }

  return candidates
    .sort((a, b) => a.distancePx - b.distancePx)
    .slice(0, limit)
    .map((item) => item.summary);
}

export function insertNearestRecord(records, candidate, limit) {
  if (records.length < limit) {
    records.push(candidate);
    records.sort((a, b) => a.distanceScore - b.distanceScore);
    return;
  }
  if (candidate.distanceScore >= records[records.length - 1].distanceScore)
    return;

  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (records[middle].distanceScore <= candidate.distanceScore)
      low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, candidate);
  records.pop();
}

export async function getSceneContext(
  viewer,
  styleManager,
  dataManager,
  viewTarget = null,
  service = defaultGeospatial,
) {
  const cartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const basemap = await getBasemapContext(viewer, viewTarget, service);
  const enabledLayers = dataManager
    .getAll()
    .filter((layer) => layer.enabled)
    .map((layer) => ({
      id: layer.id,
      name: layer.name,
      count: layer.stats?.count || 0,
      source: layer.source,
    }));
  return {
    camera: {
      latitude: Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(6)),
      longitude: Number(
        Cesium.Math.toDegrees(cartographic.longitude).toFixed(6),
      ),
      heightM: Math.round(cartographic.height),
    },
    basemap,
    style: styleManager.activeStyle || 'normal',
    enabledLayers,
  };
}

export async function getBasemapContext(
  viewer,
  viewTarget = null,
  service = defaultGeospatial,
) {
  const { reverseGeocodeCache, nearbyPlacesCache } = cachesFor(service);
  const target = viewTarget;
  const samples = sampleViewportCartographics(viewer);
  const cameraCartographic = Cesium.Cartographic.fromCartesian(
    viewer.camera.positionWC,
  );
  const cameraHeightM = cameraCartographic.height;
  const viewScale = classifyViewScale(cameraHeightM);
  const cachedViewportPlaces = viewportPlacesFromCache(
    samples,
    cameraHeightM,
    service,
  );
  const viewportPlacesPromise = cachedViewportPlaces
    ? Promise.resolve(cachedViewportPlaces)
    : reverseGeocodeViewportSamples(samples, cameraHeightM, service);
  if (!target) {
    const viewportPlaces = await resolveWithin(
      viewportPlacesPromise,
      BASEMAP_CONTEXT_WAIT_MS,
      cachedViewportPlaces,
    );
    return {
      source: 'Google Photorealistic 3D Tiles / Cesium basemap',
      hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
      viewScale,
      viewportSamples: samples,
      viewportPlaces,
      target: null,
      place: null,
    };
  }

  const latitude = Number(Cesium.Math.toDegrees(target.latitude).toFixed(6));
  const longitude = Number(Cesium.Math.toDegrees(target.longitude).toFixed(6));
  const inferredCountry = inferCountryFromSamples(samples);
  const knownLandmarks = nearbyKnownLandmarks(
    latitude,
    longitude,
    cameraHeightM,
  );
  const fallbackPlace = coarseBasemapPlace(
    viewScale,
    latitude,
    longitude,
    inferredCountry,
  );
  const cachedPlace = shouldReverseGeocode(cameraHeightM)
    ? reverseGeocodeCache.get(
        reverseGeocodeKey(latitude, longitude, service),
      ) || null
    : null;
  const nearbyCacheKey = nearbyPlacesCacheKey(
    latitude,
    longitude,
    cameraHeightM,
    service,
  );
  const cachedNearbyPlaces =
    shouldFetchNearbyPlaces(cameraHeightM) &&
    nearbyPlacesCache.has(nearbyCacheKey)
      ? nearbyPlacesCache.get(nearbyCacheKey)
      : null;
  const placePromise =
    shouldReverseGeocode(cameraHeightM) && !cachedPlace
      ? reverseGeocode(latitude, longitude, service)
      : Promise.resolve(cachedPlace);
  const nearbyPlacesPromise =
    shouldFetchNearbyPlaces(cameraHeightM) && !cachedNearbyPlaces
      ? fetchNearbyPlaces(latitude, longitude, cameraHeightM, service)
      : Promise.resolve(cachedNearbyPlaces);
  const [viewportPlaces, resolvedPlace, resolvedNearbyPlaces] =
    await Promise.all([
      resolveWithin(
        viewportPlacesPromise,
        BASEMAP_CONTEXT_WAIT_MS,
        cachedViewportPlaces,
      ),
      resolveWithin(placePromise, BASEMAP_CONTEXT_WAIT_MS, cachedPlace),
      resolveWithin(
        nearbyPlacesPromise,
        BASEMAP_CONTEXT_WAIT_MS,
        cachedNearbyPlaces,
      ),
    ]);
  const place = resolvedPlace || fallbackPlace;
  const nearbyPlaces = resolvedNearbyPlaces || [];
  return {
    source: 'Google Photorealistic 3D Tiles / Cesium basemap',
    hasGoogle3DTiles: Boolean(window.__godsEyeView?.tileset),
    viewScale,
    viewportSamples: samples,
    viewportPlaces,
    target: {
      latitude,
      longitude,
      heightM: Math.round(target.height || 0),
    },
    knownLandmarks,
    nearbyPlaces,
    place,
  };
}

export function classifyViewScale(cameraHeightM) {
  if (cameraHeightM > 12000000) return 'global';
  if (cameraHeightM > 3000000) return 'continental';
  if (cameraHeightM > 750000) return 'regional';
  if (cameraHeightM > 100000) return 'metro';
  if (cameraHeightM > 10000) return 'city';
  return 'local';
}

export function shouldReverseGeocode(cameraHeightM) {
  return cameraHeightM <= 750000;
}

export function shouldReverseGeocodeViewport(cameraHeightM) {
  return cameraHeightM <= 3000000;
}

export function shouldFetchNearbyPlaces(cameraHeightM) {
  return cameraHeightM <= 25000;
}

export function nearbyKnownLandmarks(latitude, longitude, cameraHeightM) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const maxDistanceKm =
    cameraHeightM <= 5000
      ? 2
      : cameraHeightM <= 50000
        ? 10
        : cameraHeightM <= 250000
          ? 35
          : 0;
  if (maxDistanceKm <= 0) return [];

  const matches = [];
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    for (let poiIndex = 0; poiIndex < city.pois.length; poiIndex++) {
      const poi = city.pois[poiIndex];
      const distanceKm = haversineKm(latitude, longitude, poi.lat, poi.lon);
      if (distanceKm > maxDistanceKm) continue;
      matches.push({
        name: poi.name,
        cityId,
        city: city.name,
        latitude: poi.lat,
        longitude: poi.lon,
        distanceKm: Number(distanceKm.toFixed(3)),
      });
    }
  }
  return matches.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 5);
}

export function coarseBasemapPlace(
  viewScale,
  latitude,
  longitude,
  inferredCountry = null,
) {
  if (viewScale === 'global') {
    return {
      formattedAddress: 'Global Earth view',
      locality: null,
      region: null,
      country: null,
      precision: 'global',
      note: 'Camera is too far out for a precise street or city label; do not infer a local place from the center point.',
    };
  }
  return {
    formattedAddress: inferredCountry?.country
      ? `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view over ${inferredCountry.country}`
      : `${viewScale[0].toUpperCase()}${viewScale.slice(1)} basemap view centered near ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`,
    locality: null,
    region: null,
    country: inferredCountry?.country || null,
    precision: viewScale,
    confidence: inferredCountry?.confidence || null,
    note: 'Camera altitude is high, so this is approximate basemap context rather than a precise address.',
  };
}

export function inferCountryFromSamples(samples) {
  if (!samples.length) return null;
  const counts = new Map();
  for (const sample of samples) {
    const country = inferCountry(sample.latitude, sample.longitude);
    if (!country) continue;
    counts.set(country, (counts.get(country) || 0) + 1);
  }
  if (!counts.size) return null;
  const [country, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    country,
    confidence: Number((count / samples.length).toFixed(2)),
    sampleCount: count,
    totalSamples: samples.length,
  };
}

export function inferCountry(latitude, longitude) {
  const regions = [
    { name: 'Iran', south: 24.0, north: 40.2, west: 44.0, east: 63.5 },
    { name: 'Iraq', south: 29.0, north: 37.5, west: 38.5, east: 49.0 },
    { name: 'Turkey', south: 35.5, north: 42.5, west: 25.5, east: 45.2 },
    { name: 'Saudi Arabia', south: 16.0, north: 32.5, west: 34.0, east: 56.5 },
    { name: 'Afghanistan', south: 29.0, north: 38.8, west: 60.0, east: 75.5 },
    { name: 'Pakistan', south: 23.0, north: 37.2, west: 60.5, east: 77.5 },
    { name: 'Turkmenistan', south: 35.0, north: 42.9, west: 52.0, east: 66.8 },
    { name: 'Azerbaijan', south: 38.3, north: 41.9, west: 44.6, east: 50.8 },
    { name: 'Armenia', south: 38.7, north: 41.4, west: 43.4, east: 46.7 },
    { name: 'Japan', south: 24.0, north: 46.5, west: 122.0, east: 146.5 },
    { name: 'South Korea', south: 33.0, north: 38.8, west: 124.0, east: 132.0 },
    { name: 'North Korea', south: 37.5, north: 43.2, west: 124.0, east: 131.0 },
    { name: 'China', south: 18.0, north: 53.8, west: 73.0, east: 135.2 },
    { name: 'Russia', south: 41.0, north: 82.0, west: 19.0, east: 180.0 },
    {
      name: 'United States',
      south: 24.0,
      north: 49.8,
      west: -125.0,
      east: -66.0,
    },
  ];
  const region = regions.find(
    (item) =>
      latitude >= item.south &&
      latitude <= item.north &&
      longitude >= item.west &&
      longitude <= item.east,
  );
  return region?.name || null;
}

export async function reverseGeocode(latitude, longitude, service) {
  const { reverseGeocodeCache, reverseGeocodeInFlight } = cachesFor(service);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const key = reverseGeocodeKey(latitude, longitude, service);
  if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
  if (reverseGeocodeInFlight.has(key)) return reverseGeocodeInFlight.get(key);

  const request = (async () => {
    try {
      const place =
        (await service.reverseGeocode?.(latitude, longitude)) || null;
      if (place) {
        reverseGeocodeCache.set(key, place);
        if (reverseGeocodeCache.size > 256)
          reverseGeocodeCache.delete(reverseGeocodeCache.keys().next().value);
      }
      return place;
    } catch {
      return null;
    } finally {
      reverseGeocodeInFlight.delete(key);
    }
  })();
  reverseGeocodeInFlight.set(key, request);
  return request;
}

export async function reverseGeocodeViewportSamples(
  samples,
  cameraHeightM,
  service,
) {
  if (!shouldReverseGeocodeViewport(cameraHeightM) || !samples.length)
    return null;
  // At building scale, center geocoding plus Nearby Places is more precise and
  // avoids three redundant Google requests.
  if (cameraHeightM <= 10000) return null;
  const prioritySamples = [samples[0], samples[1], samples[2]].filter(Boolean);
  const places = (
    await Promise.all(
      prioritySamples.map(async (sample) => {
        const place = await reverseGeocode(
          sample.latitude,
          sample.longitude,
          service,
        );
        if (!place) return null;
        return {
          latitude: sample.latitude,
          longitude: sample.longitude,
          formattedAddress: place.formattedAddress,
          locality: place.locality,
          region: place.region,
          country: place.country,
          types: place.types,
          labels: place.labels,
          streetLabels: place.streetLabels,
        };
      }),
    )
  ).filter(Boolean);
  return summarizeViewportPlaces(places);
}

export function viewportPlacesFromCache(samples, cameraHeightM, service) {
  const { reverseGeocodeCache } = cachesFor(service);
  if (
    !shouldReverseGeocodeViewport(cameraHeightM) ||
    cameraHeightM <= 10000 ||
    !samples.length
  )
    return null;
  const places = [samples[0], samples[1], samples[2]]
    .filter(Boolean)
    .flatMap((sample) => {
      const place = reverseGeocodeCache.get(
        reverseGeocodeKey(sample.latitude, sample.longitude, service),
      );
      if (!place) return [];
      return [
        {
          latitude: sample.latitude,
          longitude: sample.longitude,
          formattedAddress: place.formattedAddress,
          locality: place.locality,
          region: place.region,
          country: place.country,
          types: place.types,
          labels: place.labels,
          streetLabels: place.streetLabels,
        },
      ];
    });
  return summarizeViewportPlaces(places);
}

export function summarizeViewportPlaces(places) {
  if (!places.length) return null;
  return {
    samples: places,
    dominantCountry: dominantValue(
      places.map((place) => place.country).filter(Boolean),
    ),
    dominantRegion: dominantValue(
      places.map((place) => place.region).filter(Boolean),
    ),
    dominantLocality: dominantValue(
      places.map((place) => place.locality).filter(Boolean),
    ),
    visibleLabels: uniqueStrings(
      places.flatMap((place) => place.labels || []),
    ).slice(0, 24),
    streetLabels: uniqueStrings(
      places.flatMap((place) => place.streetLabels || []),
    ).slice(0, 20),
  };
}

export async function fetchNearbyPlaces(
  latitude,
  longitude,
  cameraHeightM,
  service,
) {
  const { nearbyPlacesCache, nearbyPlacesInFlight } = cachesFor(service);
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  const cacheKey = nearbyPlacesCacheKey(
    latitude,
    longitude,
    cameraHeightM,
    service,
  );
  if (nearbyPlacesCache.has(cacheKey)) return nearbyPlacesCache.get(cacheKey);
  if (nearbyPlacesInFlight.has(cacheKey))
    return nearbyPlacesInFlight.get(cacheKey);

  const request = (async () => {
    try {
      const places = (
        (await service.nearby?.({ latitude, longitude, radiusM })) || []
      )
        .filter((place) => place?.name)
        .slice(0, 12);
      nearbyPlacesCache.set(cacheKey, places);
      if (nearbyPlacesCache.size > 256)
        nearbyPlacesCache.delete(nearbyPlacesCache.keys().next().value);
      return places;
    } catch {
      return [];
    } finally {
      nearbyPlacesInFlight.delete(cacheKey);
    }
  })();
  nearbyPlacesInFlight.set(cacheKey, request);
  return request;
}

export function cachePrecision(service) {
  return Number.isInteger(service?.cachePrecision)
    ? Math.max(3, Math.min(6, service.cachePrecision))
    : 4;
}

export function reverseGeocodeKey(latitude, longitude, service) {
  return `${latitude.toFixed(cachePrecision(service))},${longitude.toFixed(cachePrecision(service))}`;
}

export function nearbyPlacesCacheKey(
  latitude,
  longitude,
  cameraHeightM,
  service,
) {
  const radiusM = nearbyPlacesRadiusM(cameraHeightM);
  return `${latitude.toFixed(cachePrecision(service))},${longitude.toFixed(cachePrecision(service))},${radiusM}`;
}

export function nearbyPlacesRadiusM(cameraHeightM) {
  if (cameraHeightM <= 1000) return 500;
  if (cameraHeightM <= 5000) return 2000;
  return 5000;
}

export function summarizeEntity(
  viewer,
  entity,
  { includeProperties = false } = {},
) {
  const now = Cesium.JulianDate.now();
  if (entity.__gevContextId) {
    const store = window.__gevContextStore;
    const record = store?.entities?.get(entity.__gevContextId);
    if (record) return summarizeContextRecord(record, { includeProperties });
  }
  const props = propertyObject(entity);
  const layerId = entity.__localLayerId || props.layerId || null;
  const tags = props.tags || {};
  const label = cleanText(
    props.name ||
      tags.name ||
      tags['name:en'] ||
      tags.official_name ||
      tags.operator ||
      props.operator ||
      entity.name ||
      layerTitle(layerId),
  );
  const position =
    entity.__localBaseCartesian ||
    entity.position?.getValue?.(now) ||
    polygonCenter(entity, now);
  const carto = position ? Cesium.Cartographic.fromCartesian(position) : null;
  return {
    id: String(entity.id || ''),
    name: label || layerTitle(layerId),
    layerId,
    layerName: layerTitle(layerId),
    latitude: carto
      ? Number(Cesium.Math.toDegrees(carto.latitude).toFixed(6))
      : null,
    longitude: carto
      ? Number(Cesium.Math.toDegrees(carto.longitude).toFixed(6))
      : null,
    properties: includeProperties ? compactProperties(props) : undefined,
  };
}

export function summarizeContextRecord(
  record,
  { includeProperties = false } = {},
) {
  return {
    id: String(record.id || ''),
    name:
      cleanText(record.label || record.properties?.name) ||
      layerTitle(record.layerId),
    layerId: record.layerId || null,
    layerName: record.layerName || layerTitle(record.layerId),
    source: record.source || null,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    properties: includeProperties
      ? compactProperties(record.properties || {})
      : undefined,
    active: isContextRecordActive(record),
  };
}

export function polygonCenter(entity, now) {
  const hierarchy = entity.polygon?.hierarchy?.getValue?.(now);
  const positions = hierarchy?.positions;
  if (!positions?.length) return null;
  return Cesium.BoundingSphere.fromPoints(positions).center;
}

export function propertyObject(entity) {
  const raw = entity?.properties?.getValue?.(Cesium.JulianDate.now()) || {};
  return unwrapProperties(raw);
}

export function unwrapProperties(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(unwrapProperties);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] =
      entry && typeof entry.getValue === 'function'
        ? unwrapProperties(entry.getValue(Cesium.JulianDate.now()))
        : unwrapProperties(entry);
  }
  return out;
}

export function compactProperties(props) {
  const preferredKeys = [
    'name',
    'operator',
    'owner',
    'brand',
    'addr:city',
    'addr:state',
    'country',
    'capacity',
    'output',
    'osm_id',
    'source',
  ];
  const flat = {
    ...props,
    ...(props.tags && typeof props.tags === 'object' ? props.tags : {}),
  };
  const result = {};
  for (const key of preferredKeys) {
    const value = cleanText(flat[key]);
    if (value) result[key] = value;
  }
  for (const [key, value] of Object.entries(flat)) {
    if (Object.keys(result).length >= 12) break;
    if (key === 'tags' || result[key] !== undefined) continue;
    const text = cleanText(value);
    if (text) result[key] = text;
  }
  return result;
}

/** Voice action `get_entity_context`. */
export async function handleGetEntityContext(ctx) {
  const { viewer, styleManager, dataManager, placeSearch, args } = ctx;
  return getEntityContext(viewer, dataManager, styleManager, args, placeSearch);
}

/** Voice action `get_current_view_state`. */
export async function handleGetCurrentViewState(ctx) {
  const { viewer, styleManager, dataManager, sceneDirector } = ctx;
  return getCurrentViewState(viewer, styleManager, dataManager, sceneDirector);
}

/** Action name → handler for this domain. */
export const CONTEXT_ACTIONS = Object.freeze({
  get_entity_context: handleGetEntityContext,
  get_current_view_state: handleGetCurrentViewState,
});
