/**
 * INFRA: the compute build-out — data centres and the power, water, chips and
 * materials that constrain where they go.
 *
 *   data centres    coloured by function (ai training, hyperscale, colo,
 *                   government, crypto…), live from OpenStreetMap in view
 *   power           plants by fuel, 230 kV+ substations and transmission —
 *                   the binding constraint on new sites
 *   water           treatment, reclaimed/wastewater and reservoirs in view
 *   chips           curated fabs, packaging and equipment makers worldwide
 *   materials       curated raw-material and refining chokepoints
 *   prediction      a transparent siting-pressure heatmap over the view,
 *                   drawn as a hatched glow so it never reads as a real site
 *   links           supply-chain edges: substation/plant/water → data centre,
 *                   solid where co-located, dashed where inferred
 *
 * Power/water/site data are OpenStreetMap; fabs and materials are public
 * facts as of 2025. The prediction is a heuristic, not a trained model.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  CHIP_FABS,
  DC_FUNCTIONS,
  FAB_KINDS,
  FUEL_COLORS,
  MATERIALS,
  WATER_KINDS,
  dataCentreQuery,
  normalizeDataCentres,
  normalizePower,
  normalizeWater,
  powerQuery,
  predictSiting,
  supplyLinks,
  waterQuery,
} from '../../intel/datacenters.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'infra';
const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installInfraPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  const sources = {};
  for (const name of [
    'dc',
    'power',
    'water',
    'chips',
    'materials',
    'predict',
    'links',
  ]) {
    const ds = new Cesium.CustomDataSource(`adam-infra-${name}`);
    viewer.dataSources.add(ds);
    sources[name] = ds;
  }
  cleanups.push(() =>
    Object.values(sources).forEach((ds) => viewer.dataSources.remove(ds, true)),
  );
  const state = { dc: [], power: null, water: [], notes: {} };
  let token = 0;

  function viewBox(maxSpan = 4) {
    const rect = viewer.camera.computeViewRectangle?.();
    if (!rect) return null;
    const s = rect.south * RAD;
    const n = rect.north * RAD;
    const w = rect.west * RAD;
    const e = rect.east * RAD;
    if (n - s > maxSpan || (e - w + 360) % 360 > maxSpan) return null;
    return [s, w, n, e].map((v) => +v.toFixed(4));
  }

  async function overpass(query) {
    const r = await fetchImpl('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!r.ok) throw new Error(`overpass HTTP ${r.status}`);
    return r.json();
  }

  function pointBillboard(ds, lon, lat, color, size = 8) {
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: size,
        color: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
  }

  function label(ds, lon, lat, text, color) {
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 7, color: Cesium.Color.fromCssColorString(color) },
      label: {
        text,
        font: '500 11px "ADAM Sans", sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor:
          Cesium.Color.fromCssColorString('#061015').withAlpha(0.78),
        pixelOffset: new Cesium.Cartesian2(9, 0),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6),
      },
    });
  }

  async function dataCentres() {
    const box = viewBox();
    if (!box) return note('dc', 'zoom in to a region ~400 km across or less');
    note('dc', 'reading openstreetmap…');
    sources.dc.entities.removeAll();
    try {
      state.dc = normalizeDataCentres(await overpass(dataCentreQuery(box)));
      for (const d of state.dc)
        label(
          sources.dc,
          d.lon,
          d.lat,
          d.name || DC_FUNCTIONS[d.fn].label,
          DC_FUNCTIONS[d.fn].color,
        );
      const counts = {};
      for (const d of state.dc) counts[d.fn] = (counts[d.fn] || 0) + 1;
      note('dc', `${state.dc.length} data centres · © OpenStreetMap`);
      state.dcCounts = counts;
    } catch (error) {
      note('dc', `data centres unavailable (${error.message})`);
    }
    done('dc');
    return {
      ok: state.dc.length > 0,
      count: state.dc.length,
      byFunction: state.dcCounts,
    };
  }

  async function power() {
    const box = viewBox();
    if (!box)
      return note('power', 'zoom in to a region ~400 km across or less');
    note('power', 'reading the grid…');
    sources.power.entities.removeAll();
    try {
      const p = normalizePower(await overpass(powerQuery(box)));
      state.power = p;
      for (const line of p.lines)
        sources.power.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(line.coords.flat()),
            width: Math.min(4, 1 + line.kv / 300),
            material: Cesium.Color.fromCssColorString('#FFD60A').withAlpha(0.5),
            clampToGround: true,
          },
        });
      for (const sub of p.substations)
        sources.power.entities.add({
          position: Cesium.Cartesian3.fromDegrees(sub.lon, sub.lat),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString('#FF9F0A'),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: `${sub.kv} kV`,
            font: '600 10px "ADAM Sans", sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#FFD60A'),
            pixelOffset: new Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              8e5,
            ),
          },
        });
      for (const plant of p.plants)
        pointBillboard(
          sources.power,
          plant.lon,
          plant.lat,
          FUEL_COLORS[plant.fuel],
          10,
        );
      note(
        'power',
        `${p.plants.length} plants · ${p.substations.length} substations ≥230 kV · ${p.lines.length} HV lines · © OpenStreetMap`,
      );
    } catch (error) {
      note('power', `grid unavailable (${error.message})`);
    }
    done('power');
    return { ok: Boolean(state.power), ...summarizePower() };
  }

  function summarizePower() {
    if (!state.power) return {};
    const byFuel = {};
    for (const p of state.power.plants)
      byFuel[p.fuel] = (byFuel[p.fuel] || 0) + 1;
    return {
      plants: state.power.plants.length,
      substations: state.power.substations.length,
      lines: state.power.lines.length,
      byFuel,
    };
  }

  async function water() {
    const box = viewBox();
    if (!box)
      return note('water', 'zoom in to a region ~400 km across or less');
    note('water', 'reading water sources…');
    sources.water.entities.removeAll();
    try {
      state.water = normalizeWater(await overpass(waterQuery(box)));
      for (const wsite of state.water)
        pointBillboard(
          sources.water,
          wsite.lon,
          wsite.lat,
          WATER_KINDS[wsite.kind].color,
          8,
        );
      note('water', `${state.water.length} water facilities · © OpenStreetMap`);
    } catch (error) {
      note('water', `water unavailable (${error.message})`);
    }
    done('water');
    return { ok: state.water.length > 0, count: state.water.length };
  }

  function chips(show = true) {
    sources.chips.entities.removeAll();
    if (!show) return (done('chips'), { ok: true, shown: false });
    for (const f of CHIP_FABS)
      label(
        sources.chips,
        f.lon,
        f.lat,
        `${f.org} · ${f.node}`,
        FAB_KINDS[f.kind].color,
      );
    note(
      'chips',
      `${CHIP_FABS.length} fabs, packaging and equipment makers (public, ~2025)`,
    );
    done('chips');
    return {
      ok: true,
      fabs: CHIP_FABS.map((f) => ({
        name: f.name,
        kind: f.kind,
        node: f.node,
        country: f.country,
      })),
    };
  }

  function materials(show = true) {
    sources.materials.entities.removeAll();
    if (!show) return (done('materials'), { ok: true, shown: false });
    for (const m of MATERIALS)
      label(
        sources.materials,
        m.lon,
        m.lat,
        `${m.material}${m.control ? ' ⚠' : ''}`,
        '#C9A227',
      );
    note(
      'materials',
      `${MATERIALS.length} raw-material & refining chokepoints (public, ~2025)`,
    );
    done('materials');
    return {
      ok: true,
      materials: MATERIALS.map((m) => ({
        name: m.name,
        material: m.material,
        country: m.country,
        export_control: m.control,
      })),
    };
  }

  async function predict() {
    const box = viewBox(6);
    if (!box) return note('predict', 'zoom to a region ~600 km across or less');
    if (!state.power) await power();
    if (!state.dc.length) await dataCentres();
    sources.predict.entities.removeAll();
    const cells = predictSiting({
      box,
      substations: state.power?.substations || [],
      dataCentres: state.dc,
      cells: 14,
    });
    for (const c of cells) {
      const a = 0.12 + 0.5 * c.score;
      sources.predict.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            c.west,
            c.south,
            c.east,
            c.north,
          ),
          material: Cesium.Color.fromCssColorString('#FF2D55').withAlpha(a),
          outline: true,
          outlineColor:
            Cesium.Color.fromCssColorString('#FF2D55').withAlpha(0.5),
          height: 0,
        },
      });
    }
    note(
      'predict',
      cells.length
        ? `siting-pressure heatmap (heuristic, not a confirmed site) · top score ${cells[0].score}`
        : 'not enough live power/cluster signal here to score',
    );
    state.predict = cells.slice(0, 12);
    done('predict');
    return {
      ok: cells.length > 0,
      caveat:
        'transparent weighted heuristic over live substation + cluster signals; not a trained/backtested model, and never a confirmed site',
      top: state.predict.map((c) => ({
        lat: +c.lat.toFixed(3),
        lon: +c.lon.toFixed(3),
        score: c.score,
        drivers: c.drivers,
      })),
    };
  }

  function links(show = true) {
    sources.links.entities.removeAll();
    if (!show) return (done('links'), { ok: true, shown: false });
    const edges = supplyLinks({
      dataCentres: state.dc,
      substations: state.power?.substations || [],
      water: state.water,
      plants: state.power?.plants || [],
    });
    const color = { power: '#FFD60A', water: '#0A84FF', generation: '#FF9F0A' };
    for (const e of edges)
      sources.links.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([...e.from, ...e.to]),
          width: 2,
          material:
            e.confidence === 'confirmed'
              ? Cesium.Color.fromCssColorString(color[e.kind]).withAlpha(0.85)
              : new Cesium.PolylineDashMaterialProperty({
                  color: Cesium.Color.fromCssColorString(
                    color[e.kind],
                  ).withAlpha(0.7),
                  dashLength: 12,
                }),
          clampToGround: true,
        },
      });
    note(
      'links',
      edges.length
        ? `${edges.length} supply links · solid = co-located, dashed = inferred from proximity`
        : 'load data centres, power and water first, then links',
    );
    done('links');
    return {
      ok: edges.length > 0,
      links: edges.length,
      note: 'descriptive graph; ADAM does not rank which asset to disable',
    };
  }

  function clearAll() {
    for (const ds of Object.values(sources)) ds.entities.removeAll();
    state.dc = [];
    state.power = null;
    state.water = [];
    state.notes = {};
    governorRequestRender('infra');
    render();
  }

  function note(key, text) {
    state.notes[key] = text;
    render();
  }
  function done(key) {
    governorRequestRender('infra');
    render();
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-infra');
  card.id = 'adam-infra';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Infrastructure and data centres');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  const actions = [
    ['data centres in view', dataCentres, 'dc'],
    ['power grid in view', power, 'power'],
    ['water sources in view', water, 'water'],
    ['chip fabs (world)', () => chips(true), 'chips'],
    ['raw materials (world)', () => materials(true), 'materials'],
    ['predict siting here', predict, 'predict'],
    ['draw supply links', () => links(true), 'links'],
  ];

  function legend(body, title, map, key) {
    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', title));
    for (const [id, meta] of Object.entries(map)) {
      if (key === 'dc' && state.dcCounts && !state.dcCounts[id]) continue;
      const row = el(
        doc,
        'div',
        'adam-space-sub',
        key === 'dc' && state.dcCounts
          ? `${meta.label} — ${state.dcCounts[id]}`
          : meta.label,
      );
      const dot = el(doc, 'span', 'adam-infra-dot');
      dot.style.background = meta.color;
      row.prepend(dot);
      body.append(row);
    }
  }

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(el(doc, 'h2', 'adam-ops-title', LABEL_TITLE), close);
    const body = el(doc, 'div', 'adam-ops-body adam-volc-body');

    const kinds = el(doc, 'div', 'adam-res-kinds');
    kinds.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px';
    for (const [labelText, fn, key] of actions) {
      const b = el(doc, 'button', 'adam-chip', labelText);
      b.type = 'button';
      b.style.whiteSpace = 'nowrap';
      b.addEventListener('click', () => void fn());
      kinds.append(b);
      if (state.notes[key]) {
        // note printed below the whole row
      }
    }
    body.append(kinds);

    for (const [, , key] of actions)
      if (state.notes[key])
        body.append(
          el(doc, 'p', 'adam-volc-note', `${key}: ${state.notes[key]}`),
        );

    if (state.dcCounts && Object.keys(state.dcCounts).length)
      legend(body, 'data centres by function', DC_FUNCTIONS, 'dc');
    if (state.power) legend(body, 'power plants by fuel', fuelLegend(), 'fuel');
    if (state.notes.chips) legend(body, 'chips', FAB_KINDS, 'fab');
    if (state.predict?.length) {
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          'predicted siting pressure',
        ),
      );
      for (const c of state.predict.slice(0, 6))
        body.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `${c.lat.toFixed(2)}, ${c.lon.toFixed(2)} — ${Math.round(c.score * 100)}% (power ${Math.round(c.drivers.power * 100)}%, cluster ${Math.round(c.drivers.cluster * 100)}%)`,
          ),
        );
    }

    const clear = el(doc, 'button', 'adam-chip', 'clear all');
    clear.type = 'button';
    clear.addEventListener('click', clearAll);
    body.append(clear);
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Data centres, power, water and lines from OpenStreetMap for the current view. Fabs and materials are public facts (~2025). Prediction is a transparent weighted heuristic over live substation and cluster signals — a model output, never a confirmed site. Links are a descriptive supply-chain graph; ADAM does not rank which shared asset to disable.',
      ),
    );
    const scroll = card.querySelector('.adam-volc-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
  }

  function fuelLegend() {
    const byFuel = summarizePower().byFuel || {};
    const out = {};
    for (const [fuel, count] of Object.entries(byFuel))
      out[fuel] = {
        label: `${fuel} — ${count}`,
        color: FUEL_COLORS[fuel] || FUEL_COLORS.other,
      };
    return out;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) render();
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title =
    'Data centres, power, water, chips, materials and siting prediction';
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
    dataCentres,
    power,
    water,
    chips,
    materials,
    predict,
    links,
    clear: clearAll,
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
