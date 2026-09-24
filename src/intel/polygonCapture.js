/**
 * Operator polygon capture on the globe, shared by the region filter and
 * alert-trigger zones.
 *
 * Click to add a vertex, double-click or Enter to finish, Backspace or
 * right-click to remove the last vertex, Escape to cancel. While a capture is
 * open this tool holds the pointer lease (src/data/inputOwnership.js), so
 * layer click handlers yield to it.
 */

import * as Cesium from 'cesium';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';

export const ZONE_POINTER_OWNER = 'adam-zone';
const MAX_VERTICES = 64;

/** Pick the globe coordinate under a screen position, as [lon, lat]. */
export function pickLonLat(viewer, position) {
  const scene = viewer?.scene;
  if (!scene || !position) return null;
  let cartesian = null;
  try {
    if (scene.pickPositionSupported) {
      const picked = scene.pickPosition(position);
      if (Cesium.defined(picked)) cartesian = picked;
    }
  } catch {
    cartesian = null;
  }
  if (!cartesian) {
    const ray = viewer.camera.getPickRay(position);
    cartesian = ray ? scene.globe.pick(ray, scene) : null;
  }
  if (!cartesian)
    cartesian = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return [
    Cesium.Math.toDegrees(carto.longitude),
    Cesium.Math.toDegrees(carto.latitude),
  ];
}

/**
 * Capture one polygon.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{color?: string, onHint?: (text: string) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<[number, number]>|null>} The ring, or null if cancelled.
 */
export function capturePolygon(
  viewer,
  { color = '#00d4ff', onHint, signal } = {},
) {
  return new Promise((resolve) => {
    const lease = claimPointer(ZONE_POINTER_OWNER);
    if (!lease) {
      onHint?.('Another tool is using the pointer. Finish it first.');
      resolve(null);
      return;
    }
    const vertices = [];
    let hover = null;
    const cesiumColor = Cesium.Color.fromCssColorString(color);
    const source = new Cesium.CustomDataSource('adam-zone-capture');
    viewer.dataSources.add(source);
    const positions = () =>
      [...vertices, ...(hover ? [hover] : [])].map(([lon, lat]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat),
      );
    source.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          const pts = positions();
          return pts.length > 1 ? [...pts, pts[0]] : pts;
        }, false),
        width: 2,
        material: cesiumColor,
        clampToGround: true,
      },
    });
    source.entities.add({
      polygon: {
        hierarchy: new Cesium.CallbackProperty(
          () => new Cesium.PolygonHierarchy(positions()),
          false,
        ),
        material: cesiumColor.withAlpha(0.12),
      },
    });
    const hint = () =>
      onHint?.(
        vertices.length < 3
          ? `Click to place zone corners (${vertices.length}/3 minimum). Esc cancels.`
          : 'Double-click or Enter to finish. Backspace removes a corner. Esc cancels.',
      );
    hint();

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    const request = () => viewer.scene.requestRender?.();
    let finished = false;

    const finish = (commit) => {
      if (finished) return;
      finished = true;
      handler.destroy();
      document.removeEventListener('keydown', onKey, true);
      signal?.removeEventListener?.('abort', onAbort);
      viewer.dataSources.remove(source, true);
      releasePointer(lease);
      request();
      resolve(commit && vertices.length >= 3 ? vertices.slice() : null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        vertices.pop();
        hint();
        request();
      }
    };
    const onAbort = () => finish(false);

    handler.setInputAction((click) => {
      const point = pickLonLat(viewer, click.position);
      if (!point || vertices.length >= MAX_VERTICES) return;
      vertices.push(point);
      hint();
      request();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(() => {
      // The double-click's two clicks already added the same corner twice.
      if (vertices.length > 3) vertices.pop();
      finish(true);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    handler.setInputAction(() => {
      vertices.pop();
      hint();
      request();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    handler.setInputAction((movement) => {
      hover = pickLonLat(viewer, movement.endPosition);
      if (vertices.length) request();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    document.addEventListener('keydown', onKey, true);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
