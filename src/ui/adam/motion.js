/**
 * ADAM motion language — the moments that tell the operator something
 * happened, each short, each tied to a real event:
 *
 *   scan-line       a layer comes online: one sweep with its name riding it
 *   acquisition     a contact is tracked: a ring closes onto it and locks
 *   trail trace     a tracked aircraft's trail lights from tail to head
 *   phosphor bloom  a chip that turns on glows and decays like a CRT phosphor
 *   scope waveform  while the voice analyst listens or speaks, the scope edge
 *                   carries its waveform
 *   panel drift     during a fly-to, the side panels ease back and settle
 *   ignition        switching to NVG or FLIR warms up like the real tube
 *
 * Everything is skipped under prefers-reduced-motion.
 */
import './motion.css';
import * as Cesium from 'cesium';
import { getKeyholeGeometry } from '../../celestialRing.js';
import { newlyEnabled, thinPositions } from './motionMath.js';
import { isScopeMaskEnabled } from '../../scopeMask.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../../renderGovernor.js';

const SCAN_MERGE_MS = 350;
const TRACE_MS = 1400;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function installMotion({
  viewer,
  dataManager,
  doc = document,
  win = globalThis,
}) {
  const cleanups = [];
  const reduced = () =>
    Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // ── Scan-line on layer activation ────────────────────────────────────────
  const scan = el(doc, 'div', 'adam-scan');
  scan.setAttribute('aria-hidden', 'true');
  const scanLabel = el(doc, 'span', 'adam-scan-label');
  scan.append(scanLabel);
  doc.body.append(scan);
  cleanups.push(() => scan.remove());
  let pendingNames = [];
  let scanTimer = null;
  const layerName = (id) =>
    dataManager.getAll?.().find((l) => l.id === id)?.name || id;
  function runScan() {
    scanTimer = null;
    if (!pendingNames.length || reduced()) return (pendingNames = []);
    const names = pendingNames.slice(0, 3);
    const extra = pendingNames.length - names.length;
    scanLabel.textContent = `ONLINE · ${names.join(' · ').toUpperCase()}${extra > 0 ? ` +${extra}` : ''}`;
    pendingNames = [];
    scan.classList.remove('is-on');
    void scan.offsetWidth;
    scan.classList.add('is-on');
  }
  let enabledIds = new Set(
    (dataManager.getAll?.() || []).filter((l) => l.enabled).map((l) => l.id),
  );
  const unsubscribe = dataManager.subscribe?.(() => {
    const now = new Set(
      (dataManager.getAll?.() || []).filter((l) => l.enabled).map((l) => l.id),
    );
    const fresh = newlyEnabled(enabledIds, now);
    enabledIds = now;
    if (!fresh.length) return;
    pendingNames.push(...fresh.map(layerName));
    clearTimeout(scanTimer);
    scanTimer = setTimeout(runScan, SCAN_MERGE_MS);
  });
  if (unsubscribe) cleanups.push(unsubscribe);

  // ── Acquisition ring + trail trace on tracking ───────────────────────────
  const ring = el(doc, 'div', 'adam-acquire');
  ring.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i += 1)
    ring.append(el(doc, 'span', `adam-acquire-tick t${i}`));
  doc.body.append(ring);
  cleanups.push(() => ring.remove());

  function screenPoint(entity) {
    const pos = entity?.position?.getValue?.(viewer.clock.currentTime);
    if (!pos) return null;
    const p = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      pos,
    );
    if (!p) return null;
    const rect = viewer.scene.canvas.getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  let ringFrame = 0;
  function acquire(entity) {
    if (reduced()) return;
    const start = performance.now();
    ring.classList.remove('is-on');
    void ring.offsetWidth;
    ring.classList.add('is-on');
    cancelAnimationFrame(ringFrame);
    // Follow the contact while the ring closes (the camera is moving too).
    const follow = () => {
      const p = screenPoint(entity);
      if (p) ring.style.transform = `translate(${p.x}px, ${p.y}px)`;
      if (performance.now() - start < 1100)
        ringFrame = requestAnimationFrame(follow);
    };
    follow();
  }

  const traceSource = new Cesium.CustomDataSource('adam-trace');
  viewer.dataSources.add(traceSource);
  cleanups.push(() => viewer.dataSources.remove(traceSource, true));
  let traceToken = 0;
  async function traceTrail() {
    if (reduced()) return;
    const token = ++traceToken;
    const flights = dataManager.layers?.get('flights')?.module;
    if (typeof flights?.getTrackedTrailPositions !== 'function') return;
    // The trail seeds immediately and backfills shortly after; wait briefly.
    let positions = [];
    for (let i = 0; i < 15 && token === traceToken; i += 1) {
      positions = flights.getTrackedTrailPositions();
      if (positions.length >= 6) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (token !== traceToken || positions.length < 3) return;
    const path = thinPositions(positions);
    const started = performance.now();
    traceSource.entities.removeAll();
    const head = () => {
      const t = Math.min(1, (performance.now() - started) / TRACE_MS);
      const eased = 1 - (1 - t) ** 3;
      const end = Math.max(2, Math.round(eased * path.length));
      const tail = Math.max(0, end - Math.round(path.length * 0.28));
      return path.slice(tail, end);
    };
    traceSource.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(head, false),
        width: 9,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.35,
          taperPower: 0.4,
          color: Cesium.Color.fromCssColorString('#7fe9ff').withAlpha(0.95),
        }),
      },
    });
    holdContinuousRender('adam-trace');
    setTimeout(() => {
      if (token === traceToken) traceSource.entities.removeAll();
      releaseContinuousRender('adam-trace');
      governorRequestRender('adam-trace-end');
    }, TRACE_MS + 250);
  }

  const removeTracked = viewer.trackedEntityChanged.addEventListener(
    (entity) => {
      if (!entity) {
        traceToken += 1;
        traceSource.entities.removeAll();
        return;
      }
      acquire(entity);
      void traceTrail();
    },
  );
  cleanups.push(removeTracked);

  // ── Phosphor bloom on chips that turn on ─────────────────────────────────
  const CHIP =
    '.adam-ops-rail-btn, .pp-toggle-btn, .data-toggle-row, .style-btn, .sky-btn, .adam-chip';
  const bloom = (node) => {
    if (reduced() || !node?.matches?.(CHIP)) return;
    node.classList.remove('adam-phosphor');
    void node.offsetWidth;
    node.classList.add('adam-phosphor');
  };
  const isOn = (node) =>
    node.getAttribute('aria-pressed') === 'true' ||
    node.classList.contains('active');
  const chipObserver = new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target;
      if (!t.matches?.(CHIP) || !isOn(t)) continue;
      const wasOn =
        r.attributeName === 'aria-pressed'
          ? r.oldValue === 'true'
          : /(^|\s)active(\s|$)/.test(r.oldValue || '');
      if (!wasOn) bloom(t);
    }
  });
  // aria-pressed changes are rare, so the whole document is cheap to watch;
  // class changes are frequent, so only the chip containers are watched.
  chipObserver.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['aria-pressed'],
  });
  const watchClasses = () => {
    let found = 0;
    for (const id of [
      'style-buttons',
      'pp-toggles',
      'left-panel-stack',
      'right-context-rail',
    ]) {
      const node = doc.getElementById(id);
      if (!node || node.dataset.adamPhosphor) continue;
      node.dataset.adamPhosphor = '1';
      chipObserver.observe(node, {
        subtree: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ['class'],
      });
      found += 1;
    }
    return found;
  };
  watchClasses();
  const classRetry = setTimeout(watchClasses, 4000);
  cleanups.push(() => {
    clearTimeout(classRetry);
    chipObserver.disconnect();
  });

  // ── Scope waveform while the voice analyst is active ─────────────────────
  const wave = el(doc, 'canvas', 'adam-scope-wave');
  wave.setAttribute('aria-hidden', 'true');
  doc.body.append(wave);
  cleanups.push(() => wave.remove());
  const ctx = wave.getContext('2d');
  let waveFrame = 0;
  let phase = 0;
  let smooth = 0;
  const voiceRoot = () => doc.querySelector('[data-speaker]');
  function drawWave() {
    waveFrame = 0;
    const root = voiceRoot();
    const speaker = root?.dataset.speaker;
    const active = speaker === 'user' || speaker === 'ai';
    const raw = active
      ? Number(getComputedStyle(root).getPropertyValue('--gev-voice-level')) ||
        0
      : 0;
    smooth += (raw - smooth) * 0.25;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const w = win.innerWidth;
    const h = win.innerHeight;
    if (wave.width !== Math.round(w * dpr)) {
      wave.width = Math.round(w * dpr);
      wave.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);
    if (smooth > 0.01 && isScopeMaskEnabled() && !reduced()) {
      const g = getKeyholeGeometry(w, h);
      const color = speaker === 'ai' ? '0, 212, 255' : '245, 166, 35';
      ctx.strokeStyle = `rgba(${color}, ${0.25 + smooth * 0.6})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const steps = 360;
      for (let i = 0; i <= steps; i += 1) {
        const a = (i / steps) * Math.PI * 2;
        const amp =
          smooth *
          14 *
          (0.55 +
            0.45 * Math.sin(a * 9 + phase) * Math.sin(a * 23 - phase * 1.7));
        const r = g.radius * 0.985 + amp;
        const x = g.centerX + Math.cos(a) * r;
        const y = g.centerY + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      phase += 0.08 + smooth * 0.25;
    }
    if (active || smooth > 0.01) waveFrame = requestAnimationFrame(drawWave);
  }
  const speakerObserver = new MutationObserver(() => {
    if (!waveFrame) waveFrame = requestAnimationFrame(drawWave);
  });
  const watchVoice = () => {
    const root = voiceRoot();
    if (!root) return false;
    speakerObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-speaker'],
    });
    return true;
  };
  if (!watchVoice()) {
    let tries = 0;
    const t = setInterval(() => {
      if (watchVoice() || (tries += 1) > 40) clearInterval(t);
    }, 500);
    cleanups.push(() => clearInterval(t));
  }
  cleanups.push(() => {
    speakerObserver.disconnect();
    cancelAnimationFrame(waveFrame);
  });

  // ── Panel drift during fly-to ────────────────────────────────────────────
  const removeMoveStart = viewer.camera.moveStart.addEventListener(() => {
    // Only programmatic flights drift the panels; a drag must not.
    if (!viewer.camera._currentFlight || reduced()) return;
    doc.body.classList.add('adam-in-flight');
  });
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    doc.body.classList.remove('adam-in-flight');
  });
  cleanups.push(removeMoveStart, removeMoveEnd, () =>
    doc.body.classList.remove('adam-in-flight'),
  );

  // ── NVG / FLIR ignition ──────────────────────────────────────────────────
  const ignition = el(doc, 'div', 'adam-ignition');
  ignition.setAttribute('aria-hidden', 'true');
  doc.body.append(ignition);
  cleanups.push(() => ignition.remove());
  let lastStyle = doc.documentElement.dataset.gevStyle || '';
  const styleObserver = new MutationObserver(() => {
    const style = doc.documentElement.dataset.gevStyle || '';
    if (style === lastStyle) return;
    lastStyle = style;
    if (reduced() || (style !== 'surveillance' && style !== 'thermal')) return;
    ignition.dataset.mode = style === 'thermal' ? 'flir' : 'nvg';
    ignition.classList.remove('is-on');
    void ignition.offsetWidth;
    ignition.classList.add('is-on');
  });
  styleObserver.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['data-gev-style'],
  });
  cleanups.push(() => styleObserver.disconnect());

  return {
    acquire,
    traceTrail,
    bloom,
    destroy() {
      clearTimeout(scanTimer);
      cancelAnimationFrame(ringFrame);
      releaseContinuousRender('adam-trace');
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* gone */
        }
      }
    },
  };
}
