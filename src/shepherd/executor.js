/**
 * Runs the tools Shepherd calls. Voice-control tools go straight to the same
 * action runner the voice session uses, so chat and voice cannot drift; the
 * Shepherd-only tools (layers in bulk, flight tracking, filters, alert zones,
 * pins, OSINT overlays, reports, 3D buildings) are implemented here.
 *
 * Every result is a plain JSON object small enough to hand back to the model.
 */
import {
  resetPresentation,
  setAltitudeBandEnabled,
  setRegionFilter,
  setStalenessEnabled,
  setTimeWindow,
  setVesselClassEnabled,
  ALTITUDE_BANDS,
  TIME_WINDOWS,
  VESSEL_TYPE_CLASSES,
} from '../intel/contactPresentation.js';
import { readConsoleState } from './consoleState.js';

const NM_TO_KM = 1.852;
const MAX_LAYER_CHANGES = 16;
const RESULT_CHARS = 6000;

/** Polygon ring approximating a circle, as [lon, lat] pairs. */
export function circleRing(lat, lon, radiusKm, steps = 48) {
  const ring = [];
  const dLat = radiusKm / 111.32;
  const dLon =
    radiusKm / (111.32 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([
      +(lon + dLon * Math.cos(a)).toFixed(5),
      +(lat + dLat * Math.sin(a)).toFixed(5),
    ]);
  }
  return ring;
}

/** Keep tool results bounded and serializable. */
export function compactResult(value) {
  let text;
  try {
    text = JSON.stringify(value ?? { ok: true });
  } catch {
    text = JSON.stringify({ ok: false, error: 'result not serializable' });
  }
  return text.length > RESULT_CHARS
    ? `${text.slice(0, RESULT_CHARS)}…(truncated)`
    : text;
}

function slug(value) {
  return (
    String(value || 'adam-report')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'adam-report'
  );
}

