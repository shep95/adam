/**
 * What the live environment draws ON the globe, not just in the panel:
 *
 *   terminator     day/night line, plus civil, nautical and astronomical
 *                  dusk lines — they sweep across the planet as time runs
 *   sun / moon     markers at the subsolar and sublunar points
 *   shadow arrow   at the view centre, pointing where shadows fall, its
 *                  length proportional to shadow length
 *   colour grade   a post-process exposure + tint from the real sun altitude
 *                  at the view centre (golden hour, blue hour, night). This is
 *                  what makes photoreal tiles — which ignore scene lighting —
 *                  change with the time of day
 *   fog            scene fog density from reported visibility
 *
 * Refreshes every second while time plays, every 30 s live, and on camera
 * settle.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { isEffectsReduced, subscribeEffectsBudget } from '../frameBudget.js';
import {
  ambientGrade,
  shadowGeometry,
  subsolarPoint,
  sublunarPoint,
  sunAltitudeRing,
  sunPosition,
} from './astronomy.js';

const RAD = 180 / Math.PI;

const GRADE_SHADER = `
uniform sampler2D colorTexture;
uniform float exposure;
uniform vec3 tint;
uniform float tintAmount;
in vec2 v_textureCoordinates;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  // Light sources stay lit: bright pixels (city lights, lamps, beacons) are
  // spared the night exposure and the tint, so they glow instead of dimming.
  float srcLuma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float keep = smoothstep(0.5, 0.85, srcLuma);
  vec3 graded = c.rgb * exposure;
  float luma = dot(graded, vec3(0.299, 0.587, 0.114));
  graded = mix(graded, luma * tint * 1.35, tintAmount);
  graded = mix(graded, c.rgb * 1.1, keep * (1.0 - exposure));
  out_FragColor = vec4(graded, c.a);
}`;

/** 1 below 50 km camera altitude, fading to 0 by 1,500 km. */
export function gradeStrengthForAltitude(altM) {
  if (!Number.isFinite(altM)) return 0;
  if (altM <= 50_000) return 1;
  if (altM >= 1_500_000) return 0;
  return 1 - Math.log(altM / 50_000) / Math.log(1_500_000 / 50_000);
}

/** Split a ring at the antimeridian so polylines never draw across the globe. */
export function splitAtAntimeridian(ring) {
  const parts = [];
  let current = [];
  for (let i = 0; i < ring.length; i += 1) {
    if (i > 0 && Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
      if (current.length > 1) parts.push(current);
      current = [];
    }
    current.push(ring[i]);
  }
  if (current.length > 1) parts.push(current);
  return parts;
}

/** Destination point from (lat, lon) along a bearing, in degrees / metres. */
export function destination(lat, lon, bearingDeg, distanceM) {
  const R = 6_371_000;
  const d = distanceM / R;
  const b = bearingDeg / RAD;
  const p1 = lat / RAD;
  const l1 = lon / RAD;
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2),
    );
  return { lat: p2 * RAD, lon: l2 * RAD };
}

const LINES = [
  { alt: 0, color: '#ffd27a', alpha: 0.85, width: 2 },
  { alt: -6, color: '#f5a623', alpha: 0.45, width: 1.2 },
  { alt: -12, color: '#7fa7ff', alpha: 0.35, width: 1 },
  { alt: -18, color: '#5a6fd0', alpha: 0.25, width: 1 },
];

