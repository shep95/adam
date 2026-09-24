/**
 * Context overlay layers: infrastructure and airspace context drawn as
 * lightweight primitives (one PolylineCollection + one PointPrimitiveCollection
 * per layer), loaded either once globally or per viewport.
 *
 * A layer is described by a config:
 *   id, name, icon, source, color
 *   mode: 'global' | 'viewport'
 *   maxSpanDeg (viewport mode): refuse wider views with a "zoom in" status
 *   load({box, signal}) → {features, stale?, saturated?}
 *   describe(feature) → {title, rows: [[label, value], ...], link?}
 *
 * Features: {id, geometry: 'point'|'line'|'multiline', coords, tags}.
 * Clicking a feature opens the shared context card (./infoCard.js).
 */

import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { showContextCard, hideContextCard } from './infoCard.js';

const VIEWPORT_DEBOUNCE_MS = 700;
const MAX_POLYLINES = 6000;
const MAX_POINTS = 12000;

function viewRectangle(viewer) {
  const rect = viewer?.camera?.computeViewRectangle(
    viewer.scene.globe.ellipsoid,
  );
  if (!rect) return null;
  const box = {
    south: Cesium.Math.toDegrees(rect.south),
    west: Cesium.Math.toDegrees(rect.west),
    north: Cesium.Math.toDegrees(rect.north),
    east: Cesium.Math.toDegrees(rect.east),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

/** Whether a view box is loadable under a span limit (no dateline crossing). */
export function viewportLoadable(box, maxSpanDeg) {
  if (!box) return false;
  if (box.east <= box.west) return false;
  return (
    box.north - box.south <= maxSpanDeg && box.east - box.west <= maxSpanDeg
  );
}

/**
 * @param {object} config
 * @returns {object} A data-manager layer module.
 */
export function createContextOverlayLayer(config) {
  const {
    id,
    name,
    icon = '◇',
    source = 'OpenStreetMap',
    color = '#00d4ff',
    mode = 'viewport',
    maxSpanDeg = 5,
    viewportOptional = false,
    lineWidth = 1.5,
    pointSize = 6,
    load,
    describe = (feature) => ({
      title: feature.tags?.name || name,
      rows: Object.entries(feature.tags || {}).slice(0, 8),
    }),
    colorFor = () => color,
  } = config;
  if (!id || typeof load !== 'function')
    throw new TypeError('A context overlay needs an id and a loader');

  const state = {
    enabled: false,
    viewer: null,
    polylines: null,
    points: null,
    features: [],
    byKey: new Map(),
    status: 'idle',
    loading: false,
    error: null,
    stale: false,
    saturated: false,
    lastUpdate: null,
    abort: null,
    timer: null,
    removeMoveEnd: null,
    clickHandler: null,
    loadedKey: null,
    listener: null,
  };

  const cssColor = (value) => Cesium.Color.fromCssColorString(value);

  function clearPrimitives() {
    state.polylines?.removeAll();
    state.points?.removeAll();
    state.byKey.clear();
  }

  function draw(features) {
    clearPrimitives();
    let lines = 0;
    let points = 0;
    for (const feature of features) {
      const tint = cssColor(colorFor(feature) || color);
      const pick = { adamContextLayer: id, featureId: feature.id };
      state.byKey.set(feature.id, feature);
      if (feature.geometry === 'point') {
        if (points >= MAX_POINTS) continue;
        const [lon, lat] = feature.coords;
        state.points.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 30),
          pixelSize: pointSize,
          color: tint.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: 2_000_000,
          scaleByDistance: new Cesium.NearFarScalar(2e4, 1.4, 2e7, 0.6),
          id: pick,
        });
        points += 1;
        continue;
      }
      const parts =
        feature.geometry === 'multiline' ? feature.coords : [feature.coords];
      for (const part of parts) {
        if (lines >= MAX_POLYLINES || !Array.isArray(part) || part.length < 2)
          continue;
        const flat = [];
        for (const [lon, lat] of part) flat.push(lon, lat);
        state.polylines.add({
          positions: Cesium.Cartesian3.fromDegreesArray(flat),
          width: lineWidth,
          material: Cesium.Material.fromType('Color', {
            color: tint.withAlpha(0.85),
          }),
          id: pick,
        });
        lines += 1;
      }
    }
    state.viewer?.scene?.requestRender?.();
  }

  function publish() {
    state.listener?.();
  }

  async function refresh({ force = false } = {}) {
    if (!state.enabled || !state.viewer) return;
    let box = null;
    if (mode === 'viewport') {
      box = viewRectangle(state.viewer);
      if (!viewportLoadable(box, maxSpanDeg) && viewportOptional) {
        box = null;
      } else if (!viewportLoadable(box, maxSpanDeg)) {
        state.abort?.abort();
        state.loading = false;
        state.status = 'zoom-in';
        publish();
        return;
      }
    }
    const key = box
      ? [box.south, box.west, box.north, box.east]
          .map((v) => v.toFixed(2))
          .join(',')
      : 'global';
    if (!force && key === state.loadedKey && state.status === 'ready') return;
    state.abort?.abort();
    const controller = new AbortController();
    state.abort = controller;
    state.loading = true;
    state.status = 'loading';
    publish();
    try {
      const result = await load({ box, signal: controller.signal });
      if (controller.signal.aborted || !state.enabled) return;
      state.features = Array.isArray(result?.features) ? result.features : [];
      state.stale = result?.stale === true;
      state.saturated = result?.saturated === true;
      state.error = null;
      state.status = 'ready';
      state.loadedKey = key;
      state.lastUpdate = Date.now();
      draw(state.features);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      state.error = error?.message || String(error);
      state.status = 'unavailable';
    } finally {
      if (state.abort === controller) {
        state.loading = false;
        state.abort = null;
      }
      publish();
    }
  }

  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void refresh(), VIEWPORT_DEBOUNCE_MS);
  }

  function installClick(viewer) {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
      if (!isPointerFree()) return;
      let picked = null;
      try {
        picked = viewer.scene.pick(click.position);
      } catch {
        picked = null;
      }
      const pickId = picked?.id;
      if (pickId?.adamContextLayer !== id) return;
      const feature = state.byKey.get(pickId.featureId);
      if (!feature) return;
      const details = describe(feature) || {};
      showContextCard({
        kicker: name.toUpperCase(),
        title: details.title || name,
        rows: details.rows || [],
        link: details.link || null,
        note: details.note || null,
        loadMore: details.loadMore || null,
        position: click.position,
        accent: colorFor(feature) || color,
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return handler;
  }

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval: 0,
    statsRefreshInterval: 1000,

    async init() {
      return true;
    },

    async enable(viewer) {
      state.enabled = true;
      state.viewer = viewer;
      if (!state.polylines) {
        state.polylines = viewer.scene.primitives.add(
          new Cesium.PolylineCollection(),
        );
        state.points = viewer.scene.primitives.add(
          new Cesium.PointPrimitiveCollection(),
        );
      }
      state.polylines.show = true;
      state.points.show = true;
      state.clickHandler ||= installClick(viewer);
      if (mode === 'viewport' && !state.removeMoveEnd)
        state.removeMoveEnd =
          viewer.camera.moveEnd.addEventListener(scheduleRefresh);
      await refresh({ force: true });
      return true;
    },

    async disable() {
      state.enabled = false;
      state.abort?.abort();
      clearTimeout(state.timer);
      state.removeMoveEnd?.();
      state.removeMoveEnd = null;
      state.clickHandler?.destroy();
      state.clickHandler = null;
      if (state.polylines) state.polylines.show = false;
      if (state.points) state.points.show = false;
      clearPrimitives();
      state.features = [];
      state.loadedKey = null;
      state.status = 'idle';
      hideContextCard();
      state.viewer?.scene?.requestRender?.();
      return true;
    },

    async update() {
      await refresh({ force: true });
      return true;
    },

    destroy() {
      void layer.disable();
      if (state.viewer && state.polylines) {
        state.viewer.scene.primitives.remove(state.polylines);
        state.viewer.scene.primitives.remove(state.points);
      }
      state.polylines = null;
      state.points = null;
    },

    setRowControlsListener(listener) {
      state.listener = listener;
    },

    getFeatures() {
      return state.features;
    },

    getStats() {
      const count = state.features.length;
      return {
        count,
        countLabel: state.enabled
          ? `${count.toLocaleString('en-US')} mapped`
          : '',
        lastUpdate: state.lastUpdate,
        stale: state.stale,
        saturated: state.saturated,
        error: state.status === 'unavailable' ? state.error : null,
        status: state.status,
        loading: state.loading,
        loadingLabel: state.loading
          ? `loading ${name.toLowerCase()}`
          : state.status === 'zoom-in'
            ? `Zoom in to load (≤ ${maxSpanDeg}° view)`
            : [
                state.stale ? 'Showing cached data' : '',
                state.saturated ? 'Coverage limited — zoom in' : '',
              ]
                .filter(Boolean)
                .join(' · ') || null,
        source,
      };
    },
  };
  return layer;
}
