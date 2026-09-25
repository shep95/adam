/**
 * REWIND (R): scrub back through the last ~45 minutes of held tracks.
 *
 * Past-position markers show where every tracked aircraft and vessel was at the
 * chosen moment, with a short tail of the five minutes before it. Live
 * contacts keep their real positions underneath; LIVE returns to now. Play
 * runs history forward at 30× (one real second = 30 s of history).
 *
 * The history is the pattern watcher's decimated samples (one per ~30 s), so
 * markers are interpolated — a reconstruction, labelled as such.
 */
import * as Cesium from 'cesium';
import './rewind.css';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../../renderGovernor.js';

const PLAY_RATE = 30;
const TAIL_MS = 5 * 60_000;
const COLORS = {
  flights: '#00BCD4',
  military: '#E53935',
  'ais-live-vessels': '#4DD0E1',
};
const LABEL_LIVE = 'LIVE';
const LABEL_PLAY = 'PLAY';
const LABEL_PAUSE = 'PAUSE';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clock(ms) {
  return new Date(ms).toISOString().slice(11, 19) + 'Z';
}

export function installRewind({ viewer, intel, doc = document }) {
  const api = intel?.rewind;
  if (!api) return { destroy() {} };
  const cleanups = [];
  const points = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  const tails = viewer.scene.primitives.add(new Cesium.PolylineCollection());
  cleanups.push(() => {
    viewer.scene.primitives.remove(points);
    viewer.scene.primitives.remove(tails);
  });

  const bar = el(doc, 'section', 'adam-panel adam-rewind');
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Rewind');
  const title = el(doc, 'span', 'adam-meta adam-rewind-title', 'REWIND');
  const play = el(doc, 'button', 'adam-chip adam-rewind-play', LABEL_PLAY);
  play.type = 'button';
  const slider = el(doc, 'input', 'adam-rewind-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.value = '1000';
  slider.setAttribute('aria-label', 'Time');
  const readout = el(doc, 'span', 'adam-readout adam-rewind-time', '—');
  const live = el(doc, 'button', 'adam-chip adam-rewind-live', LABEL_LIVE);
  live.type = 'button';
  const note = el(
    doc,
    'span',
    'adam-meta adam-rewind-note',
    'reconstructed from ~30 s samples',
  );
  bar.append(title, play, slider, readout, live, note);
  doc.body.append(bar);
  cleanups.push(() => bar.remove());

  let at = null; // null = live
  let playing = false;
  let lastFrame = 0;
  let raf = null;

  function range() {
    return api.range();
  }

  function draw() {
    points.removeAll();
    tails.removeAll();
    if (at == null) {
      governorRequestRender('adam-rewind');
      return;
    }
    const past = api.snapshotAt(at);
    for (const g of past) {
      const color = Cesium.Color.fromCssColorString(
        COLORS[g.layerKey] || '#B0BEC5',
      );
      const vessel = g.layerKey === 'ais-live-vessels';
      points.add({
        position: Cesium.Cartesian3.fromDegrees(
          g.lon,
          g.lat,
          vessel ? 5 : 9000,
        ),
        pixelSize: vessel ? 5 : 6,
        color: color.withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      const track = api
        .trackOf(g.layerKey, g.id)
        .filter((p) => p.t <= at && p.t >= at - TAIL_MS);
      if (track.length) {
        const coords = [];
        for (const p of track) coords.push(p.lon, p.lat);
        coords.push(g.lon, g.lat);
        if (coords.length >= 4)
          tails.add({
            positions: Cesium.Cartesian3.fromDegreesArray(coords),
            width: 1.5,
            material: Cesium.Material.fromType('Color', {
              color: color.withAlpha(0.45),
            }),
          });
      }
    }
    readout.textContent = `${clock(at)} · −${Math.round((Date.now() - at) / 60_000)} min · ${past.length}`;
    governorRequestRender('adam-rewind');
  }

  function setAt(ms) {
    const r = range();
    if (!r) {
      at = null;
      readout.textContent = 'no history yet — keep layers on a few minutes';
      draw();
      return;
    }
    at = ms == null ? null : Math.min(Math.max(ms, r.from), r.to);
    slider.value =
      at == null
        ? '1000'
        : String(
            Math.round(((at - r.from) / Math.max(1, r.to - r.from)) * 1000),
          );
    if (at == null) readout.textContent = LABEL_LIVE;
    bar.classList.toggle('is-rewound', at != null);
    draw();
  }

  function stopPlay() {
    playing = false;
    play.textContent = LABEL_PLAY;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    releaseContinuousRender('adam-rewind');
  }

  function step(now) {
    if (!playing) return;
    const dt = now - lastFrame;
    lastFrame = now;
    const r = range();
    if (!r || at == null) return stopPlay();
    const next = at + dt * PLAY_RATE;
    if (next >= r.to) {
      setAt(r.to);
      return stopPlay();
    }
    setAt(next);
    raf = requestAnimationFrame(step);
  }

  play.addEventListener('click', () => {
    if (playing) return stopPlay();
    const r = range();
    if (!r) return setAt(null);
    if (at == null || at >= r.to) setAt(r.from);
    playing = true;
    play.textContent = LABEL_PAUSE;
    holdContinuousRender('adam-rewind');
    lastFrame = performance.now();
    raf = requestAnimationFrame(step);
  });
  slider.addEventListener('input', () => {
    stopPlay();
    const r = range();
    if (!r) return setAt(null);
    const v = Number(slider.value);
    setAt(v >= 1000 ? null : r.from + ((r.to - r.from) * v) / 1000);
  });
  live.addEventListener('click', () => {
    stopPlay();
    setAt(null);
  });

  function setOpen(open) {
    bar.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (!open) {
      stopPlay();
      setAt(null);
    } else {
      const r = range();
      readout.textContent = r
        ? `${LABEL_LIVE} · ${Math.round((r.to - r.from) / 60_000)} min held`
        : 'no history yet — keep layers on a few minutes';
    }
  }

  // Rail chip, docked before KEYS like SKY.
  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Rewind the last 45 minutes (R)';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(
    el(doc, 'span', 'adam-ops-rail-label', 'REWIND'),
    el(doc, 'kbd', 'adam-ops-rail-key', 'R'),
  );
  chip.addEventListener('click', () => setOpen(bar.hidden));
  const dock = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    const keys = [...rail.children].find((c) => c.textContent.includes('KEYS'));
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

  const onKey = (event) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (
      event.target?.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    if (event.repeat) return;
    if (event.key === 'r' || event.key === 'R') setOpen(bar.hidden);
    else if (event.key === 'Escape' && !bar.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));
  cleanups.push(stopPlay);

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Jump to `minutesAgo` (null = live). */
    seek(minutesAgo) {
      if (bar.hidden) setOpen(true);
      stopPlay();
      setAt(minutesAgo == null ? null : Date.now() - minutesAgo * 60_000);
      return { at, range: range() };
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
