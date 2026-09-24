import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyActivity,
  countByRegion,
  createBaselineStore,
  regionKeyFor,
  regionLabel,
} from './baselineStore.js';
import {
  createAlertMonitor,
  evaluateAlertRule,
  normalizeAlertRule,
} from './alertRules.js';
import { buildSituationBrief, summarizeLayer } from './briefing.js';
import { pointInPolygon } from './geo.js';
import {
  altitudeBandFor,
  contactPresentationFactor,
  describeStaleness,
  resetPresentation,
  setAltitudeBandEnabled,
  setRegionFilter,
  setTimeWindow,
  setVesselClassEnabled,
  stalenessFactor,
  vesselClassFor,
} from './contactPresentation.js';
import { createIntelService, contactKeyFor } from './intelService.js';

const DAY = 86_400_000;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const square = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

test('geo: point in polygon, including across the antimeridian', () => {
  assert.equal(pointInPolygon(square, 0, 0), true);
  assert.equal(pointInPolygon(square, 2, 0), false);
  const dateline = [
    [179, -1],
    [-179, -1],
    [-179, 1],
    [179, 1],
  ];
  assert.equal(pointInPolygon(dateline, 179.5, 0), true);
  assert.equal(pointInPolygon(dateline, -179.5, 0), true);
  assert.equal(pointInPolygon(dateline, 0, 0), false);
});

test('baseline: region keys bin to fixed cells and label readably', () => {
  assert.equal(regionKeyFor(30.2, -97.7), '30:-100');
  assert.equal(regionKeyFor(-0.1, 0.1), '-10:0');
  assert.equal(regionKeyFor(NaN, 0), null);
  assert.equal(regionLabel('30:-100'), '30N–40N, 100W–90W');
  const counts = countByRegion([
    { lat: 30.2, lon: -97.7 },
    { lat: 31, lon: -95 },
    { lat: 51.5, lon: -0.1 },
    { lat: null, lon: 1 },
  ]);
  assert.equal(counts.get('30:-100'), 2);
  assert.equal(counts.size, 2);
});

test('baseline: classification needs history and a real delta', () => {
  assert.equal(classifyActivity(10, 3, 1).level, 'insufficient');
  assert.equal(classifyActivity(17, 5, 7).level, 'surge');
  assert.equal(classifyActivity(9, 5, 7).level, 'elevated');
  assert.equal(classifyActivity(6, 5, 7).level, 'normal');
  assert.equal(classifyActivity(1, 10, 7).level, 'quiet');
});

test('baseline: today never inflates its own baseline; 3x reads as surge', () => {
  let clock = Date.UTC(2026, 8, 1, 14, 0, 0);
  const storage = memoryStorage();
  const store = createBaselineStore({ storage, now: () => clock });
  const austin = (n) =>
    Array.from({ length: n }, () => ({ lat: 30.2, lon: -97.7 }));
  for (let day = 0; day < 7; day += 1) {
    store.sample('military', austin(5));
    clock += DAY;
  }
  const regionKey = regionKeyFor(30.2, -97.7);
  store.sample('military', austin(17));
  const assessment = store.assess('military', regionKey, 17);
  assert.equal(assessment.days, 7);
  assert.equal(assessment.mean, 5);
  assert.equal(assessment.level, 'surge');
  assert.match(assessment.statement, /surging: 17 now vs a 5\.0 average/);
  store.persist();
  const reloaded = createBaselineStore({ storage, now: () => clock });
  assert.equal(reloaded.baseline('military', regionKey).mean, 5);
  const anomalies = reloaded.anomalies('military', austin(17));
  assert.equal(anomalies[0].level, 'surge');
});

test('baseline: corrupt storage starts empty instead of throwing', () => {
  const storage = memoryStorage();
  storage.setItem('adam.intel.baselines.v1', '{not json');
  const store = createBaselineStore({ storage });
  assert.equal(store.size(), 0);
});

