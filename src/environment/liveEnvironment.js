/**
 * Live environment: the globe lit by the real sun for the moment being
 * shown, with the moon, star field, terrain/building shadows and the time
 * controls that move all of it.
 *
 *   live    the globe clock follows wall time (sun moves as it really does)
 *   offset  a fixed moment, hours before or after now (scrubbing)
 *   play    time runs at a multiplier (60×, 600×, 3600×) from wherever it is
 *
 * Only the scene clock moves. Live contacts (aircraft, vessels, satellites)
 * dead-reckon on wall time, so scrubbing the sky never misplaces a contact.
 */
import * as Cesium from 'cesium';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

const LIVE_REPAINT_MS = 20_000;
const MAX_OFFSET_MS = 7 * 86_400_000;
export const PLAY_SPEEDS = Object.freeze([1, 60, 600, 3600]);

/** Clamp an arbitrary offset request to ±7 days. */
export function clampOffsetMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, n));
}

export function createLiveEnvironment({ viewer }) {
  const scene = viewer.scene;
  const clock = viewer.clock;
  const listeners = new Set();
  // The environment always matches the physical place: sunlight, sky and
  // weather are not operator options. Shadows follow the camera — on close in
  // (where they read and are affordable), off at regional and globe scale.
  const state = {
    lighting: true,
    shadows: false,
    sky: true,
    mode: 'live',
    offsetMs: 0,
    speed: 1,
    playing: false,
  };
  const SHADOW_MAX_ALT_M = 15_000;
  let repaintTimer = null;
  let removeTick = null;

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(snapshot());
      } catch {
        /* listener gone */
      }
    }
  };

  function autoShadows() {
    const want = viewer.camera.positionCartographic.height < SHADOW_MAX_ALT_M;
    if (want === state.shadows) return;
    state.shadows = want;
    applyScene();
    emit();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(autoShadows);

  function applyScene() {
    const globe = scene.globe;
    globe.enableLighting = state.lighting;
    globe.dynamicAtmosphereLighting = state.lighting;
    globe.dynamicAtmosphereLightingFromSun = state.lighting;
    // Cesium fades sun lighting out as the camera nears the ground, so a city
    // at midnight would still read as noon up close. Light at every range.
    globe.lightingFadeOutDistance = state.lighting ? 1 : 1.0e7;
    globe.lightingFadeInDistance = state.lighting ? 2 : 2.0e7;
    globe.nightFadeOutDistance = state.lighting ? 1 : 1.0e7;
    globe.nightFadeInDistance = state.lighting ? 2 : 5.0e7;
    if (!(scene.light instanceof Cesium.SunLight))
      scene.light = new Cesium.SunLight();
    if (scene.sun) scene.sun.show = state.sky;
    if (scene.moon) scene.moon.show = state.sky;
    if (scene.skyBox) scene.skyBox.show = state.sky;
    viewer.shadows = state.shadows;
    if (state.shadows && viewer.shadowMap) {
      viewer.shadowMap.softShadows = true;
      viewer.shadowMap.darkness = 0.35;
      viewer.shadowMap.maximumDistance = 6000;
      viewer.terrainShadows = Cesium.ShadowMode.RECEIVE_ONLY;
    }
    governorRequestRender('adam-environment');
  }

  function currentDate() {
    return Cesium.JulianDate.toDate(clock.currentTime);
  }

  function syncClock() {
    if (state.mode === 'live') {
      clock.currentTime = Cesium.JulianDate.now();
      clock.multiplier = 1;
      clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK;
    } else if (state.mode === 'offset') {
      clock.currentTime = Cesium.JulianDate.fromDate(
        new Date(Date.now() + state.offsetMs),
      );
      clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
      clock.multiplier = state.playing ? state.speed : 0;
    }
    clock.shouldAnimate = true;
  }

  function setPlaying(playing) {
    state.playing = playing && state.speed > 1;
    if (state.playing) holdContinuousRender('adam-environment-play');
    else releaseContinuousRender('adam-environment-play');
  }

  // Keep the offset readout honest while time plays.
  removeTick = clock.onTick.addEventListener(() => {
    if (state.mode === 'offset' && state.playing)
      state.offsetMs = clampOffsetMs(
        Cesium.JulianDate.toDate(clock.currentTime).valueOf() - Date.now(),
      );
  });

  repaintTimer = setInterval(() => {
    if (state.mode === 'live') syncClock();
    governorRequestRender('adam-environment-live');
    emit();
  }, LIVE_REPAINT_MS);

  function snapshot() {
    return {
      ...state,
      date: currentDate(),
    };
  }

  const api = {
    snapshot,
    currentDate,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Return to real time. */
    live() {
      state.mode = 'live';
      state.offsetMs = 0;
      setPlaying(false);
      syncClock();
      applyScene();
      emit();
      return snapshot();
    },
    /** Show a moment `ms` from now (negative = past). */
    setOffset(ms) {
      state.mode = 'offset';
      state.offsetMs = clampOffsetMs(ms);
      syncClock();
      governorRequestRender('adam-environment-scrub');
      emit();
      return snapshot();
    },
    /** Show a specific instant. */
    setDate(date) {
      return api.setOffset(new Date(date).valueOf() - Date.now());
    },
    play(speed = 600) {
      state.speed = PLAY_SPEEDS.includes(Number(speed)) ? Number(speed) : 600;
      if (state.mode === 'live') {
        state.mode = 'offset';
        state.offsetMs = 0;
      }
      setPlaying(true);
      syncClock();
      emit();
      return snapshot();
    },
    pause() {
      setPlaying(false);
      syncClock();
      emit();
      return snapshot();
    },
    destroy() {
      clearInterval(repaintTimer);
      removeMoveEnd();
      removeTick?.();
      releaseContinuousRender('adam-environment-play');
      listeners.clear();
    },
  };

  syncClock();
  applyScene();
  autoShadows();
  return api;
}
