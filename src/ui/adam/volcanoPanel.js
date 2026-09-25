/**
 * VOLCANOES: every volcano on land and under the sea, the ones on alert now,
 * and what an eruption would reach.
 *
 *   globe      all Holocene volcanoes (Smithsonian GVP) — orange on land,
 *              blue under the sea; USGS elevated alerts ringed in their colour
 *   pick one   fly there and draw hazard rings for an eruption size (VEI
 *              slider, starting at its largest recorded eruption)
 *
 * Offline, the notable set that ships with the app stands in.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  NOTABLE_VOLCANOES,
  clampVei,
  findVolcanoes,
  hazardRings,
} from '../../intel/volcanoes.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'volcanoes';
const ALERT_COLORS = {
  RED: '#FF3B30',
  ORANGE: '#FF8C1A',
  YELLOW: '#FFD60A',
  GREEN: '#34C759',
};

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installVolcanoPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  let all = NOTABLE_VOLCANOES.slice();
  let liveCount = 0;
  let elevated = [];
  let feedNote = '';
  let query = '';
  let filter = 'all';
  let selected = null;
  let vei = 3;
  let showAll = false;

  const markers = new Cesium.CustomDataSource('adam-volcanoes');
  const rings = new Cesium.CustomDataSource('adam-volcano-hazard');
  viewer.dataSources.add(markers);
  viewer.dataSources.add(rings);
  cleanups.push(() => {
    viewer.dataSources.remove(markers, true);
    viewer.dataSources.remove(rings, true);
  });

  async function loadLive() {
    const [gvp, hans] = await Promise.allSettled([
      fetchImpl('/api/volcanoes').then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(r.status)),
      ),
      fetchImpl('/api/volcanoes/elevated').then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(r.status)),
      ),
    ]);
    if (gvp.status === 'fulfilled' && gvp.value.volcanoes?.length) {
      const notable = new Map(
        NOTABLE_VOLCANOES.map((v) => [v.name.toLowerCase(), v]),
      );
      all = gvp.value.volcanoes.map((v) => ({
        ...v,
        vei: notable.get(v.name.toLowerCase())?.vei ?? null,
      }));
      for (const n of NOTABLE_VOLCANOES)
        if (
          !all.some(
            (v) =>
              Math.abs(v.lat - n.lat) < 0.05 && Math.abs(v.lon - n.lon) < 0.05,
          )
        )
          all.push(n);
      liveCount = gvp.value.volcanoes.length;
    }
    if (hans.status === 'fulfilled') elevated = hans.value.volcanoes || [];
    feedNote =
      gvp.status === 'fulfilled'
        ? `${liveCount.toLocaleString('en-US')} volcanoes from the Smithsonian catalogue`
        : `${NOTABLE_VOLCANOES.length} notable volcanoes (live catalogue unreachable)`;
    if (showAll) drawMarkers();
    render();
  }

  function drawMarkers() {
    markers.entities.removeAll();
    if (!showAll) return governorRequestRender('volcanoes');
    const land = Cesium.Color.fromCssColorString('#FF6B2C');
    const sea = Cesium.Color.fromCssColorString('#3FA9F5');
    for (const v of all)
      markers.entities.add({
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat),
        point: {
          pixelSize: v.source === 'notable' ? 7 : 5,
          color: v.submarine ? sea : land,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          scaleByDistance: new Cesium.NearFarScalar(2e5, 1.4, 2e7, 0.6),
          disableDepthTestDistance: 5e6,
        },
        properties: { volcano: v.name },
      });
    for (const e of elevated) {
      const color = Cesium.Color.fromCssColorString(
        ALERT_COLORS[e.color] || '#FFD60A',
      );
      markers.entities.add({
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat),
        point: {
          pixelSize: 14,
          color: color.withAlpha(0.25),
          outlineColor: color,
          outlineWidth: 2,
        },
        label: {
          text: `${e.name} · ${String(e.alert || e.color || '').toLowerCase()}`,
          font: '500 12px "ADAM Sans", sans-serif',
          fillColor: color,
          pixelOffset: new Cesium.Cartesian2(12, 0),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8e6),
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
        },
      });
    }
    governorRequestRender('volcanoes');
  }

  function drawRings() {
    rings.entities.removeAll();
    if (!selected) return governorRequestRender('volcanoes');
    const plan = hazardRings(vei, { submarine: selected.submarine });
    const center = Cesium.Cartesian3.fromDegrees(selected.lon, selected.lat);
    for (const r of plan.rings) {
      const color = Cesium.Color.fromCssColorString(r.color);
      rings.entities.add({
        position: center,
        ellipse: {
          semiMajorAxis: r.km * 1000,
          semiMinorAxis: r.km * 1000,
          material: color.withAlpha(r.kind === 'lightAsh' ? 0.05 : 0.12),
          outline: true,
          outlineColor: color.withAlpha(0.85),
          height: 0,
        },
      });
    }
    rings.entities.add({
      position: center,
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString(
          selected.submarine ? '#3FA9F5' : '#FF6B2C',
        ),
      },
      label: {
        text: `${selected.name} · VEI ${vei}`,
        font: '600 13px "ADAM Sans", sans-serif',
        fillColor: Cesium.Color.WHITE,
        pixelOffset: new Cesium.Cartesian2(12, -12),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#061015').withAlpha(0.8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    governorRequestRender('volcanoes');
  }

  function select(v, { fly = true, eruption } = {}) {
    selected = v;
    vei = clampVei(eruption ?? v.vei ?? 3);
    drawRings();
    if (fly) {
      const reach = hazardRings(vei).rings[0]?.km || 20;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          v.lon,
          v.lat,
          Math.max(60_000, Math.min(6_000_000, reach * 2600)),
        ),
        duration: 1.8,
      });
    }
    render();
    return summary();
  }

  function summary() {
    if (!selected) return null;
    const plan = hazardRings(vei, { submarine: selected.submarine });
    return {
      volcano: selected.name,
      country: selected.country,
      setting: selected.submarine ? 'undersea' : 'land',
      lastActivity: selected.lastActivity,
      largestRecordedVei: selected.vei,
      projectedVei: vei,
      rings: plan.rings.map((r) => ({ what: r.label, radiusKm: r.km })),
      notes: [
        ...plan.notes,
        'illustrative distances by eruption size; real reach depends on vent, wind and terrain',
      ],
      alert:
        elevated.find(
          (e) => e.name.toLowerCase() === selected.name.toLowerCase(),
        ) || null,
    };
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-volcanoes');
  card.id = 'adam-volcanoes';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Volcanoes');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function row(v) {
    const b = el(
      doc,
      'button',
      `adam-volc-row${selected === v ? ' is-on' : ''}`,
    );
    b.type = 'button';
    b.append(
      el(doc, 'span', `adam-volc-dot ${v.submarine ? 'is-sea' : 'is-land'}`),
      el(doc, 'span', 'adam-volc-name', v.name),
      el(
        doc,
        'span',
        'adam-volc-sub',
        [
          v.country,
          v.submarine ? 'undersea' : null,
          v.vei != null ? `vei ${v.vei}` : null,
          v.lastActivity ? `last ${v.lastActivity}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    b.addEventListener('click', () => select(v));
    return b;
  }

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(
      el(doc, 'h2', 'adam-ops-title', LABEL_TITLE),
      close,
      el(
        doc,
        'p',
        'adam-meta adam-ops-sub',
        feedNote || 'loading the catalogue…',
      ),
    );
    const body = el(doc, 'div', 'adam-ops-body adam-volc-body');

    const controls = el(doc, 'div', 'adam-volc-controls');
    const globe = el(doc, 'label', 'adam-volc-toggle');
    const cb = el(doc, 'input');
    cb.type = 'checkbox';
    cb.checked = showAll;
    cb.addEventListener('change', () => {
      showAll = cb.checked;
      drawMarkers();
    });
    globe.append(cb, el(doc, 'span', '', 'show all on the globe'));
    const search = el(doc, 'input', 'adam-input adam-volc-search');
    search.type = 'search';
    search.placeholder = 'volcano or country';
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value;
      renderList();
      search.focus();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const kinds = el(doc, 'div', 'adam-volc-kinds');
    for (const [id, label] of [
      ['all', 'all'],
      ['land', 'land'],
      ['sea', 'undersea'],
    ]) {
      const k = el(
        doc,
        'button',
        `adam-chip${filter === id ? ' is-on' : ''}`,
        label,
      );
      k.type = 'button';
      k.addEventListener('click', () => {
        filter = id;
        render();
      });
      kinds.append(k);
    }
    controls.append(globe, search, kinds);
    body.append(controls);

    if (selected) {
      const plan = hazardRings(vei, { submarine: selected.submarine });
      const box = el(doc, 'div', 'adam-volc-hazard');
      box.append(
        el(
          doc,
          'div',
          'adam-volc-selected',
          `${selected.name}${selected.country ? ` · ${selected.country}` : ''}`,
        ),
      );
      const slider = el(doc, 'input', 'adam-volc-vei');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '8';
      slider.value = String(vei);
      const veiLabel = el(
        doc,
        'span',
        'adam-volc-vei-label',
        `eruption size · VEI ${vei}`,
      );
      slider.addEventListener('input', () => {
        vei = clampVei(slider.value);
        veiLabel.textContent = `eruption size · VEI ${vei}`;
        drawRings();
        renderRings();
      });
      const ringsList = el(doc, 'ul', 'adam-volc-rings');
      const renderRings = () => {
        const p = hazardRings(vei, { submarine: selected.submarine });
        ringsList.replaceChildren(
          ...p.rings.map((r) => {
            const li = el(doc, 'li');
            const sw = el(doc, 'span', 'adam-volc-swatch');
            sw.style.background = r.color;
            li.append(
              sw,
              el(
                doc,
                'span',
                '',
                `${r.label} — ${r.km.toLocaleString('en-US')} km`,
              ),
            );
            return li;
          }),
          ...p.notes.map((n) => el(doc, 'li', 'adam-volc-note', n)),
        );
      };
      renderRings();
      box.append(veiLabel, slider, ringsList);
      box.append(
        el(
          doc,
          'p',
          'adam-volc-note',
          `largest recorded: VEI ${selected.vei ?? 'unknown'} · distances are illustrative for an eruption of this size; real reach depends on the vent, wind and terrain.`,
        ),
      );
      const clear = el(doc, 'button', 'adam-chip', 'clear rings');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        selected = null;
        drawRings();
        render();
      });
      box.append(clear);
      body.append(box);
    }

    if (elevated.length) {
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          `on alert now · usgs · ${elevated.length}`,
        ),
      );
      const list = el(doc, 'div', 'adam-volc-list');
      for (const e of elevated) {
        const v = all.find(
          (x) => x.name.toLowerCase() === e.name.toLowerCase(),
        ) || { ...e, vei: null, submarine: false, country: 'United States' };
        const b = row(v);
        const tag = el(
          doc,
          'span',
          'adam-volc-alert',
          String(e.alert || e.color || '').toLowerCase(),
        );
        tag.style.color = ALERT_COLORS[e.color] || '#FFD60A';
        b.append(tag);
        list.append(b);
      }
      body.append(list);
    }

    const listHead = el(doc, 'h3', 'adam-meta adam-ops-section');
    const list = el(doc, 'div', 'adam-volc-list');
    body.append(listHead, list);
    function renderList() {
      const pool = all.filter(
        (v) =>
          filter === 'all' || (filter === 'sea' ? v.submarine : !v.submarine),
      );
      const hits = query.trim()
        ? findVolcanoes(pool, query, 40)
        : pool.filter((v) => v.source === 'notable').slice(0, 80);
      listHead.textContent = query.trim()
        ? `matches · ${hits.length}`
        : 'notable';
      list.replaceChildren(...hits.map(row));
      if (!hits.length)
        list.append(el(doc, 'p', 'adam-volc-note', 'no volcano matches'));
    }
    renderList();
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Smithsonian Global Volcanism Program; alert levels from the USGS Volcano Hazards Program.',
      ),
    );

    const scroll = card.querySelector('.adam-volc-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        doc.querySelector('#adam-ops-flyout .adam-ops-close')?.click();
      render();
      if (!liveCount) void loadLive();
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Volcanoes on land and under the sea, alerts, eruption reach';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(card.hidden));
  const dock = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    const keys = [...rail.children].find(
      (c) => c.textContent.includes('keys') || c.textContent.includes('KEYS'),
    );
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
    /** Shepherd: find a volcano, draw its hazard rings, report distances. */
    async project({ name, lat, lon, vei: size } = {}) {
      if (!liveCount) await loadLive().catch(() => {});
      let v = name ? findVolcanoes(all, name, 1)[0] : null;
      if (!v && Number.isFinite(lat) && Number.isFinite(lon))
        v = all.reduce((best, x) => {
          const d = Math.hypot(
            x.lat - lat,
            (x.lon - lon) * Math.cos((lat * Math.PI) / 180),
          );
          return !best || d < best.d ? { d, x } : best;
        }, null)?.x;
      if (!v)
        return {
          ok: false,
          error: `no volcano matches ${name || `${lat}, ${lon}`}`,
        };
      setOpen(true);
      return { ok: true, ...select(v, { eruption: size }) };
    },
    async showAll(on = true) {
      showAll = Boolean(on);
      if (!liveCount) await loadLive().catch(() => {});
      drawMarkers();
      render();
      return {
        ok: true,
        shown: showAll ? all.length : 0,
        elevated: elevated.map((e) => ({
          name: e.name,
          alert: e.alert,
          color: e.color,
        })),
      };
    },
    list: () => ({ total: all.length, live: liveCount > 0, elevated }),
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
