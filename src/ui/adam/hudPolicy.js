/**
 * Operational display policy — what the chrome shows, and when.
 *
 *   state strip      VIEW (surface / near-space / orbital) + style, HUD, detect
 *   collection clock COLL timestamp; REC + elapsed only while recording
 *   suppression      AIS only near the surface and when populated; satellite
 *                    pass data only with the satellite layer on
 *   right rail       DISPLAY opens from the top bar; CCTV shows with the CCTV
 *                    layer; CONTEXT shows with a selection or the radio
 *   layer scale      rows for layers invisible from this altitude are dimmed
 */
import { showAisField, viewModeFor } from '../../hudViewMode.js';

/** Highest camera altitude (m) at which each layer still reads on screen. */
/** Short names for the top action icons (by id, then by aria-label). */
export const TOP_ACTION_LABELS = Object.freeze({
  'clear-selected-layers': 'clear',
  'share-btn': 'share',
  'tilt-map-view': 'tilt',
  'north-up-view': 'north',
  'reset-globe-view': 'globe',
  'Display controls': 'display',
  'Snapshot the view': 'snapshot',
  'Record the view': 'record',
  'Interface scale': 'scale',
  Measure: 'measure',
});

export function topActionLabel(button) {
  if (!button) return null;
  if (TOP_ACTION_LABELS[button.id]) return TOP_ACTION_LABELS[button.id];
  const aria = button.getAttribute?.('aria-label') || '';
  return TOP_ACTION_LABELS[aria] || null;
}

const OUT_OF_SCALE_TITLE = 'Too small to see from this altitude — zoom in';
const WORD_ON = 'on';
const WORD_OFF = 'off';
const LABEL_REC = 'REC';
const LABEL_UTC = 'UTC';

export const LAYER_MAX_VISIBLE_ALT_M = Object.freeze({
  flights: 3_000_000,
  military: 3_000_000,
  'ais-live-vessels': 2_000_000,
  'local-adsb': 1_000_000,
  traffic: 200_000,
  transit: 300_000,
  bikeshare: 100_000,
  cctv: 600_000,
  alpr: 100_000,
  directions: 400_000,
  'infra-power-lines': 1_500_000,
  'infra-pipelines': 3_000_000,
  'infra-border-crossings': 1_500_000,
  'local-datacenters': 2_000_000,
  'local-dams': 2_000_000,
});

export function layerOutOfScale(layerId, altM) {
  const max = LAYER_MAX_VISIBLE_ALT_M[layerId];
  return Number.isFinite(max) && altM > max;
}

const STYLE_NAMES = {
  normal: 'NORMAL',
  retro: 'CRT',
  surveillance: 'NVG',
  thermal: 'FLIR',
  anime: 'ANIME',
  noir: 'NOIR',
  snow: 'SNOW',
};

/** Smallest viewport the full cockpit instrument layout is designed for. */
export const COCKPIT_MIN = Object.freeze({ width: 1024, height: 650 });

export function cockpitCompact(width, height) {
  return width < COCKPIT_MIN.width || height < COCKPIT_MIN.height;
}