test('alerts: rules are sanitized and bounded', () => {
  assert.equal(normalizeAlertRule(null), null);
  assert.equal(
    normalizeAlertRule({
      kind: 'count-in-zone',
      layerKey: 'flights',
      ring: square,
    }),
    null,
    'count rules need a threshold',
  );
  assert.equal(
    normalizeAlertRule({
      kind: 'nope',
      layerKey: 'flights',
      ring: square,
      threshold: 2,
    }),
    null,
  );
  const rule = normalizeAlertRule({
    kind: 'count-in-zone',
    layerKey: 'flights',
    ring: [...square, [999, 999]],
    threshold: 2,
    label: '<script>x</script>',
    id: 'bad id!',
  });
  assert.equal(rule.ring.length, 4, 'out-of-range vertices are dropped');
  assert.doesNotMatch(rule.label, /[<>]/);
  assert.match(rule.id, /^rule-/);
});

test('alerts: count and speed triggers evaluate inside the zone only', () => {
  const count = normalizeAlertRule({
    kind: 'count-in-zone',
    layerKey: 'flights',
    ring: square,
    threshold: 1,
  });
  const inside = [
    { lat: 0, lon: 0 },
    { lat: 0.5, lon: 0.5 },
  ];
  assert.equal(evaluateAlertRule(count, inside).triggered, true);
  assert.equal(
    evaluateAlertRule(count, [...inside.slice(0, 1), { lat: 5, lon: 5 }])
      .triggered,
    false,
  );
  const speed = normalizeAlertRule({
    kind: 'speed-in-zone',
    layerKey: 'ais-live-vessels',
    ring: square,
    maxSpeedKts: 8,
  });
  const result = evaluateAlertRule(speed, [
    { lat: 0, lon: 0, speedKts: 12, name: 'FAST' },
    { lat: 0, lon: 0, speedKts: 4, name: 'SLOW' },
    { lat: 9, lon: 9, speedKts: 30, name: 'OUTSIDE' },
  ]);
  assert.equal(result.triggered, true);
  assert.equal(result.count, 1);
  assert.match(result.detail, /FAST 12 kt/);
});

test('alerts: monitor fires once on the rising edge and re-arms', () => {
  const trips = [];
  const storage = memoryStorage();
  const monitor = createAlertMonitor({
    storage,
    onTrip: (rule) => trips.push(rule.id),
  });
  const rule = monitor.add({
    kind: 'count-in-zone',
    layerKey: 'flights',
    ring: square,
    threshold: 0,
  });
  let records = [{ lat: 0, lon: 0 }];
  monitor.evaluate(() => records);
  monitor.evaluate(() => records);
  assert.deepEqual(trips, [rule.id]);
  records = [];
  monitor.evaluate(() => records);
  records = [{ lat: 0, lon: 0 }];
  monitor.evaluate(() => records);
  assert.equal(trips.length, 2);
  const reloaded = createAlertMonitor({ storage });
  assert.equal(reloaded.list().length, 1);
});

test('brief: synthesizes counts, facts, anomalies, alerts and feed issues', () => {
  const layers = [
    { id: 'flights', enabled: true, feedState: 'nominal' },
    {
      id: 'ais-live-vessels',
      enabled: true,
      feedState: 'stale',
      ageLabel: '12m ago',
    },
    { id: 'earthquakes', enabled: true, feedState: 'nominal' },
    { id: 'satellites', enabled: false, feedState: 'off' },
  ];
  const records = {
    flights: [
      { lat: 0, lon: 0, altitudeM: 10000, onGround: false, military: true },
      { lat: 0, lon: 0, altitudeM: 0, onGround: true },
    ],
    'ais-live-vessels': [{ lat: 0, lon: 0, speedKts: 30 }],
    earthquakes: [{ lat: 0, lon: 0, magnitude: 5.4, place: 'off Chile' }],
  };
  const brief = buildSituationBrief({
    layers,
    getRecords: (k) => records[k] || [],
    alertTrips: [
      {
        rule: { id: 'r', label: 'Harbor speed' },
        result: { detail: '1 over 8 kt' },
      },
    ],
  });
  assert.equal(brief.sections.length, 3);
  assert.match(brief.headline, /2 aircraft · 1 vessels · 1 earthquakes/);
  assert.match(
    brief.spoken,
    /Aircraft: 2, 1 airborne, 1 on ground, 1 military/,
  );
  assert.match(brief.spoken, /strongest M5\.4 off Chile/);
  assert.match(brief.spoken, /Harbor speed/);
  assert.match(brief.spoken, /Not live: Vessels STALE/);
  const empty = buildSituationBrief({ layers: [], getRecords: () => [] });
  assert.match(empty.spoken, /Nothing is loaded/);
  assert.deepEqual(
    summarizeLayer('ais-live-vessels', [{ speedKts: 0 }]).facts,
    ['0 underway'],
  );
});

