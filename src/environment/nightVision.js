/**
 * Night vision for the night side: the map stays readable after dark.
 *
 * While it is on, the globe's day/night shading is lifted so the imagery,
 * roads, coasts and every overlay show at full strength, and the part of the
 * Earth where the sun is down gets a phosphor-green tint so you still know
 * where night is. Which pixels are night comes from geometry — each pixel's
 * view ray is intersected with the ellipsoid and the surface normal compared
 * with the sun's direction — so space, sky and the day side are untouched.
 * Coloured overlays (tracks, markers, labels in colour) keep their colours.
 */
import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';

export const NVG_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform float tint;
  uniform float debugMask;
  in vec2 v_textureCoordinates;

  // View ray through this pixel, intersected with the ellipsoid.
  // Returns the surface normal (world), or vec3(0) when the ray misses.
  vec3 surfaceNormal(vec2 uv) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
    vec4 far = czm_inverseViewProjection * ndc;
    vec3 point = far.xyz / far.w;
    vec3 origin = czm_viewerPositionWC;
    vec3 dir = normalize(point - origin);
    vec3 o = origin * czm_ellipsoidInverseRadii;
    vec3 d = dir * czm_ellipsoidInverseRadii;
    float a = dot(d, d);
    float b = dot(o, d);
    float c = dot(o, o) - 1.0;
    float disc = b * b - a * c;
    if (disc < 0.0) return vec3(0.0);
    float t = (-b - sqrt(disc)) / a;
    if (t < 0.0) return vec3(0.0);
    vec3 hit = o + d * t; // on the unit sphere of the scaled ellipsoid
    return normalize(hit * czm_ellipsoidInverseRadii);
  }

  void main() {
    vec4 color = texture(colorTexture, v_textureCoordinates);
    vec3 n = surfaceNormal(v_textureCoordinates);
    if (dot(n, n) < 0.5) {
      out_FragColor = color; // space and sky
      return;
    }
    float sunDot = dot(n, normalize(czm_sunDirectionWC));
    float night = smoothstep(0.06, -0.10, sunDot);

    // Coloured overlays stay as drawn.
    float maxC = max(color.r, max(color.g, color.b));
    float minC = min(color.r, min(color.g, color.b));
    float saturation = maxC > 0.0 ? (maxC - minC) / maxC : 0.0;
    float keep = smoothstep(0.4, 0.65, saturation) * step(0.3, maxC);
    float w = night * (1.0 - keep);

    if (debugMask > 0.5) {
      out_FragColor = vec4(night, keep, color.b, 1.0);
      return;
    }
    float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 green = vec3(0.5, 1.0, 0.58) * (lum * 1.1 + 0.03);
    vec3 nvg = mix(color.rgb * 0.9, green, tint);
    out_FragColor = vec4(mix(color.rgb, nvg, w), color.a);
  }
`;

export function createNightVision({
  viewer,
  nightLights = null,
  tint = 0.6,
} = {}) {
  const scene = viewer.scene;
  const globe = scene.globe;
  let stage = null;
  let enabled = false;
  let debugMask = false;
  let saved = null;

  function ensureStage() {
    if (stage) return stage;
    stage = new Cesium.PostProcessStage({
      name: 'adam-night-vision',
      fragmentShader: NVG_SHADER,
      uniforms: {
        tint: () => tint,
        debugMask: () => (debugMask ? 1 : 0),
      },
    });
    stage.enabled = false;
    scene.postProcessStages.add(stage);
    return stage;
  }

  // Keep the shading lifted while on, even if the environment re-applies it.
  const hold = () => {
    if (enabled && globe.enableLighting) globe.enableLighting = false;
  };
  const removeHold = scene.preRender.addEventListener(hold);

  function set(on) {
    const next = Boolean(on);
    if (next === enabled) return enabled;
    enabled = next;
    ensureStage().enabled = enabled;
    if (enabled) {
      saved = {
        lighting: globe.enableLighting,
        groundAtmosphere: globe.showGroundAtmosphere,
      };
      globe.enableLighting = false;
      globe.showGroundAtmosphere = false;
      nightLights?.suppress?.(true);
    } else if (saved) {
      globe.enableLighting = saved.lighting;
      globe.showGroundAtmosphere = saved.groundAtmosphere;
      nightLights?.suppress?.(false);
      saved = null;
    }
    governorRequestRender('night-vision');
    return enabled;
  }

  return {
    set,
    toggle: () => set(!enabled),
    isEnabled: () => enabled,
    /** Show the night mask (red) and kept overlays (green) instead. */
    debug(on) {
      debugMask = Boolean(on);
      governorRequestRender('night-vision');
    },
    setTint(t) {
      if (Number.isFinite(t)) tint = Math.max(0, Math.min(1, t));
      governorRequestRender('night-vision');
    },
    destroy() {
      set(false);
      removeHold();
      if (stage && !stage.isDestroyed?.())
        scene.postProcessStages.remove(stage);
      stage = null;
    },
  };
}
