/**
 * Night lights: the lit world after dark.
 *
 *   city lights    NASA Black Marble (VIIRS night lights, keyless GIBS tiles).
 *                  On the globe it uses Cesium's night alpha, so it shows only
 *                  on the night side of the real terminator; on photoreal 3D
 *                  tiles (which ignore scene lighting) it is draped with an
 *                  opacity from the sun altitude at the view centre.
 *   street lights  close in at night, OpenStreetMap roads tagged lit=yes and
 *                  mapped street lamps glow warm, from the Overpass proxy.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { sunPosition } from './astronomy.js';

export const BLACK_MARBLE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
/** Same night-lights product family, the long-standing 2012 composite; used
 * if the Black Marble tiles fail to load. */
export const CITY_LIGHTS_2012_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/2012-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg';
/** Cesium lights the night side at ~0.3 of day (both shading paths); the
 * lights layer is brightened by the inverse so city light reads as light. */
export const NIGHT_SIDE_GAIN = 3.2;
const STREET_MAX_ALT_M = 9000;
const MAX_LAMPS = 1500;
const MAX_LIT_WAYS = 2500;
const WARM = '#ffc56b';
const RAD = 180 / Math.PI;

/** 0 in daylight → 1 by the end of civil twilight (sun 10° below). */
export function nightFactor(sunAltitude) {
  return Math.max(0, Math.min(1, (-sunAltitude - 1) / 9));
}

