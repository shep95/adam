/**
 * HISTORY: wars on a timeline from the present back to antiquity.
 *
 * Scrub or play (back into the past, or forward to now). At each year the
 * globe shows the wars being fought — a marker at each theatre in its era's
 * colour — the key battles of the last few years, and every battle Wikidata
 * has coordinates for in that span. The side card lists the wars of the
 * moment with who fought and the strategies that defined them.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import './historyTimeline.css';
import {
  ERAS,
  WARS,
  battlesUpTo,
  eraOf,
  formatYear,
  warsAt,
} from '../../history/wars.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';

const LABEL_TITLE = 'history';
const LABEL_BACK = '◀ play back';
const LABEL_FWD = 'play ▶';
const LABEL_STOP = 'pause';
const NOW = new Date().getFullYear();

/** Piecewise slider scale: recent centuries get more room than antiquity. */
const SEGMENTS = [
  [0, -500],
  [140, 500],
  [290, 1500],
  [430, 1800],
  [570, 1914],
  [720, 1946],
  [860, 1992],
  [1000, NOW],
];

export function sliderToYear(v) {
  for (let i = 1; i < SEGMENTS.length; i += 1) {
    const [x1, y1] = SEGMENTS[i];
    const [x0, y0] = SEGMENTS[i - 1];
    if (v <= x1) return Math.round(y0 + ((v - x0) / (x1 - x0)) * (y1 - y0));
  }
  return NOW;
}

