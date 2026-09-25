/**
 * ADAM ops deck: the operator surfaces layered over the globe.
 *
 *   ops rail        BRIEF (B) · ALERTS (A) · FILTER (G) · HEALTH · KEYS (?)
 *   last tracked    the most recently tracked contact, surviving view changes
 *   comparison rail up to four pinned contacts with live telemetry (P pins)
 *   alert flash     full-frame critical flash plus a toast when a trigger trips
 *   zones           region-filter and alert-zone outlines on the globe
 *
 * Loaded lazily after the globe is up (see src/app/tools.js), so none of this
 * sits on the startup parse path. All dynamic text goes through textContent.
 */

import * as Cesium from 'cesium';
import './opsDeck.css';
import { setOdometer } from './odometer.js';
import { assessHealth } from './systemHealth.js';
import { SCENARIOS, applyScenario } from './scenarios.js';
import { isEffectsReduced } from '../../frameBudget.js';
import {
  applyProfile,
  collectProfile,
  sealProfile,
  serverSigner,
  verifyProfile,
} from './operatorProfile.js';
import { layerSnapshots } from '../../data/layerSnapshot.js';
import { capturePolygon } from '../../intel/polygonCapture.js';
import { ALERT_LAYERS, HAZARD_RULE_LAYERS } from '../../intel/alertRules.js';
import {
  ALTITUDE_BANDS,
  TIME_WINDOWS,
  VESSEL_TYPE_CLASSES,
  describeStaleness,
  resetPresentation,
  setAltitudeBandEnabled,
  setRegionFilter,
  setStalenessEnabled,
  setTimeWindow,
  setVesselClassEnabled,
  snapshotPresentation,
  subscribePresentation,
} from '../../intel/contactPresentation.js';
import { currentShortcutMode, shortcutsForMode } from '../shortcutRegistry.js';

const LAYER_LABELS = {
  flights: 'AIRCRAFT',
  military: 'MILITARY',
  'ais-live-vessels': 'VESSEL',
  satellites: 'SATELLITE',
};
const COLLAPSE_KEY = 'adam.ops.lastTrackedCollapsed';
const FT_PER_M = 3.28084;
const KTS_PER_MPS = 1.943844;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button(doc, label, className, onClick, attrs = {}) {
  const node = el(doc, 'button', className, label);
  node.type = 'button';
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  node.addEventListener('click', onClick);
  return node;
}

