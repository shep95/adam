/**
 * Globe interaction extras:
 *
 *   local time   the wall-clock time where the camera is looking, under the
 *                coordinate readout, at 40% opacity (e.g. "CDT 18:42:07")
 *   search pin   every location search ends on a precision pin at the spot
 *   right-click  copy coordinates · drop pin · ask Shepherd about here ·
 *                live sky here · alert zone here · 3D buildings
 *   icon guard   icons and logos cannot be dragged out or saved via the
 *                context menu
 */
import './mapInteraction.css';
import * as Cesium from 'cesium';
import {
  loadTzLookup,
  zoneFor,
  formatZoneTime,
} from '../../shepherd/localTime.js';

const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Surface point under a canvas pixel, in degrees, or null off-globe. */
export function pickLatLon(viewer, x, y) {
  const scene = viewer.scene;
  let cartesian = null;
  if (scene.pickPositionSupported) {
    try {
      cartesian = scene.pickPosition(new Cesium.Cartesian2(x, y));
    } catch {
      cartesian = null;
    }
  }
  if (!cartesian) {
    const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
    cartesian = ray ? scene.globe.pick(ray, scene) : null;
  }
  if (!cartesian)
    cartesian = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(x, y),
      scene.globe.ellipsoid,
    );
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return null;
  return {
    lat: carto.latitude * RAD,
    lon: carto.longitude * RAD,
    heightM: carto.height,
  };
}

export function formatCoords(lat, lon) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