export function elapsedLabel(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `+${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function installHudPolicy({ viewer, dataManager, doc = document }) {
  const cleanups = [];
  const root = doc.documentElement;

  // ── Top action names under the icons (buttons arrive lazily) ───────────
  const actions = doc.getElementById('top-center-actions');
  const labelActions = () => {
    for (const b of actions?.querySelectorAll('button') || []) {
      if (b.querySelector('.adam-btn-label')) continue;
      const text = topActionLabel(b);
      if (!text) continue;
      const tag = doc.createElement('span');
      tag.className = 'adam-btn-label';
      tag.setAttribute('aria-hidden', 'true');
      tag.textContent = text;
      b.append(tag);
    }
  };
  labelActions();
  if (actions && typeof MutationObserver === 'function') {
    const mo = new MutationObserver(labelActions);
    mo.observe(actions, { childList: true });
    cleanups.push(() => mo.disconnect());
  }

  // ── State strip ──────────────────────────────────────────────────────────
  const indicator = doc.getElementById('style-indicator');
  const strip = doc.createElement('div');
  strip.className = 'adam-state';
  const viewLine = doc.createElement('div');
  viewLine.className = 'adam-state-view';
  const metaLine = doc.createElement('div');
  metaLine.className = 'adam-state-meta';
  strip.append(viewLine, metaLine);
  if (indicator) {
    indicator.classList.add('adam-state-strip');
    indicator.append(strip);
    cleanups.push(() => {
      strip.remove();
      indicator.classList.remove('adam-state-strip');
    });
  }

  // ── Persistent alert line under the collection clock ────────────────────
  const recLine = doc.getElementById('hud-rec');
  const alertLine = recLine ? doc.createElement('div') : null;
  if (alertLine) {
    alertLine.className = 'hud-alert-line is-suppressed';
    alertLine.setAttribute('role', 'status');
    recLine.after(alertLine);
    cleanups.push(() => alertLine.remove());
  }

  // ── Right rail: DISPLAY button on the top bar ────────────────────────────
  const display = doc.getElementById('pp-toggles');
  const cctvPanel = doc.getElementById('cctv-panel');
  const contextPanel = doc.getElementById('global-context-panel');
  let displayOpen = false;
  let selectionActive = false;
  const bar = doc.getElementById('top-center-actions');
  let tune = null;
  if (bar && display) {
    tune = doc.createElement('button');
    tune.type = 'button';
    tune.title = 'Display controls';
    tune.setAttribute('aria-label', 'Display controls');
    tune.setAttribute('aria-pressed', 'false');
    const icon = doc.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'tune';
    tune.append(icon);
    tune.addEventListener('click', () => {
      displayOpen = !displayOpen;
      if (displayOpen && display.classList.contains('collapsed'))
        display.querySelector('.pp-collapse-btn')?.click();
      refresh();
    });
    const reset = doc.getElementById('reset-globe-view');
    if (reset) reset.after(tune);
    else bar.append(tune);
    cleanups.push(() => tune.remove());
  }
  const onSelect = (e) => {
    selectionActive = Boolean(e?.detail);
    refresh();
  };
  globalThis.addEventListener?.('gev:entity-selected', onSelect);
  cleanups.push(() =>
    globalThis.removeEventListener?.('gev:entity-selected', onSelect),
  );

  const expanded = (panel) => panel && !panel.classList.contains('collapsed');
  const enabled = (id) => {
    try {
      return Boolean(dataManager?.isEnabled?.(id));
    } catch {
      return false;
    }
  };

  function refresh() {
    const altM = viewer.camera.positionCartographic.height;
    const mode = viewModeFor(altM);

    // State strip.
    const style =
      STYLE_NAMES[root.dataset.gevStyle] ||
      String(root.dataset.gevStyle || 'normal').toUpperCase();
    const hudOn = doc
      .getElementById('hud-toggle')
      ?.classList.contains('active');
    const detectOn =
      doc.getElementById('detection-toggle')?.getAttribute('aria-pressed') ===
      'true';
    viewLine.textContent = `${mode.label} view`;
    metaLine.textContent = `${style} style${hudOn === false ? ' · readouts off' : ''} · detection ${detectOn ? WORD_ON : WORD_OFF}`;

    // Collection clock / recording.
    const rec = doc.getElementById('hud-rec');
    const since = Number(root.dataset.adamRecordingSince);
    const recording = Number.isFinite(since) && since > 0;
    if (rec) {
      rec.classList.toggle('is-recording', recording);
      const label = doc.getElementById('hud-rec-label');
      if (label) label.textContent = recording ? LABEL_REC : LABEL_UTC;
      const elapsed = doc.getElementById('hud-rec-elapsed');
      if (elapsed)
        elapsed.textContent = recording ? elapsedLabel(Date.now() - since) : '';
    }

    // Persistent alert channel: tripped rules stay on screen until they clear.
    const trips =
      globalThis.__godsEyeView?.intel?.alerts?.activeTrips?.() || [];
    if (alertLine) {
      if (trips.length) {
        const first = Math.min(...trips.map((t) => t.trippedAt || Date.now()));
        const since = new Date(first).toISOString().slice(11, 16);
        alertLine.textContent = `ALERT ×${trips.length} · SINCE ${since}Z · ${String(
          trips[0].rule?.label || '',
        )
          .toUpperCase()
          .slice(0, 40)}`;
      }
      alertLine.classList.toggle('is-suppressed', trips.length === 0);
    }

    // Suppression.
    const ais = doc.getElementById('hud-ais-vessel');
    if (ais)
      ais.classList.toggle(
        'is-suppressed',
        !showAisField(altM, ais.textContent),
      );
    root.classList.toggle('adam-sat-context', enabled('satellites'));

    // Right rail relevance.
    if (display) display.classList.toggle('adam-rail-idle', !displayOpen);
    tune?.setAttribute('aria-pressed', String(displayOpen));
    if (cctvPanel)
      cctvPanel.classList.toggle(
        'adam-rail-idle',
        !(enabled('cctv') || expanded(cctvPanel)),
      );
    if (contextPanel)
      contextPanel.classList.toggle(
        'adam-rail-idle',
        !(
          viewer.trackedEntity ||
          selectionActive ||
          enabled('radio') ||
          expanded(contextPanel)
        ),
      );

    // Layer rows out of scale.
    for (const row of doc.querySelectorAll('.data-toggle-row[data-layer-id]')) {
      const out = layerOutOfScale(row.dataset.layerId, altM);
      row.classList.toggle('adam-out-of-scale', out);
      if (out) row.title = OUT_OF_SCALE_TITLE;
      else if (row.title === OUT_OF_SCALE_TITLE) row.removeAttribute('title');
    }
  }

  // ── Cockpit below its designed viewport: compact readout, said once ─────
  const notice = doc.createElement('div');
  notice.className = 'adam-cockpit-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  doc.body.append(notice);
  cleanups.push(() => notice.remove());
  let noticeShown = false;
  function syncCockpit() {
    const inCockpit = doc.body.classList.contains('cockpit-mode');
    const compact =
      inCockpit &&
      cockpitCompact(globalThis.innerWidth, globalThis.innerHeight);
    doc.body.classList.toggle('adam-cockpit-compact', compact);
    if (compact && !noticeShown) {
      noticeShown = true;
      notice.textContent = `COCKPIT NEEDS ${COCKPIT_MIN.width}×${COCKPIT_MIN.height} · COMPACT READOUT ACTIVE`;
      notice.hidden = false;
      setTimeout(() => (notice.hidden = true), 5000);
    }
    if (!inCockpit) noticeShown = false;
  }
  const bodyObserver = new MutationObserver(syncCockpit);
  bodyObserver.observe(doc.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  globalThis.addEventListener?.('resize', syncCockpit);
  cleanups.push(() => {
    bodyObserver.disconnect();
    globalThis.removeEventListener?.('resize', syncCockpit);
    doc.body.classList.remove('adam-cockpit-compact');
  });

  const timer = setInterval(refresh, 1000);
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(refresh);
  const removeTracked = viewer.trackedEntityChanged.addEventListener(refresh);
  const unsubscribe = dataManager?.subscribe?.(() => refresh());
  cleanups.push(
    () => clearInterval(timer),
    removeMoveEnd,
    removeTracked,
    () => unsubscribe?.(),
  );
  refresh();

  return {
    refresh,
    openDisplay: (open = true) => {
      displayOpen = open;
      refresh();
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* gone */
        }
      }
      for (const p of [display, cctvPanel, contextPanel])
        p?.classList.remove('adam-rail-idle');
    },
  };
}
