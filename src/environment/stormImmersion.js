/**
 * Fly into weather. Samples the radar/satellite field under and around the
 * camera as it moves (stormField.js), places the camera in the storm's
 * vertical structure, and eases the whole look toward it:
 *
 *   rain        streak density follows reflectivity continuously
 *   darkening   the light drops under a cell (a blue-grey veil)
 *   whiteout    inside the cloud the view closes to grey
 *   fog         globe fog follows the radar-derived visibility
 *   lightning   flashes in and under convective cells; seen from above the
 *               tops, a glow blooms below
 *
 * Where the radar does not cover (outside CONUS), the point observation keeps
 * driving the rain as before, and IR cloud density still shades the view.
 */
import './stormImmersion.css';
import { createStormSampler, stormState } from './stormField.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

const RAD = 180 / Math.PI;
const POLL_MS = 400;
const RESAMPLE_M = 350;
const ACTIVE_BELOW_M = 30_000;
const EASE_S = 0.9;

async function loadPixelsFromUrl(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(256, 256)
      : Object.assign(document.createElement('canvas'), {
          width: 256,
          height: 256,
        });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, 256, 256);
  bitmap.close?.();
  return ctx.getImageData(0, 0, 256, 256).data;
}

const ZERO = Object.freeze({
  rain: 0,
  inCloud: 0,
  darkness: 0,
  visibilityM: 50_000,
  lightning: 0,
  layer: 'clear',
});

