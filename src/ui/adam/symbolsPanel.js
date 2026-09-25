/**
 * SYMBOLS FROM THE SKY for the area in view: sacred sites of every faith,
 * esoteric sites (lodges, obelisks, pyramids, megaliths) and the shapes
 * buildings and streets make from above (cruciform plans, star forts,
 * pentagons, star junctions). Marked on the globe by category.
 */
import * as Cesium from 'cesium';
import './placeDossier.css';
import './symbolsPanel.css';
import {
  cityBox,
  classifySymbols,
  junctionQuery,
  starJunctions,
  summarizeSymbols,
  symbolQuery,
} from '../../intel/symbolScan.js';
import { governorRequestRender } from '../../renderGovernor.js';

const COLORS = { sacred: '#FFD166', esoteric: '#B388FF', shape: '#00D4FF' };
const GROUP_TITLES = {
  esoteric: 'esoteric · lodges, obelisks, pyramids, megaliths',
  sacred: 'sacred sites',
  shape: 'shapes from the sky',
};
const LABEL_CLOSE = '×';

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

async function overpass(fetchImpl, query) {
  const r = await fetchImpl('/api/overpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!r.ok) throw new Error(`overpass HTTP ${r.status}`);
  return r.json();
}

export function installSymbolsPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const marks = new Cesium.CustomDataSource('adam-symbols');
  viewer.dataSources.add(marks);
  const card = el(doc, 'section', 'adam-panel adam-place adam-symbols');
  card.hidden = true;
  card.setAttribute('aria-label', 'Symbols from the sky');
  doc.body.append(card);
  let token = 0;

  function close() {
    card.hidden = true;
    token += 1;
  }

  function header(title, sub) {
    const h = el(doc, 'header', 'adam-place-head');
    const t = el(doc, 'div', 'adam-place-titles');
    t.append(
      el(doc, 'span', 'adam-place-kicker', 'symbols from the sky'),
      el(doc, 'h2', 'adam-place-title', title),
    );
    if (sub) t.append(el(doc, 'span', 'adam-place-sub', sub));
    const x = el(doc, 'button', 'adam-place-close', LABEL_CLOSE);
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', () => {
      close();
      marks.entities.removeAll();
      governorRequestRender('symbols');
    });
    h.append(t, x);
    return h;
  }

  function draw(sites) {
    marks.entities.removeAll();
    for (const s of sites) {
      const color = Cesium.Color.fromCssColorString(COLORS[s.category]);
      const labelled = s.category !== 'sacred' || s.shape;
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
        point: {
          pixelSize: s.category === 'sacred' ? 6 : 9,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: 50_000,
        },
        label: labelled
          ? {
              text: `${s.name || s.kind}${s.shape && s.category !== 'shape' ? ` · ${s.shape}` : ''}`,
              font: '500 12px "ADAM Sans", sans-serif',
              fillColor: color,
              showBackground: true,
              backgroundColor:
                Cesium.Color.fromCssColorString('#061015').withAlpha(0.78),
              pixelOffset: new Cesium.Cartesian2(10, -8),
              horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                40_000,
              ),
              disableDepthTestDistance: 50_000,
            }
          : undefined,
      });
    }
    governorRequestRender('symbols');
  }

  async function scan(lat, lon, { radiusKm = 5 } = {}) {
    const my = ++token;
    card.hidden = false;
    card.replaceChildren(
      header(`${lat.toFixed(4)}, ${lon.toFixed(4)}`, 'reading openstreetmap…'),
    );
    const box = cityBox(lat, lon, radiusKm);
    const [sitesRes, junctionRes] = await Promise.allSettled([
      overpass(fetchImpl, symbolQuery(box)),
      overpass(fetchImpl, junctionQuery(box)),
    ]);
    if (my !== token) return null;
    const sites = [
      ...(sitesRes.status === 'fulfilled'
        ? classifySymbols(sitesRes.value)
        : []),
      ...(junctionRes.status === 'fulfilled'
        ? starJunctions(junctionRes.value)
        : []),
    ];
    const error =
      sitesRes.status === 'rejected' ? sitesRes.reason?.message : null;
    draw(sites);
    const summary = summarizeSymbols(sites);
    const body = el(doc, 'div', 'adam-place-body');
    if (!sites.length)
      body.append(
        el(
          doc,
          'p',
          'adam-place-empty',
          error
            ? `openstreetmap unavailable (${error})`
            : 'nothing mapped in this area',
        ),
      );
    for (const category of ['esoteric', 'shape', 'sacred']) {
      const group = sites.filter((s) => s.category === category);
      if (!group.length) continue;
      const head = el(
        doc,
        'h3',
        'adam-place-section',
        `${GROUP_TITLES[category]} · ${group.length}`,
      );
      head.style.color = COLORS[category];
      body.append(head);
      if (category === 'sacred') {
        const byFaith = Object.entries(summary.byReligion)
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r.replace(/_/g, ' ')} ${n}`)
          .join(' · ');
        body.append(el(doc, 'p', 'adam-place-note', byFaith));
      }
      const list = el(doc, 'ul', 'adam-place-osm');
      const shown =
        category === 'sacred'
          ? group.filter((s) => s.name || s.shape).slice(0, 25)
          : group.slice(0, 40);
      for (const s of shown) {
        const li = el(doc, 'li');
        const b = el(doc, 'button', 'adam-symbols-go', s.name || s.kind);
        b.type = 'button';
        b.addEventListener('click', () =>
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 900),
            duration: 1.4,
          }),
        );
        li.append(
          b,
          el(
            doc,
            'span',
            'adam-place-dist',
            ` · ${s.kind}${s.shape && category !== 'shape' ? ` · ${s.shape} plan` : ''}${s.streets?.length ? ` · ${s.streets.slice(0, 4).join(', ')}` : ''}`,
          ),
        );
        list.append(li);
      }
      body.append(list);
    }
    body.append(
      el(
        doc,
        'p',
        'adam-place-note',
        'From OpenStreetMap: sites as mappers tagged and named them; shapes measured from building footprints and road junctions. It shows what is built and how it looks from above — not what it means.',
      ),
    );
    card.replaceChildren(
      header(
        `${summary.total} sites · ${(radiusKm * 2).toFixed(0)} km across`,
        `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      ),
      body,
    );
    return {
      ok: !error || sites.length > 0,
      error,
      summary,
      esoteric: sites
        .filter((s) => s.category === 'esoteric')
        .slice(0, 20)
        .map((s) => ({ name: s.name, kind: s.kind })),
      shapes: summary.shapes.slice(0, 20),
    };
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && !card.hidden) close();
  };
  doc.addEventListener('keydown', onKey);
  return {
    scan,
    close,
    destroy() {
      doc.removeEventListener('keydown', onKey);
      viewer.dataSources.remove(marks, true);
      card.remove();
    },
  };
}
