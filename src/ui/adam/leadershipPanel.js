/**
 * LEADERS: who holds public office over a place.
 *
 * Pick a point (the view centre, a click on the globe, or a country) and get
 * the chain of areas containing it — nation → state / province → county →
 * municipality — with each area's current head of state and head of
 * government, office, party and start date. Any area can be opened into its
 * subdivisions and their heads of government, labelled on the globe.
 *
 * Public office from Wikidata. Nothing here locates or follows a person.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  adminAreasQuery,
  normalizeAdminChain,
} from '../../intel/leadership.js';
import { loadNations, findNation } from '../../nations/nationProfile.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'leaders';
const LABEL_PICKING = 'click a place on the globe…';
const RAD = 180 / Math.PI;
const SUB_COLOR = '#64D2FF';

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function holderLine(h) {
  return [
    h.role,
    h.office,
    h.parties?.length ? h.parties.join(', ') : null,
    h.start ? `since ${h.start}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function installLeadershipPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  const marks = new Cesium.CustomDataSource('adam-leadership');
  viewer.dataSources.add(marks);
  cleanups.push(() => viewer.dataSources.remove(marks, true));
  let chain = [];
  let note = '';
  let subs = null;
  let subNote = '';
  let picking = false;
  let token = 0;

  const getJson = async (url, init) => {
    const r = await fetchImpl(url, init);
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
    return b;
  };

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

  async function at({ lat, lon } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon))
      ({ lat, lon } = viewCenter());
    const mine = (token += 1);
    note = 'finding the areas that contain this place…';
    subs = null;
    subNote = '';
    marks.entities.removeAll();
    render();
    try {
      const areas = normalizeAdminChain(
        await getJson('/api/overpass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(adminAreasQuery(lat, lon)),
        }),
      );
      if (mine !== token) return { ok: false, error: 'superseded' };
      if (!areas.length)
        throw new Error('no administrative areas here (open sea?)');
      note = 'reading officeholders from wikidata…';
      chain = areas;
      render();
      const { areas: offices } = await getJson(
        `/api/leadership/officeholders?ids=${areas.map((a) => a.wikidata).join(',')}`,
      );
      if (mine !== token) return { ok: false, error: 'superseded' };
      chain = areas.map((a) => ({
        ...a,
        legislature: offices[a.wikidata]?.legislature || null,
        holders: offices[a.wikidata]?.holders || [],
      }));
      note = `${lat.toFixed(3)}, ${lon.toFixed(3)} · public office from Wikidata`;
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(SUB_COLOR),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      governorRequestRender('leadership');
    } catch (error) {
      if (mine !== token) return { ok: false, error: 'superseded' };
      note = `leadership unavailable (${error.message})`;
      if (!chain.length || !chain[0].holders) chain = [];
    }
    render();
    return summary();
  }

  function summary() {
    return {
      ok: chain.length > 0,
      note,
      chain: chain.map((a) => ({
        level: a.levelName,
        name: a.name,
        wikidata: a.wikidata,
        legislature: a.legislature || undefined,
        officeholders: (a.holders || []).map((h) => ({
          role: h.role,
          name: h.name,
          office: h.office,
          party: h.parties?.join(', ') || undefined,
          since: h.start || undefined,
        })),
      })),
      caveat:
        'current officeholders as recorded in Wikidata; may lag recent elections',
    };
  }

  async function country(name) {
    const n = findNation(await loadNations(), name || '');
    if (!n?.ll) return { ok: false, error: `no country matches “${name}”` };
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(n.ll[1], n.ll[0], 4_000_000),
      duration: 1.4,
    });
    return at({ lat: n.ll[0], lon: n.ll[1] });
  }

  async function subdivisions(id) {
    const area = chain.find((a) => a.wikidata === id) || {
      name: id,
      wikidata: id,
    };
    subNote = `reading the subdivisions of ${area.name}…`;
    render();
    try {
      const b = await getJson(
        `/api/leadership/subdivisions?id=${encodeURIComponent(id)}`,
      );
      subs = { of: area.name, id, list: b.subdivisions };
      subNote = `${b.subdivisions.length} subdivisions of ${area.name} · Wikidata`;
      marks.entities.removeAll();
      for (const s of b.subdivisions) {
        if (!s.coords) continue;
        marks.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.coords[0], s.coords[1]),
          point: {
            pixelSize: 5,
            color: Cesium.Color.fromCssColorString(SUB_COLOR),
          },
          label: {
            text: s.holder ? `${s.name}\n${s.holder.name}` : s.name,
            font: '500 11px "ADAM Sans", sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor:
              Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
            pixelOffset: new Cesium.Cartesian2(8, 0),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              8e6,
            ),
          },
        });
      }
      governorRequestRender('leadership');
    } catch (error) {
      subs = null;
      subNote = `subdivisions unavailable (${error.message})`;
    }
    render();
    return {
      ok: Boolean(subs),
      note: subNote,
      subdivisions: (subs?.list || []).slice(0, 80).map((s) => ({
        name: s.name,
        wikidata: s.id,
        headOfGovernment: s.holder?.name || null,
        office: s.holder?.office || s.office || null,
        party: s.holder?.parties?.join(', ') || null,
        since: s.holder?.start || null,
      })),
    };
  }

  // One-shot globe pick.
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  cleanups.push(() => handler.destroy());
  handler.setInputAction((e) => {
    if (!picking) return;
    picking = false;
    const scene = viewer.scene;
    const ray = viewer.camera.getPickRay(e.position);
    const hit = ray && scene.globe.pick(ray, scene);
    if (!hit) return render();
    const c = scene.globe.ellipsoid.cartesianToCartographic(hit);
    void at({ lat: c.latitude * RAD, lon: c.longitude * RAD });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-leadership');
  card.id = 'adam-leadership';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Leaders');
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

    const row = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    const here = el(doc, 'button', 'adam-chip', 'leaders here');
    here.type = 'button';
    here.addEventListener('click', () => void at());
    const pick = el(
      doc,
      'button',
      `adam-chip${picking ? ' is-on' : ''}`,
      picking ? LABEL_PICKING : 'pick on the globe',
    );
    pick.type = 'button';
    pick.addEventListener('click', () => {
      picking = !picking;
      render();
    });
    row.append(here, pick);
    body.append(row);
    const form = el(doc, 'form', 'adam-session-form');
    const input = el(doc, 'input', 'adam-input');
    input.placeholder = 'country · france, india, brazil…';
    input.addEventListener('keydown', (e) => e.stopPropagation());
    form.append(input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void country(input.value.trim());
    });
    body.append(form);
    if (note) body.append(el(doc, 'p', 'adam-volc-note', note));

    for (const a of chain) {
      const item = el(doc, 'div', 'adam-space-neo');
      item.append(
        el(doc, 'div', 'adam-meta', a.levelName),
        el(doc, 'div', 'adam-space-name', a.name),
      );
      for (const h of a.holders || [])
        item.append(
          el(doc, 'div', 'adam-space-sub', `${h.name} — ${holderLine(h)}`),
        );
      if (a.holders && !a.holders.length)
        item.append(
          el(doc, 'div', 'adam-space-sub', 'no officeholder recorded'),
        );
      if (a.legislature)
        item.append(
          el(doc, 'div', 'adam-space-sub', `legislature · ${a.legislature}`),
        );
      const sb = el(doc, 'button', 'adam-chip', 'subdivisions');
      sb.type = 'button';
      sb.addEventListener('click', () => void subdivisions(a.wikidata));
      item.append(sb);
      body.append(item);
    }

    if (subNote) {
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          subs ? `inside ${subs.of}` : 'subdivisions',
        ),
        el(doc, 'p', 'adam-volc-note', subNote),
      );
    }
    for (const s of subs?.list || []) {
      const item = el(doc, 'div', 'adam-space-neo');
      item.append(el(doc, 'div', 'adam-space-name', s.name));
      if (s.holder)
        item.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `${s.holder.name} — ${holderLine(s.holder)}`,
          ),
        );
      else if (s.office)
        item.append(el(doc, 'div', 'adam-space-sub', s.office));
      const sb = el(doc, 'button', 'adam-chip', 'subdivisions');
      sb.type = 'button';
      sb.addEventListener('click', () => void subdivisions(s.id));
      item.append(sb);
      if (s.coords)
        item.addEventListener('dblclick', () =>
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              s.coords[0],
              s.coords[1],
              600_000,
            ),
            duration: 1.2,
          }),
        );
      body.append(item);
    }
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Public office as recorded in Wikidata (areas from OpenStreetMap boundaries). It can lag elections and appointments. Offices and terms only — never anyone’s whereabouts.',
      ),
    );
    const scroll = card.querySelector('.adam-volc-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (!open) picking = false;
    if (open) render();
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Who holds public office here: nation, state, county, city';
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

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    at,
    country,
    subdivisions,
    state: summary,
    clear() {
      marks.entities.removeAll();
      chain = [];
      subs = null;
      note = subNote = '';
      governorRequestRender('leadership');
      render();
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