export function installMapInteraction({
  viewer,
  overlay,
  buildings,
  room,
  intel,
  getSkyPanel = () => null,
  getEnvironment = () => null,
  doc = document,
}) {
  const cleanups = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // ── Local time under the coordinate readout ──────────────────────────────
  const timeLine = el(doc, 'div', 'adam-local-time', '');
  timeLine.id = 'hud-localtime';
  const mountTime = () => {
    const anchor = doc.getElementById('hud-latlon');
    if (!anchor) return false;
    anchor.after(timeLine);
    return true;
  };
  if (!mountTime()) {
    doc.body.append(timeLine);
    timeLine.classList.add('is-floating');
  }
  cleanups.push(() => timeLine.remove());
  let tz = null;
  loadTzLookup()
    .then((fn) => {
      tz = fn;
      tickTime();
    })
    .catch(() => {});
  function tickTime() {
    if (!tz) return;
    const carto = viewer.camera.positionCartographic;
    const zone = zoneFor(tz, carto.latitude * RAD, carto.longitude * RAD);
    const z = formatZoneTime(zone);
    timeLine.textContent = z
      ? `${z.abbr} ${z.time}  ${z.zone.replace(/_/g, ' ').toLowerCase()}`
      : '';
  }
  const timer = setInterval(tickTime, 1000);
  cleanups.push(() => clearInterval(timer));

  // ── Search results end on a precision pin ────────────────────────────────
  on(globalThis, 'adam:place-located', (event) => {
    const { lat, lon, label } = event.detail || {};
    overlay.dropPin({ lat, lon, label, fly: false });
  });

  // ── Right-click menu ─────────────────────────────────────────────────────
  const menu = el(doc, 'div', 'adam-panel adam-ctx');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  doc.body.append(menu);
  cleanups.push(() => menu.remove());

  const close = () => {
    menu.hidden = true;
  };

  function item(label, hint, action) {
    const b = el(doc, 'button', 'adam-ctx-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el(doc, 'span', 'adam-ctx-label', label));
    if (hint) b.append(el(doc, 'span', 'adam-ctx-hint', hint));
    b.addEventListener('click', () => {
      close();
      action();
    });
    return b;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function openAt(x, y, point) {
    const { lat, lon } = point;
    const coords = formatCoords(lat, lon);
    const head = el(doc, 'div', 'adam-ctx-head', coords);
    const items = [
      item('copy coordinates', 'lat, lon', async () => {
        head.textContent = (await copy(coords)) ? 'copied' : coords;
      }),
      item('drop pin', '', () => overlay.dropPin({ lat, lon, fly: false })),
      item('fly here', '', () => overlay.flyToPoint(lat, lon, 1200)),
      item('ask shepherd about here', 'S', () =>
        room.ask(
          `what is at ${coords}? give me the osint picture for this spot — infrastructure, activity, anything notable — and mark it on the map.`,
        ),
      ),
      item('live sky here', 'L', () => {
        overlay.flyToPoint(lat, lon, 2500);
        getSkyPanel()?.open();
      }),
      item('alert zone · 25 nm', 'aircraft', () => {
        const ring = [];
        const km = 25 * 1.852;
        for (let i = 0; i < 48; i += 1) {
          const a = (i / 48) * Math.PI * 2;
          ring.push([
            lon + (km / (111.32 * Math.cos(lat / RAD))) * Math.cos(a),
            lat + (km / 111.32) * Math.sin(a),
          ]);
        }
        const rule = intel?.alerts?.add?.({
          kind: 'count-in-zone',
          layerKey: 'flights',
          ring,
          threshold: 0,
          label: `aircraft within 25 nm of ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
        });
        head.textContent = rule ? 'alert armed' : 'alert rejected';
      }),
      item(
        buildings.isOn() ? '3d buildings · off' : '3d buildings · on',
        '',
        () => void buildings.toggle(),
      ),
    ];
    if (getEnvironment()?.snapshot().mode !== 'live')
      items.push(item('back to live time', '', () => getEnvironment().live()));
    menu.replaceChildren(head, ...items);
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(x, globalThis.innerWidth - w - 8)}px`;
    menu.style.top = `${Math.min(y, globalThis.innerHeight - h - 8)}px`;
    menu.querySelector('button')?.focus({ preventScroll: true });
  }

  const canvas = viewer.scene.canvas;
  on(canvas, 'contextmenu', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const point = pickLatLon(
      viewer,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (point) openAt(event.clientX, event.clientY, point);
  });
  on(
    doc,
    'pointerdown',
    (event) => {
      if (!menu.hidden && !menu.contains(event.target)) close();
    },
    true,
  );
  on(doc, 'keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) close();
  });
  const removeMove = viewer.camera.moveStart.addEventListener(close);
  cleanups.push(removeMove);

  // ── 3D buildings chip on the ops rail ────────────────────────────────────
  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn adam-3d-chip');
  chip.type = 'button';
  chip.title =
    '3D buildings: photoreal tiles with a key, OpenStreetMap footprints without';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', '3D'));
  chip.addEventListener('click', async () => {
    chip.disabled = true;
    try {
      await buildings.toggle();
    } finally {
      chip.disabled = false;
      chip.setAttribute('aria-pressed', String(buildings.isOn()));
      chip.title = `3D buildings: ${buildings.state()}`;
    }
  });
  const dockChip = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    const keys = [...rail.children].find((c) => c.textContent.includes('KEYS'));
    rail.insertBefore(chip, keys || null);
    return true;
  };
  if (!dockChip()) {
    let tries = 0;
    const t = setInterval(() => {
      if (dockChip() || (tries += 1) > 40) clearInterval(t);
    }, 250);
    cleanups.push(() => clearInterval(t));
  }
  cleanups.push(() => chip.remove());

  // ── Icon guard ───────────────────────────────────────────────────────────
  const ICONS =
    'img, svg, .material-symbols-outlined, [class*="logo"], [class*="icon"]';
  on(
    doc,
    'dragstart',
    (event) => {
      if (event.target?.closest?.(ICONS)) event.preventDefault();
    },
    true,
  );
  on(
    doc,
    'contextmenu',
    (event) => {
      if (event.target !== canvas && event.target?.closest?.(ICONS))
        event.preventDefault();
    },
    true,
  );
  on(
    doc,
    'copy',
    (event) => {
      const selection = doc.getSelection?.();
      const node = selection?.anchorNode?.parentElement;
      if (node?.closest?.(ICONS)) event.preventDefault();
    },
    true,
  );

  return {
    openAt,
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* gone */
        }
      }
    },
  };
}
