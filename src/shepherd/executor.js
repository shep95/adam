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

/** Shrink arrays and long strings so the result stays valid JSON. */
function shrink(value, maxItems, maxChars, depth = 0) {
  if (typeof value === 'string')
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  if (!value || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, maxItems)
      .map((v) => shrink(v, maxItems, maxChars, depth + 1));
    if (value.length > maxItems) kept.push(`…${value.length - maxItems} more`);
    return kept;
  }
  const out = {};
  for (const [k, v] of Object.entries(value))
    out[k] = shrink(v, maxItems, maxChars, depth + 1);
  return out;
}

/** Keep tool results bounded, serializable and still valid JSON. */
export function compactResult(value) {
  let text;
  try {
    text = JSON.stringify(value ?? { ok: true });
  } catch {
    return JSON.stringify({ ok: false, error: 'result not serializable' });
  }
  if (text.length <= RESULT_CHARS) return text;
  for (const [items, chars] of [
    [40, 400],
    [20, 240],
    [10, 160],
    [5, 100],
    [3, 60],
  ]) {
    const parsed = JSON.parse(text);
    const small =
      parsed && typeof parsed === 'object'
        ? { ...shrink(parsed, items, chars), truncated: true }
        : parsed;
    const t = JSON.stringify(small);
    if (t.length <= RESULT_CHARS) return t;
  }
  return JSON.stringify({
    ok: true,
    truncated: true,
    preview: text.slice(0, RESULT_CHARS - 80),
  });
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
    const zone = args.zone ? intel?.zoneById?.(args.zone) : null;
    if (args.zone && !zone)
      return { ok: false, error: `no zone ${args.zone}; see list_zones` };
    if (!zone && ![args.lat, args.lon].every((v) => Number.isFinite(Number(v))))
      return { ok: false, error: 'give lat/lon/radiusNm or a saved zone id' };
    const radiusKm = Math.max(
      0.5,
      Math.min(2000, Number(args.radiusNm) * NM_TO_KM || 50),
    );
    const rule = intel?.alerts?.add?.({
      kind: args.kind,
      layerKey: args.layer,
      ring: zone
        ? zone.ring
        : circleRing(Number(args.lat), Number(args.lon), radiusKm),
      threshold:
        args.kind === 'count-in-zone' || args.kind === 'fire-in-zone'
          ? Math.max(0, Math.floor(Number(args.threshold) || 0))
          : undefined,
      maxSpeedKts:
        args.kind === 'speed-in-zone' ? Number(args.maxSpeedKts) : undefined,
      minMagnitude:
        args.kind === 'quake-in-zone' ? Number(args.minMagnitude) : undefined,
      minFrp:
        args.kind === 'fire-in-zone' ? Number(args.minFrp) || 0 : undefined,
      label: args.label,
    });
    if (!rule)
      return {
        ok: false,
        error: 'rule rejected (bad values or 24-rule limit reached)',
      };
    if (!dataManager.isEnabled(rule.layerKey))
      void setLayer(rule.layerKey, true);
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
      case 'health':
      case 'scenario':
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
        c.shepherd?.files?.clear?.();
        return overlay.clear();
      case 'unpin_all': {
        const pins = intel?.getPins?.() || [];
        for (const p of pins) intel.unpin(p.layerKey, p.value);
        return { ok: true, removed: pins.length };
      }
      case 'rewind': {
        if (!c.rewind?.seek)
          return { ok: false, error: 'rewind is not loaded' };
        const minutes =
          value == null || value === 'live' ? null : Number(value);
        if (minutes != null && !(minutes > 0 && minutes <= 45))
          return { ok: false, error: 'rewind takes 1-45 minutes or live' };
        const r = c.rewind.seek(minutes);
        return {
          ok: true,
          at: r.at ? new Date(r.at).toISOString() : 'live',
          heldMinutes: r.range
            ? Math.round((r.range.to - r.range.from) / 60_000)
            : 0,
        };
      }
      case 'profile_export':
        if (typeof c.opsDeck?.exportProfile !== 'function')
          return { ok: false, error: 'ops deck is not loaded' };
        return c.opsDeck.exportProfile();
      case 'system_status': {
        const layers = (dataManager.getAll?.() || []).filter((l) => l.enabled);
        return {
          ok: true,
          layers: layers.map((l) => ({
            id: l.id,
            count: l.stats?.count ?? null,
            error: l.stats?.error || null,
          })),
          health: c.opsDeck?.readHealth?.() || null,
          storm: c.storm?.state?.() || null,
          recording: Boolean(doc.documentElement?.dataset?.adamRecordingSince),
          uiScale: Number(doc.documentElement?.dataset?.uiScale || 1),
          view: doc.documentElement?.dataset?.adamView || null,
        };
      }
      default:
        return { ok: false, error: `unknown command ${command}` };
    }
  }

  let lastRecommendations = [];
  /** Fetch a GeoJSON route and put it on the globe in its own colour. */
  async function loadKeyedOverlay(url, name, color, summarize) {
    const res = await fetch(url, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    const files = getConsole().shepherd?.files;
    let shown = null;
    if (files && body.features?.length)
      shown = await files.load(
        new File([JSON.stringify(body)], `${name}.geojson`, {
          type: 'application/geo+json',
        }),
        { color },
      );
    return {
      ok: true,
      count: body.features?.length || 0,
      shown,
      ...summarize(body),
    };
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
    space_weather: async () => {
      const res = await fetch('/api/spaceweather', {
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      return res.ok
        ? { ok: true, ...body }
        : { ok: false, error: body.error || `HTTP ${res.status}` };
    },
    news_events: async ({ query, timespan = '24h' } = {}) => {
      const res = await fetch(
        `/api/events?query=${encodeURIComponent(query || '')}&timespan=${encodeURIComponent(timespan)}`,
        { credentials: 'same-origin' },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok)
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      const feats = (body.features || []).slice(0, 150);
      if (feats.length)
        overlay.drawOverlay({
          title: `news: ${query}`,
          nodes: feats.map((f, i) => ({
            id: `news-${i}`,
            label: `${f.properties.name} (${f.properties.count})`,
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
            confidence: 0.4,
            note: f.properties.url || '',
          })),
        });
      return {
        ok: true,
        source: body.source,
        places: feats.length,
        top: feats
          .slice()
          .sort((a, b) => b.properties.count - a.properties.count)
          .slice(0, 12)
          .map((f) => ({
            name: f.properties.name,
            count: f.properties.count,
            url: f.properties.url,
          })),
        note: 'news-reported locations (GDELT): density of reporting, not verified events',
      };
    },
    list_feeds: async () => {
      const res = await fetch('/api/ingest', { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      return res.ok
        ? { ok: true, ...body }
        : { ok: false, error: body.error || `HTTP ${res.status}` };
    },
    load_feed: async ({ name } = {}) => {
      const res = await fetch(`/api/ingest/${encodeURIComponent(name || '')}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return { ok: false, error: `no feed ${name}` };
      const files = getConsole().shepherd?.files;
      if (!files)
        return { ok: false, error: 'overlay loader is still loading' };
      const text = await res.text();
      return {
        ok: true,
        ...(await files.load(
          new File([text], `${name}.geojson`, { type: 'application/geo+json' }),
        )),
      };
    },
    load_url: async ({ url } = {}) => {
      const res = await fetch(
        `/api/fetch-geo?url=${encodeURIComponent(url || '')}`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      }
      const type = res.headers.get('content-type') || '';
      let text = await res.text();
      let name =
        (String(url).split('/').pop() || 'overlay')
          .split('?')[0]
          .slice(0, 60) || 'overlay';
      if (/csv|text\/plain/.test(type) || /\.csv$/i.test(name)) {
        const { csvToGeoJson } = await import('./fileIntel.js');
        const gj = csvToGeoJson(text);
        if (!gj) return { ok: false, error: 'CSV needs lat and lon columns' };
        text = JSON.stringify(gj);
        name = name.replace(/\.csv$/i, '') + '.geojson';
      } else if (/kml/.test(type) && !/\.km[lz]$/i.test(name)) name += '.kml';
      else if (!/\.(geo)?json$|\.km[lz]$/i.test(name)) name += '.geojson';
      const files = getConsole().shepherd?.files;
      if (!files)
        return { ok: false, error: 'overlay loader is still loading' };
      return { ok: true, ...(await files.load(new File([text], name))) };
    },
    record_finding: (args = {}) => {
      if (!intel?.addFinding)
        return { ok: false, error: 'intel service is not running' };
      const f = intel.addFinding({ ...args, author: 'shepherd' });
      return { ok: true, id: f.id, recorded: f.subject };
    },
    list_findings: () => ({
      ok: true,
      findings: intel?.listFindings?.() || [],
    }),
    export_product: async ({
      title,
      bluf,
      assessment,
      marking,
      periodHours,
    } = {}) => {
      const { downloadProduct } = await import('../ui/adam/productExport.js');
      return downloadProduct(
        { title, bluf, assessment, marking, periodHours },
        doc,
      );
    },
    get_action_log: ({ limit } = {}) => ({
      ok: true,
      actions: (getConsole().shepherd?.agent?.actionLog?.() || [])
        .slice(-(limit || 50))
        .map((a) => ({ ...a, at: new Date(a.at).toISOString() })),
    }),
    recommend_actions: ({ limit } = {}) => {
      if (!intel?.recommend)
        return { ok: false, error: 'intel service is not running' };
      lastRecommendations = intel.recommend({ limit: limit || 6 });
      return {
        ok: true,
        actions: lastRecommendations.map((r, i) => ({
          n: i + 1,
          title: r.title,
          why: r.why,
          action: r.action.type,
        })),
      };
    },
    run_recommendation: async ({ index } = {}) => {
      const r = lastRecommendations[(Number(index) || 0) - 1];
      if (!r)
        return {
          ok: false,
          error: 'call recommend_actions first; index out of range',
        };
      const runner = getConsole().actions;
      if (!runner)
        return { ok: false, error: 'action runner is still loading' };
      return { title: r.title, ...(await runner.run(r.action)) };
    },
    predict_track: ({ layer, id, minutes, zone } = {}) => {
      if (!intel?.predict)
        return { ok: false, error: 'intel service is not running' };
      const res = intel.predict({
        layerKey: layer,
        id,
        minutes: minutes || 240,
        zone,
      });
      if (res.ok) getConsole().actions?.showPrediction?.(res);
      if (!res.ok) return res;
      const last = res.track.at(-1);
      return {
        ok: true,
        name: res.name,
        sentence: res.sentence,
        eta: res.eta,
        horizon: {
          minutes: last.min,
          lat: last.lat,
          lon: last.lon,
          radiusKm: Math.round(last.radiusKm),
        },
        note: 'dead reckoning at current course and speed; the band is a screening radius',
      };
    },
    asset_risk: ({ limit } = {}) => {
      if (!intel?.assetRisk)
        return { ok: false, error: 'intel service is not running' };
      return { ok: true, assets: intel.assetRisk({ limit: limit || 10 }) };
    },
    measure: ({ points = [], rhumb = false, unit = 'km' } = {}) => {
      const pts = points.filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      if (pts.length < 2) return { ok: false, error: 'two or more points' };
      const tool = getConsole().measure;
      if (tool)
        return { ok: true, ...tool.measure(pts, { rhumbLine: rhumb, unit }) };
      return { ok: false, error: 'measure tool is still loading' };
    },
    range_rings: ({ lat, lon, unit = 'km' } = {}) => {
      const tool = getConsole().measure;
      if (!tool) return { ok: false, error: 'measure tool is still loading' };
      return { ok: true, ...tool.rings({ lat, lon }, { unit }) };
    },
    create_zone: async ({
      name,
      kind,
      lat,
      lon,
      radiusKm,
      widthKm,
      points = [],
    } = {}) => {
      const g = await import('../intel/geoMeasure.js');
      const pts = points.filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      let ring = null;
      if (kind === 'circle' && Number.isFinite(lat) && Number.isFinite(lon))
        ring = g.circleRing(
          { lat, lon },
          Math.max(0.1, Number(radiusKm) || 10),
        );
      else if (kind === 'polygon' && pts.length >= 3)
        ring = pts.map((p) => [p.lon, p.lat]);
      else if (kind === 'corridor' && pts.length >= 2)
        ring = g.corridorRing(pts, Math.max(0.05, Number(widthKm) || 5));
      if (!ring)
        return {
          ok: false,
          error:
            'circle needs lat/lon/radiusKm; polygon 3+ points; corridor 2+ points',
        };
      const zone = intel?.addZone?.({
        name,
        kind,
        ring,
        meta: {
          radiusKm,
          widthKm,
          areaKm2: g.polygonAreaKm2(ring.map(([x, y]) => ({ lat: y, lon: x }))),
        },
      });
      return zone
        ? {
            ok: true,
            zone: {
              id: zone.id,
              name: zone.name,
              kind: zone.kind,
              areaKm2: Math.round(zone.meta.areaKm2),
            },
          }
        : { ok: false, error: 'zone rejected (limit 40)' };
    },
    list_zones: () => ({
      ok: true,
      zones: (intel?.listZones?.() || []).map((z) => ({
        id: z.id,
        name: z.name,
        kind: z.kind,
        areaKm2: z.meta?.areaKm2 ? Math.round(z.meta.areaKm2) : null,
      })),
    }),
    apply_scenario: async ({ id, replace = true } = {}) => {
      const { applyScenario } = await import('../ui/adam/scenarios.js');
      return applyScenario(dataManager, id, { replace, intel });
    },
    get_watch_log: ({ kind, since, limit } = {}) => {
      if (!intel?.watchLog)
        return { ok: false, error: 'intel service is not running' };
      const t = since ? Date.parse(since) : 0;
      return {
        ok: true,
        entries: intel
          .watchLog({
            kind: kind || null,
            since: Number.isFinite(t) ? t : 0,
            limit: limit || 50,
          })
          .map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
      };
    },
    get_watch: ({ limit } = {}) => {
      if (!intel?.triage)
        return { ok: false, error: 'intel service is not running' };
      return {
        ok: true,
        mission: intel.getMission?.() || null,
        items: intel.triage({ limit: limit || 10 }),
      };
    },
    set_mission: ({ text = '', areas = [] } = {}) => {
      if (!intel?.setMission)
        return { ok: false, error: 'intel service is not running' };
      return { ok: true, mission: intel.setMission({ text, areas }) };
    },
    cctv_find: async ({ query = '', coverage = false, limit } = {}) => {
      const dir = getConsole().cctvDirectory;
      if (!dir)
        return { ok: false, error: 'camera directory is still loading' };
      if (coverage) return { ok: true, coverage: await dir.coverage() };
      return {
        ok: true,
        cameras: await dir.find({ query, limit: limit || 10 }),
      };
    },
    cctv_connect: async ({ id, nearest = false } = {}) => {
      const dir = getConsole().cctvDirectory;
      if (!dir)
        return { ok: false, error: 'camera directory is still loading' };
      let target = id;
      if (!target && nearest) target = (await dir.find({ limit: 1 }))[0]?.id;
      if (!target)
        return {
          ok: false,
          error: 'give an id from cctv_find or nearest=true',
        };
      return dir.connect(target);
    },
    notams: async ({ icao, lat, lon, radius_nm } = {}) => {
      const q = new URLSearchParams();
      if (icao) q.set('icao', icao);
      else if (Number.isFinite(lat) && Number.isFinite(lon)) {
        q.set('lat', lat);
        q.set('lon', lon);
        q.set('radiusNm', radius_nm || 25);
      } else return { ok: false, error: 'icao, or lat and lon' };
      return loadKeyedOverlay(
        `/api/notams?${q}`,
        `notams-${icao || `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`}`,
        '#FFB454',
        (fc) => ({
          notams: fc.features.slice(0, 25).map((f) => ({
            number: f.properties.number,
            location: f.properties.location,
            start: f.properties.start,
            end: f.properties.end,
            text: String(f.properties.text || '').slice(0, 240),
          })),
        }),
      );
    },
    conflict_events: async ({ country, lat, lon, radius_km, days } = {}) => {
      const q = new URLSearchParams({ days: String(days || 30) });
      if (country) q.set('country', country);
      else if (Number.isFinite(lat) && Number.isFinite(lon)) {
        q.set('lat', lat);
        q.set('lon', lon);
        q.set('radiusKm', radius_km || 100);
      } else return { ok: false, error: 'country, or lat and lon' };
      return loadKeyedOverlay(
        `/api/acled?${q}`,
        `acled-${country || `${(+lat).toFixed(2)},${(+lon).toFixed(2)}`}`,
        '#FF5A5F',
        (fc) => ({
          summary: fc.summary,
          latest: fc.features.slice(0, 12).map((f) => ({
            date: f.properties.date,
            type: f.properties.subType || f.properties.type,
            place: f.properties.place,
            fatalities: f.properties.fatalities,
          })),
          source: 'ACLED',
        }),
      );
    },
    sanctions_check: async ({ query, schema } = {}) => {
      const q = new URLSearchParams({ q: String(query || '') });
      if (schema) q.set('schema', schema);
      const res = await fetch(`/api/sanctions?${q}`, {
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok)
        return { ok: false, error: body.error || `HTTP ${res.status}` };
      return { ok: true, ...body };
    },
    telecom_links: async ({ country } = {}) => {
      const nations = getConsole().shepherd?.nations;
      if (!nations)
        return { ok: false, error: 'nations panel is still loading' };
      return nations.telecom({ country });
    },
    infrastructure_ownership: async ({ country, kind } = {}) => {
      const nations = getConsole().shepherd?.nations;
      if (!nations)
        return { ok: false, error: 'nations panel is still loading' };
      return nations.ownership({ country, kind });
    },
    heat: async ({ action, on, layer } = {}) => {
      const maps = getConsole().mapLayers;
      if (action === 'night_vision') {
        const nv = getConsole().nightVision;
        if (!nv) return { ok: false, error: 'night vision is still loading' };
        const next = on ?? !nv.isEnabled();
        getConsole().settings?.set?.({ night: next ? 'nvg' : 'natural' });
        return { ok: true, nightVision: nv.set(next) };
      }
      if (!maps) return { ok: false, error: 'map layers are still loading' };
      if (action === 'thermal') return maps.thermalFilter(on);
      if (action === 'layer')
        return { ...maps.add(layer || 'activity-heat'), ...maps.list() };
      return maps.heatRanking();
    },
    volcano: async ({ name, lat, lon, vei, show_all } = {}) => {
      const v = getConsole().volcanoes;
      if (!v) return { ok: false, error: 'volcano panel is still loading' };
      if (show_all && !name && !Number.isFinite(lat)) return v.showAll(true);
      const out = await v.project({ name, lat, lon, vei });
      if (show_all) await v.showAll(true);
      return out;
    },
    space: async ({ action, diameter_m, velocity_kms, lat, lon } = {}) => {
      const sp = getConsole().space;
      if (!sp) return { ok: false, error: 'space panel is still loading' };
      if (action === 'open') {
        sp.open();
        return { ok: true };
      }
      if (action === 'planets') return { ok: true, planets: sp.planets() };
      if (action === 'asteroids')
        return { ok: true, ...(await sp.asteroids()) };
      if (action === 'impact') {
        let at = { lat, lon };
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          const c = viewer.camera.positionCartographic;
          at = {
            lat: (c.latitude * 180) / Math.PI,
            lon: (c.longitude * 180) / Math.PI,
          };
        }
        return sp.showImpact({
          ...at,
          diameterM: diameter_m || 50,
          velocityKms: velocity_kms || 20,
        });
      }
      return { ok: false, error: `unknown action ${action}` };
    },
    symbols_scan: async ({ lat, lon, radius_km } = {}) => {
      const sym = getConsole().symbols;
      if (!sym) return { ok: false, error: 'symbols panel is still loading' };
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        const scene = viewer.scene;
        const c = scene.canvas;
        const ray = viewer.camera.getPickRay({
          x: c.clientWidth / 2,
          y: c.clientHeight / 2,
        });
        const hit = ray && scene.globe.pick(ray, scene);
        const carto = hit
          ? scene.globe.ellipsoid.cartesianToCartographic(hit)
          : viewer.camera.positionCartographic;
        lat = (carto.latitude * 180) / Math.PI;
        lon = (carto.longitude * 180) / Math.PI;
      }
      return sym.scan(lat, lon, { radiusKm: radius_km || 5 });
    },
    map_layers: ({ action, id, opacity, url, label, rise_m } = {}) => {
      const maps = getConsole().mapLayers;
      if (!maps) return { ok: false, error: 'map layers are still loading' };
      let result = { ok: true };
      switch (action) {
        case 'list':
          break;
        case 'catalog':
          return { ok: true, catalog: maps.catalog(), presets: maps.presets() };
        case 'add':
          result = maps.add(id);
          break;
        case 'remove':
          result = maps.remove(id);
          break;
        case 'opacity':
          result = maps.setAlpha(id, opacity ?? 1);
          break;
        case 'show':
        case 'hide':
          result = maps.setShow(id, action === 'show');
          break;
        case 'raise':
        case 'lower':
          result = maps.move(id, action === 'raise' ? 1 : -1);
          break;
        case 'import':
          result = maps.importUrl(url, label);
          break;
        case 'sea_level':
          maps.add('sea-level');
          result = maps.setRise(rise_m ?? 0);
          break;
        case 'open':
          maps.open();
          break;
        default:
          return { ok: false, error: `unknown action ${action}` };
      }
      return { ...result, ...maps.list() };
    },
    place_dossier: async ({ lat, lon, radius } = {}) => {
      const dossier = getConsole().placeDossier;
      if (!dossier)
        return { ok: false, error: 'place dossier is still loading' };
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        return { ok: false, error: 'lat and lon required' };
      return dossier.open(lat, lon, { radius: radius || 600 });
    },
    get_exposure: ({ limit } = {}) => {
      const exposure = intel?.exposure?.({ limit: limit || 8 });
      if (!exposure)
        return { ok: false, error: 'intel service is not running' };
      const on = (k) => Boolean(dataManager.isEnabled?.(k));
      return {
        ok: true,
        exposure,
        layersOn: {
          earthquakes: on('earthquakes'),
          fires: on('local-firms'),
          datacentres: on('local-datacenters'),
          dams: on('local-dams'),
        },
      };
    },
    get_patterns: ({ kind, limit } = {}) => {
      const findings = intel?.patterns?.({
        kind: kind || null,
        limit: limit || 12,
      });
      if (!findings)
        return { ok: false, error: 'intel service is not running' };
      return { ok: true, findings };
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