test('presentation: filters hide, regions fade, staleness decays', () => {
  resetPresentation();
  const now = 1_000_000_000_000;
  const plane = {
    lat: 0,
    lon: 0,
    altitudeM: 11000,
    onGround: false,
    lastSeenMs: now,
  };
  assert.equal(contactPresentationFactor('flights', plane, now), 1);
  assert.equal(altitudeBandFor(plane), 'high');
  setAltitudeBandEnabled('high', false);
  assert.equal(contactPresentationFactor('flights', plane, now), 0);
  setAltitudeBandEnabled('high', true);
  setRegionFilter([
    [10, 10],
    [11, 10],
    [11, 11],
  ]);
  assert.equal(contactPresentationFactor('flights', plane, now), 0.2);
  setRegionFilter(null);
  setTimeWindow(10 * 60_000);
  assert.equal(
    contactPresentationFactor(
      'flights',
      { ...plane, lastSeenMs: now - 11 * 60_000 },
      now,
    ),
    0,
  );
  setTimeWindow(null);
  assert.ok(stalenessFactor('ais-live-vessels', 40 * 60_000) < 1);
  assert.equal(stalenessFactor('ais-live-vessels', 5 * 60_000), 1);
  assert.equal(
    describeStaleness('ais-live-vessels', now - 40 * 60_000, now).stale,
    true,
  );
  assert.equal(vesselClassFor('80'), 'tanker');
  assert.equal(vesselClassFor('35'), 'military');
  assert.equal(vesselClassFor(''), 'unknown');
  setVesselClassEnabled('tanker', false);
  assert.equal(
    contactPresentationFactor('ais-live-vessels', { shipType: 'Tanker' }, now),
    0,
  );
  resetPresentation();
});

test('intel service: last tracked and pins survive, resolve live and cap at four', () => {
  const session = memoryStorage();
  const records = [
    { icao24: 'a1', callsign: 'ONE', lat: 0, lon: 0 },
    { icao24: 'a2', callsign: 'TWO', lat: 0, lon: 0 },
    { icao24: 'a3', lat: 0, lon: 0 },
    { icao24: 'a4', lat: 0, lon: 0 },
    { icao24: 'a5', lat: 0, lon: 0 },
  ];
  const dataManager = {
    isEnabled: (k) => k === 'flights',
    layers: new Map([
      ['flights', { module: { getAnalystRecords: () => records } }],
    ]),
    getAll: () => [{ id: 'flights', enabled: true, stats: { count: 5 } }],
  };
  const events = new EventTarget();
  const timers = {
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout() {},
    clearInterval() {},
  };
  const service = createIntelService({
    dataManager,
    events,
    localStorage: memoryStorage(),
    sessionStorage: session,
    timers,
  }).start();
  events.dispatchEvent(
    new CustomEvent('gev:awareness-subject-selected', {
      detail: { layerId: 'flights', id: 'a2', label: 'TWO' },
    }),
  );
  assert.equal(service.getLastTracked().record.callsign, 'TWO');
  for (const r of records) service.pin('flights', r);
  assert.equal(service.getPins().length, 4);
  assert.equal(service.pin('flights', records[0]), false, 'no duplicates');
  assert.equal(service.unpin('flights', 'a1'), true);
  assert.deepEqual(contactKeyFor('flights', records[0]), {
    layerKey: 'flights',
    field: 'icao24',
    value: 'a1',
  });
  service.stop();
  const again = createIntelService({
    dataManager,
    events,
    localStorage: memoryStorage(),
    sessionStorage: session,
    timers,
  });
  assert.equal(again.getLastTracked().value, 'a2');
  assert.equal(again.getPins().length, 3);
  assert.match(again.brief().headline, /5 aircraft/);
});