function readLocal(key) {
  try {
    return globalThis.localStorage?.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function formatAltitude(m) {
  if (!Number.isFinite(m)) return '—';
  return `${Math.round(m * FT_PER_M).toLocaleString('en-US')} FT`;
}

export function formatSpeed(record) {
  const kts = Number.isFinite(record?.speedKts)
    ? record.speedKts
    : Number.isFinite(record?.speedMps)
      ? record.speedMps * KTS_PER_MPS
      : null;
  return kts === null ? '—' : `${Math.round(kts)} KT`;
}

export function formatHeading(record) {
  const deg = Number.isFinite(record?.heading)
    ? record.heading
    : Number.isFinite(record?.courseDeg)
      ? record.courseDeg
      : null;
  return deg === null
    ? '—'
    : `${String(Math.round(deg) % 360).padStart(3, '0')}°`;
}

export function formatPosition(record) {
  const { lat, lon } = record || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${Math.abs(lat).toFixed(2)}${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}${lon >= 0 ? 'E' : 'W'}`;
}

/** Telemetry rows for a contact record. */
export function telemetryRows(layerKey, record) {
  if (!record) return [];
  if (layerKey === 'ais-live-vessels') {
    return [
      ['SPD', formatSpeed(record)],
      ['CRS', formatHeading(record)],
      ['TYPE', record.shipType || '—'],
      ['DEST', record.destination || '—'],
      ['POS', formatPosition(record)],
    ];
  }
  return [
    ['ALT', record.onGround ? 'GROUND' : formatAltitude(record.altitudeM)],
    ['SPD', formatSpeed(record)],
    ['HDG', formatHeading(record)],
    ['POS', formatPosition(record)],
  ];
}

/**
 * @param {{viewer: Cesium.Viewer, dataManager: object, intel: object,
 *          requestRender?: Function, doc?: Document}} options
 */
export function installOpsDeck({
  viewer,
  dataManager,
  intel,
  requestRender = () => viewer?.scene?.requestRender?.(),
  doc = document,
}) {
  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  // ── Rail + flyout ────────────────────────────────────────────────────────
  const rail = el(doc, 'nav', 'adam-ops-rail');
  rail.id = 'adam-ops-rail';
  rail.setAttribute('aria-label', 'ADAM operations');
  const flyout = el(doc, 'section', 'adam-panel adam-ops-flyout');
  flyout.id = 'adam-ops-flyout';
  flyout.hidden = true;
  flyout.setAttribute('role', 'region');
  let activeView = null;
  const railButtons = {};

  const VIEWS = {
    brief: { label: 'BRIEF', key: 'B', render: renderBrief },
    alerts: { label: 'ALERTS', key: 'A', render: renderAlerts },
    filters: { label: 'FILTER', key: 'G', render: renderFilters },
    health: { label: 'HEALTH', key: '', render: renderHealth },
    scenario: { label: 'SCENARIO', key: '', render: renderScenarios },
  };
  for (const [id, view] of Object.entries(VIEWS)) {
    const btn = button(
      doc,
      '',
      'adam-chip adam-ops-rail-btn',
      () => toggleView(id),
      {
        'aria-pressed': 'false',
        title: view.key ? `${view.label} (${view.key})` : view.label,
      },
    );
    btn.append(el(doc, 'span', 'adam-ops-rail-label', view.label));
    if (view.key) btn.append(el(doc, 'kbd', 'adam-ops-rail-key', view.key));
    const badge = el(doc, 'span', 'adam-ops-badge');
    badge.hidden = true;
    btn.append(badge);
    railButtons[id] = { btn, badge };
    rail.append(btn);
  }
  const keysBtn = button(
    doc,
    '',
    'adam-chip adam-ops-rail-btn',
    () => toggleShortcuts(),
    {
      title: 'Keyboard shortcuts (?)',
    },
  );
  keysBtn.append(el(doc, 'span', 'adam-ops-rail-label', 'KEYS'));
  keysBtn.append(el(doc, 'kbd', 'adam-ops-rail-key', '?'));
  rail.append(keysBtn);

  function toggleView(id, force) {
    const open = force ?? activeView !== id;
    activeView = open ? id : null;
    for (const [key, { btn }] of Object.entries(railButtons))
      btn.setAttribute('aria-pressed', String(key === activeView));
    flyout.hidden = !activeView;
    if (activeView) {
      flyout.setAttribute('aria-label', VIEWS[activeView].label);
      flyout.classList.remove('adam-lock-in');
      void flyout.offsetWidth;
      flyout.classList.add('adam-lock-in');
      VIEWS[activeView].render();
    }
  }

  function flyoutHeader(title, subtitle) {
    const header = el(doc, 'header', 'adam-ops-header');
    header.append(
      el(doc, 'span', 'adam-meta adam-ops-kicker', 'ADAM · #HOUSEOFASHER'),
    );
    header.append(el(doc, 'h2', 'adam-ops-title', title));
    if (subtitle)
      header.append(el(doc, 'p', 'adam-meta adam-ops-sub', subtitle));
    header.append(
      button(doc, '×', 'adam-ops-close', () => toggleView(activeView, false), {
        'aria-label': 'Close',
      }),
    );
    return header;
  }

  // ── BRIEF ────────────────────────────────────────────────────────────────
  function renderBrief() {
    const brief = intel.brief();
    const body = el(doc, 'div', 'adam-ops-body');
    // Mission: the operator's standing focus, which lifts matching items.
    const mission = intel.getMission?.();
    const missionRow = el(doc, 'form', 'adam-brief-mission');
    const missionInput = el(doc, 'input', 'adam-input');
    missionInput.type = 'text';
    missionInput.maxLength = 500;
    missionInput.placeholder = 'MISSION — WHAT ARE YOU WATCHING FOR TODAY?';
    missionInput.value = mission?.text || '';
    missionInput.setAttribute('aria-label', 'Mission');
    missionInput.addEventListener('keydown', (e) => e.stopPropagation());
    missionRow.append(missionInput);
    missionRow.addEventListener('submit', (e) => {
      e.preventDefault();
      intel.setMission?.({
        text: missionInput.value,
        areas: intel.getMission?.()?.areas || [],
      });
      renderBrief();
    });
    body.append(missionRow);
    // Triage first: the most significant things on the globe, ranked.
    const ranked = intel.triage?.({ limit: 6 }) || [];
    body.append(
      el(doc, 'h3', 'adam-meta adam-ops-section', 'TOP OF THE PICTURE'),
    );
    if (!ranked.length)
      body.append(
        el(
          doc,
          'p',
          'adam-meta adam-ops-note',
          'Nothing ranks above routine right now.',
        ),
      );
    for (const t of ranked) {
      const row = button(
        doc,
        '',
        'adam-brief-pattern',
        () => {
          if (Number.isFinite(t.lat))
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, 150_000),
              duration: 1.6,
            });
        },
        { title: t.why },
      );
      row.append(
        el(
          doc,
          'span',
          `adam-meta ${t.score >= 80 ? 'adam-tier-critical' : t.score >= 60 ? 'adam-tier-alert' : 'adam-tier-primary'}`,
          `${t.score} · ${t.title}`,
        ),
        el(doc, 'span', 'adam-meta adam-brief-facts', t.label),
      );
      body.append(row);
    }
    const productRow = el(doc, 'div', 'adam-chip-row');
    productRow.append(
      button(
        doc,
        'EXPORT PRODUCT',
        'adam-chip',
        async () => {
          const { downloadProduct } = await import('./productExport.js');
          await downloadProduct({ title: 'ADAM situation brief' }, doc);
        },
        {
          title:
            'Cover, BLUF, map extract, findings, watch, contacts, event and action logs, sources — as a printable document',
        },
      ),
    );
    body.append(productRow);
    // Decision support: what to do next, with the reason.
    const recs = intel.recommend?.({ limit: 4 }) || [];
    if (recs.length) {
      body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'NEXT ACTIONS'));
      for (const r of recs) {
        const row = el(doc, 'div', 'adam-brief-action');
        const text = el(doc, 'div', 'adam-brief-action-text');
        text.append(
          el(doc, 'span', 'adam-meta adam-tier-primary', r.title.toUpperCase()),
          el(doc, 'span', 'adam-meta adam-brief-facts', r.why),
        );
        const go = button(doc, 'DO', 'adam-chip', async () => {
          go.disabled = true;
          const res = await globalThis.__godsEyeView?.actions?.run?.(r.action);
          go.textContent = res?.ok ? 'DONE' : 'FAILED';
          go.title = res?.error || res?.did || '';
        });
        row.append(text, go);
        body.append(row);
      }
    }
    body.append(el(doc, 'p', 'adam-value adam-brief-headline', brief.headline));
    const list = el(doc, 'ul', 'adam-brief-sections');
    for (const section of brief.sections) {
      const li = el(doc, 'li', 'adam-brief-row');
      if (section.feedState && !['nominal', 'off'].includes(section.feedState))
        li.classList.add('is-alert');
      const top = el(doc, 'div', 'adam-brief-row-top');
      top.append(el(doc, 'span', 'adam-meta', section.label.toUpperCase()));
      const count = el(doc, 'span', 'adam-readout adam-brief-count');
      setOdometer(count, section.count.toLocaleString('en-US'));
      top.append(count);
      li.append(top);
      if (section.facts.length)
        li.append(
          el(doc, 'p', 'adam-meta adam-brief-facts', section.facts.join(' · ')),
        );
      if (section.feedState && !['nominal', 'off'].includes(section.feedState))
        li.append(
          el(
            doc,
            'p',
            'adam-meta adam-tier-alert',
            `${section.feedState.toUpperCase()}${section.ageLabel ? ` · ${section.ageLabel}` : ''}`,
          ),
        );
      list.append(li);
    }
    if (!brief.sections.length)
      list.append(
        el(
          doc,
          'li',
          'adam-meta',
          'No data layers are active. Turn one on in Data Layers (F).',
        ),
      );
    body.append(list);
    if (brief.anomalies.length) {
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          'PATTERN · VS 7-DAY BASELINE',
        ),
      );
      for (const a of brief.anomalies)
        body.append(
          el(
            doc,
            'p',
            `adam-meta adam-brief-anomaly ${a.level === 'surge' ? 'adam-tier-critical' : 'adam-tier-alert'}`,
            a.statement,
          ),
        );
    } else {
      body.append(
        el(
          doc,
          'p',
          'adam-meta adam-ops-note',
          'Baselines build while ADAM is open: the pattern layer needs two days of history for the same hour.',
        ),
      );
    }
    const exposed = intel.exposure?.({ limit: 4 }) || [];
    if (exposed.length) {
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          'EXPOSURE · ASSETS IN HAZARD REACH',
        ),
      );
      for (const x of exposed) {
        const row = button(
          doc,
          '',
          'adam-brief-pattern',
          () =>
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(
                x.hazard.lon,
                x.hazard.lat,
                Math.max(40_000, x.reachKm * 2600),
              ),
              duration: 1.6,
            }),
          { title: 'Screening radius, not a damage estimate' },
        );
        row.append(
          el(
            doc,
            'span',
            'adam-meta adam-tier-alert',
            x.hazard.label.toUpperCase(),
          ),
          el(doc, 'span', 'adam-meta adam-brief-facts', x.statement),
        );
        body.append(row);
      }
    }
    const watched = intel.patterns?.({ limit: 6 }) || [];
    if (watched.length) {
      body.append(
        el(doc, 'h3', 'adam-meta adam-ops-section', 'BEHAVIOUR · LAST 45 MIN'),
      );
      for (const f of watched) {
        const row = button(
          doc,
          '',
          'adam-brief-pattern',
          () =>
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(
                f.lon,
                f.lat,
                f.layerKey === 'ais-live-vessels' ? 12_000 : 90_000,
              ),
              duration: 1.6,
            }),
          { title: `Fly to · or: ${f.alternative}` },
        );
        row.append(
          el(
            doc,
            'span',
            `adam-meta ${f.confidence >= 0.6 ? 'adam-tier-alert' : 'adam-tier-primary'}`,
            `${f.title} · ${f.label}`,
          ),
          el(
            doc,
            'span',
            'adam-meta adam-brief-facts',
            `${f.detail} · conf ${f.confidence.toFixed(2)}`,
          ),
        );
        body.append(row);
      }
    }
    if (brief.alerts.length) {
      body.append(
        el(doc, 'h3', 'adam-meta adam-ops-section', 'TRIPPED ALERTS'),
      );
      for (const a of brief.alerts)
        body.append(
          el(
            doc,
            'p',
            'adam-meta adam-tier-critical',
            `${a.label} — ${a.detail}`,
          ),
        );
    }
    body.append(
      el(
        doc,
        'p',
        'adam-meta adam-ops-note',
        `Generated ${new Date(brief.generatedAt).toUTCString().slice(17, 25)}Z · Ask the voice analyst "brief me" for a spoken read.`,
      ),
    );
    flyout.replaceChildren(
      flyoutHeader('SITUATION BRIEF', 'All loaded layers, one read'),
      body,
    );
  }

  // ── ALERTS ───────────────────────────────────────────────────────────────
  let zoneHint = null;
  function renderAlerts() {
    const body = el(doc, 'div', 'adam-ops-body');
    const rules = intel.alerts.list();
    const list = el(doc, 'ul', 'adam-alert-list');
    for (const rule of rules) {
      const li = el(
        doc,
        'li',
        `adam-alert-rule${rule.triggered ? ' is-tripped' : ''}`,
      );
      const head = el(doc, 'div', 'adam-alert-rule-top');
      head.append(el(doc, 'span', 'adam-value', rule.label));
      head.append(
        el(
          doc,
          'span',
          `adam-meta ${rule.triggered ? 'adam-tier-critical' : rule.enabled ? 'adam-tier-primary' : ''}`,
          rule.triggered ? 'TRIPPED' : rule.enabled ? 'ARMED' : 'OFF',
        ),
      );
      li.append(head);
      if (rule.detail) li.append(el(doc, 'p', 'adam-meta', rule.detail));
      const actions = el(doc, 'div', 'adam-alert-actions');
      actions.append(
        button(
          doc,
          rule.enabled ? 'DISARM' : 'ARM',
          'adam-chip adam-latch',
          () => {
            intel.alerts.setEnabled(rule.id, !rule.enabled);
            renderAlerts();
          },
        ),
      );
      actions.append(
        button(doc, 'DELETE', 'adam-chip adam-latch', () => {
          intel.alerts.remove(rule.id);
          renderAlerts();
        }),
      );
      li.append(actions);
      list.append(li);
    }
    if (!rules.length)
      list.append(
        el(
          doc,
          'li',
          'adam-meta adam-ops-note',
          'No triggers yet. Define one below, then draw its zone on the globe.',
        ),
      );
    body.append(list);

    // Watch log: every trip and high-ranked watch item, timestamped.
    const log = intel.watchLog?.({ limit: 12 }) || [];
    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'WATCH LOG'));
    if (!log.length)
      body.append(
        el(doc, 'p', 'adam-meta adam-ops-note', 'Nothing logged yet.'),
      );
    for (const e of log)
      body.append(
        el(
          doc,
          'p',
          `adam-meta ${e.severity === 'critical' || e.severity === 'alert' ? 'adam-tier-alert' : ''}`,
          `${new Date(e.at).toISOString().slice(5, 19).replace('T', ' ')}Z · ${e.title}${e.detail ? ` — ${e.detail}` : ''}`,
        ),
      );
    const logActions = el(doc, 'div', 'adam-chip-row');
    logActions.append(
      button(doc, 'EXPORT CSV', 'adam-chip', () => exportWatchLog()),
      button(doc, 'CLEAR', 'adam-chip', () => {
        intel.clearWatchLog?.();
        renderAlerts();
      }),
    );
    body.append(logActions);

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'NEW TRIGGER'));
    const form = el(doc, 'form', 'adam-alert-form');
    const kind = el(doc, 'select', 'adam-input');
    kind.setAttribute('aria-label', 'Trigger kind');
    for (const [value, label] of [
      ['count-in-zone', 'MORE THAN N CONTACTS IN ZONE'],
      ['speed-in-zone', 'CONTACT FASTER THAN X KT IN ZONE'],
      ['quake-in-zone', 'EARTHQUAKE OF MAGNITUDE M+ IN ZONE'],
      ['fire-in-zone', 'MORE THAN N FIRE DETECTIONS IN ZONE'],
    ]) {
      const option = el(doc, 'option', '', label);
      option.value = value;
      kind.append(option);
    }
    const layer = el(doc, 'select', 'adam-input');
    layer.setAttribute('aria-label', 'Layer');
    for (const key of ALERT_LAYERS) {
      const option = el(doc, 'option', '', LAYER_LABELS[key] || key);
      option.value = key;
      layer.append(option);
    }
    const zoneSelect = el(doc, 'select', 'adam-input');
    zoneSelect.setAttribute('aria-label', 'Zone');
    const drawOpt = el(doc, 'option', '', 'DRAW A NEW ZONE');
    drawOpt.value = '';
    zoneSelect.append(drawOpt);
    for (const z of intel.listZones?.() || []) {
      const o = el(doc, 'option', '', `ZONE · ${z.name.toUpperCase()}`);
      o.value = z.id;
      zoneSelect.append(o);
    }
    const amount = el(doc, 'input', 'adam-input');
    amount.type = 'number';
    amount.min = '0';
    amount.step = '1';
    amount.value = '10';
    amount.setAttribute('aria-label', 'Threshold');
    const label = el(doc, 'input', 'adam-input');
    label.type = 'text';
    label.maxLength = 60;
    label.placeholder = 'LABEL (OPTIONAL)';
    label.setAttribute('aria-label', 'Label');
    const syncAmount = () => {
      const speed = kind.value === 'speed-in-zone';
      const quake = kind.value === 'quake-in-zone';
      const fire = kind.value === 'fire-in-zone';
      layer.hidden = quake || fire;
      amount.step = quake ? '0.1' : '1';
      amount.setAttribute(
        'aria-label',
        speed
          ? 'Max speed (knots)'
          : quake
            ? 'Minimum magnitude'
            : fire
              ? 'Max fire detections'
              : 'Max contacts',
      );
      amount.placeholder = speed
        ? 'MAX KT'
        : quake
          ? 'MIN MAGNITUDE'
          : fire
            ? 'MAX FIRES'
            : 'MAX CONTACTS';
      if (quake && Number(amount.value) > 10) amount.value = '5';
      if (speed && layer.value !== 'ais-live-vessels')
        layer.value = 'ais-live-vessels';
    };
    kind.addEventListener('change', syncAmount);
    syncAmount();
    zoneHint = el(doc, 'p', 'adam-meta adam-ops-note', '');
    const draw = button(
      doc,
      'DRAW ZONE + ARM',
      'adam-chip adam-latch adam-primary-btn',
      async () => {
        draw.disabled = true;
        const saved = zoneSelect.value
          ? intel.zoneById?.(zoneSelect.value)
          : null;
        const ring = saved
          ? saved.ring
          : await capturePolygon(viewer, {
              color: '#f5a623',
              onHint: (text) => {
                if (zoneHint) zoneHint.textContent = text;
              },
            });
        draw.disabled = false;
        if (!ring) {
          if (zoneHint) zoneHint.textContent = 'Zone cancelled.';
          return;
        }
        const value = Number(amount.value);
        const rule = intel.alerts.add({
          kind: kind.value,
          layerKey: layer.value,
          ring,
          label: label.value,
          ...(kind.value === 'count-in-zone' || kind.value === 'fire-in-zone'
            ? { threshold: value }
            : kind.value === 'quake-in-zone'
              ? { minMagnitude: value }
              : { maxSpeedKts: value }),
        });
        const hazardLayer = HAZARD_RULE_LAYERS[kind.value];
        if (rule && hazardLayer && !dataManager?.isEnabled?.(hazardLayer))
          void dataManager?.setEnabled?.(hazardLayer, true, { origin: 'user' });
        if (zoneHint)
          zoneHint.textContent = rule
            ? `Armed: ${rule.label}`
            : 'That trigger is not valid (check the number).';
        intel.evaluateAlerts();
        renderAlerts();
      },
    );
    form.addEventListener('submit', (event) => event.preventDefault());
    form.append(kind, layer, zoneSelect, amount, label, draw, zoneHint);
    body.append(form);
    body.append(
      el(
        doc,
        'p',
        'adam-meta adam-ops-note',
        'Triggers are checked every 5 s against live data and flash when they trip. Quake and fire triggers switch their layer on. They are stored in this browser only.',
      ),
    );
    flyout.replaceChildren(
      flyoutHeader(
        'ALERT TRIGGERS',
        'Zone counts, speed limits, earthquakes and fires',
      ),
      body,
    );
  }

  // ── FILTERS ──────────────────────────────────────────────────────────────
  function chipRow(title, items, isOn, onToggle) {
    const wrap = el(doc, 'div', 'adam-filter-group');
    wrap.append(el(doc, 'h3', 'adam-meta adam-ops-section', title));
    const row = el(doc, 'div', 'adam-chip-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', title);
    for (const item of items) {
      const on = isOn(item);
      row.append(
        button(
          doc,
          item.label,
          `adam-chip adam-latch${on ? ' is-on' : ''}`,
          () => onToggle(item, !on),
          {
            'aria-pressed': String(on),
          },
        ),
      );
    }
    wrap.append(row);
    return wrap;
  }

  let regionHint = null;
  function renderFilters() {
    const state = snapshotPresentation();
    const body = el(doc, 'div', 'adam-ops-body');
    body.append(
      chipRow(
        'TIME WINDOW · LAST HEARD',
        TIME_WINDOWS,
        (w) => (w.ms ?? null) === state.timeWindowMs,
        (w) => {
          setTimeWindow(w.ms);
        },
      ),
    );
    const region = el(doc, 'div', 'adam-filter-group');
    region.append(
      el(
        doc,
        'h3',
        'adam-meta adam-ops-section',
        'REGION · OUTSIDE FADES TO 20%',
      ),
    );
    const regionRow = el(doc, 'div', 'adam-chip-row');
    regionRow.append(
      button(
        doc,
        state.region ? 'REDRAW REGION' : 'DRAW REGION',
        'adam-chip adam-latch adam-primary-btn',
        async () => {
          const ring = await capturePolygon(viewer, {
            color: '#00bcd4',
            onHint: (text) => {
              if (regionHint) regionHint.textContent = text;
            },
          });
          if (ring) setRegionFilter(ring);
          else if (regionHint) regionHint.textContent = 'Region unchanged.';
        },
      ),
    );
    if (state.region)
      regionRow.append(
        button(doc, 'CLEAR REGION', 'adam-chip adam-latch', () =>
          setRegionFilter(null),
        ),
      );
    region.append(regionRow);
    regionHint = el(
      doc,
      'p',
      'adam-meta adam-ops-note',
      state.region
        ? `Region set · ${state.region.length} corners`
        : 'No region: every contact at full strength.',
    );
    region.append(regionHint);
    body.append(region);
    body.append(
      chipRow(
        'AIRCRAFT · ALTITUDE BAND',
        ALTITUDE_BANDS,
        (b) => state.altitudeBands.includes(b.id),
        (b, on) => setAltitudeBandEnabled(b.id, on),
      ),
    );
    body.append(
      chipRow(
        'VESSELS · TYPE',
        [...VESSEL_TYPE_CLASSES, { id: 'unknown', label: 'UNKNOWN' }],
        (c) => state.vesselClasses.includes(c.id),
        (c, on) => setVesselClassEnabled(c.id, on),
      ),
    );
    body.append(
      chipRow(
        'STALENESS',
        [{ id: 'decay', label: 'DECAY QUIET CONTACTS' }],
        () => state.staleness,
        (_, on) => setStalenessEnabled(on),
      ),
    );
    const reset = el(doc, 'div', 'adam-chip-row');
    reset.append(
      button(doc, 'RESET ALL FILTERS', 'adam-chip adam-latch', () =>
        resetPresentation(),
      ),
    );
    body.append(reset);
    flyout.replaceChildren(
      flyoutHeader('FILTERS', 'Applies to aircraft and vessels on the globe'),
      body,
    );
  }

  // ── Zones on the globe ───────────────────────────────────────────────────
  const zones = new Cesium.CustomDataSource('adam-zones');
  viewer.dataSources.add(zones);
  cleanups.push(() => viewer.dataSources.remove(zones, true));
  function ringPositions(ring) {
    const pts = ring.map(([lon, lat]) =>
      Cesium.Cartesian3.fromDegrees(lon, lat),
    );
    return [...pts, pts[0]];
  }
  function drawZones() {
    zones.entities.removeAll();
    const region = snapshotPresentation().region;
    if (region)
      zones.entities.add({
        polyline: {
          positions: ringPositions(region),
          width: 2,
          clampToGround: true,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#00bcd4'),
          }),
        },
      });
    for (const rule of intel.alerts.list()) {
      if (!rule.enabled) continue;
      zones.entities.add({
        polyline: {
          positions: ringPositions(rule.ring),
          width: rule.triggered ? 3 : 2,
          clampToGround: true,
          material: Cesium.Color.fromCssColorString(
            rule.triggered ? '#e53935' : '#f5a623',
          ),
        },
      });
    }
    requestRender();
  }

  // ── Alert flash ──────────────────────────────────────────────────────────
  const flash = el(doc, 'div', 'adam-alert-flash');
  flash.setAttribute('aria-hidden', 'true');
  const alertStack = el(doc, 'div', 'adam-alert-stack');
  alertStack.setAttribute('role', 'alert');
  alertStack.setAttribute('aria-live', 'assertive');
  function onTrip({ rule, result }) {
    flash.classList.remove('is-flashing');
    void flash.offsetWidth;
    flash.classList.add('is-flashing');
    const toast = el(doc, 'div', 'adam-panel adam-alert-toast adam-lock-in');
    toast.append(
      el(doc, 'span', 'adam-meta adam-tier-critical', 'ALERT TRIPPED'),
    );
    toast.append(el(doc, 'span', 'adam-value', rule.label));
    toast.append(el(doc, 'span', 'adam-meta', result?.detail || ''));
    toast.append(
      button(doc, '×', 'adam-ops-close', () => toast.remove(), {
        'aria-label': 'Dismiss alert',
      }),
    );
    alertStack.prepend(toast);
    while (alertStack.children.length > 3) alertStack.lastChild.remove();
    setTimeout(() => toast.remove(), 20_000);
  }

  // ── HEALTH ───────────────────────────────────────────────────────────────
  const healthFacts = { webgl: true, shepherd: undefined };
  const canvas = viewer?.scene?.canvas;
  if (canvas?.addEventListener) {
    listen(canvas, 'webglcontextlost', () => {
      healthFacts.webgl = false;
      updateBadges();
    });
    listen(canvas, 'webglcontextrestored', () => {
      healthFacts.webgl = true;
      updateBadges();
    });
  }
  let shepherdCheckedAt = 0;
  async function refreshShepherdStatus() {
    if (Date.now() - shepherdCheckedAt < 60_000) return;
    shepherdCheckedAt = Date.now();
    try {
      const res = await globalThis.fetch('/api/shepherd/status', {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      healthFacts.shepherd = {
        configured: (body?.providers || []).filter((p) => p.configured).length,
      };
    } catch {
      healthFacts.shepherd = null;
    }
    if (activeView === 'health') renderHealth();
  }

  function readHealth() {
    let snapshots = [];
    try {
      snapshots = layerSnapshots(dataManager?.getAll?.() || []);
    } catch {
      snapshots = [];
    }
    return assessHealth(snapshots, {
      online: globalThis.navigator?.onLine !== false,
      effectsReduced: isEffectsReduced(),
      webgl: healthFacts.webgl,
      photoreal: doc.body?.classList?.contains('adam-no-ion')
        ? false
        : undefined,
      shepherd: healthFacts.shepherd,
    });
  }

  function healthRows(list, title, rows, render) {
    if (!rows.length) return;
    list.append(el(doc, 'li', 'adam-meta adam-health-group', title));
    for (const r of rows) list.append(render(r));
  }

  function renderHealth() {
    const health = readHealth();
    const body = el(doc, 'div', 'adam-ops-body');
    body.append(
      el(
        doc,
        'p',
        `adam-value adam-health-level is-${health.level}`,
        health.level === 'nominal'
          ? 'ALL ENABLED FEEDS NOMINAL'
          : `${health.level.toUpperCase()} · ${health.faults} FAULT${health.faults === 1 ? '' : 'S'}`,
      ),
    );
    const list = el(doc, 'ul', 'adam-brief-sections adam-health-list');
    const layerRow = (r) => {
      const li = el(doc, 'li', 'adam-brief-row is-alert');
      const top = el(doc, 'div', 'adam-brief-row-top');
      top.append(el(doc, 'span', 'adam-meta', String(r.name).toUpperCase()));
      top.append(
        el(
          doc,
          'span',
          'adam-meta adam-tier-alert',
          `${r.state.toUpperCase()}${r.age ? ` · ${r.age}` : ''}`,
        ),
      );
      li.append(top);
      const detail = [r.source, r.error].filter(Boolean).join(' · ');
      if (detail) li.append(el(doc, 'p', 'adam-meta adam-brief-facts', detail));
      return li;
    };
    healthRows(list, 'DOWN', health.down, layerRow);
    healthRows(list, 'STALE', health.stale, layerRow);
    healthRows(list, 'ON FALLBACK', health.fallback, layerRow);
    healthRows(list, 'CAPABILITIES', health.capabilities, (c) => {
      const li = el(doc, 'li', `adam-brief-row${c.ok ? '' : ' is-alert'}`);
      const top = el(doc, 'div', 'adam-brief-row-top');
      top.append(el(doc, 'span', 'adam-meta', c.label));
      top.append(
        el(doc, 'span', `adam-meta${c.ok ? '' : ' adam-tier-alert'}`, c.detail),
      );
      li.append(top);
      return li;
    });
    body.append(list);
    body.append(
      el(doc, 'p', 'adam-meta adam-health-group', 'OPERATOR PROFILE'),
    );
    const actions = el(doc, 'div', 'adam-chip-row');
    actions.append(
      button(doc, 'EXPORT', 'adam-chip', () => void exportProfile(), {
        title:
          'Download alert rules, baselines, pins, layers, scene and prefs as a signed file',
      }),
      button(doc, 'IMPORT', 'adam-chip', () => profileInput.click(), {
        title:
          'Load a profile file; its checksum and signature are verified first',
      }),
    );
    body.append(actions);
    if (profileNote)
      body.append(el(doc, 'p', 'adam-meta adam-ops-note', profileNote));
    flyout.replaceChildren(
      flyoutHeader('HEALTH', 'Feeds, fallbacks and degraded capabilities'),
      body,
    );
    void refreshShepherdStatus();
  }

  function exportWatchLog() {
    const rows = [
      ['utc', 'kind', 'severity', 'score', 'title', 'detail', 'lat', 'lon'],
      ...(intel.watchLog?.({ limit: 500 }) || [])
        .slice()
        .reverse()
        .map((e) => [
          new Date(e.at).toISOString(),
          e.kind,
          e.severity,
          e.score ?? '',
          e.title,
          e.detail,
          e.lat ?? '',
          e.lon ?? '',
        ]),
    ];
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = `adam-watch-log-${new Date().toISOString().slice(0, 10)}.csv`;
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ── SCENARIO ──────────────────────────────────────────────────────────────
  let scenarioNote = '';
  function renderScenarios() {
    const body = el(doc, 'div', 'adam-ops-body');
    for (const s of SCENARIOS) {
      const on = s.layers.every((l) => dataManager?.isEnabled?.(l));
      const row = button(
        doc,
        '',
        `adam-brief-pattern${on ? ' is-on' : ''}`,
        async () => {
          scenarioNote = `Setting up ${s.label}…`;
          renderScenarios();
          const r = await applyScenario(dataManager, s.id, { intel });
          scenarioNote = r.ok
            ? `${s.label}: ${r.on.length} layers on${r.off.length ? `, ${r.off.length} off` : ''}. Mission set.`
            : `${s.label}: ${r.failed?.length || 0} layers failed (${(r.failed || []).join(', ')}).`;
          renderScenarios();
        },
        { title: 'Replaces the current layers; the mission line follows it' },
      );
      row.append(
        el(
          doc,
          'span',
          `adam-meta ${on ? 'adam-tier-primary' : ''}`,
          `${s.label}${on ? ' · ACTIVE' : ''}`,
        ),
        el(doc, 'span', 'adam-meta adam-brief-facts', s.summary),
      );
      body.append(row);
    }
    if (scenarioNote)
      body.append(el(doc, 'p', 'adam-meta adam-ops-note', scenarioNote));
    flyout.replaceChildren(
      flyoutHeader('SCENARIOS', 'One action: layers, focus and mission'),
      body,
    );
  }

  // ── Operator profile ───────────────────────────────────────────────────
  let profileNote = '';
  const signer = serverSigner();
  const shepherdMemory = () => globalThis.__godsEyeView?.shepherd?.memory;
  const noteProfile = (text) => {
    profileNote = text;
    if (activeView === 'health') renderHealth();
  };

  async function exportProfile() {
    try {
      const shepherdPrefs = await shepherdMemory()
        ?.loadPrefs?.()
        .catch(() => null);
      const body = collectProfile({ shepherdPrefs });
      const sealed = await sealProfile(body, { sign: signer.sign });
      const blob = new Blob([JSON.stringify(sealed, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = `adam-profile-${body.exportedAt.slice(0, 10)}.json`;
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      const n = Object.keys(body.keys).length;
      noteProfile(
        `Exported ${n} setting${n === 1 ? '' : 's'} · ${sealed.signature ? `signed by ${sealed.signature.signer}` : 'checksum only (no access token on this deployment)'}.`,
      );
      return { ok: true, settings: n, signed: Boolean(sealed.signature) };
    } catch (error) {
      noteProfile(`Export failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async function importProfile(text) {
    let doc_;
    try {
      doc_ = JSON.parse(text);
    } catch {
      noteProfile('Import refused: not JSON.');
      return { ok: false, error: 'not JSON' };
    }
    const check = await verifyProfile(doc_, { verify: signer.verify });
    if (!check.ok) {
      noteProfile(`Import refused: ${check.reason}.`);
      return { ok: false, error: check.reason };
    }
    const provenance = check.verified
      ? 'signature verified'
      : check.signed
        ? 'signed elsewhere (not verifiable here)'
        : 'unsigned, checksum ok';
    if (
      typeof globalThis.confirm === 'function' &&
      !globalThis.confirm(
        `Replace ${check.keys.length} settings with this profile (${provenance})? The page reloads to apply them.`,
      )
    )
      return { ok: false, error: 'cancelled' };
    const written = applyProfile(doc_);
    if (doc_.shepherd?.prefs && typeof doc_.shepherd.prefs === 'object')
      await shepherdMemory()
        ?.savePrefs?.(doc_.shepherd.prefs)
        .catch(() => {});
    noteProfile(
      `Imported ${written.length} settings (${provenance}). Reloading…`,
    );
    setTimeout(() => globalThis.location?.reload?.(), 600);
    return { ok: true, written: written.length, provenance };
  }

  const profileInput = doc.createElement('input');
  profileInput.type = 'file';
  profileInput.accept = 'application/json,.json';
  profileInput.hidden = true;
  listen(profileInput, 'change', async () => {
    const file = profileInput.files?.[0];
    profileInput.value = '';
    if (file) await importProfile(await file.text());
  });

  function updateBadges() {
    const health = readHealth();
    railButtons.health.badge.hidden = health.faults === 0;
    railButtons.health.badge.textContent = String(health.faults);
    railButtons.health.btn.classList.toggle('is-alert', health.faults > 0);
    railButtons.health.btn.classList.toggle(
      'is-pulse',
      health.level === 'degraded',
    );
    const tripped = intel.alerts.activeTrips().length;
    const { badge } = railButtons.alerts;
    badge.hidden = tripped === 0;
    badge.textContent = String(tripped);
    railButtons.alerts.btn.classList.toggle('is-critical', tripped > 0);
    const filtered = snapshotPresentation();
    const filtering =
      filtered.timeWindowMs !== null ||
      filtered.region !== null ||
      filtered.altitudeBands.length < ALTITUDE_BANDS.length ||
      filtered.vesselClasses.length < VESSEL_TYPE_CLASSES.length + 1;
    railButtons.filters.badge.hidden = !filtering;
    railButtons.filters.badge.textContent = '●';
    const anomalies = intel
      .anomalies({ limit: 3 })
      .filter((a) => a.level !== 'quiet');
    const behaviour = (intel.patterns?.({ limit: 99 }) || []).filter(
      (f) => f.confidence >= 0.5,
    ).length;
    const briefFlags = anomalies.length + behaviour;
    railButtons.brief.badge.hidden = briefFlags === 0;
    railButtons.brief.badge.textContent = String(briefFlags);
    railButtons.brief.btn.classList.toggle('is-alert', briefFlags > 0);
  }

  // ── Last tracked ─────────────────────────────────────────────────────────
  const lastCard = el(
    doc,
    'section',
    'adam-panel adam-contact-card adam-last-tracked',
  );
  lastCard.id = 'adam-last-tracked';
  lastCard.hidden = true;
  lastCard.setAttribute('aria-label', 'Last tracked contact');
  let lastCollapsed = readLocal(COLLAPSE_KEY) === '1';

  function contactCard(card, ref, { title, onClose, extraActions = [] }) {
    const record = ref.record;
    const stale = describeStaleness(ref.layerKey, record?.lastSeenMs);
    card.classList.toggle('is-stale', Boolean(record && stale.stale));
    card.classList.toggle('is-lost', !record);
    let header = card.querySelector(':scope > header');
    if (!header || header.dataset.key !== `${ref.layerKey}:${ref.value}`) {
      card.replaceChildren();
      header = el(doc, 'header', 'adam-card-header');
      header.dataset.key = `${ref.layerKey}:${ref.value}`;
      header.append(
        el(doc, 'span', 'adam-meta adam-card-kicker', title),
        el(doc, 'span', 'adam-value adam-card-label'),
        el(
          doc,
          'span',
          'adam-meta adam-card-layer',
          LAYER_LABELS[ref.layerKey] || ref.layerKey.toUpperCase(),
        ),
        button(doc, '×', 'adam-ops-close', onClose, {
          'aria-label': `Close ${title.toLowerCase()}`,
        }),
      );
      card.append(header);
      card.append(el(doc, 'dl', 'adam-card-telemetry'));
      card.append(el(doc, 'p', 'adam-meta adam-card-status'));
      card.append(el(doc, 'div', 'adam-card-actions'));
      card.classList.remove('adam-lock-in');
      void card.offsetWidth;
      card.classList.add('adam-lock-in');
    }
    const labelNode = header.querySelector('.adam-card-label');
    if (labelNode.textContent !== (ref.label || ref.value))
      labelNode.textContent = ref.label || ref.value;
    const dl = card.querySelector('.adam-card-telemetry');
    const rows = record ? telemetryRows(ref.layerKey, record) : [];
    const existing = [...dl.querySelectorAll('dd')];
    if (existing.length !== rows.length) {
      dl.replaceChildren();
      for (const [label] of rows) {
        dl.append(el(doc, 'dt', 'adam-meta', label));
        dl.append(el(doc, 'dd', 'adam-value'));
      }
    }
    const dds = [...dl.querySelectorAll('dd')];
    rows.forEach(([, value], i) => setOdometer(dds[i], value));
    const status = card.querySelector('.adam-card-status');
    status.className = 'adam-meta adam-card-status';
    if (!record) {
      status.textContent = 'SIGNAL LOST · not in the loaded feed';
      status.classList.add('adam-tier-critical');
    } else if (stale.stale) {
      status.textContent = `STALE · last heard ${stale.label}`;
      status.classList.add('adam-tier-alert');
    } else {
      status.textContent = stale.label ? `LIVE · heard ${stale.label}` : 'LIVE';
      status.classList.add('adam-tier-primary');
    }
    const actions = card.querySelector('.adam-card-actions');
    const signature = extraActions.map((node) => node.textContent).join('|');
    if (actions.dataset.signature !== signature) {
      actions.dataset.signature = signature;
      actions.replaceChildren(...extraActions);
    }
  }

  function trackRef(ref) {
    const module = dataManager?.layers?.get(ref.layerKey)?.module;
    try {
      if (typeof module?.trackById === 'function')
        return module.trackById(ref.value, { origin: 'ui' });
      if (typeof module?.selectById === 'function')
        return module.selectById(ref.value);
    } catch (error) {
      console.warn('[adam-ops] could not re-track contact:', error);
    }
    return false;
  }

  function renderLastTracked() {
    const ref = intel.getLastTracked();
    lastCard.hidden = !ref;
    if (!ref) return;
    lastCard.classList.toggle('is-collapsed', lastCollapsed);
    contactCard(lastCard, ref, {
      title: 'LAST TRACKED',
      onClose: () => intel.clearLastTracked(),
      extraActions: [
        button(
          doc,
          lastCollapsed ? 'EXPAND' : 'COLLAPSE',
          'adam-chip adam-latch',
          () => {
            lastCollapsed = !lastCollapsed;
            writeLocal(COLLAPSE_KEY, lastCollapsed ? '1' : '0');
            renderLastTracked();
          },
          { 'aria-expanded': String(!lastCollapsed) },
        ),
        button(doc, 'TRACK', 'adam-chip adam-latch', () => trackRef(ref)),
        button(doc, 'PIN', 'adam-chip adam-latch', () => pinRef(ref)),
      ],
    });
  }

  // ── Comparison rail ──────────────────────────────────────────────────────
  const pinRail = el(doc, 'section', 'adam-pin-rail');
  pinRail.id = 'adam-pin-rail';
  pinRail.setAttribute('aria-label', 'Pinned contacts');
  const pinCards = new Map();
  const pinHint = el(doc, 'div', 'adam-meta adam-pin-hint');
  function pinRef(ref) {
    const record = ref.record || intel.findRecord(ref);
    const ok = intel.pin(
      ref.layerKey,
      record || { [ref.field]: ref.value },
      ref.label,
    );
    if (!ok) {
      pinHint.textContent =
        intel.getPins().length >= 4
          ? 'RAIL FULL · unpin one first (max 4)'
          : 'ALREADY PINNED';
      pinHint.classList.add('is-visible');
      setTimeout(() => pinHint.classList.remove('is-visible'), 2500);
    }
    renderPins();
  }
  function renderPins() {
    const pins = intel.getPins();
    pinRail.hidden = pins.length === 0;
    const keep = new Set();
    for (const pin of pins) {
      const key = `${pin.layerKey}:${pin.value}`;
      keep.add(key);
      let card = pinCards.get(key);
      if (!card) {
        card = el(doc, 'article', 'adam-panel adam-contact-card adam-pin-card');
        pinCards.set(key, card);
        pinRail.append(card);
      }
      contactCard(card, pin, {
        title: 'PINNED',
        onClose: () => {
          intel.unpin(pin.layerKey, pin.value);
          renderPins();
        },
        extraActions: [
          button(doc, 'TRACK', 'adam-chip adam-latch', () => trackRef(pin)),
        ],
      });
    }
    for (const [key, card] of pinCards) {
      if (keep.has(key)) continue;
      card.remove();
      pinCards.delete(key);
    }
    pinRail.append(pinHint);
  }

  // ── Shortcut overlay ─────────────────────────────────────────────────────
  const overlay = el(doc, 'div', 'adam-shortcuts');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Keyboard shortcuts');
  function renderShortcuts() {
    const mode = currentShortcutMode(doc, viewer);
    const panel = el(
      doc,
      'div',
      'adam-panel adam-shortcuts-panel adam-lock-in',
    );
    const header = el(doc, 'header', 'adam-ops-header');
    header.append(
      el(
        doc,
        'span',
        'adam-meta adam-ops-kicker',
        `MODE · ${mode.toUpperCase()}`,
      ),
    );
    header.append(el(doc, 'h2', 'adam-ops-title', 'KEYBOARD'));
    header.append(
      button(doc, '×', 'adam-ops-close', () => toggleShortcuts(false), {
        'aria-label': 'Close shortcuts',
      }),
    );
    panel.append(header);
    const grid = el(doc, 'div', 'adam-shortcuts-grid');
    for (const { group, items } of shortcutsForMode(mode)) {
      const section = el(doc, 'section', 'adam-shortcuts-group');
      section.append(
        el(doc, 'h3', 'adam-meta adam-ops-section', group.toUpperCase()),
      );
      const dl = el(doc, 'dl');
      for (const item of items) {
        const dt = el(doc, 'dt');
        for (const key of item.keys) dt.append(el(doc, 'kbd', 'adam-kbd', key));
        dl.append(dt, el(doc, 'dd', 'adam-meta', item.action));
      }
      section.append(dl);
      grid.append(section);
    }
    panel.append(grid);
    panel.append(
      el(
        doc,
        'p',
        'adam-meta adam-ops-note',
        'Shortcuts are ignored while typing in a field. Press ? or Esc to close.',
      ),
    );
    overlay.replaceChildren(panel);
  }
  let shortcutReturnFocus = null;
  function toggleShortcuts(force) {
    const open = force ?? overlay.hidden;
    if (open) {
      shortcutReturnFocus = doc.activeElement;
      renderShortcuts();
      overlay.hidden = false;
      overlay.querySelector('.adam-ops-close')?.focus();
    } else {
      overlay.hidden = true;
      shortcutReturnFocus?.focus?.();
    }
  }
  listen(overlay, 'click', (event) => {
    if (event.target === overlay) toggleShortcuts(false);
  });

  // ── Keyboard ─────────────────────────────────────────────────────────────
  listen(doc, 'keydown', (event) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing
    )
      return;
    if (
      event.target?.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
    if (!overlay.hidden && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleShortcuts(false);
      return;
    }
    if (event.repeat) return;
    const key = event.key;
    if (key === '?') {
      event.preventDefault();
      toggleShortcuts();
    } else if (key === 'b' || key === 'B') {
      toggleView('brief');
    } else if (key === 'a' || key === 'A') {
      toggleView('alerts');
    } else if (key === 'g' || key === 'G') {
      toggleView('filters');
    } else if (key === 'p' || key === 'P') {
      const ref = intel.getLastTracked();
      if (ref && viewer.trackedEntity) pinRef(ref);
    }
  });

  // ── Wiring ───────────────────────────────────────────────────────────────
  const root = el(doc, 'div', 'adam-ops-root');
  root.append(
    lastCard,
    rail,
    flyout,
    pinRail,
    alertStack,
    overlay,
    profileInput,
  );
  doc.body.append(root, flash);
  cleanups.push(() => {
    root.remove();
    flash.remove();
  });

  cleanups.push(
    intel.subscribe((type, detail) => {
      if (type === 'alert-tripped') {
        onTrip(detail);
        drawZones();
        updateBadges();
        if (activeView === 'alerts') renderAlerts();
      } else if (type === 'alerts-changed') {
        drawZones();
        updateBadges();
      } else if (type === 'last-tracked-changed') {
        renderLastTracked();
      } else if (type === 'pins-changed') {
        renderPins();
      } else if (type === 'watch-logged') {
        if (activeView === 'alerts') renderAlerts();
      } else if (type === 'patterns-changed') {
        updateBadges();
        if (activeView === 'brief') renderBrief();
      } else if (type === 'baselines-sampled') {
        updateBadges();
      }
    }),
  );
  cleanups.push(
    subscribePresentation(() => {
      drawZones();
      updateBadges();
      if (activeView === 'filters') renderFilters();
      requestRender();
    }),
  );

  let tick = 0;
  const interval = setInterval(() => {
    tick += 1;
    if (!lastCard.hidden) renderLastTracked();
    if (!pinRail.hidden) renderPins();
    if (activeView === 'brief' && tick % 10 === 0) renderBrief();
    if (activeView === 'health' && tick % 5 === 0) renderHealth();
    if (tick % 15 === 0) updateBadges();
  }, 1000);
  cleanups.push(() => clearInterval(interval));

  renderLastTracked();
  renderPins();
  drawZones();
  updateBadges();

  if (typeof globalThis.addEventListener === 'function') {
    listen(globalThis, 'online', updateBadges);
    listen(globalThis, 'offline', updateBadges);
  }

  return {
    toggleView,
    readHealth,
    exportProfile,
    importProfile,
    toggleShortcuts,
    renderPins,
    destroy() {
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