export function createGlobeSky({ viewer, environment, getCenter }) {
  const scene = viewer.scene;
  const source = new Cesium.CustomDataSource('adam-sky');
  viewer.dataSources.add(source);
  const state = { terminator: true, grade: true, markers: true };
  let visibilityM = null;

  // Colour grade.
  const uniforms = {
    exposure: 1,
    tint: new Cesium.Cartesian3(1, 1, 1),
    tintAmount: 0,
  };
  let stage = null;
  try {
    stage = scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: 'adam_ambient_grade',
        fragmentShader: GRADE_SHADER,
        uniforms,
      }),
    );
  } catch {
    stage = null;
  }

  const lineEntities = LINES.map((line, index) => ({
    line,
    index,
    entities: [],
  }));
  const sunMarker = source.entities.add({
    id: 'adam-sky-sun',
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    point: {
      pixelSize: 14,
      color: Cesium.Color.fromCssColorString('#ffd27a'),
      outlineColor: Cesium.Color.fromCssColorString('#fff3cf').withAlpha(0.6),
      outlineWidth: 6,
    },
  });
  const moonMarker = source.entities.add({
    id: 'adam-sky-moon',
    position: Cesium.Cartesian3.fromDegrees(0, 0),
    point: {
      pixelSize: 11,
      color: Cesium.Color.fromCssColorString('#dfe8f5'),
      outlineColor: Cesium.Color.fromCssColorString('#9fb4d6').withAlpha(0.5),
      outlineWidth: 4,
    },
  });
  const shadowArrow = source.entities.add({
    id: 'adam-sky-shadow',
    polyline: {
      positions: [],
      width: 10,
      clampToGround: true,
      material: new Cesium.PolylineArrowMaterialProperty(
        Cesium.Color.fromCssColorString('#0b1a2a').withAlpha(0.75),
      ),
    },
  });
  const sunRay = source.entities.add({
    id: 'adam-sky-sunray',
    polyline: {
      positions: [],
      width: 2,
      clampToGround: true,
      material: new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.fromCssColorString('#ffd27a').withAlpha(0.8),
        dashLength: 10,
      }),
    },
  });

  function drawLines(date) {
    for (const slot of lineEntities) {
      for (const e of slot.entities) source.entities.remove(e);
      slot.entities = [];
      if (!state.terminator) continue;
      const ring = sunAltitudeRing(date, slot.line.alt, 240);
      for (const part of splitAtAntimeridian(ring)) {
        slot.entities.push(
          source.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(part.flat()),
              width: slot.line.width,
              arcType: Cesium.ArcType.NONE,
              material: Cesium.Color.fromCssColorString(
                slot.line.color,
              ).withAlpha(slot.line.alpha),
            },
          }),
        );
      }
    }
  }

  function update() {
    const date = environment.currentDate();
    const center = getCenter();
    const sun = sunPosition(date, center.lat, center.lon);
    drawLines(date);
    const ss = subsolarPoint(date);
    const sl = sublunarPoint(date);
    sunMarker.show = state.markers;
    moonMarker.show = state.markers;
    sunMarker.position = Cesium.Cartesian3.fromDegrees(ss.lon, ss.lat, 0);
    moonMarker.position = Cesium.Cartesian3.fromDegrees(sl.lon, sl.lat, 0);

    // Shadow arrow sized to the view: a 12%-of-altitude "reference object".
    const shadow = shadowGeometry(sun);
    const alt = viewer.camera.positionCartographic.height;
    const show = state.markers && alt < 60_000;
    if (shadow && show) {
      const len = Math.min(
        alt * 0.35,
        Math.max(30, alt * 0.06 * Math.min(shadow.lengthRatio, 6)),
      );
      const tip = destination(center.lat, center.lon, shadow.towardDeg, len);
      shadowArrow.polyline.positions = Cesium.Cartesian3.fromDegreesArray([
        center.lon,
        center.lat,
        tip.lon,
        tip.lat,
      ]);
      const src = destination(center.lat, center.lon, sun.azimuth, alt * 0.12);
      sunRay.polyline.positions = Cesium.Cartesian3.fromDegreesArray([
        src.lon,
        src.lat,
        center.lon,
        center.lat,
      ]);
      shadowArrow.show = true;
      sunRay.show = true;
    } else {
      shadowArrow.show = false;
      sunRay.show = false;
    }

    if (stage) {
      const g = ambientGrade(sun.altitude);
      const lit = environment.snapshot().lighting;
      // Time of day is local: full grade near the ground, none at globe scale
      // (where the terminator and globe lighting already tell the story).
      const f = gradeStrengthForAltitude(alt);
      stage.enabled = state.grade && lit && f > 0.01 && !isEffectsReduced();
      uniforms.exposure = 1 + (g.exposure - 1) * f;
      uniforms.tint = new Cesium.Cartesian3(...g.tint);
      uniforms.tintAmount = g.tintAmount * f;
    }
    if (scene.fog) {
      scene.fog.enabled = true;
      scene.fog.density =
        visibilityM != null && visibilityM < 10_000
          ? Math.min(0.004, 12 / Math.max(200, visibilityM) / 100)
          : 2.0e-4;
    }
    governorRequestRender('adam-sky');
  }

  const unsubscribeBudget = subscribeEffectsBudget(() => update());
  let timer = null;
  function schedule() {
    clearInterval(timer);
    timer = setInterval(update, environment.snapshot().playing ? 1000 : 30_000);
  }
  const unsubscribe = environment.subscribe(() => {
    schedule();
    update();
  });
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(update);
  schedule();
  update();

  return {
    update,
    setWeather(weather) {
      visibilityM = Number.isFinite(weather?.visibilityM)
        ? weather.visibilityM
        : null;
      update();
    },
    set(options = {}) {
      for (const key of ['terminator', 'grade', 'markers'])
        if (typeof options[key] === 'boolean') state[key] = options[key];
      update();
      return { ...state };
    },
    state: () => ({ ...state }),
    destroy() {
      clearInterval(timer);
      unsubscribe();
      unsubscribeBudget();
      removeMoveEnd();
      if (stage) scene.postProcessStages.remove(stage);
      viewer.dataSources.remove(source, true);
    },
  };
}
