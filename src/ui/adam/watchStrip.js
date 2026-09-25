/**
 * WATCH: the persistent heads-up surface. Whatever panel is open, the top
 * of the ranked picture (intel.triage) stays in the top-right corner, each
 * line clickable to fly there; the same items are marked on the globe (a
 * ring sized to the kind, coloured by score); and anything new scoring 65+
 * is posted into Shepherd as an ambient WATCH line, unasked.
 */
import * as Cesium from 'cesium';
import './watchStrip.css';
import { governorRequestRender } from '../../renderGovernor.js';

const POLL_MS = 5000;
const SHOW = 3;
const ANNOUNCE_AT = 65;
const MARK_AT = 45;
const LABEL_MARKERS = 'MARKS';
const LABEL_NOMINAL = 'PICTURE NOMINAL';
const RING_KM = { orbit: 30, 'pattern-cluster': 60, exposure: 40, alert: 25 };

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const tier = (score) =>
  score >= 80 ? 'critical' : score >= 60 ? 'alert' : 'primary';

export function installWatchStrip({
  viewer,
  intel,
  doc = document,
  getShepherd = () => globalThis.__godsEyeView?.shepherd,
}) {
  const strip = el(doc, 'section', 'adam-watch');
  strip.setAttribute('aria-label', 'Watch');
  strip.setAttribute('aria-live', 'polite');
  const head = el(doc, 'div', 'adam-watch-head');
  const title = el(doc, 'span', 'adam-watch-title', 'WATCH');
  const marksBtn = el(doc, 'button', 'adam-watch-toggle', LABEL_MARKERS);
  marksBtn.type = 'button';
  marksBtn.setAttribute('aria-pressed', 'true');
  head.append(title, marksBtn);
  const list = el(doc, 'ol', 'adam-watch-list');
  strip.append(head, list);
  doc.body.append(strip);

  const source = new Cesium.CustomDataSource('adam-watch');
  viewer.dataSources.add(source);
  let marks = true;
  marksBtn.addEventListener('click', () => {
    marks = !marks;
    marksBtn.setAttribute('aria-pressed', String(marks));
    source.show = marks;
    governorRequestRender('adam-watch');
  });

  const announced = new Set();
  let firstPass = true;
  let items = [];

  function fly(item) {
    if (!Number.isFinite(item.lat)) return;
    const km = RING_KM[item.kind] || 15;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        item.lon,
        item.lat,
        Math.max(25_000, km * 5000),
      ),
      duration: 1.6,
    });
  }

  function renderStrip() {
    list.replaceChildren();
    strip.classList.toggle('is-quiet', !items.length);
    if (!items.length) {
      list.append(el(doc, 'li', 'adam-watch-quiet', LABEL_NOMINAL));
      return;
    }
    for (const item of items.slice(0, SHOW)) {
      const li = el(doc, 'li', `adam-watch-item is-${tier(item.score)}`);
      const btn = el(doc, 'button', 'adam-watch-btn');
      btn.type = 'button';
      btn.title = `${item.label}\n${item.why}`;
      btn.append(
        el(doc, 'span', 'adam-watch-score', String(item.score)),
        el(doc, 'span', 'adam-watch-text', item.title),
      );
      btn.addEventListener('click', () => fly(item));
      li.append(btn);
      list.append(li);
    }
    if (items.length > SHOW)
      list.append(
        el(
          doc,
          'li',
          'adam-watch-more',
          `+${items.length - SHOW} more in BRIEF`,
        ),
      );
  }

  function renderMarks() {
    source.entities.removeAll();
    for (const item of items) {
      if (item.score < MARK_AT || !Number.isFinite(item.lat)) continue;
      const color = Cesium.Color.fromCssColorString(
        item.score >= 80 ? '#E53935' : item.score >= 60 ? '#f5a623' : '#00BCD4',
      );
      const km = RING_KM[item.kind] || 15;
      source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(item.lon, item.lat),
        ellipse: {
          semiMajorAxis: km * 1000,
          semiMinorAxis: km * 1000,
          material: color.withAlpha(0.08),
          outline: true,
          outlineColor: color.withAlpha(0.85),
          height: 0,
        },
        label: {
          text: `${item.score} · ${item.title}`,
          font: '500 11px "ADAM Mono", monospace',
          fillColor: color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6e6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    governorRequestRender('adam-watch');
  }

  function announce() {
    const room = getShepherd()?.room;
    for (const item of items) {
      if (item.score < ANNOUNCE_AT || announced.has(item.id)) continue;
      announced.add(item.id);
      // Items present at start-up are the standing picture, not news.
      if (firstPass) continue;
      room?.notice?.(`WATCH ${item.score} · ${item.title} — ${item.label}`);
      intel.logEvent?.({
        kind: item.kind,
        severity: item.score >= 80 ? 'critical' : 'watch',
        title: item.title,
        detail: `${item.label} · ${item.why}`,
        lat: item.lat,
        lon: item.lon,
        ref: item.id,
        score: item.score,
      });
    }
    firstPass = false;
  }

  function tick() {
    try {
      items = intel.triage({ limit: 20 });
    } catch {
      items = [];
    }
    renderStrip();
    renderMarks();
    announce();
  }

  const timer = setInterval(tick, POLL_MS);
  const unsubscribe = intel.subscribe?.((type) => {
    if (
      [
        'alert-tripped',
        'alerts-changed',
        'patterns-changed',
        'mission-changed',
      ].includes(type)
    )
      tick();
  });
  setTimeout(tick, 1500);

  return {
    items: () => items.slice(),
    refresh: tick,
    setMarks(on) {
      marks = Boolean(on);
      source.show = marks;
      marksBtn.setAttribute('aria-pressed', String(marks));
    },
    destroy() {
      clearInterval(timer);
      unsubscribe?.();
      strip.remove();
      viewer.dataSources.remove(source, true);
    },
  };
}