/** Viewport box for the street-light query, sized to camera altitude. */
export function streetBox(lat, lon, altM) {
  const halfKm = Math.max(0.6, Math.min(3.5, altM / 1400));
  const dLat = halfKm / 111;
  const dLon = halfKm / (111 * Math.max(0.2, Math.cos(lat / RAD)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(
    (v) => +v.toFixed(5),
  );
}

export function streetLightQuery([s, w, n, e]) {
  return `[out:json][timeout:25];(way["highway"]["lit"="yes"](${s},${w},${n},${e});node["highway"="street_lamp"](${s},${w},${n},${e}););out geom ${MAX_LIT_WAYS + MAX_LAMPS};`;
}

/** Overpass `out geom` → {ways: [[lon,lat]...][], lamps: [lon,lat][]} */
export function parseStreetLights(json) {
  const ways = [];
  const lamps = [];
  for (const el of json?.elements || []) {
    if (el.type === 'node' && lamps.length < MAX_LAMPS) {
      const lat = Number(el.lat);
      const lon = Number(el.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) lamps.push([lon, lat]);
    } else if (
      el.type === 'way' &&
      ways.length < MAX_LIT_WAYS &&
      Array.isArray(el.geometry)
    ) {
      const line = el.geometry
        .map((p) => [Number(p.lon), Number(p.lat)])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      if (line.length >= 2) ways.push(line);
    }
  }
  return { ways, lamps };
}

export function createNightLights({
  viewer,
  environment,
  getCenter,
  getTileset = () => null,
  fetchImpl = (...a) => fetch(...a),
}) {
  let lightsUrl = BLACK_MARBLE_URL;
  const provider = () => {
    const p = new Cesium.UrlTemplateImageryProvider({
      url: lightsUrl,
      maximumLevel: 8,
      credit: new Cesium.Credit(
        'Night lights: NASA Black Marble (VIIRS), GIBS',
      ),
    });
    // Fall back to the 2012 city-lights composite if tiles keep failing.
    let errors = 0;
    p.errorEvent.addEventListener(() => {
      errors += 1;
      if (errors === 8 && lightsUrl === BLACK_MARBLE_URL) {
        lightsUrl = CITY_LIGHTS_2012_URL;
        rebuildGlobeLayer();
      }
    });
    return p;
  };

  // Globe: per-pixel day/night via Cesium's night alpha where the shader
  // supports it (terrain without vertex normals); with normal-lit terrain
  // Cesium skips day/night alpha, so the layer fades by the sun at the view
  // centre instead (the terminator is rarely inside a regional view).
  let globeLayer = null;
  function rebuildGlobeLayer() {
    if (globeLayer) viewer.imageryLayers.remove(globeLayer, true);
    globeLayer = viewer.imageryLayers.addImageryProvider(provider());
    globeLayer.dayAlpha = 0;
    globeLayer.nightAlpha = 1;
    globeLayer.brightness = NIGHT_SIDE_GAIN;
    globeLayer.contrast = 1.15;
    globeLayer.gamma = 0.9;
  }
  rebuildGlobeLayer();
  const perPixelNight = () =>
    !viewer.terrainProvider?.hasVertexNormals &&
    viewer.scene.globe.enableLighting;

  // 3D tiles: draped, faded by the sun at the view centre.
  let tileLayer = null;
  let tileHost = null;
  function syncTileLayer(factor) {
    const tileset = getTileset();
    const host =
      tileset && !tileset.isDestroyed?.() && tileset.show !== false
        ? tileset
        : null;
    if (host !== tileHost) {
      if (tileLayer && tileHost?.imageryLayers && !tileHost.isDestroyed?.())
        tileHost.imageryLayers.remove(tileLayer, true);
      tileLayer = null;
      tileHost = host;
      if (host?.imageryLayers) {
        tileLayer = host.imageryLayers.addImageryProvider(provider());
        tileLayer.brightness = 1.6;
      }
    }
    if (tileLayer) {
      tileLayer.alpha = 0.92 * factor;
      tileLayer.show = factor > 0.02;
    }
  }

  // Street lights.
  const lamps = new Cesium.CustomDataSource('adam-street-lamps');
  viewer.dataSources.add(lamps);
  const glow = Cesium.Material.fromType('PolylineGlow', {
    color: Cesium.Color.fromCssColorString(WARM).withAlpha(0.9),
    glowPower: 0.3,
    taperPower: 1,
  });
  let roads = null;
  let lastKey = '';
  let controller = null;
  let status = '';

  function clearStreets() {
    if (roads) {
      viewer.scene.groundPrimitives.remove(roads);
      roads = null;
    }
    lamps.entities.removeAll();
    lastKey = '';
  }

  async function loadStreets(center, altM) {
    const box = streetBox(center.lat, center.lon, altM);
    const key = box.map((v) => v.toFixed(3)).join(',');
    if (key === lastKey) return;
    lastKey = key;
    controller?.abort();
    controller = new AbortController();
    status = 'loading street lights';
    const response = await fetchImpl('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(streetLightQuery(box)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`overpass HTTP ${response.status}`);
    const { ways, lamps: points } = parseStreetLights(await response.json());
    if (roads) viewer.scene.groundPrimitives.remove(roads);
    roads = null;
    if (ways.length) {
      roads = viewer.scene.groundPrimitives.add(
        new Cesium.GroundPolylinePrimitive({
          geometryInstances: ways.map(
            (line) =>
              new Cesium.GeometryInstance({
                geometry: new Cesium.GroundPolylineGeometry({
                  positions: Cesium.Cartesian3.fromDegreesArray(line.flat()),
                  width: 5,
                }),
              }),
          ),
          appearance: new Cesium.PolylineMaterialAppearance({ material: glow }),
          classificationType: Cesium.ClassificationType.BOTH,
          asynchronous: true,
        }),
      );
    }
    lamps.entities.removeAll();
    const warm = Cesium.Color.fromCssColorString('#ffe2a8');
    for (const [lon, lat] of points)
      lamps.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 5,
          color: warm,
          outlineColor: Cesium.Color.fromCssColorString(WARM).withAlpha(0.45),
          outlineWidth: 5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(200, 1.4, 8000, 0.4),
        },
      });
    status = `${ways.length} lit roads · ${points.length} lamps`;
    governorRequestRender('adam-night-streets');
  }

  let factor = 0;
  function update() {
    const center = getCenter();
    const sun = sunPosition(environment.currentDate(), center.lat, center.lon);
    factor = nightFactor(sun.altitude);
    syncTileLayer(factor);
    if (globeLayer) {
      const perPixel = perPixelNight();
      globeLayer.alpha = perPixel ? 1 : factor;
      globeLayer.show = perPixel || factor > 0.02;
    }
    const altM = viewer.camera.positionCartographic.height;
    const wantStreets = factor > 0.15 && altM < STREET_MAX_ALT_M;
    lamps.show = wantStreets;
    if (roads) roads.show = wantStreets;
    glow.uniforms.color = Cesium.Color.fromCssColorString(WARM).withAlpha(
      0.35 + 0.6 * factor,
    );
    if (wantStreets)
      loadStreets(center, altM).catch((error) => {
        if (error?.name !== 'AbortError')
          status = `street lights unavailable (${error.message})`;
      });
    governorRequestRender('adam-night-lights');
  }

  const unsubscribe = environment.subscribe(update);
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(update);
  const timer = setInterval(update, 30_000);
  update();

  return {
    update,
    state: () => ({ factor: +factor.toFixed(2), streets: status || 'idle' }),
    destroy() {
      clearInterval(timer);
      unsubscribe();
      removeMoveEnd();
      controller?.abort();
      clearStreets();
      viewer.dataSources.remove(lamps, true);
      viewer.imageryLayers.remove(globeLayer, true);
      if (tileLayer && tileHost?.imageryLayers && !tileHost.isDestroyed?.())
        tileHost.imageryLayers.remove(tileLayer, true);
    },
  };
}
