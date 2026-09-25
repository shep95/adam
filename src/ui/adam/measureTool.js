/**
 * MEASURE (top action bar): click the globe to measure.
 *
 *   LINE      range and bearing per leg and in total
 *   AREA      polygon area and perimeter
 *   RINGS     range rings around a point (4 radii in the chosen unit)
 *   CORRIDOR  a band of chosen half-width along a path
 *
 * Great-circle or rhumb, km / nm / mi. Any shape can be saved as a named
 * ZONE — kept across reloads, drawn on the globe, usable by alert triggers
 * and known to Shepherd. Double-click or Enter finishes; Esc cancels.
 */
import * as Cesium from 'cesium';
import './measureTool.css';
import {
  circleRing,
  corridorRing,
  formatArea,
  formatBearing,
  formatDistance,
  greatCirclePath,
  measurePath,
  polygonAreaKm2,
  rhumbPath,
} from '../../intel/geoMeasure.js';
import { governorRequestRender } from '../../renderGovernor.js';

const RAD = 180 / Math.PI;
const MODES = ['line', 'area', 'rings', 'corridor'];
const MODE_LABEL = {
  line: 'LINE',
  area: 'AREA',
  rings: 'RINGS',
  corridor: 'CORRIDOR',
};
const RING_STEPS = {
  km: [10, 25, 50, 100],
  nm: [5, 10, 25, 50],
  mi: [5, 10, 25, 50],
};
const UNIT_KM = { km: 1, nm: 1.852, mi: 1.609344 };
const CYAN = Cesium.Color.fromCssColorString('#00BCD4');
const AMBER = Cesium.Color.fromCssColorString('#f5a623');
const LABEL_SAVE = 'SAVE ZONE';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function installMeasureTool({ viewer, intel, doc = document }) {
  const bar = doc.getElementById('top-center-actions');
  const cleanups = [];
  const drawSource = new Cesium.CustomDataSource('adam-measure');
  const zoneSource = new Cesium.CustomDataSource('adam-zones');
  viewer.dataSources.add(drawSource);
  viewer.dataSources.add(zoneSource);
  cleanups.push(() => {
    viewer.dataSources.remove(drawSource, true);
    viewer.dataSources.remove(zoneSource, true);
  });

  const state = {
    active: false,
    mode: 'line',
    rhumb: false,
    unit: 'km',
    widthKm: 5,
    points: [],
    hover: null,
    done: false,
  };

  // ── Toolbar button + panel ───────────────────────────────────────────────
  const btn = el(doc, 'button', 'adam-cap-btn adam-measure-btn');
  btn.type = 'button';
  btn.title = 'Measure: range, bearing, area, rings, corridors';
  btn.setAttribute('aria-label', 'Measure');
  btn.setAttribute('aria-pressed', 'false');
  const icon = el(doc, 'span', 'material-symbols-outlined', 'straighten');
  icon.setAttribute('aria-hidden', 'true');
  btn.append(icon);
  bar?.append(btn);
  cleanups.push(() => btn.remove());

  const panel = el(doc, 'section', 'adam-panel adam-measure');
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Measure');
  doc.body.append(panel);
  cleanups.push(() => panel.remove());

  function chip(label, pressed, onClick, title) {
    const b = el(doc, 'button', 'adam-measure-chip', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(pressed)));
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function readout() {
    const p = state.points;
    const u = state.unit;
    if (state.mode === 'rings') {
      if (!p.length) return 'Click a centre point.';
      return `Rings ${RING_STEPS[u].join(' / ')} ${u} around ${p[0].lat.toFixed(4)}, ${p[0].lon.toFixed(4)}`;
    }
    const pts = state.hover && !state.done ? [...p, state.hover] : p;
    if (pts.length < 2)
      return 'Click points on the globe. Double-click or Enter to finish.';
    const m = measurePath(pts, { rhumbLine: state.rhumb });
    const legs = m.legs
      .slice(-3)
      .map((l) => `${formatDistance(l.km, u)} @ ${formatBearing(l.bearingDeg)}`)
      .join(' · ');
    if (state.mode === 'area' && pts.length >= 3) {
      const perim = m.totalKm + measurePath([pts.at(-1), pts[0]]).totalKm;
      return `AREA ${formatArea(polygonAreaKm2(pts), u)} · PERIMETER ${formatDistance(perim, u)}`;
    }
    if (state.mode === 'corridor')
      return `LENGTH ${formatDistance(m.totalKm, u)} · WIDTH ±${formatDistance(state.widthKm, u)}`;
    return `TOTAL ${formatDistance(m.totalKm, u)}${m.legs.length > 1 ? ` · ${legs}` : ` @ ${formatBearing(m.legs[0].bearingDeg)}`}`;
  }

  function renderPanel() {
    panel.replaceChildren();
    const modes = el(doc, 'div', 'adam-measure-row');
    for (const m of MODES)
      modes.append(
        chip(MODE_LABEL[m], state.mode === m, () => {
          state.mode = m;
          reset();
        }),
      );
    const opts = el(doc, 'div', 'adam-measure-row');
    opts.append(
      chip(
        state.rhumb ? 'RHUMB' : 'GREAT CIRCLE',
        true,
        () => {
          state.rhumb = !state.rhumb;
          redraw();
        },
        'Toggle great-circle / rhumb line',
      ),
    );
    for (const u of ['km', 'nm', 'mi'])
      opts.append(
        chip(u.toUpperCase(), state.unit === u, () => {
          state.unit = u;
          redraw();
        }),
      );
    if (state.mode === 'corridor')
      for (const w of [1, 5, 10, 25])
        opts.append(
          chip(
            `±${w}`,
            Math.abs(state.widthKm - w * UNIT_KM[state.unit]) < 1e-6,
            () => {
              state.widthKm = w * UNIT_KM[state.unit];
              redraw();
            },
          ),
        );
    const out = el(doc, 'p', 'adam-measure-readout', readout());
    out.setAttribute('aria-live', 'polite');
    const actions = el(doc, 'div', 'adam-measure-row');
    const name = el(doc, 'input', 'adam-input adam-measure-name');
    name.placeholder = 'ZONE NAME';
    name.maxLength = 60;
    name.addEventListener('keydown', (e) => e.stopPropagation());
    actions.append(
      name,
      chip(LABEL_SAVE, false, () => saveZone(name.value)),
      chip('CLEAR', false, () => reset()),
    );
    panel.append(modes, opts, out, actions);
    const zones = intel?.listZones?.() || [];
    if (zones.length) {
      const list = el(doc, 'div', 'adam-measure-zones');
      list.append(el(doc, 'span', 'adam-meta', `ZONES · ${zones.length}`));
      for (const z of zones) {
        const row = el(doc, 'div', 'adam-measure-zone');
        row.append(el(doc, 'span', '', `${z.name} · ${z.kind}`));
        const del = chip(
          '×',
          false,
          () => {
            intel.removeZone(z.id);
            renderPanel();
          },
          'Delete zone',
        );
        row.append(del);
        list.append(row);
      }
      panel.append(list);
    }
  }

  // ── Geometry ─────────────────────────────────────────────────────────────
  function shapeRing() {
    const p = state.points;
    if (state.mode === 'rings' && p.length)
      return circleRing(
        p[0],
        RING_STEPS[state.unit].at(-1) * UNIT_KM[state.unit],
      );
    if (state.mode === 'area' && p.length >= 3)
      return p.map((q) => [q.lon, q.lat]);
    if (state.mode === 'corridor' && p.length >= 2)
      return corridorRing(p, state.widthKm);
    return null;
  }

  function pathPoints(pts, closed = false) {
    const out = [];
    const seq = closed ? [...pts, pts[0]] : pts;
    for (let i = 1; i < seq.length; i += 1) {
      const leg = state.rhumb
        ? rhumbPath(seq[i - 1], seq[i], 24)
        : greatCirclePath(seq[i - 1], seq[i], 24);
      out.push(...(i === 1 ? leg : leg.slice(1)));
    }
    return out;
  }

  const toCart = (pts) =>
    Cesium.Cartesian3.fromDegreesArray(pts.flatMap((p) => [p.lon, p.lat]));

  function label(pos, text, color = CYAN) {
    drawSource.entities.add({
      position: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat),
      label: {
        text,
        font: '600 12px "ADAM Mono", monospace',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -14),
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#060A0C').withAlpha(0.78),
        backgroundPadding: new Cesium.Cartesian2(6, 3),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function redraw() {
    drawSource.entities.removeAll();
    const u = state.unit;
    const p = state.points;
    for (const q of p)
      drawSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat),
        point: {
          pixelSize: 7,
          color: CYAN,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    if (state.mode === 'rings' && p.length) {
      for (const r of RING_STEPS[u]) {
        const ring = circleRing(p[0], r * UNIT_KM[u]);
        drawSource.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              [...ring, ring[0]].flat(),
            ),
            width: 1.5,
            material: CYAN.withAlpha(0.85),
            clampToGround: true,
          },
        });
        label(
          { lat: p[0].lat + (r * UNIT_KM[u]) / 111.2, lon: p[0].lon },
          `${r} ${u}`,
        );
      }
    } else {
      const pts = state.hover && !state.done ? [...p, state.hover] : p;
      if (pts.length >= 2) {
        const closed = state.mode === 'area' && pts.length >= 3;
        drawSource.entities.add({
          polyline: {
            positions: toCart(pathPoints(pts, closed)),
            width: 3,
            material: CYAN,
            clampToGround: true,
          },
        });
        const m = measurePath(pts, { rhumbLine: state.rhumb });
        m.legs.forEach((leg, i) => {
          const a = pts[i];
          const b = pts[i + 1];
          label(
            { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 },
            `${formatDistance(leg.km, u)} · ${formatBearing(leg.bearingDeg)}`,
          );
        });
        if (state.mode === 'corridor') {
          const ring = corridorRing(pts, state.widthKm);
          drawSource.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
              material: CYAN.withAlpha(0.12),
            },
          });
        }
        if (closed)
          drawSource.entities.add({
            polygon: {
              hierarchy: toCart(pts),
              material: CYAN.withAlpha(0.1),
            },
          });
      }
    }
    renderPanel();
    governorRequestRender('adam-measure');
  }

  function drawZones() {
    zoneSource.entities.removeAll();
    for (const z of intel?.listZones?.() || []) {
      const ring = z.ring;
      zoneSource.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            [...ring, ring[0]].flat(),
          ),
          width: 1.5,
          material: new Cesium.PolylineDashMaterialProperty({
            color: AMBER.withAlpha(0.85),
            dashLength: 12,
          }),
          clampToGround: true,
        },
      });
      const c = ring.reduce(
        (s, [lon, lat]) => [s[0] + lon, s[1] + lat],
        [0, 0],
      );
      zoneSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(
          c[0] / ring.length,
          c[1] / ring.length,
        ),
        label: {
          text: z.name.toUpperCase(),
          font: '600 10px "ADAM Mono", monospace',
          fillColor: AMBER,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4e6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    governorRequestRender('adam-zones');
  }
  drawZones();
  const unsubscribe = intel?.subscribe?.((type) => {
    if (type === 'zones-changed') drawZones();
  });
  if (unsubscribe) cleanups.push(unsubscribe);

  function saveZone(name) {
    const ring = shapeRing();
    if (!ring) {
      const out = panel.querySelector('.adam-measure-readout');
      if (out) out.textContent = 'Draw an area, rings or a corridor first.';
      return null;
    }
    const zone = intel?.addZone?.({
      name,
      kind:
        state.mode === 'rings'
          ? 'circle'
          : state.mode === 'corridor'
            ? 'corridor'
            : 'polygon',
      ring,
      meta: {
        radiusKm:
          state.mode === 'rings'
            ? RING_STEPS[state.unit].at(-1) * UNIT_KM[state.unit]
            : null,
        widthKm: state.mode === 'corridor' ? state.widthKm : null,
        areaKm2: polygonAreaKm2(ring.map(([lon, lat]) => ({ lat, lon }))),
      },
    });
    reset();
    return zone;
  }

  function reset() {
    state.points = [];
    state.hover = null;
    state.done = false;
    redraw();
  }

  // ── Input ────────────────────────────────────────────────────────────────
  function pick(position) {
    const ray = viewer.camera.getPickRay(position);
    const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
    if (!hit) return null;
    const c = Cesium.Cartographic.fromCartesian(hit);
    return { lat: c.latitude * RAD, lon: c.longitude * RAD };
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  cleanups.push(() => handler.destroy());
  handler.setInputAction((e) => {
    if (!state.active) return;
    const p = pick(e.position);
    if (!p) return;
    if (state.done) reset();
    if (state.mode === 'rings') {
      state.points = [p];
      state.done = true;
    } else state.points.push(p);
    viewer.selectedEntity = undefined;
    redraw();
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction((e) => {
    if (!state.active || state.done || !state.points.length) return;
    state.hover = pick(e.endPosition);
    redraw();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(() => {
    if (!state.active) return;
    state.done = true;
    state.hover = null;
    redraw();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  const onKey = (e) => {
    if (!state.active || e.target?.closest?.('input, textarea')) return;
    if (e.key === 'Enter') {
      state.done = true;
      state.hover = null;
      redraw();
    } else if (e.key === 'Escape') setActive(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  function setActive(on) {
    state.active = Boolean(on);
    panel.hidden = !state.active;
    btn.setAttribute('aria-pressed', String(state.active));
    doc.body.classList.toggle('adam-measuring', state.active);
    if (!state.active) reset();
    else renderPanel();
  }
  btn.addEventListener('click', () => setActive(!state.active));

  return {
    setActive,
    /** Programmatic measurement (Shepherd): points [{lat, lon}]. */
    measure(points, { rhumbLine = false, unit = 'km', draw = true } = {}) {
      const m = measurePath(points, { rhumbLine });
      if (draw) {
        state.mode = 'line';
        state.rhumb = rhumbLine;
        state.unit = UNIT_KM[unit] ? unit : 'km';
        state.points = points.slice();
        state.done = true;
        redraw();
      }
      return {
        totalKm: m.totalKm,
        total: formatDistance(m.totalKm, unit),
        legs: m.legs.map((l) => ({
          km: l.km,
          distance: formatDistance(l.km, unit),
          bearing: formatBearing(l.bearingDeg),
        })),
        method: rhumbLine ? 'rhumb' : 'great circle',
      };
    },
    rings(center, { unit = 'km' } = {}) {
      state.mode = 'rings';
      state.unit = UNIT_KM[unit] ? unit : 'km';
      state.points = [center];
      state.done = true;
      redraw();
      return { radii: RING_STEPS[state.unit], unit: state.unit };
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* already gone */
        }
      }
      doc.body.classList.remove('adam-measuring');
    },
  };
}
