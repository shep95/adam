/**
 * Hints at the moment they are useful, not a tour. A small card fades in
 * near the bottom when something you can do becomes relevant, offers the
 * one-click action, and fades out on its own:
 *
 *   down among streets     street view · what's here · 3d buildings
 *   an aircraft tracked    cockpit view · path ahead
 *   a vessel tracked       path ahead · sanctions check
 *   night under the view   night vision
 *
 * Each shows once per session; settings can turn them off.
 */
import './contextHints.css';
import { sunPosition } from '../../environment/astronomy.js';

export const HINTS_OFF_KEY = 'adam.hints.off';
const SEEN_KEY = 'adam.hints.seen.v1';
const SHOW_MS = 8000;
const STREET_ALT_M = 4000;
const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function streetViewUrl(lat, lon) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function mapillaryUrl(lat, lon) {
  return `https://www.mapillary.com/app/?lat=${lat.toFixed(6)}&lng=${lon.toFixed(6)}&z=17`;
}

/** Which hint (if any) the current situation calls for. */
export function pickHint(s, seen = new Set()) {
  const ok = (id) => !seen.has(id);
  if (s.tracked?.aircraft && ok(`cockpit:${s.tracked.id}`)) return 'cockpit';
  if (s.tracked?.vessel && ok(`vessel:${s.tracked.id}`)) return 'vessel';
  if (
    Number.isFinite(s.altM) &&
    s.altM < STREET_ALT_M &&
    s.overLand &&
    ok('street')
  )
    return 'street';
  if (s.night && !s.nightVision && s.altM < 3_000_000 && ok('night'))
    return 'night';
  return null;
}

export function installContextHints({
  viewer,
  intel,
  doc = document,
  storage = globalThis.localStorage,
  session = globalThis.sessionStorage,
  getConsole = () => globalThis.__godsEyeView || {},
}) {
  const cleanups = [];
  const seen = new Set(
    (() => {
      try {
        return JSON.parse(session?.getItem(SEEN_KEY) || '[]');
      } catch {
        return [];
      }
    })(),
  );
  const markSeen = (id) => {
    seen.add(id);
    try {
      session?.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-100)));
    } catch {
      /* ignore */
    }
  };
  const off = () => {
    try {
      return storage?.getItem(HINTS_OFF_KEY) === '1';
    } catch {
      return false;
    }
  };

  const card = el(doc, 'div', 'adam-hint');
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  card.hidden = true;
  doc.body.append(card);
  cleanups.push(() => card.remove());
  let hideTimer = null;
  let hovering = false;
  card.addEventListener('mouseenter', () => {
    hovering = true;
    clearTimeout(hideTimer);
  });
  card.addEventListener('mouseleave', () => {
    hovering = false;
    schedule();
  });
  function schedule() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hovering) hide();
    }, SHOW_MS);
  }
  function hide() {
    card.classList.remove('is-shown');
    setTimeout(() => {
      if (!card.classList.contains('is-shown')) card.hidden = true;
    }, 400);
  }

  function show(text, actions) {
    const body = el(doc, 'div', 'adam-hint-body');
    body.append(el(doc, 'span', 'adam-hint-text', text));
    const row = el(doc, 'div', 'adam-hint-actions');
    for (const [label, fn] of actions) {
      const b = el(doc, 'button', 'adam-hint-btn', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        hide();
        fn();
      });
      row.append(b);
    }
    const x = el(doc, 'button', 'adam-hint-close', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', hide);
    card.replaceChildren(body, row, x);
    card.hidden = false;
    requestAnimationFrame(() => card.classList.add('is-shown'));
    schedule();
  }

  function center() {
    const scene = viewer.scene;
    const c = scene.canvas;
    const ray = viewer.camera.getPickRay({
      x: c.clientWidth / 2,
      y: c.clientHeight / 2,
    });
    const hit = ray && scene.globe.pick(ray, scene);
    const carto = hit
      ? scene.globe.ellipsoid.cartesianToCartographic(hit)
      : viewer.camera.positionCartographic;
    return { lat: carto.latitude * RAD, lon: carto.longitude * RAD };
  }

  function situation() {
    const altM = viewer.camera.positionCartographic.height;
    const ref = intel?.getLastTracked?.();
    const tracked = ref?.record
      ? {
          id: `${ref.layerKey}:${ref.value}`,
          aircraft: ref.layerKey === 'flights' || ref.layerKey === 'military',
          vessel: ref.layerKey === 'ais-live-vessels',
          label: ref.label || ref.value,
          ref,
        }
      : null;
    const c = center();
    const date = getConsole().environment?.currentDate?.() || new Date();
    const sun = sunPosition(date, c.lat, c.lon);
    return {
      altM,
      tracked,
      center: c,
      overLand: altM < STREET_ALT_M, // close in: cities, roads — the hint is harmless over water
      night: Number.isFinite(sun?.altitude) ? sun.altitude < -6 : false,
      nightVision: Boolean(getConsole().nightVision?.isEnabled?.()),
    };
  }

  function check() {
    if (off()) return;
    let s;
    try {
      s = situation();
    } catch {
      return;
    }
    const hint = pickHint(s, seen);
    if (!hint) return;
    const con = getConsole();
    const exec = con.shepherd?.executor;
    if (hint === 'cockpit') {
      markSeen(`cockpit:${s.tracked.id}`);
      show(
        `${s.tracked.label}: ride along in the cockpit, or see where it's heading.`,
        [
          [
            'cockpit view',
            () =>
              exec?.run('control_cockpit', {
                action: 'enter',
                targetLayer: s.tracked.ref.layerKey,
              }),
          ],
          ['path ahead', () => con.opsDeck?.showAhead?.()],
        ],
      );
    } else if (hint === 'vessel') {
      markSeen(`vessel:${s.tracked.id}`);
      show(
        `${s.tracked.label}: the dashed line is where it's heading on its course.`,
        [
          [
            'sanctions check',
            () =>
              con.shepherd?.room?.ask?.(
                `run sanctions_check (schema Vessel) for ${s.tracked.label} and tell me whether it matches any list.`,
              ),
          ],
        ],
      );
    } else if (hint === 'street') {
      markSeen('street');
      const { lat, lon } = s.center;
      show('down among the streets — look around at ground level.', [
        [
          'street view',
          () => globalThis.open(streetViewUrl(lat, lon), '_blank', 'noopener'),
        ],
        ["what's here", () => con.placeDossier?.open?.(lat, lon)],
        ['3d buildings', () => con.shepherd?.buildings?.toggle?.()],
      ]);
    } else if (hint === 'night') {
      markSeen('night');
      show("it's night under you — night vision keeps the map readable.", [
        ['night vision', () => con.settings?.set?.({ night: 'nvg' })],
      ]);
    }
  }

  const removeMove = viewer.camera.moveEnd.addEventListener(() =>
    setTimeout(check, 600),
  );
  cleanups.push(removeMove);
  const unsubscribe = intel?.subscribe?.((type) => {
    if (type === 'last-tracked-changed') setTimeout(check, 900);
  });
  if (unsubscribe) cleanups.push(unsubscribe);

  return {
    check,
    show,
    setEnabled(on) {
      try {
        if (on) storage?.removeItem(HINTS_OFF_KEY);
        else storage?.setItem(HINTS_OFF_KEY, '1');
      } catch {
        /* ignore */
      }
      if (!on) hide();
    },
    destroy() {
      clearTimeout(hideTimer);
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
