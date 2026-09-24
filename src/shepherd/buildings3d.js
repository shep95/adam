/**
 * 3D buildings, best available source first:
 *
 *   photoreal   Google Photorealistic 3D Tiles (needs a Google key or a
 *               Cesium ion token) — real textured buildings and terrain
 *   osm-ion     Cesium OSM Buildings through ion (needs the ion token)
 *   osm-extrude keyless: OpenStreetMap footprints near the camera from the
 *               Overpass proxy, extruded to their tagged height
 *
 * The keyless path is governed by level of detail: it only loads under
 * ~6 km camera altitude, for a bounded box around the view centre, caps the
 * footprint count, and reloads after the camera settles somewhere new.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

const MAX_ALT_M = 6000;
const MAX_BUILDINGS = 4000;
const LEVEL_M = 3.2;
const DEFAULT_HEIGHT_M = 9;
const RAD = 180 / Math.PI;

/** Height of an OSM building from its tags, in metres. */
export function buildingHeightM(tags = {}) {
  const parse = (v) => {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const height = parse(tags.height) ?? parse(tags['building:height']);
  if (height) return Math.min(height, 900);
  const levels = parse(tags['building:levels']);
  const roof = parse(tags['roof:levels']) || 0;
  if (levels) return Math.min((levels + roof) * LEVEL_M, 900);
  return DEFAULT_HEIGHT_M;
}

export function minHeightM(tags = {}) {
  const v = parseFloat(String(tags.min_height ?? ''));
  if (Number.isFinite(v) && v > 0) return v;
  const levels = parseFloat(String(tags['building:min_level'] ?? ''));
  return Number.isFinite(levels) && levels > 0 ? levels * LEVEL_M : 0;
}

/** Bounding box (south, west, north, east) sized to the camera altitude. */
export function viewBox(lat, lon, altM) {
  const halfKm = Math.max(0.4, Math.min(2.2, altM / 1500));
  const dLat = halfKm / 111;
  const dLon = halfKm / (111 * Math.max(0.2, Math.cos(lat / RAD)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(
    (v) => +v.toFixed(5),
  );
}

export function buildingsQuery([s, w, n, e]) {
  return `[out:json][timeout:25];(way["building"](${s},${w},${n},${e});relation["building"]["type"="multipolygon"](${s},${w},${n},${e}););out geom ${MAX_BUILDINGS};`;
}

/** Overpass `out geom` → [{ring:[[lon,lat]...], height, base}] */
export function footprintsFromOverpass(json) {
  const out = [];
  for (const el of json?.elements || []) {
    if (out.length >= MAX_BUILDINGS) break;
    const tags = el.tags || {};
    const rings =
      el.type === 'way'
        ? [el.geometry]
        : (el.members || [])
            .filter((m) => m.role === 'outer' && Array.isArray(m.geometry))
            .map((m) => m.geometry);
    for (const geom of rings) {
      if (!Array.isArray(geom) || geom.length < 4) continue;
      const ring = geom
        .map((p) => [Number(p.lon), Number(p.lat)])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      if (ring.length < 4) continue;
      out.push({ ring, height: buildingHeightM(tags), base: minHeightM(tags) });
    }
  }
  return out;
}

const LOW = Cesium.Color.fromCssColorString('#2a4a5e');
const HIGH = Cesium.Color.fromCssColorString('#9fe8ff');

function shadeFor(height) {
  const t = Math.max(0, Math.min(1, height / 120));
  return Cesium.Color.lerp(LOW, HIGH, t, new Cesium.Color()).withAlpha(0.92);
}

export function createBuildings3d({
  viewer,
  mapStackController,
  cesiumToken = '',
  fetchImpl = (...a) => fetch(...a),
}) {
  let mode = 'off';
  let primitive = null;
  let osmTileset = null;
  let previousStack = null;
  let lastKey = '';
  let controller = null;
  let status = '';
  let removeMoveEnd = null;

  const render = () => governorRequestRender('adam-buildings');

  function clearExtrusion() {
    if (primitive) {
      viewer.scene.primitives.remove(primitive);
      primitive = null;
    }
  }

  async function loadExtrusion() {
    const carto = viewer.camera.positionCartographic;
    const altM = carto.height;
    if (altM > MAX_ALT_M) {
      status = `zoom below ${MAX_ALT_M / 1000} km to load buildings`;
      return;
    }
    const lat = carto.latitude * RAD;
    const lon = carto.longitude * RAD;
    const box = viewBox(lat, lon, altM);
    const key = box.map((v) => v.toFixed(3)).join(',');
    if (key === lastKey && primitive) return;
    lastKey = key;
    controller?.abort();
    controller = new AbortController();
    status = 'loading footprints';
    const response = await fetchImpl('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(buildingsQuery(box)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`overpass HTTP ${response.status}`);
    const footprints = footprintsFromOverpass(await response.json());
    if (mode !== 'osm-extrude') return;
    const instances = [];
    for (const f of footprints) {
      try {
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(f.ring.flat()),
              ),
              height: f.base,
              extrudedHeight: Math.max(f.base + 1, f.height),
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                shadeFor(f.height),
              ),
            },
          }),
        );
      } catch {
        /* degenerate footprint */
      }
    }
    clearExtrusion();
    if (instances.length) {
      primitive = viewer.scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({
            translucent: false,
            closed: true,
          }),
          asynchronous: true,
          releaseGeometryInstances: true,
        }),
      );
    }
    status = `${instances.length} footprints`;
    render();
  }

  function scheduleExtrusion() {
    loadExtrusion().catch((error) => {
      if (error?.name !== 'AbortError')
        status = `footprints unavailable (${error.message})`;
    });
  }

  async function enable() {
    if (mode !== 'off') return state();
    if (mapStackController?.isStackAvailable?.('photoreal')) {
      previousStack = mapStackController.getState?.().activeId || null;
      if (previousStack !== 'photoreal')
        await mapStackController.setStack('photoreal');
      mode = 'photoreal';
      status = 'google photorealistic 3d tiles';
      return state();
    }
    if (cesiumToken) {
      try {
        const resource = await Cesium.IonResource.fromAssetId(96188, {
          accessToken: cesiumToken,
        });
        osmTileset = viewer.scene.primitives.add(
          await Cesium.Cesium3DTileset.fromUrl(resource),
        );
        mode = 'osm-ion';
        status = 'cesium osm buildings';
        render();
        return state();
      } catch {
        osmTileset = null;
      }
    }
    mode = 'osm-extrude';
    lastKey = '';
    removeMoveEnd = viewer.camera.moveEnd.addEventListener(scheduleExtrusion);
    scheduleExtrusion();
    return state();
  }

  async function disable() {
    if (mode === 'photoreal' && previousStack && previousStack !== 'photoreal')
      await mapStackController?.setStack?.(previousStack);
    if (osmTileset) {
      viewer.scene.primitives.remove(osmTileset);
      osmTileset = null;
    }
    removeMoveEnd?.();
    removeMoveEnd = null;
    controller?.abort();
    clearExtrusion();
    mode = 'off';
    status = '';
    render();
    return state();
  }

  function state() {
    return mode === 'off' ? 'off' : `${mode}${status ? ` · ${status}` : ''}`;
  }

  return {
    enable,
    disable,
    async set(enabled) {
      return { ok: true, state: enabled ? await enable() : await disable() };
    },
    toggle: () => (mode === 'off' ? enable() : disable()),
    isOn: () => mode !== 'off',
    state,
    destroy: () => void disable(),
  };
}