export function yearToSlider(y) {
  for (let i = 1; i < SEGMENTS.length; i += 1) {
    const [x1, y1] = SEGMENTS[i];
    const [x0, y0] = SEGMENTS[i - 1];
    if (y <= y1)
      return Math.round(x0 + ((Math.max(y, y0) - y0) / (y1 - y0)) * (x1 - x0));
  }
  return 1000;
}

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installHistoryTimeline({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  const marks = new Cesium.CustomDataSource('adam-history');
  const live = new Cesium.CustomDataSource('adam-history-wikidata');
  viewer.dataSources.add(marks);
  viewer.dataSources.add(live);
  cleanups.push(() => {
    viewer.dataSources.remove(marks, true);
    viewer.dataSources.remove(live, true);
  });
  let year = NOW;
  let playing = 0; // -1 back, +1 forward
  let raf = 0;
  let lastFrame = 0;
  let liveTimer = null;
  let liveNote = '';
  const liveCache = new Map();

  // ── Bar ────────────────────────────────────────────────────────────────
  const bar = el(doc, 'section', 'adam-panel adam-history-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'War history timeline');
  const yearLabel = el(doc, 'span', 'adam-history-year', formatYear(year));
  const back = el(doc, 'button', 'adam-chip', LABEL_BACK);
  back.type = 'button';
  const fwd = el(doc, 'button', 'adam-chip', LABEL_FWD);
  fwd.type = 'button';
  const slider = el(doc, 'input', 'adam-history-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.value = '1000';
  slider.setAttribute('aria-label', 'Year');
  const legend = el(doc, 'div', 'adam-history-legend');
  for (const e of ERAS) {
    const k = el(doc, 'button', 'adam-history-era', e.label);
    k.type = 'button';
    k.style.setProperty('--era', e.color);
    k.title = `${formatYear(e.from)} – ${e.to > 3000 ? 'now' : formatYear(e.to)}`;
    k.addEventListener('click', () =>
      setYear(
        Math.min(
          NOW,
          e.to > 3000 ? NOW : Math.round((Math.max(e.from, -500) + e.to) / 2),
        ),
      ),
    );
    legend.append(k);
  }
  const close = el(doc, 'button', 'adam-ops-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => setOpen(false));
  const row = el(doc, 'div', 'adam-history-row');
  row.append(back, yearLabel, slider, fwd, close);
  bar.append(row, legend);
  doc.body.append(bar);
  cleanups.push(() => bar.remove());

  // ── Side card ──────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-place adam-history-card');
  card.hidden = true;
  card.setAttribute('aria-label', 'Wars of the moment');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function renderCard() {
    const active = warsAt(year, NOW);
    const head = el(doc, 'header', 'adam-place-head');
    const titles = el(doc, 'div', 'adam-place-titles');
    titles.append(
      el(
        doc,
        'span',
        'adam-place-kicker',
        `${eraOf(year).label} · ${formatYear(year)}`,
      ),
      el(
        doc,
        'h2',
        'adam-place-title',
        active.length
          ? `${active.length} war${active.length === 1 ? '' : 's'} being fought`
          : 'no major war in this list',
      ),
    );
    head.append(titles);
    const body = el(doc, 'div', 'adam-place-body');
    for (const w of active) {
      const item = el(doc, 'div', 'adam-history-war');
      const name = el(doc, 'button', 'adam-symbols-go', w.name);
      name.type = 'button';
      name.style.color = w.color;
      name.addEventListener('click', () =>
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, 2_500_000),
          duration: 1.4,
        }),
      );
      item.append(
        name,
        el(
          doc,
          'div',
          'adam-space-sub',
          `${formatYear(w.start)} – ${w.ongoing ? 'ongoing (as of 2025; check current reporting)' : formatYear(w.end)} · ${w.type}`,
        ),
        el(doc, 'div', 'adam-space-sub', w.sides),
        el(doc, 'p', 'adam-history-strategy', `strategy: ${w.strategies}`),
      );
      const recent = w.battles.filter((b) => b.year <= year);
      if (recent.length)
        item.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            `battles so far: ${recent.map((b) => `${b.name} (${formatYear(b.year)})`).join(', ')}`,
          ),
        );
      body.append(item);
    }
    if (liveNote) body.append(el(doc, 'p', 'adam-place-note', liveNote));
    body.append(
      el(
        doc,
        'p',
        'adam-place-note',
        'Curated wars and battles; the smaller markers are every battle Wikidata places in these years.',
      ),
    );
    card.replaceChildren(head, body);
  }

  function draw() {
    marks.entities.removeAll();
    for (const w of warsAt(year, NOW)) {
      const color = Cesium.Color.fromCssColorString(w.color);
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(w.lon, w.lat),
        point: {
          pixelSize: 16,
          color: color.withAlpha(0.35),
          outlineColor: color,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: w.name,
          font: '600 13px "ADAM Sans", sans-serif',
          fillColor: color,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#061015').withAlpha(0.8),
          pixelOffset: new Cesium.Cartesian2(14, -6),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    for (const b of battlesUpTo(year, 4)) {
      const color = Cesium.Color.fromCssColorString(b.color);
      const age = year - b.year;
      marks.entities.add({
        position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat),
        point: {
          pixelSize: 9,
          color: color.withAlpha(1 - age * 0.18),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${b.name} · ${formatYear(b.year)}`,
          font: '500 11px "ADAM Sans", sans-serif',
          fillColor: Cesium.Color.WHITE,
          showBackground: true,
          backgroundColor: color.withAlpha(0.55),
          pixelOffset: new Cesium.Cartesian2(10, 8),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            1.2e7,
          ),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    governorRequestRender('history');
  }

  function drawLive(battles) {
    live.entities.removeAll();
    const color = Cesium.Color.fromCssColorString(eraOf(year).color);
    for (const b of battles)
      live.entities.add({
        position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat),
        point: {
          pixelSize: 5,
          color: color.withAlpha(0.8),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
          outlineWidth: 1,
        },
        label: {
          text: b.name,
          font: '500 10px "ADAM Sans", sans-serif',
          fillColor: color,
          pixelOffset: new Cesium.Cartesian2(8, 0),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6),
        },
      });
    governorRequestRender('history');
  }

  async function loadLive() {
    const from = year - 5;
    const to = year;
    const key = `${from}:${to}`;
    try {
      let battles = liveCache.get(key);
      if (!battles) {
        const r = await fetchImpl(`/api/history/battles?from=${from}&to=${to}`);
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || r.status);
        battles = b.battles || [];
        liveCache.set(key, battles);
      }
      if (from !== year - 5) return;
      drawLive(battles);
      liveNote = `${battles.length} battles on Wikidata between ${formatYear(from)} and ${formatYear(to)}`;
    } catch (error) {
      live.entities.removeAll();
      liveNote = `wikidata battles unavailable (${error.message})`;
    }
    if (!card.hidden) renderCard();
  }

  function setYear(y, { fromSlider = false } = {}) {
    year = Math.max(-500, Math.min(NOW, Math.round(y)));
    yearLabel.textContent = formatYear(year);
    yearLabel.style.color = eraOf(year).color;
    if (!fromSlider) slider.value = String(yearToSlider(year));
    draw();
    renderCard();
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void loadLive(), playing ? 900 : 350);
  }

  function stop() {
    playing = 0;
    cancelAnimationFrame(raf);
    back.textContent = LABEL_BACK;
    fwd.textContent = LABEL_FWD;
    releaseContinuousRender('history');
  }

  function step(t) {
    if (!playing) return;
    const dt = (t - lastFrame) / 1000;
    lastFrame = t;
    // Years per second scale with the era: slower through the 20th century.
    const rate = year > 1900 ? 4 : year > 1500 ? 15 : 40;
    const next = year + playing * rate * dt;
    if (next <= -500 || next >= NOW) {
      setYear(next);
      return stop();
    }
    if (Math.round(next) !== year) setYear(next);
    else year = next;
    raf = requestAnimationFrame(step);
  }

  function play(direction) {
    if (playing === direction) return stop();
    stop();
    playing = direction;
    (direction < 0 ? back : fwd).textContent = LABEL_STOP;
    holdContinuousRender('history');
    lastFrame = performance.now();
    raf = requestAnimationFrame(step);
  }

  back.addEventListener('click', () => play(-1));
  fwd.addEventListener('click', () => play(1));
  slider.addEventListener('input', () => {
    stop();
    setYear(sliderToYear(Number(slider.value)), { fromSlider: true });
  });

  function setOpen(open) {
    bar.hidden = !open;
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) setYear(year);
    else {
      stop();
      marks.entities.removeAll();
      live.entities.removeAll();
      governorRequestRender('history');
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'War history timeline, present to antiquity';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(bar.hidden));
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
  cleanups.push(stop);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Shepherd: jump to a year; returns the wars then with strategies. */
    goTo(y) {
      if (bar.hidden) setOpen(true);
      stop();
      setYear(Number.isFinite(y) ? y : NOW);
      return {
        year: formatYear(year),
        era: eraOf(year).label,
        wars: warsAt(year, NOW).map((w) => ({
          name: w.name,
          years: `${formatYear(w.start)}–${w.ongoing ? 'ongoing' : formatYear(w.end)}`,
          sides: w.sides,
          strategies: w.strategies,
          battles: w.battles.map((b) => `${b.name} ${formatYear(b.year)}`),
        })),
      };
    },
    play: (direction = -1) => {
      if (bar.hidden) setOpen(true);
      play(direction < 0 ? -1 : 1);
      return {
        playing: direction < 0 ? 'back' : 'forward',
        from: formatYear(year),
      };
    },
    find(name) {
      const q = String(name || '').toLowerCase();
      const w = WARS.find((x) => x.name.toLowerCase().includes(q));
      if (!w) return { ok: false, error: `no war matches ${name}` };
      const out = this.goTo(w.battles[0]?.year ?? w.start);
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(w.lon, w.lat, 3_000_000),
        duration: 1.5,
      });
      return { ok: true, ...out };
    },
    destroy() {
      clearTimeout(liveTimer);
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