function download(doc, filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createShepherdExecutor({
  runGevAction,
  viewer,
  dataManager,
  intel,
  overlay,
  buildings,
  client,
  getTzLookup = () => null,
  getEnvironment = () => null,
  getSkyPanel = () => null,
  getNations = () => null,
  getConsole = () => globalThis.__godsEyeView || {},
  memory = null,
  doc = globalThis.document,
}) {
  async function setLayer(layerId, enabled, signal) {
    try {
      const r = await runGevAction(
        'set_layer_visibility',
        { layerId, enabled },
        { signal },
      );
      return {
        id: layerId,
        ok: r?.ok !== false,
        count: r?.count ?? null,
        error: r?.error || null,
      };
    } catch (error) {
      return { id: layerId, ok: false, error: error.message };
    }
  }

  async function trackFlight({ query }, signal) {
    const lookup = await client.flightLookup(String(query || ''), { signal });
    const aircraft = lookup?.aircraft?.[0];
    if (!aircraft) return { ok: false, error: 'no aircraft matched' };
    if (!dataManager.isEnabled('flights'))
      await setLayer('flights', true, signal);
    const flights = dataManager.layers.get('flights')?.module;
    let tracked = false;
    // The live layer may not have this airframe until its next poll; give it
    // a short window before falling back to a pinned position.
    for (let i = 0; i < 8 && !tracked && !signal?.aborted; i += 1) {
      const found = flights?.findByQuery?.(aircraft.icao24);
      if (found?.icao24 === aircraft.icao24) {
        tracked = Boolean(
          flights.trackById?.(found.icao24, { origin: 'shepherd' }),
        );
        if (tracked) {
          const record = intel?.findRecord?.({
            layerKey: 'flights',
            field: 'icao24',
            value: found.icao24,
          });
          if (record)
            intel?.pin?.(
              'flights',
              record,
              aircraft.callsign || aircraft.registration || aircraft.icao24,
            );
        }
        break;
      }
      await sleep(1000);
    }
    if (!tracked)
      overlay.dropPin({
        lat: aircraft.lat,
        lon: aircraft.lon,
        label: `${aircraft.callsign || aircraft.registration || aircraft.icao24} · ${aircraft.altitudeFt ?? '?'} ft`,
        range: 40_000,
      });
    memory?.noteFocus(`flight:${aircraft.callsign || aircraft.icao24}`);
    return {
      ok: true,
      tracking: tracked
        ? 'follow camera locked'
        : 'position pinned (not yet in the live layer)',
      matchedBy: lookup.matchedBy,
      aircraft,
      otherMatches: lookup.aircraft.length - 1,
    };
  }

  function setContactFilter(args) {
    if (args.reset) resetPresentation();
    if (args.timeWindow) {
      const w = TIME_WINDOWS.find((t) => t.id === args.timeWindow);
      if (w) setTimeWindow(w.ms);
    }
    if (Array.isArray(args.altitudeBands) && args.altitudeBands.length)
      for (const band of ALTITUDE_BANDS)
        setAltitudeBandEnabled(band.id, args.altitudeBands.includes(band.id));
    if (Array.isArray(args.vesselTypes) && args.vesselTypes.length) {
      for (const cls of VESSEL_TYPE_CLASSES)
        setVesselClassEnabled(cls.id, args.vesselTypes.includes(cls.id));
      setVesselClassEnabled('unknown', args.vesselTypes.includes('unknown'));
    }
    if (typeof args.staleness === 'boolean')
      setStalenessEnabled(args.staleness);
    if (args.clearRegion) setRegionFilter(null);
    const c = args.regionCenter;
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      const km = Math.max(
        1,
        Math.min(3000, Number(args.regionRadiusKm) || 100),
      );
      setRegionFilter(circleRing(c.lat, c.lon, km));
    }
    return { ok: true };
  }

  function createAlertZone(args) {
    const radiusKm = Math.max(
      0.5,
      Math.min(2000, Number(args.radiusNm) * NM_TO_KM || 50),
    );
    const rule = intel?.alerts?.add?.({
      kind: args.kind,
      layerKey: args.layer,
      ring: circleRing(Number(args.lat), Number(args.lon), radiusKm),
      threshold:
        args.kind === 'count-in-zone'
          ? Math.max(0, Math.floor(Number(args.threshold) || 0))
          : undefined,
      maxSpeedKts:
        args.kind === 'speed-in-zone' ? Number(args.maxSpeedKts) : undefined,
      label: args.label,
    });
    if (!rule)
      return {
        ok: false,
        error: 'rule rejected (bad values or 24-rule limit reached)',
      };
    if (!dataManager.isEnabled(args.layer)) void setLayer(args.layer, true);
    return { ok: true, rule: { id: rule.id, label: rule.label } };
  }

  function exportReport({ title, markdown }) {
    const name = slug(title);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const body = `${String(markdown || '').slice(0, 200_000)}\n\n---\nADAM · #houseofasher · ${new Date().toISOString()}\n`;
    download(doc, `${name}-${stamp}.md`, body, 'text/markdown');
    const geo = overlay.geojson();
    if (geo.features.length)
      download(
        doc,
        `${name}-${stamp}.geojson`,
        JSON.stringify(geo, null, 2),
        'application/geo+json',
      );
    return { ok: true, files: geo.features.length ? 2 : 1 };
  }

  function setEnvironment(args) {
    const env = getEnvironment();
    const sky = getSkyPanel();
    if (!env || !sky)
      return { ok: false, error: 'live environment is still loading' };
    if (typeof args.lighting === 'boolean') env.setLighting(args.lighting);
    if (typeof args.shadows === 'boolean') env.setShadows(args.shadows);
    if (typeof args.sky === 'boolean') env.setSky(args.sky);
    const mode = args.mode || 'read';
    if (mode === 'live') env.live();
    else if (mode === 'offset')
      env.setOffset(Number(args.hoursFromNow || 0) * 3_600_000);
    else if (mode === 'play') env.play(Number(args.speed) || 600);
    else if (mode === 'pause') env.pause();
    else if (mode === 'jump') {
      const r = sky.reading();
      const day = 86_400_000;
      const next = (d) =>
        d && d.valueOf() < Date.now() - 3_600_000
          ? new Date(d.valueOf() + day)
          : d;
      const target = {
        sunrise: next(r.sunTimes?.rise),
        noon: next(r.solarNoon),
        sunset: next(r.sunTimes?.set),
        midnight: r.solarNoon
          ? next(new Date(r.solarNoon.valueOf() + day / 2))
          : null,
      }[args.jump];
      if (!target)
        return { ok: false, error: `no ${args.jump} at this latitude today` };
      env.setDate(target);
    }
    if (args.openPanel) sky.open();
    const r = sky.reading();
    const snap = env.snapshot();
    const iso = (d) => (d ? d.toISOString() : null);
    return {
      ok: true,
      clock: {
        mode: snap.mode,
        utc: snap.date.toISOString(),
        offsetHours: +(snap.offsetMs / 3_600_000).toFixed(2),
        playing: snap.playing,
        speed: snap.speed,
      },
      scene: { lighting: snap.lighting, shadows: snap.shadows, sky: snap.sky },
      at: { lat: +r.center.lat.toFixed(4), lon: +r.center.lon.toFixed(4) },
      phase: r.phase,
      sun: {
        altitude: +r.sun.altitude.toFixed(1),
        azimuth: Math.round(r.sun.azimuth),
        rise: iso(r.sunTimes.rise),
        set: iso(r.sunTimes.set),
        noon: iso(r.solarNoon),
      },
      moon: {
        altitude: +r.moon.altitude.toFixed(1),
        azimuth: Math.round(r.moon.azimuth),
        phase: r.moon.name,
        lit: +r.moon.fraction.toFixed(2),
        rise: iso(r.moonTimes.rise),
        set: iso(r.moonTimes.set),
      },
      shadow: r.shadow
        ? {
            towardDeg: Math.round(r.shadow.towardDeg),
            lengthRatio: +r.shadow.lengthRatio.toFixed(2),
          }
        : null,
      stars: r.stars.map((x) => x.name),
      weather: r.weather,
    };
  }

  function clickIfExists(id) {
    const node = doc.getElementById?.(id);
    if (!node) return false;
    node.click();
    return true;
  }

  function setPanel(panel, open) {
    const c = getConsole();
    switch (panel) {
      case 'brief':
      case 'alerts':
      case 'filter':
        c.opsDeck?.toggleView?.(panel === 'filter' ? 'filters' : panel, open);
        return true;
      case 'keys':
        c.opsDeck?.toggleShortcuts?.(open);
        return true;
      case 'sky':
        open ? c.skyPanel?.open?.() : c.skyPanel?.close?.();
        return Boolean(c.skyPanel);
      case 'nations':
        open ? c.shepherd?.nations?.open?.() : c.shepherd?.nations?.close?.();
        return Boolean(c.shepherd?.nations);
      case 'shepherd':
        open ? c.shepherd?.room?.open?.() : c.shepherd?.room?.close?.();
        return true;
      case 'display':
        c.hudPolicy?.openDisplay?.(open);
        return Boolean(c.hudPolicy);
      case 'data_layers': {
        const panelEl = doc.getElementById?.('data-panel');
        const collapsed = panelEl?.classList?.contains('collapsed');
        if (panelEl && collapsed === open)
          panelEl.querySelector('.panel-collapse-btn')?.click();
        return Boolean(panelEl);
      }
      default:
        return false;
    }
  }

  async function consoleCommand({ command, panel, value }) {
    const c = getConsole();
    switch (command) {
      case 'open_panel':
      case 'close_panel':
        return { ok: setPanel(panel, command === 'open_panel'), panel };
      case 'scope': {
        const want = !/^(off|false|0)$/i.test(String(value ?? 'on'));
        const btn = doc.getElementById?.('scope-toggle');
        const isOn = btn?.getAttribute('aria-pressed') !== 'false';
        if (btn && isOn !== want) btn.click();
        return { ok: Boolean(btn), scope: want ? 'on' : 'off' };
      }
      case 'snapshot':
        if (!c.capture) return { ok: false, error: 'capture tools not loaded' };
        await c.capture.snapshot();
        return { ok: true, saved: 'png' };
      case 'record_start':
        if (!c.capture) return { ok: false, error: 'capture tools not loaded' };
        await c.capture.startRecording();
        return { ok: true, recording: true };
      case 'record_stop':
        c.capture?.stopRecording?.();
        return { ok: true, recording: false };
      case 'ui_scale':
        c.capture?.setScale?.(Number(value) || 1);
        return { ok: Boolean(c.capture), scale: Number(value) || 1 };
      case 'share_view':
        return {
          ok: clickIfExists('share-btn'),
          note: 'share link copied to the clipboard',
        };
      case 'clear_overlays':
        return overlay.clear();
      case 'unpin_all': {
        const pins = intel?.getPins?.() || [];
        for (const p of pins) intel.unpin(p.layerKey, p.value);
        return { ok: true, removed: pins.length };
      }
      case 'system_status': {
        const layers = (dataManager.getAll?.() || []).filter((l) => l.enabled);
        return {
          ok: true,
          layers: layers.map((l) => ({
            id: l.id,
            count: l.stats?.count ?? null,
            error: l.stats?.error || null,
          })),
          recording: Boolean(doc.documentElement?.dataset?.adamRecordingSince),
          uiScale: Number(doc.documentElement?.dataset?.uiScale || 1),
          view: doc.documentElement?.dataset?.adamView || null,
        };
      }
      default:
        return { ok: false, error: `unknown command ${command}` };
    }
  }

  const EXTRA = {
    console_command: consoleCommand,
    get_traffic_snapshot: ({ limit } = {}) => {
      const traffic = dataManager.layers?.get?.('traffic')?.module;
      if (
        !dataManager.isEnabled?.('traffic') ||
        typeof traffic?.getFlowSnapshot !== 'function'
      )
        return {
          ok: false,
          error: 'the traffic layer is off — enable it first',
        };
      return {
        ok: true,
        ...traffic.getFlowSnapshot({ limit: Number(limit) || 10 }),
      };
    },
    export_fires: ({ format = 'csv', inViewOnly = true } = {}) => {
      const firms = dataManager.layers?.get?.('local-firms')?.module;
      if (
        !dataManager.isEnabled?.('local-firms') ||
        typeof firms?.getAnalystRecords !== 'function'
      )
        return {
          ok: false,
          error: 'the FIRMS fire layer is off — enable it first',
        };
      let rows = firms.getAnalystRecords(50_000) || [];
      const rect = inViewOnly ? viewer.camera?.computeViewRectangle?.() : null;
      if (rect) {
        const deg = (r) => (r * 180) / Math.PI;
        const [w, s, e, n] = [
          deg(rect.west),
          deg(rect.south),
          deg(rect.east),
          deg(rect.north),
        ];
        rows = rows.filter(
          (r) =>
            r.lat >= s &&
            r.lat <= n &&
            (w <= e ? r.lon >= w && r.lon <= e : r.lon >= w || r.lon <= e),
        );
      }
      const records = rows.map((r) => ({
        id: r.id,
        lat: r.lat,
        lon: r.lon,
        frp_mw: r.frp,
        confidence: r.confidence,
        satellite: r.satellite,
        acquired_utc: Number.isFinite(r.acqTime)
          ? new Date(r.acqTime).toISOString()
          : null,
      }));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      if (format === 'json')
        download(
          doc,
          `adam-firms-${stamp}.json`,
          JSON.stringify(records, null, 2),
          'application/json',
        );
      else {
        const cols = [
          'id',
          'lat',
          'lon',
          'frp_mw',
          'confidence',
          'satellite',
          'acquired_utc',
        ];
        const esc = (v) =>
          v === null || v === undefined
            ? ''
            : /[",\n]/.test(String(v))
              ? `"${String(v).replace(/"/g, '""')}"`
              : String(v);
        download(
          doc,
          `adam-firms-${stamp}.csv`,
          [
            cols.join(','),
            ...records.map((r) => cols.map((c) => esc(r[c])).join(',')),
          ].join('\n'),
          'text/csv',
        );
      }
      const bySat = {};
      for (const r of records)
        bySat[r.satellite || 'unknown'] =
          (bySat[r.satellite || 'unknown'] || 0) + 1;
      const strongest = records.reduce(
        (a, b) => ((b.frp_mw ?? -1) > (a?.frp_mw ?? -1) ? b : a),
        null,
      );
      const newest = records.reduce(
        (a, b) => ((b.acquired_utc || '') > (a?.acquired_utc || '') ? b : a),
        null,
      );
      return {
        ok: true,
        count: records.length,
        format,
        scope: rect ? 'in view' : 'all loaded',
        bySatellite: bySat,
        strongest,
        newest,
      };
    },
    list_alerts: () => ({ ok: true, rules: intel?.alerts?.list?.() || [] }),
    remove_alert: ({ id, enabled }) => {
      if (typeof enabled === 'boolean')
        return {
          ok: Boolean(intel?.alerts?.setEnabled?.(id, enabled)),
          id,
          enabled,
        };
      return { ok: Boolean(intel?.alerts?.remove?.(id)), id, removed: true };
    },
    get_console_state: () =>
      readConsoleState({
        viewer,
        dataManager,
        intel,
        overlay,
        buildings,
        tzLookup: getTzLookup(),
      }),
    set_layers: async (args, signal) => {
      const changes = (Array.isArray(args.layers) ? args.layers : []).slice(
        0,
        MAX_LAYER_CHANGES,
      );
      const results = await Promise.all(
        changes.map((c) => {
          if (c.enabled) memory?.noteFocus(`layer:${c.id}`);
          return setLayer(String(c.id || ''), Boolean(c.enabled), signal);
        }),
      );
      return { ok: results.every((r) => r.ok), results };
    },
    track_flight: trackFlight,
    set_contact_filter: setContactFilter,
    create_alert_zone: createAlertZone,
    drop_pin: (args) => {
      memory?.noteFocus(
        `place:${Number(args.lat).toFixed(1)},${Number(args.lon).toFixed(1)}`,
      );
      return overlay.dropPin(args);
    },
    osint_overlay: (args) => overlay.drawOverlay(args),
    clear_osint_overlay: () => overlay.clear(),
    export_report: exportReport,
    set_3d_buildings: (args) => buildings.set(Boolean(args.enabled)),
    set_environment: (args) => setEnvironment(args),
    nation_profile: async (args) => {
      const nations = getNations();
      if (!nations)
        return { ok: false, error: 'nations panel is still loading' };
      return nations.profile(args);
    },
    show_summits: () => {
      const nations = getNations();
      if (!nations)
        return { ok: false, error: 'nations panel is still loading' };
      return { ok: true, summits: nations.showSummits() };
    },
  };

  return {
    has: (name) => Object.hasOwn(EXTRA, name),
    /**
     * @param {string} name
     * @param {object} args
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<string>} JSON text for the tool result turn
     */
    async run(name, args = {}, { signal } = {}) {
      const safeArgs = args && typeof args === 'object' ? args : {};
      try {
        const result = Object.hasOwn(EXTRA, name)
          ? await EXTRA[name](safeArgs, signal)
          : await runGevAction(name, safeArgs, {
              signal,
              isCurrent: () => !signal?.aborted,
            });
        return compactResult(result);
      } catch (error) {
        return compactResult({
          ok: false,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    },
  };
}
