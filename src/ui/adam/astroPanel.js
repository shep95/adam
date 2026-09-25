/**
 * ASTRO: astrocartography lines over the Earth for a chosen moment.
 *
 * Pick a date, a local time and a UTC offset. ADAM computes where each body
 * (Sun, Moon, Mercury…Pluto) was on an angle at that instant and draws its
 * four lines across the globe: MC and IC as meridians, AC and DC as rising
 * and setting curves, coloured per body. Toggle bodies on and off.
 *
 * This is sky geometry — where a body stood over the Earth at a time. It says
 * nothing about any person born or living anywhere on a line.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import {
  BODIES,
  BODY_COLORS,
  chartLines,
  localToUtc,
} from '../../astro/astrocartography.js';
import { governorRequestRender } from '../../renderGovernor.js';

const LABEL_TITLE = 'astro';
const ANGLE_LABEL = { MC: 'mc', IC: 'ic', AC: 'ac', DC: 'dc' };

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const OFFSETS = [];
for (let h = -12; h <= 14; h += 0.5) OFFSETS.push(h);
const fmtOffset = (h) => {
  const sign = h < 0 ? '-' : '+';
  const a = Math.abs(h);
  const hh = String(Math.floor(a)).padStart(2, '0');
  const mm = String(Math.round((a % 1) * 60)).padStart(2, '0');
  return `utc${sign}${hh}:${mm}`;
};

export function installAstroPanel({ viewer, doc = document }) {
  const cleanups = [];
  const ds = new Cesium.CustomDataSource('adam-astro');
  viewer.dataSources.add(ds);
  cleanups.push(() => viewer.dataSources.remove(ds, true));

  const now = new Date();
  const state = {
    date: now.toISOString().slice(0, 10),
    time: '12:00',
    offset: -now.getTimezoneOffset() / 60,
    active: new Set(BODIES),
    note: '',
    computed: null,
  };

  function moment() {
    const [y, m, d] = state.date.split('-').map(Number);
    const [hh, mm] = state.time.split(':').map(Number);
    return localToUtc(
      { year: y, month: m, day: d, hour: hh || 0, minute: mm || 0 },
      state.offset,
    );
  }

  function compute() {
    ds.entities.removeAll();
    let utc;
    try {
      utc = moment();
      if (Number.isNaN(utc.getTime()))
        throw new Error('check the date and time');
    } catch (error) {
      state.note = `couldn’t read that moment (${error.message})`;
      return render();
    }
    const charts = chartLines(utc).filter((c) => state.active.has(c.body));
    for (const chart of charts) {
      const color = Cesium.Color.fromCssColorString(BODY_COLORS[chart.body]);
      for (const line of chart.lines) {
        for (const seg of line.segments) {
          if (seg.length < 2) continue;
          ds.entities.add({
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(seg.flat()),
              width: line.angle === 'MC' || line.angle === 'IC' ? 2.2 : 1.6,
              material:
                line.angle === 'IC' || line.angle === 'DC'
                  ? new Cesium.PolylineDashMaterialProperty({
                      color: color.withAlpha(0.85),
                      dashLength: 14,
                    })
                  : color.withAlpha(0.9),
              clampToGround: true,
            },
          });
          // Label at the top of a meridian, mid-curve for AC/DC.
          const mid =
            seg[
              Math.floor(
                seg.length *
                  (line.angle === 'MC'
                    ? 0.78
                    : line.angle === 'IC'
                      ? 0.22
                      : 0.5),
              )
            ];
          ds.entities.add({
            position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
            label: {
              text: `${chart.body} ${ANGLE_LABEL[line.angle]}`,
              font: '600 11px "ADAM Sans", sans-serif',
              fillColor: color,
              showBackground: true,
              backgroundColor:
                Cesium.Color.fromCssColorString('#050a10').withAlpha(0.7),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                4e7,
              ),
            },
          });
        }
      }
    }
    state.computed = {
      utc: utc.toISOString(),
      bodies: charts.map((c) => ({
        body: c.body,
        ra: +c.ra.toFixed(2),
        dec: +c.dec.toFixed(2),
      })),
    };
    state.note = `${charts.length} bodies · ${utc.toISOString().slice(0, 16).replace('T', ' ')} UTC · MC/AC solid, IC/DC dashed`;
    governorRequestRender('astro');
    render();
    return state.computed;
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-astro');
  card.id = 'adam-astro';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Astrocartography');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function field(labelText, input) {
    const wrap = el(doc, 'label', 'adam-settings-row');
    wrap.append(el(doc, 'span', 'adam-settings-label', labelText), input);
    return wrap;
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

    const dateIn = el(doc, 'input', 'adam-settings-select');
    dateIn.type = 'date';
    dateIn.value = state.date;
    dateIn.addEventListener('keydown', (e) => e.stopPropagation());
    dateIn.addEventListener('change', () => {
      state.date = dateIn.value;
    });
    const timeIn = el(doc, 'input', 'adam-settings-select');
    timeIn.type = 'time';
    timeIn.value = state.time;
    timeIn.addEventListener('keydown', (e) => e.stopPropagation());
    timeIn.addEventListener('change', () => {
      state.time = timeIn.value;
    });
    const tz = el(doc, 'select', 'adam-settings-select');
    for (const h of OFFSETS)
      tz.append(new Option(fmtOffset(h), String(h), false, h === state.offset));
    tz.addEventListener('change', () => {
      state.offset = Number(tz.value);
    });
    body.append(
      field('date', dateIn),
      field('local time', timeIn),
      field('time zone', tz),
    );

    const go = el(doc, 'button', 'adam-chip', 'place the sky');
    go.type = 'button';
    go.addEventListener('click', () => void compute());
    const nowBtn = el(doc, 'button', 'adam-chip', 'now');
    nowBtn.type = 'button';
    nowBtn.addEventListener('click', () => {
      const t = new Date();
      state.date = t.toISOString().slice(0, 10);
      state.time = t.toTimeString().slice(0, 5);
      state.offset = -t.getTimezoneOffset() / 60;
      compute();
    });
    const clear = el(doc, 'button', 'adam-chip', 'clear');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      ds.entities.removeAll();
      state.computed = null;
      state.note = '';
      governorRequestRender('astro');
      render();
    });
    const row = el(doc, 'div', 'adam-res-kinds');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:8px 0';
    row.append(go, nowBtn, clear);
    body.append(row);
    if (state.note) body.append(el(doc, 'p', 'adam-volc-note', state.note));

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'bodies'));
    const bodyRow = el(doc, 'div', 'adam-res-kinds');
    bodyRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px';
    for (const b of BODIES) {
      const on = state.active.has(b);
      const btn = el(doc, 'button', `adam-chip${on ? ' is-on' : ''}`, b);
      btn.type = 'button';
      btn.style.borderColor = on ? BODY_COLORS[b] : '';
      btn.addEventListener('click', () => {
        if (on) state.active.delete(b);
        else state.active.add(b);
        if (state.computed) compute();
        else render();
      });
      bodyRow.append(btn);
    }
    body.append(bodyRow);

    if (state.computed?.bodies?.length) {
      body.append(
        el(doc, 'h3', 'adam-meta adam-ops-section', 'positions (ra / dec)'),
      );
      for (const p of state.computed.bodies) {
        const line = el(
          doc,
          'div',
          'adam-space-sub',
          `${p.body} — ra ${p.ra}°, dec ${p.dec}°`,
        );
        const dot = el(doc, 'span', 'adam-infra-dot');
        dot.style.background = BODY_COLORS[p.body];
        line.prepend(dot);
        body.append(line);
      }
    }
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Where each body was on an angle at the chosen instant: MC / IC are the meridians it was culminating over (solid) and opposite (dashed); AC / DC are where it was rising (solid) and setting (dashed). Sky geometry only — nothing about anyone born or living on a line. Positions use a compact planetary theory (Moon ~0.25°, Pluto approximate).',
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
  chip.title =
    'Astrocartography: planetary lines over Earth for a date and time';
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
    /** Set the moment and draw. date 'YYYY-MM-DD', time 'HH:MM', offset hours. */
    place({ date, time, offset } = {}) {
      if (date) state.date = date;
      if (time) state.time = time;
      if (offset != null) state.offset = Number(offset);
      setOpen(true);
      return compute();
    },
    toggle(body, on) {
      if (!BODIES.includes(body))
        return { ok: false, error: `unknown body ${body}` };
      if (on === false) state.active.delete(body);
      else state.active.add(body);
      if (state.computed) compute();
      return { ok: true, active: [...state.active] };
    },
    clear() {
      ds.entities.removeAll();
      state.computed = null;
      governorRequestRender('astro');
      render();
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
