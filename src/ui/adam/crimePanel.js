/**
 * CRIME: open crime data on the globe.
 *
 *   around the view     street-level incidents where police and cities
 *                       publish them, as a heat grid with the categories
 *   homicide rates      every country, circles sized and coloured by
 *                       intentional homicides per 100,000 (World Bank/UNODC)
 *   organized crime     for a country, the armed groups ACLED reports
 *                       active, by region, with the outline around their
 *                       reported events — reported activity, not territory
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  categoryBreakdown,
  crimeGrid,
  heatColor,
  organizedCrimeActivity,
} from '../../intel/crime.js';
import { loadNations, findNation } from '../../nations/nationProfile.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'crime';
const RAD = 180 / Math.PI;
const GROUP_COLORS = [
  '#FF3B30',
  '#FF9F0A',
  '#BF5AF2',
  '#64D2FF',
  '#FFD60A',
  '#30D158',
  '#FF375F',
  '#5E5CE6',
];

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installCrimePanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  const heat = new Cesium.CustomDataSource('adam-crime-heat');
  const rates = new Cesium.CustomDataSource('adam-crime-rates');
  const groups = new Cesium.CustomDataSource('adam-crime-groups');
  for (const ds of [heat, rates, groups]) viewer.dataSources.add(ds);
  cleanups.push(() =>
    [heat, rates, groups].forEach((ds) => viewer.dataSources.remove(ds, true)),
  );
  let local = null;
  let localNote = '';
  let rateSummary = null;
  let org = null;
  let orgNote = '';
  let country = '';

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

  async function near({ lat, lon, radiusM = 1600 } = {}) {
    if (!Number.isFinite(lat)) ({ lat, lon } = viewCenter());
    localNote = 'reading open crime data…';
    render();
    try {
      const r = await fetchImpl(
        `/api/crime/near?lat=${lat}&lon=${lon}&radiusM=${radiusM}`,
      );
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || r.status);
      local = { ...b, lat, lon };
      localNote = b.source
        ? `${b.incidents.length.toLocaleString('en-US')} incidents · ${b.period} · ${b.source}`
        : b.note;
    } catch (error) {
      local = null;
      localNote = `crime data unavailable (${error.message})`;
    }
    drawHeat();
    render();
    return {
      ok: Boolean(local?.source),
      note: localNote,
      incidents: local?.incidents?.length || 0,
      categories: local ? categoryBreakdown(local.incidents, 10) : [],
      hottest: local
        ? crimeGrid(local.incidents)
            .slice(0, 5)
            .map((c) => ({
              lat: +((c.south + c.north) / 2).toFixed(5),
              lon: +((c.west + c.east) / 2).toFixed(5),
              incidents: c.count,
            }))
        : [],
    };
  }

  function drawHeat() {
    heat.entities.removeAll();
    if (!local?.incidents?.length) return governorRequestRender('crime');
    for (const c of crimeGrid(local.incidents)) {
      const [r, g, b] = heatColor(c.intensity);
      heat.entities.add({
        rectangle: {
          coordinates: Cesium.Rectangle.fromDegrees(
            c.west,
            c.south,
            c.east,
            c.north,
          ),
          material: Cesium.Color.fromBytes(
            r,
            g,
            b,
            Math.round(70 + 150 * c.intensity),
          ),
          height: 0,
        },
      });
    }
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(local.lon, local.lat, 7000),
      duration: 1.4,
    });
    governorRequestRender('crime');
  }

  async function homicideRates(show = true) {
    rates.entities.removeAll();
    if (!show) {
      rateSummary = null;
      render();
      return { ok: true, shown: false };
    }
    try {
      const [r, nations] = await Promise.all([
        fetchImpl('/api/crime/homicide-rates').then((x) => x.json()),
        loadNations(),
      ]);
      const list = [];
      for (const n of nations) {
        const v = r.rates?.[n.a3];
        if (!v || !n.ll) continue;
        list.push({ ...v, iso3: n.a3, lat: n.ll[0], lon: n.ll[1] });
        const t = Math.min(1, v.rate / 40);
        const [cr, cg, cb] = heatColor(t);
        rates.entities.add({
          position: Cesium.Cartesian3.fromDegrees(n.ll[1], n.ll[0]),
          point: {
            pixelSize: 6 + Math.sqrt(v.rate) * 3,
            color: Cesium.Color.fromBytes(cr, cg, cb, 200),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
          },
          label: {
            text: `${v.name} · ${v.rate}`,
            font: '500 11px "ADAM Sans", sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor:
              Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
            pixelOffset: new Cesium.Cartesian2(10, 0),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              9e6,
            ),
          },
        });
      }
      list.sort((a, b) => b.rate - a.rate);
      rateSummary = {
        highest: list.slice(0, 10),
        lowest: list.slice(-5).reverse(),
        count: list.length,
        source: r.source,
      };
    } catch (error) {
      rateSummary = { error: error.message };
    }
    governorRequestRender('crime');
    render();
    return { ok: !rateSummary.error, ...rateSummary };
  }

  async function organized(name, { days = 365 } = {}) {
    groups.entities.removeAll();
    country = name || country;
    const nations = await loadNations();
    const n = findNation(nations, country);
    if (!n) {
      orgNote = `no country matches “${country}”`;
      render();
      return { ok: false, error: orgNote };
    }
    orgNote = `asking ACLED about ${n.n}…`;
    render();
    try {
      const r = await fetchImpl(
        `/api/acled?country=${encodeURIComponent(n.n)}&days=${days}`,
      );
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || r.status);
      org = { country: n.n, groups: organizedCrimeActivity(b) };
      orgNote = org.groups.length
        ? `${org.groups.length} organized armed groups reported active in ${n.n} over ${days} days · ACLED`
        : `no organized-crime actors named in ACLED events for ${n.n} over ${days} days`;
      org.groups.slice(0, 8).forEach((g, i) => {
        const color = Cesium.Color.fromCssColorString(
          GROUP_COLORS[i % GROUP_COLORS.length],
        );
        if (g.area?.length >= 3)
          groups.entities.add({
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(g.area.flat()),
              material: color.withAlpha(0.12),
              outline: true,
              outlineColor: color,
              height: 0,
            },
          });
        for (const [lon, lat] of g.points.slice(0, 200))
          groups.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat),
            point: { pixelSize: 4, color },
          });
      });
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(n.ll[1], n.ll[0], 2_500_000),
        duration: 1.6,
      });
    } catch (error) {
      org = null;
      orgNote = `organized-crime activity unavailable (${error.message})`;
    }
    governorRequestRender('crime');
    render();
    return {
      ok: Boolean(org),
      note: orgNote,
      groups: (org?.groups || [])
        .slice(0, 10)
        .map((g) => ({
          name: g.name,
          events: g.events,
          fatalities: g.fatalities,
          lastReported: g.lastReported,
          regions: g.regions,
        })),
      caveat: 'reported activity in ACLED events, not territorial control',
    };
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-crime');
  card.id = 'adam-crime';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Crime');
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

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'around the view'));
    const nb = el(doc, 'button', 'adam-chip', 'crime heat map here');
    nb.type = 'button';
    nb.addEventListener('click', () => void near());
    const row1 = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    row1.append(nb);
    body.append(row1);
    if (localNote) body.append(el(doc, 'p', 'adam-volc-note', localNote));
    if (local?.incidents?.length)
      for (const c of categoryBreakdown(local.incidents, 10))
        body.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `${c.category} — ${c.count} (${c.share}%)`,
          ),
        );

    body.append(
      el(doc, 'h3', 'adam-meta adam-ops-section', 'homicide rates by country'),
    );
    const hb = el(
      doc,
      'button',
      `adam-chip${rateSummary && !rateSummary.error ? ' is-on' : ''}`,
      rateSummary && !rateSummary.error ? 'hide' : 'show on the globe',
    );
    hb.type = 'button';
    hb.addEventListener(
      'click',
      () => void homicideRates(!(rateSummary && !rateSummary.error)),
    );
    body.append(hb);
    if (rateSummary?.error)
      body.append(
        el(doc, 'p', 'adam-volc-note', `unavailable (${rateSummary.error})`),
      );
    if (rateSummary?.highest) {
      for (const r of rateSummary.highest)
        body.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `${r.name} — ${r.rate} per 100,000 (${r.year})`,
          ),
        );
      body.append(el(doc, 'p', 'adam-volc-note', rateSummary.source));
    }

    body.append(
      el(
        doc,
        'h3',
        'adam-meta adam-ops-section',
        'organized crime · reported activity',
      ),
    );
    const form = el(doc, 'form', 'adam-session-form');
    const input = el(doc, 'input', 'adam-input');
    input.placeholder = 'country · mexico, colombia, el salvador…';
    input.value = country;
    input.addEventListener('keydown', (e) => e.stopPropagation());
    form.append(input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void organized(input.value.trim());
    });
    body.append(form);
    if (orgNote) body.append(el(doc, 'p', 'adam-volc-note', orgNote));
    (org?.groups || []).slice(0, 8).forEach((g, i) => {
      const item = el(doc, 'div', 'adam-space-neo');
      const name = el(doc, 'div', 'adam-space-name', g.name);
      name.style.color = GROUP_COLORS[i % GROUP_COLORS.length];
      item.append(
        name,
        el(
          doc,
          'div',
          'adam-space-sub',
          `${g.events} events · ${g.fatalities} reported fatalities · last ${g.lastReported}`,
        ),
        el(
          doc,
          'div',
          'adam-space-sub',
          g.regions.map((r) => `${r.region} (${r.events})`).join(' · '),
        ),
      );
      body.append(item);
    });
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Open data only. Street-level incidents are as police and cities publish them (locations are generalised to the street). Organized-crime areas outline where ACLED recorded events naming a group — reported activity, not territory or membership.',
      ),
    );
    const scroll = card.querySelector('.adam-volc-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) render();
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Crime heat maps, homicide rates, organized-crime activity';
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
    near,
    homicideRates,
    organized,
    clear() {
      heat.entities.removeAll();
      rates.entities.removeAll();
      groups.entities.removeAll();
      governorRequestRender('crime');
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
