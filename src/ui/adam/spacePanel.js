/**
 * SPACE: the solar system around the globe.
 *
 *   orrery        the planets where they are today (or ±1 year with the
 *                 slider), the main asteroid belt with its Kirkwood gaps;
 *                 inner or whole system
 *   in your sky   each planet's distance, light-time and whether it is up
 *                 from the centre of the view
 *   asteroids     near-Earth asteroids passing close in the next 60 days
 *                 (NASA/JPL), with size, speed, miss distance, and what it
 *                 would do if it hit — drawn as a hypothetical footprint on
 *                 the globe on request
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import './spacePanel.css';
import {
  asteroidBelt,
  impactEffects,
  orbitPath,
  planetPositions,
  PLANETS,
} from '../../space/solarSystem.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'space';
const LABEL_TODAY = 'today';
const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const fmt = (n, d = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: d })
    : '—';

export function installSpacePanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  let dayOffset = 0;
  let scope = 'inner';
  let approaches = null;
  let approachNote = '';
  const belt = asteroidBelt(1400);

  const footprint = new Cesium.CustomDataSource('adam-impact');
  viewer.dataSources.add(footprint);
  cleanups.push(() => viewer.dataSources.remove(footprint, true));

  function viewCenter() {
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

  const date = () => new Date(Date.now() + dayOffset * 86_400_000);

  async function loadApproaches() {
    try {
      const r = await fetchImpl('/api/space/close-approaches');
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || r.status);
      approaches = b.approaches || [];
      approachNote = `${approaches.length} close approaches in the next 60 days · NASA/JPL`;
    } catch (error) {
      approaches = [];
      approachNote = `close-approach feed unavailable (${error.message})`;
    }
    render();
  }

  /** Hypothetical impact footprint at a point: severe damage, windows, burns. */
  function showImpact({
    lat,
    lon,
    diameterM,
    velocityKms,
    name = 'hypothetical impact',
  }) {
    const hit = impactEffects(diameterM, velocityKms);
    footprint.entities.removeAll();
    const at = Cesium.Cartesian3.fromDegrees(lon, lat);
    const rings = [
      ['windows break (1 psi)', hit.windowsKm, '#FFD60A'],
      ['burns', hit.thermalBurnsKm, '#FF8C1A'],
      ['severe damage (5 psi)', hit.severeDamageKm, '#FF3B30'],
    ].filter(([, km]) => km > 0.05);
    for (const [, km, color] of rings) {
      const c = Cesium.Color.fromCssColorString(color);
      footprint.entities.add({
        position: at,
        ellipse: {
          semiMajorAxis: km * 1000,
          semiMinorAxis: km * 1000,
          material: c.withAlpha(0.1),
          outline: true,
          outlineColor: c,
          height: 0,
        },
      });
    }
    footprint.entities.add({
      position: at,
      label: {
        text: `${name} · ${fmt(hit.energyMt, 2)} Mt · hypothetical`,
        font: '600 12px "ADAM Sans", sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#061015').withAlpha(0.8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const reach = Math.max(...rings.map((r) => r[1]), 5);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        Math.max(40_000, reach * 4000),
      ),
      duration: 1.6,
    });
    governorRequestRender('impact');
    return {
      ok: true,
      hypothetical: true,
      energyMt: +hit.energyMt.toFixed(3),
      hiroshimas: Math.round(hit.hiroshimas),
      severeDamageKm: hit.severeDamageKm,
      windowsKm: hit.windowsKm,
      thermalBurnsKm: hit.thermalBurnsKm,
      craterKm: hit.craterKm,
      note: 'illustrative scaling from energy (airburst overpressure); not a forecast — no listed asteroid is on a collision course',
    };
  }

  // ── Orrery ─────────────────────────────────────────────────────────────
  function drawOrrery(canvas) {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = canvas.clientWidth || 400;
    const h = canvas.clientHeight || 300;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#04080b';
    ctx.fillRect(0, 0, w, h);
    const extent = scope === 'inner' ? 3.6 : 31;
    const s = (Math.min(w, h) / 2 - 12) / extent;
    const cx = w / 2;
    const cy = h / 2;
    const at = date();
    // Belt.
    ctx.fillStyle = 'rgba(200, 190, 170, 0.35)';
    for (const [x, y] of belt) ctx.fillRect(cx + x * s, cy - y * s, 1, 1);
    // Orbits.
    for (const p of PLANETS) {
      if (scope === 'inner' && p.el[0] > 4) continue;
      ctx.beginPath();
      orbitPath(p, at, 160).forEach(([x, y], i) =>
        i
          ? ctx.lineTo(cx + x * s, cy - y * s)
          : ctx.moveTo(cx + x * s, cy - y * s),
      );
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Sun.
    ctx.fillStyle = '#ffd36b';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    // Planets.
    const font =
      getComputedStyle(doc.documentElement).getPropertyValue(
        '--adam-font-sans',
      ) || 'sans-serif';
    ctx.font = `11px ${font}`;
    for (const p of planetPositions(at)) {
      if (scope === 'inner' && p.sunDistanceAu > 4) continue;
      const x = cx + p.x * s;
      const y = cy - p.y * s;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.name === 'earth' ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(230, 244, 246, 0.85)';
      ctx.fillText(p.name, x + 6, y - 5);
    }
    ctx.fillStyle = 'rgba(200, 212, 218, 0.6)';
    ctx.fillText(
      `${at.toISOString().slice(0, 10)} · top view of the ecliptic${scope === 'inner' ? ' · to the asteroid belt' : ''}`,
      8,
      h - 8,
    );
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space');
  card.id = 'adam-space';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Space');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(el(doc, 'h2', 'adam-ops-title', LABEL_TITLE), close);
    const body = el(doc, 'div', 'adam-ops-body adam-volc-body');

    const canvas = el(doc, 'canvas', 'adam-space-orrery');
    const controls = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    for (const [id, label] of [
      ['inner', 'inner system'],
      ['outer', 'whole system'],
    ]) {
      const b = el(
        doc,
        'button',
        `adam-chip${scope === id ? ' is-on' : ''}`,
        label,
      );
      b.type = 'button';
      b.addEventListener('click', () => {
        scope = id;
        render();
      });
      controls.append(b);
    }
    const slider = el(doc, 'input', 'adam-space-days');
    slider.type = 'range';
    slider.min = '-365';
    slider.max = '365';
    slider.value = String(dayOffset);
    const when = el(
      doc,
      'span',
      'adam-volc-note',
      dayOffset ? `${dayOffset > 0 ? '+' : ''}${dayOffset} days` : LABEL_TODAY,
    );
    slider.addEventListener('input', () => {
      dayOffset = Number(slider.value);
      when.textContent = dayOffset
        ? `${dayOffset > 0 ? '+' : ''}${dayOffset} days`
        : LABEL_TODAY;
      drawOrrery(canvas);
    });
    body.append(canvas, controls, slider, when);

    // Planets in your sky.
    const c = viewCenter();
    body.append(
      el(
        doc,
        'h3',
        'adam-meta adam-ops-section',
        `planets · from ${c.lat.toFixed(1)}, ${c.lon.toFixed(1)}`,
      ),
    );
    const table = el(doc, 'div', 'adam-space-planets');
    for (const p of planetPositions(date(), c)) {
      if (p.name === 'earth') continue;
      const rowEl = el(doc, 'div', 'adam-space-planet');
      const dot = el(doc, 'span', 'adam-volc-swatch');
      dot.style.background = p.color;
      rowEl.append(
        dot,
        el(doc, 'span', 'adam-space-name', p.name),
        el(
          doc,
          'span',
          'adam-space-sub',
          `${fmt(p.earthDistanceAu, 2)} au · ${fmt(p.lightMinutes, 1)} light-min`,
        ),
        el(
          doc,
          'span',
          `adam-space-up${p.altitudeDeg > 0 ? ' is-up' : ''}`,
          p.altitudeDeg > 0
            ? `up ${Math.round(p.altitudeDeg)}° · az ${Math.round(p.azimuthDeg)}°`
            : 'below horizon',
        ),
      );
      table.append(rowEl);
    }
    body.append(table);

    // Asteroids.
    body.append(
      el(doc, 'h3', 'adam-meta adam-ops-section', 'asteroids passing close'),
    );
    if (approachNote) body.append(el(doc, 'p', 'adam-volc-note', approachNote));
    for (const a of (approaches || []).slice(0, 15)) {
      const item = el(doc, 'div', 'adam-space-neo');
      item.append(
        el(doc, 'div', 'adam-volc-name', `${a.name} · ${a.closeApproach}`),
        el(
          doc,
          'div',
          'adam-volc-sub',
          `${fmt(a.distanceLunar, 2)} lunar distances · ${fmt(a.diameterM)} m · ${fmt(a.velocityKms, 1)} km/s`,
        ),
      );
      if (a.ifItHit) {
        item.append(
          el(
            doc,
            'div',
            'adam-volc-sub',
            `if it hit: ${fmt(a.ifItHit.energyMt, a.ifItHit.energyMt < 1 ? 2 : 0)} Mt · severe damage to ${fmt(a.ifItHit.severeDamageKm, 1)} km`,
          ),
        );
        const show = el(doc, 'button', 'adam-chip', 'footprint at view centre');
        show.type = 'button';
        show.addEventListener('click', () => {
          const p = viewCenter();
          showImpact({
            ...p,
            diameterM: a.diameterM,
            velocityKms: a.velocityKms,
            name: a.name,
          });
        });
        item.append(show);
      }
      body.append(item);
    }
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'planet positions from JPL approximate elements; the belt is illustrative (real asteroids, real gaps). Impact footprints are hypothetical scaling from energy, not forecasts.',
      ),
    );

    const scroll = card.querySelector('.adam-volc-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
    requestAnimationFrame(() => drawOrrery(canvas));
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        doc.querySelector('#adam-ops-flyout .adam-ops-close')?.click();
      render();
      if (!approaches) void loadApproaches();
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Planets, the asteroid belt and near-Earth asteroids';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(card.hidden));
  const dock = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    const keys = [...rail.children].find((c) => /keys/i.test(c.textContent));
    rail.insertBefore(chip, keys || null);
    return true;
  };
  if (!dock()) {
    let tries = 0;
    const t = setInterval(() => {
      if (dock() || (tries += 1) > 40) clearInterval(t);
    }, 250);
    cleanups.push(() => clearInterval(t));
  }
  cleanups.push(() => chip.remove());
  const onRailClick = (event) => {
    const target = event.target.closest?.('.adam-ops-rail-btn');
    if (target && target !== chip && !card.hidden) setOpen(false);
  };
  doc.addEventListener('click', onRailClick, true);
  cleanups.push(() => doc.removeEventListener('click', onRailClick, true));
  const onKey = (event) => {
    if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    planets: () => {
      const c = viewCenter();
      return planetPositions(new Date(), c)
        .filter((p) => p.name !== 'earth')
        .map((p) => ({
          name: p.name,
          distanceAu: +p.earthDistanceAu.toFixed(3),
          lightMinutes: p.lightMinutes,
          upFromView: p.altitudeDeg > 0,
          altitudeDeg: Math.round(p.altitudeDeg),
          azimuthDeg: Math.round(p.azimuthDeg),
        }));
    },
    async asteroids() {
      if (!approaches) await loadApproaches();
      return {
        note: approachNote,
        approaches: (approaches || []).slice(0, 15),
      };
    },
    showImpact,
    clearImpact() {
      footprint.entities.removeAll();
      governorRequestRender('impact');
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
