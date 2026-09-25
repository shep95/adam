/**
 * RESOURCES: which countries hold the world's natural wealth.
 *
 *   ranking         countries by a resource type (oil, gas, coal, minerals,
 *                   forests, gold reserves, foreign exchange reserves,
 *                   freshwater, arable land — World Bank), as a list and as
 *                   circles on the globe sized by value
 *   sites in view   the infrastructure that produces and stores it, from
 *                   OpenStreetMap: mines, wells, refineries, LNG terminals,
 *                   fuel storage and power plants
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  RESOURCE_TYPES,
  SITE_KINDS,
  formatValue,
  normalizeSites,
  siteQuery,
} from '../../intel/resources.js';
import { loadNations } from '../../nations/nationProfile.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'resources';
const RAD = 180 / Math.PI;
const RANK_COLOR = '#C9A227';

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installResourcesPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  const ranks = new Cesium.CustomDataSource('adam-resources-rank');
  const sites = new Cesium.CustomDataSource('adam-resources-sites');
  for (const ds of [ranks, sites]) viewer.dataSources.add(ds);
  cleanups.push(() =>
    [ranks, sites].forEach((ds) => viewer.dataSources.remove(ds, true)),
  );
  let type = 'total';
  let ranking = null;
  let rankNote = '';
  let siteList = [];
  let siteNote = '';
  let token = 0;

  async function rank(nextType = type) {
    type = RESOURCE_TYPES.some((t) => t.id === nextType) ? nextType : 'total';
    const mine = (token += 1);
    rankNote = 'reading world bank data…';
    render();
    ranks.entities.removeAll();
    try {
      const [r, nations] = await Promise.all([
        fetchImpl(`/api/resources?type=${type}&limit=60`).then(async (x) => {
          const b = await x.json();
          if (!x.ok) throw new Error(b.error || x.status);
          return b;
        }),
        loadNations(),
      ]);
      if (mine !== token) return { ok: false, error: 'superseded' };
      ranking = r;
      const byIso = new Map(nations.map((n) => [n.a3, n]));
      const top = r.rows[0]?.value || 1;
      for (const row of r.rows) {
        const n = byIso.get(row.iso3);
        if (!n?.ll) continue;
        const t = Math.sqrt(row.value / top);
        ranks.entities.add({
          position: Cesium.Cartesian3.fromDegrees(n.ll[1], n.ll[0]),
          point: {
            pixelSize: 6 + 30 * t,
            color: Cesium.Color.fromCssColorString(RANK_COLOR).withAlpha(
              0.35 + 0.45 * t,
            ),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
            outlineWidth: 1,
          },
          label: {
            text: `${row.rank}. ${row.name} · ${formatValue(row.value, r.unit)}`,
            font: '500 11px "ADAM Sans", sans-serif',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor:
              Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
            pixelOffset: new Cesium.Cartesian2(12, 0),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
              0,
              row.rank <= 15 ? 2.5e7 : 8e6,
            ),
          },
        });
      }
      rankNote = `${r.label} · ${r.count} countries with data · ${r.source}`;
    } catch (error) {
      if (mine !== token) return { ok: false, error: 'superseded' };
      ranking = null;
      rankNote = `resource ranking unavailable (${error.message})`;
    }
    governorRequestRender('resources');
    render();
    return {
      ok: Boolean(ranking),
      note: rankNote,
      type,
      unit: ranking?.unit,
      top: (ranking?.rows || []).slice(0, 20).map((r) => ({
        rank: r.rank,
        country: r.name,
        value: formatValue(r.value, ranking.unit),
        worldShare: r.worldShare,
        ...(r.share != null ? { shareOfGdp: r.share } : {}),
        year: r.year,
      })),
    };
  }

  function viewBox() {
    const rect = viewer.camera.computeViewRectangle?.();
    if (!rect) return null;
    const s = rect.south * RAD;
    const n = rect.north * RAD;
    const w = rect.west * RAD;
    const e = rect.east * RAD;
    if (n - s > 3 || (e - w + 360) % 360 > 3) return null;
    return [s, w, n, e].map((v) => +v.toFixed(4));
  }

  async function sitesInView() {
    sites.entities.removeAll();
    const box = viewBox();
    if (!box) {
      siteList = [];
      siteNote = 'zoom in to a region about 300 km across or less';
      render();
      return { ok: false, error: siteNote };
    }
    siteNote = 'reading openstreetmap…';
    render();
    try {
      const r = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(siteQuery(box)),
      });
      if (!r.ok) throw new Error(`overpass HTTP ${r.status}`);
      siteList = normalizeSites(await r.json());
      for (const s of siteList) {
        const color = Cesium.Color.fromCssColorString(SITE_KINDS[s.kind].color);
        sites.entities.add({
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
          point: {
            pixelSize: 7,
            color,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: s.name
            ? {
                text: s.name,
                font: '500 10px "ADAM Sans", sans-serif',
                fillColor: color,
                showBackground: true,
                backgroundColor:
                  Cesium.Color.fromCssColorString('#061015').withAlpha(0.7),
                pixelOffset: new Cesium.Cartesian2(9, 0),
                horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                  0,
                  60_000,
                ),
              }
            : undefined,
          description: [s.kind, s.detail].filter(Boolean).join(' · '),
        });
      }
      siteNote = `${siteList.length} sites in view · © OpenStreetMap contributors`;
    } catch (error) {
      siteList = [];
      siteNote = `sites unavailable (${error.message})`;
    }
    governorRequestRender('resources');
    render();
    return { ok: siteList.length > 0, note: siteNote, counts: counts() };
  }

  function counts() {
    const c = {};
    for (const s of siteList) c[s.kind] = (c[s.kind] || 0) + 1;
    return c;
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-resources');
  card.id = 'adam-resources';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Resources');
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

    body.append(
      el(doc, 'h3', 'adam-meta adam-ops-section', 'richest countries by'),
    );
    const kinds = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    for (const t of RESOURCE_TYPES) {
      const b = el(
        doc,
        'button',
        `adam-chip${ranking && ranking.type === t.id ? ' is-on' : ''}`,
        t.label,
      );
      b.type = 'button';
      b.addEventListener('click', () => void rank(t.id));
      kinds.append(b);
    }
    body.append(kinds);
    if (rankNote) body.append(el(doc, 'p', 'adam-volc-note', rankNote));
    for (const r of ranking?.rows || []) {
      const item = el(doc, 'div', 'adam-space-neo');
      item.append(
        el(doc, 'div', 'adam-space-name', `${r.rank}. ${r.name}`),
        el(
          doc,
          'div',
          'adam-space-sub',
          [
            formatValue(r.value, ranking.unit),
            `${r.worldShare}% of world`,
            r.share != null ? `${r.share}% of gdp` : null,
            r.year,
          ]
            .filter((x) => x != null)
            .join(' · '),
        ),
      );
      item.addEventListener('click', async () => {
        const n = (await loadNations()).find((x) => x.a3 === r.iso3);
        if (n?.ll)
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              n.ll[1],
              n.ll[0],
              3_000_000,
            ),
            duration: 1.4,
          });
      });
      body.append(item);
    }

    body.append(
      el(
        doc,
        'h3',
        'adam-meta adam-ops-section',
        'stockpiles & infrastructure in view',
      ),
    );
    const sb = el(doc, 'button', 'adam-chip', 'find sites here');
    sb.type = 'button';
    sb.addEventListener('click', () => void sitesInView());
    body.append(sb);
    if (siteNote) body.append(el(doc, 'p', 'adam-volc-note', siteNote));
    const c = counts();
    for (const [kind, meta] of Object.entries(SITE_KINDS)) {
      if (!c[kind]) continue;
      const row = el(
        doc,
        'div',
        'adam-space-sub',
        `${meta.label} — ${c[kind]}`,
      );
      row.style.color = meta.color;
      body.append(row);
    }
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Resource values: World Bank rents (value above extraction cost) converted with GDP; gold is total reserves minus reserves excluding gold; freshwater is internal renewable resources; arable land in hectares. Official strategic stockpiles beyond reserves are rarely published by country. Sites are as mapped in OpenStreetMap.',
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
  chip.title = 'Richest countries by resource, and the sites that produce it';
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
    rank,
    sitesInView,
    types: () => RESOURCE_TYPES.map((t) => ({ id: t.id, label: t.label })),
    clear() {
      ranks.entities.removeAll();
      sites.entities.removeAll();
      ranking = null;
      siteList = [];
      governorRequestRender('resources');
      render();
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
