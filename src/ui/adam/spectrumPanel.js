/**
 * SPECTRUM: what the airwaves carry, who is listening, where the masts are.
 *
 *   lookup        type a frequency (1090, 156.8 MHz, 2.4 GHz, 518 kHz) to
 *                 see its allocation and common uses
 *   receivers     public KiwiSDR web receivers on the globe — click to tune
 *                 one live in the browser
 *   transmitters  broadcast, mobile and radar masts in the view (OSM)
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  BANDS,
  bandsFor,
  formatMHz,
  normalizeTransmitters,
  parseFrequency,
  transmitterQuery,
} from '../../intel/spectrum.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'spectrum';
const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installSpectrumPanel({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  let query = '';
  let receivers = null;
  let receiverNote = '';
  let transmitters = [];
  let transmitterNote = '';
  const marks = new Cesium.CustomDataSource('adam-spectrum');
  viewer.dataSources.add(marks);
  cleanups.push(() => viewer.dataSources.remove(marks, true));

  function viewBox() {
    const rect = viewer.camera.computeViewRectangle?.();
    if (!rect) return null;
    const s = rect.south * RAD;
    const n = rect.north * RAD;
    const w = rect.west * RAD;
    const e = rect.east * RAD;
    if (n - s > 1.5 || (e - w + 360) % 360 > 1.5) return null;
    return [s, w, n, e].map((v) => +v.toFixed(4));
  }

  function lookup(text) {
    const mhz = parseFrequency(text);
    if (mhz == null)
      return {
        ok: false,
        error: 'type a frequency like 1090, 156.8 MHz, 2.4 GHz or 518 kHz',
      };
    const bands = bandsFor(mhz);
    return {
      ok: true,
      frequency: formatMHz(mhz),
      bands: bands.map((b) => ({
        service: b.service,
        uses: b.uses,
        range: `${formatMHz(b.from)}–${formatMHz(b.to)}`,
      })),
      note: bands.length
        ? 'simplified allocation; national tables differ by ITU region'
        : 'no common allocation listed here',
    };
  }

  async function showReceivers() {
    if (!receivers) {
      try {
        const r = await fetchImpl('/api/spectrum/receivers');
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || r.status);
        receivers = b.receivers || [];
        receiverNote = `${receivers.length} public receivers · KiwiSDR`;
      } catch (error) {
        receivers = [];
        receiverNote = `receiver list unavailable (${error.message})`;
      }
    }
    marks.entities.values
      .filter((e) => e.properties?.kind?.getValue?.() === 'receiver')
      .forEach((e) => marks.entities.remove(e));
    const green = Cesium.Color.fromCssColorString('#34C759');
    for (const r of receivers) {
      if (r.offline) continue;
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
        point: {
          pixelSize: 6,
          color: green,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: 5e6,
        },
        label: {
          text: r.name,
          font: '500 11px "ADAM Sans", sans-serif',
          fillColor: green,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
          pixelOffset: new Cesium.Cartesian2(8, 0),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            1.5e6,
          ),
        },
        properties: { kind: 'receiver', url: r.url },
      });
    }
    governorRequestRender('spectrum');
    render();
    return {
      ok: receivers.length > 0,
      note: receiverNote,
      count: receivers.length,
      sample: receivers
        .slice(0, 10)
        .map((r) => ({ name: r.name, url: r.url, users: r.users })),
    };
  }

  async function showTransmitters() {
    const box = viewBox();
    if (!box) {
      transmitterNote =
        'zoom in to a region (about 150 km across) to map masts';
      render();
      return { ok: false, error: transmitterNote };
    }
    try {
      const r = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(transmitterQuery(box)),
      });
      if (!r.ok) throw new Error(`overpass HTTP ${r.status}`);
      transmitters = normalizeTransmitters(await r.json());
      transmitterNote = `${transmitters.length} masts and towers in view · OpenStreetMap`;
    } catch (error) {
      transmitters = [];
      transmitterNote = `masts unavailable (${error.message})`;
    }
    marks.entities.values
      .filter((e) => e.properties?.kind?.getValue?.() === 'mast')
      .forEach((e) => marks.entities.remove(e));
    const amber = Cesium.Color.fromCssColorString('#FFB454');
    for (const t of transmitters)
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
        point: {
          pixelSize: 6,
          color: amber,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          text:
            [t.name, t.uses.join('/')].filter(Boolean).join(' · ') || t.kind,
          font: '500 11px "ADAM Sans", sans-serif',
          fillColor: amber,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#061015').withAlpha(0.75),
          pixelOffset: new Cesium.Cartesian2(8, 0),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            60_000,
          ),
        },
        properties: { kind: 'mast' },
      });
    governorRequestRender('spectrum');
    render();
    return {
      ok: transmitters.length > 0,
      note: transmitterNote,
      byUse: transmitters.reduce((m, t) => {
        for (const u of t.uses.length ? t.uses : ['unspecified'])
          m[u] = (m[u] || 0) + 1;
        return m;
      }, {}),
    };
  }

  // Clicking a receiver opens it.
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    const url = picked?.id?.properties?.url?.getValue?.();
    if (url && picked.id.properties.kind?.getValue?.() === 'receiver')
      globalThis.open(url, '_blank', 'noopener');
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  cleanups.push(() => handler.destroy());

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-spectrum');
  card.id = 'adam-spectrum';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Spectrum');
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

    const input = el(doc, 'input', 'adam-input adam-volc-search');
    input.type = 'search';
    input.placeholder = 'frequency · 1090 · 156.8 mhz · 2.4 ghz · 518 khz';
    input.value = query;
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const result = el(doc, 'div', 'adam-spectrum-result');
    const showResult = () => {
      result.replaceChildren();
      if (!query.trim()) return;
      const r = lookup(query);
      if (!r.ok) return result.append(el(doc, 'p', 'adam-volc-note', r.error));
      result.append(el(doc, 'div', 'adam-volc-selected', r.frequency));
      for (const b of r.bands)
        result.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `${b.service} — ${b.uses} (${b.range})`,
          ),
        );
      result.append(el(doc, 'p', 'adam-volc-note', r.note));
    };
    input.addEventListener('input', () => {
      query = input.value;
      showResult();
    });
    body.append(input, result);
    showResult();

    const actions = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    const rx = el(doc, 'button', 'adam-chip', 'public receivers');
    rx.type = 'button';
    rx.addEventListener('click', () => void showReceivers());
    const tx = el(doc, 'button', 'adam-chip', 'masts in view');
    tx.type = 'button';
    tx.addEventListener('click', () => void showTransmitters());
    const clear = el(doc, 'button', 'adam-chip', 'clear');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      marks.entities.removeAll();
      governorRequestRender('spectrum');
    });
    actions.append(rx, tx, clear);
    body.append(actions);
    if (receiverNote)
      body.append(
        el(
          doc,
          'p',
          'adam-volc-note',
          `${receiverNote} — click a green receiver on the globe to listen live`,
        ),
      );
    if (transmitterNote)
      body.append(el(doc, 'p', 'adam-volc-note', transmitterNote));

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'allocations'));
    const table = el(doc, 'div', 'adam-space-planets');
    for (const b of BANDS) {
      const rowEl = el(doc, 'button', 'adam-spectrum-band');
      rowEl.type = 'button';
      rowEl.append(
        el(
          doc,
          'span',
          'adam-space-sub',
          `${formatMHz(b.from)}–${formatMHz(b.to)}`,
        ),
        el(doc, 'span', 'adam-space-name', b.service),
        el(doc, 'span', 'adam-space-sub', b.uses),
      );
      rowEl.addEventListener('click', () => {
        query = formatMHz((b.from + b.to) / 2);
        render();
      });
      table.append(rowEl);
    }
    body.append(table);
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Simplified from the ITU Radio Regulations and common national plans; national tables differ by ITU region.',
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
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Spectrum: frequency lookup, public receivers, masts';
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
    lookup,
    showReceivers,
    showTransmitters,
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
