/**
 * Hover context: rest the cursor on the globe and a small card says what is
 * there — a strait and its traffic, the zone or mission area you drew, a
 * watch item nearby, open water or which time zone's land, and local time.
 * Stays out of the way of entity picks (their own cards win) and never
 * appears while measuring or dragging.
 */
import * as Cesium from 'cesium';
import './hoverContext.css';
import { hoverLines } from './hoverContextModel.js';
import {
  formatZoneTime,
  loadTzLookup,
  zoneFor,
} from '../../shepherd/localTime.js';

const IDLE_MS = 550;
const RAD = 180 / Math.PI;

export function installHoverContext({ viewer, intel, doc = document }) {
  const card = doc.createElement('div');
  card.className = 'adam-hover';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  doc.body.append(card);

  let tz = null;
  void loadTzLookup().then((fn) => {
    tz = fn;
  });

  let timer = 0;
  let last = null;
  const hide = () => {
    card.hidden = true;
  };

  function show(screen) {
    if (doc.body.classList.contains('adam-measuring')) return;
    const scene = viewer.scene;
    const picked = scene.pick(screen);
    if (picked) return; // entity cards own that point
    const ray = viewer.camera.getPickRay(screen);
    const hit = ray && scene.globe.pick(ray, scene);
    if (!hit) return;
    const c = Cesium.Cartographic.fromCartesian(hit);
    const p = { lat: c.latitude * RAD, lon: c.longitude * RAD };
    const zone = tz ? zoneFor(tz, p.lat, p.lon) : null;
    const t = zone ? formatZoneTime(zone) : null;
    let watch = [];
    try {
      watch = intel?.triage?.({ limit: 20 }) || [];
    } catch {
      watch = [];
    }
    const lines = hoverLines(p, {
      zone,
      localTime: t ? `${t.time.slice(0, 5)} ${t.abbr}` : null,
      zones: intel?.listZones?.() || [],
      mission: intel?.getMission?.() || null,
      watch,
    });
    card.replaceChildren(
      ...lines.map((text, i) => {
        const row = doc.createElement('div');
        row.className = i === 0 ? 'adam-hover-lead' : 'adam-hover-line';
        row.textContent = text;
        return row;
      }),
    );
    const rect = scene.canvas.getBoundingClientRect();
    card.style.left = `${rect.left + screen.x + 14}px`;
    card.style.top = `${rect.top + screen.y + 14}px`;
    card.hidden = false;
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((e) => {
    hide();
    clearTimeout(timer);
    last = Cesium.Cartesian2.clone(e.endPosition);
    timer = setTimeout(() => show(last), IDLE_MS);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  for (const type of [
    Cesium.ScreenSpaceEventType.LEFT_DOWN,
    Cesium.ScreenSpaceEventType.RIGHT_DOWN,
    Cesium.ScreenSpaceEventType.WHEEL,
  ])
    handler.setInputAction(() => {
      clearTimeout(timer);
      hide();
    }, type);
  const onLeave = () => {
    clearTimeout(timer);
    hide();
  };
  viewer.scene.canvas.addEventListener('mouseleave', onLeave);

  return {
    destroy() {
      clearTimeout(timer);
      handler.destroy();
      viewer.scene.canvas.removeEventListener('mouseleave', onLeave);
      card.remove();
    },
  };
}