export function createStormImmersion({
  viewer,
  weatherFx,
  globeSky,
  doc = document,
  sampler = createStormSampler({ loadPixels: loadPixelsFromUrl }),
}) {
  const veil = doc.createElement('div');
  veil.className = 'adam-storm-veil';
  const cloud = doc.createElement('div');
  cloud.className = 'adam-storm-cloud';
  const bolt = doc.createElement('div');
  bolt.className = 'adam-storm-bolt';
  for (const n of [veil, cloud, bolt]) {
    n.setAttribute('aria-hidden', 'true');
    doc.body.append(n);
  }

  let enabled = true;
  let field = null;
  let fieldAt = null;
  let target = ZERO;
  let current = { ...ZERO };
  let heightAgl = Infinity;
  let sampling = false;
  let raf = 0;
  let last = 0;
  let holding = false;
  let pinned = null;

  function cameraPoint() {
    const carto = viewer.camera.positionCartographic;
    const ground = viewer.scene.globe.getHeight(carto) ?? 0;
    return {
      lat: carto.latitude * RAD,
      lon: carto.longitude * RAD,
      agl: carto.height - (Number.isFinite(ground) ? ground : 0),
    };
  }

  function distM(a, b) {
    const k = 111_320;
    return Math.hypot(
      (a.lat - b.lat) * k,
      (a.lon - b.lon) * k * Math.cos((a.lat * Math.PI) / 180),
    );
  }

  async function poll() {
    if (!enabled || doc.hidden) return;
    const p = cameraPoint();
    heightAgl = p.agl;
    if (p.agl > ACTIVE_BELOW_M) {
      setTarget(ZERO, false);
      return;
    }
    if (pinned) {
      field = pinned;
      setTarget(stormState(field, heightAgl), true);
      return;
    }
    if (!sampling && (!fieldAt || distM(p, fieldAt) > RESAMPLE_M)) {
      sampling = true;
      try {
        field = await sampler.fieldAt(p.lat, p.lon);
        fieldAt = p;
      } catch {
        field = null;
      } finally {
        sampling = false;
      }
    }
    if (field) setTarget(stormState(field, heightAgl), field.radarCovered);
  }

  let radarCovered = false;
  function setTarget(next, covered) {
    target = next;
    radarCovered = covered;
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(step);
    }
  }

  const KEYS = ['rain', 'inCloud', 'darkness', 'lightning'];
  function step(now) {
    raf = 0;
    const dt = Math.min(0.2, (now - last) / 1000);
    last = now;
    const k = 1 - Math.exp(-dt / EASE_S);
    let moving = false;
    for (const key of KEYS) {
      current[key] += (target[key] - current[key]) * k;
      if (Math.abs(target[key] - current[key]) > 0.004) moving = true;
      else current[key] = target[key];
    }
    // Visibility eases in log space so closing in feels continuous.
    const lv = Math.log(current.visibilityM);
    const tv = Math.log(target.visibilityM);
    current.visibilityM = Math.exp(lv + (tv - lv) * k);
    if (Math.abs(tv - lv) > 0.01) moving = true;
    current.layer = target.layer;
    apply();
    if (moving) {
      if (!holding) {
        holdContinuousRender('adam-storm');
        holding = true;
      }
      raf = requestAnimationFrame(step);
    } else if (holding) {
      releaseContinuousRender('adam-storm');
      holding = false;
    }
  }

  let flashTimer = 0;
  function apply() {
    const c = current;
    veil.style.opacity = String(Math.min(0.78, c.darkness * 0.85));
    cloud.style.opacity = String(Math.min(0.94, c.inCloud * 0.94));
    globeSky?.setStormVisibility?.(
      c.visibilityM < 45_000 ? c.visibilityM : null,
    );
    if (radarCovered) {
      weatherFx?.setOverride?.({
        kind: weatherFx.observedKind?.() === 'snow' ? 'snow' : 'rain',
        intensity: c.rain,
        thunder: c.lightning > 0.1 && c.layer !== 'above',
        lightning: c.lightning,
      });
    } else weatherFx?.setOverride?.(null);
    bolt.dataset.layer = c.layer;
  }

  // Lightning inside the cloud or seen from above: its own flash layer, since
  // weatherFx only draws while rain is falling on the camera.
  function flashLoop() {
    const c = current;
    if (
      enabled &&
      c.lightning > 0.1 &&
      (c.layer === 'inside' || c.layer === 'above') &&
      Math.random() < 0.02 + 0.2 * c.lightning
    ) {
      bolt.classList.remove('is-on');
      void bolt.offsetWidth;
      bolt.classList.add('is-on');
    }
    flashTimer = setTimeout(flashLoop, 700 + Math.random() * 1600);
  }
  flashLoop();

  // A light poll (one camera read, resampling only after 350 m of travel)
  // keeps the field current while flying without touching camera settings.
  const timer = setInterval(() => void poll(), POLL_MS);

  return {
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) {
        target = ZERO;
        current = { ...ZERO };
        apply();
        weatherFx?.setOverride?.(null);
        globeSky?.setStormVisibility?.(null);
      } else void poll();
    },
    state: () => ({
      enabled,
      radarCovered,
      heightAglM: Number.isFinite(heightAgl) ? Math.round(heightAgl) : null,
      layer: current.layer,
      rain: +current.rain.toFixed(2),
      inCloud: +current.inCloud.toFixed(2),
      darkness: +current.darkness.toFixed(2),
      visibilityM: Math.round(current.visibilityM),
      lightning: +current.lightning.toFixed(2),
      reflectivityDbz: field?.dbz ?? null,
      nearestCellKm: field?.nearestKm ?? null,
    }),
    /**
     * Pin a synthetic field (training, demos, QA without a radar feed), e.g.
     * {here:1, approach:1, dbz:55, peakDbz:60, cloud:0.9, lightning:0.8}.
     * null returns to live radar.
     */
    simulate(next) {
      pinned = next
        ? {
            here: 0,
            approach: 0,
            dbz: 0,
            peakDbz: 0,
            cloud: 0,
            lightning: 0,
            nearestKm: null,
            radarCovered: true,
            ...next,
          }
        : null;
      fieldAt = null;
      void poll();
      return Boolean(pinned);
    },
    /** Force a resample (after the radar frame updates). */
    refresh() {
      fieldAt = null;
      void poll();
    },
    destroy() {
      clearInterval(timer);
      clearTimeout(flashTimer);
      cancelAnimationFrame(raf);
      if (holding) releaseContinuousRender('adam-storm');
      weatherFx?.setOverride?.(null);
      globeSky?.setStormVisibility?.(null);
      for (const n of [veil, cloud, bolt]) n.remove();
    },
  };
}
