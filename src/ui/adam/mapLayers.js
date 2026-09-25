/**
 * MAPS: stack other map sources over the base map. Each layer keeps its own
 * opacity, visibility and place in the stack, so a topo map can sit at 40%
 * over satellite, sea marks over that, and the future coast on top.
 *
 *   future coast   world sea level rise (computed from global elevation) and
 *                  NOAA's US projection, driven by one rise control with the
 *                  IPCC AR6 presets
 *   add            any catalog source, or IMPORT a pasted XYZ / ArcGIS / WMS URL
 *
 * The stack is remembered per browser. Layers drape on the globe, or on the
 * 3D tileset when a photoreal stack hides the globe.
 */
import * as Cesium from 'cesium';
import './mapLayers.css';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import {
  MAX_RISE_M,
  OVERLAY_GROUPS,
  OVERLAY_SOURCES,
  SEA_LEVEL_PRESETS,
  TERRARIUM_URL,
  clampRise,
  floodPixels,
  gibsDate,
  heatPixels,
  noaaSlrUrl,
  parseCustomSource,
  restoreStack,
  riseToFeet,
  serializeStack,
  sourceById,
} from '../../maps/overlayCatalog.js';

const STORE_KEY = 'adam.maplayers.v1';
const LABEL_TITLE = 'MAPS';
const LABEL_UP = '↑';
const LABEL_DOWN = '↓';
const LABEL_REMOVE = '×';
const LABEL_ADD = 'add';
const LABEL_ON = 'on';
const LABEL_THERMAL = 'thermal camera filter';
const LABEL_HEAT_RANK = 'where the heat is';
const LABEL_RETRY = 'unreachable · retry';
const LABEL_LOADING = 'loading';
const LABEL_PARTIAL = 'some tiles failed';
const LABEL_IMPORT = 'import';
const RISE_DEBOUNCE_MS = 350;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatRise(m) {
  if (m === 0) return 'today’s sea level';
  return m < 10
    ? `+${m.toFixed(2).replace(/\.?0+$/, '')} m`
    : `+${Math.round(m)} m`;
}

/** Wrap a tile provider so each tile is recoloured by `recolour(data)`. */
function recolourProvider(provider, doc, recolour) {
  const base = provider.requestImage.bind(provider);
  provider.requestImage = (x, y, level, request) => {
    const pending = base(x, y, level, request);
    if (!pending) return pending; // throttled: Cesium retries
    return Promise.resolve(pending).then((img) => {
      const w = img.width || 256;
      const h = img.height || 256;
      const canvas = doc.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, w, h);
      recolour(data.data);
      ctx.putImageData(data, 0, 0);
      return canvas;
    });
  };
  return provider;
}

/** Terrarium elevation tiles recoloured into a flood layer for `rise` m. */
function createSeaLevelProvider(rise, doc) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: TERRARIUM_URL,
    maximumLevel: 12,
    credit: new Cesium.Credit(
      'Sea level rise from Terrain Tiles elevation (AWS Open Data); bathtub model',
    ),
  });
  return recolourProvider(provider, doc, (data) => floodPixels(data, rise));
}

async function createProvider(source, { rise, doc }) {
  const credit = new Cesium.Credit(source.credit || source.label);
  switch (source.kind) {
    case 'arcgis':
      return Cesium.ArcGisMapServerImageryProvider.fromUrl(source.url, {
        enablePickFeatures: false,
        credit,
      });
    case 'xyz':
      return new Cesium.UrlTemplateImageryProvider({
        url: source.url,
        subdomains: source.subdomains || undefined,
        maximumLevel: source.maxLevel ?? 19,
        credit,
      });
    case 'gibs':
      return new Cesium.UrlTemplateImageryProvider({
        url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${source.layer}/default/${source.date || gibsDate()}/GoogleMapsCompatible_${source.matrix}/{z}/{y}/{x}.${source.ext}`,
        maximumLevel: source.maxLevel ?? 8,
        credit,
      });
    case 'wms':
      return new Cesium.WebMapServiceImageryProvider({
        url: source.url,
        layers: source.layers,
        parameters: { transparent: true, format: 'image/png' },
        enablePickFeatures: false,
        credit,
      });
    case 'sealevel':
      return createSeaLevelProvider(rise, doc);
    case 'heatlights':
      return recolourProvider(
        new Cesium.UrlTemplateImageryProvider({
          url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
          maximumLevel: 8,
          credit,
        }),
        doc,
        heatPixels,
      );
    case 'noaa-slr':
      return Cesium.ArcGisMapServerImageryProvider.fromUrl(noaaSlrUrl(rise), {
        enablePickFeatures: false,
        credit,
      });
    default:
      throw new Error(`unknown source kind ${source.kind}`);
  }
}

export function installMapLayers({
  viewer,
  mapStackController = null,
  doc = document,
  storage = globalThis.localStorage,
  getConsole = () => globalThis.__godsEyeView || {},
}) {
  const cleanups = [];
  let heat = null;
  let heatNote = '';
  /** Bottom → top. */
  let entries = [];
  let rise = 0;
  let riseTimer = null;
  let importNote = '';
  let destroyed = false;

  const host = () =>
    resolveImageryHost({
      viewer,
      tileset: mapStackController?.getImageryHostTileset?.(),
    }).collection;

  function save() {
    try {
      storage?.setItem(
        STORE_KEY,
        JSON.stringify(serializeStack(entries, rise)),
      );
    } catch {
      /* private mode: the stack just is not remembered */
    }
  }

  function detach(entry) {
    if (entry.layer && entry.host && !entry.host.isDestroyed?.()) {
      entry.host.remove(entry.layer, true);
    } else if (entry.layer && !entry.layer.isDestroyed?.()) {
      entry.layer.destroy?.();
    }
    entry.layer = null;
    entry.host = null;
  }

  function order() {
    for (const e of entries) {
      if (e.layer && e.host?.contains?.(e.layer)) e.host.raiseToTop(e.layer);
    }
    viewer.scene.requestRender?.();
  }

  async function attach(entry) {
    const gen = (entry.gen = (entry.gen || 0) + 1);
    entry.error = null;
    entry.loading = true;
    try {
      const provider = await createProvider(entry.source, { rise, doc });
      if (destroyed || gen !== entry.gen || !entries.includes(entry)) return;
      const collection = host();
      if (!collection) throw new Error('this map source cannot host overlays');
      detach(entry);
      entry.layer = new Cesium.ImageryLayer(provider, {
        alpha: entry.alpha,
        show: entry.show,
      });
      collection.add(entry.layer);
      entry.host = collection;
      provider.errorEvent?.addEventListener?.(() => {
        entry.error = 'some tiles failed';
      });
      order();
    } catch (error) {
      if (gen === entry.gen) entry.error = error.message || String(error);
    } finally {
      if (gen === entry.gen) entry.loading = false;
      render();
    }
  }

  function add(sourceOrId, { alpha, show = true } = {}) {
    const source =
      typeof sourceOrId === 'string' ? sourceById(sourceOrId) : sourceOrId;
    if (!source) return { ok: false, error: 'unknown source' };
    let entry = entries.find((e) => e.source.id === source.id);
    if (entry) return { ok: true, id: source.id, already: true };
    if (entries.length >= 12)
      return { ok: false, error: 'twelve layers at most; remove one first' };
    entry = {
      source,
      alpha: Number.isFinite(alpha) ? alpha : (source.alpha ?? 1),
      show,
      layer: null,
      host: null,
    };
    entries.push(entry);
    void attach(entry);
    save();
    render();
    return { ok: true, id: source.id };
  }

  function remove(id) {
    const entry = entries.find((e) => e.source.id === id);
    if (!entry) return { ok: false, error: 'not in the stack' };
    entry.gen = (entry.gen || 0) + 1;
    detach(entry);
    entries = entries.filter((e) => e !== entry);
    save();
    render();
    viewer.scene.requestRender?.();
    return { ok: true };
  }

  function setAlpha(id, alpha) {
    const entry = entries.find((e) => e.source.id === id);
    if (!entry) return { ok: false, error: 'not in the stack' };
    entry.alpha = Math.max(0, Math.min(1, Number(alpha)));
    if (entry.layer) entry.layer.alpha = entry.alpha;
    viewer.scene.requestRender?.();
    save();
    return { ok: true, alpha: entry.alpha };
  }

  function setShow(id, show) {
    const entry = entries.find((e) => e.source.id === id);
    if (!entry) return { ok: false, error: 'not in the stack' };
    entry.show = Boolean(show);
    if (entry.layer) entry.layer.show = entry.show;
    viewer.scene.requestRender?.();
    save();
    render();
    return { ok: true };
  }

  /** delta +1 raises one place, -1 lowers. */
  function move(id, delta) {
    const i = entries.findIndex((e) => e.source.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= entries.length) return { ok: false };
    [entries[i], entries[j]] = [entries[j], entries[i]];
    order();
    save();
    render();
    return { ok: true };
  }

  function setRise(m, { immediate = false } = {}) {
    const next = clampRise(m);
    const feetChanged = riseToFeet(next) !== riseToFeet(rise);
    const changed = next !== rise;
    rise = next;
    save();
    if (!changed) return { ok: true, rise };
    clearTimeout(riseTimer);
    const rebuild = () => {
      for (const e of entries) {
        if (e.source.kind === 'sealevel') void attach(e);
        if (e.source.kind === 'noaa-slr' && feetChanged) void attach(e);
      }
    };
    if (immediate) rebuild();
    else riseTimer = setTimeout(rebuild, RISE_DEBOUNCE_MS);
    return { ok: true, rise };
  }

  function importUrl(text, label) {
    const parsed = parseCustomSource(text, label);
    if (parsed.error) return { ok: false, error: parsed.error };
    return add(parsed.source);
  }

  // Keep the stack on whichever surface the active map stack drapes on.
  const rehome = () => {
    const collection = host();
    for (const e of entries) {
      if (!e.layer || e.host === collection) continue;
      if (e.host && !e.host.isDestroyed?.()) e.host.remove(e.layer, false);
      e.host = null;
      if (collection) {
        collection.add(e.layer);
        e.host = collection;
      }
    }
    order();
  };
  const unsubscribe = mapStackController?.subscribe?.(rehome);
  if (unsubscribe) cleanups.push(unsubscribe);

  // ── Panel ────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-maps');
  card.id = 'adam-maps';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Map layers');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function stackRow(entry, index) {
    const li = el(doc, 'li', 'adam-maps-row');
    const top = el(doc, 'div', 'adam-maps-row-top');
    const vis = el(doc, 'input', 'adam-maps-vis');
    vis.type = 'checkbox';
    vis.checked = entry.show;
    vis.setAttribute('aria-label', `Show ${entry.source.label}`);
    vis.addEventListener('change', () => setShow(entry.source.id, vis.checked));
    const name = el(doc, 'span', 'adam-maps-name', entry.source.label);
    let status;
    if (entry.error && !entry.layer) {
      // Nothing drew: offer a retry, with the reason on hover.
      status = el(doc, 'button', 'adam-maps-status is-error', LABEL_RETRY);
      status.type = 'button';
      status.title = entry.error;
      status.addEventListener('click', () => void attach(entry));
    } else {
      status = el(
        doc,
        'span',
        `adam-maps-status${entry.error ? ' is-error' : ''}`,
        entry.loading ? LABEL_LOADING : entry.error ? LABEL_PARTIAL : '',
      );
      if (entry.error) status.title = entry.error;
    }
    const up = el(doc, 'button', 'adam-maps-btn', LABEL_UP);
    up.type = 'button';
    up.title = 'Raise';
    up.disabled = index === entries.length - 1;
    up.addEventListener('click', () => move(entry.source.id, 1));
    const down = el(doc, 'button', 'adam-maps-btn', LABEL_DOWN);
    down.type = 'button';
    down.title = 'Lower';
    down.disabled = index === 0;
    down.addEventListener('click', () => move(entry.source.id, -1));
    const x = el(doc, 'button', 'adam-maps-btn', LABEL_REMOVE);
    x.type = 'button';
    x.title = 'Remove';
    x.addEventListener('click', () => remove(entry.source.id));
    top.append(vis, name, status, up, down, x);
    const slider = el(doc, 'input', 'adam-maps-alpha');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round(entry.alpha * 100));
    slider.setAttribute('aria-label', `${entry.source.label} opacity`);
    const pct = el(doc, 'span', 'adam-maps-pct', `${slider.value}%`);
    slider.addEventListener('input', () => {
      setAlpha(entry.source.id, Number(slider.value) / 100);
      pct.textContent = `${slider.value}%`;
    });
    const bottom = el(doc, 'div', 'adam-maps-row-bottom');
    bottom.append(slider, pct);
    li.append(top, bottom);
    if (entry.source.credit)
      li.append(el(doc, 'div', 'adam-maps-credit', entry.source.credit));
    return li;
  }

  function riseBlock() {
    const block = el(doc, 'div', 'adam-maps-rise');
    const value = el(doc, 'div', 'adam-maps-rise-value', formatRise(rise));
    const slider = el(doc, 'input', 'adam-maps-rise-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1000';
    // Square-root scale: centimetres near today, metres at the far end.
    slider.value = String(Math.round(Math.sqrt(rise / MAX_RISE_M) * 1000));
    slider.setAttribute('aria-label', 'Sea level rise');
    slider.addEventListener('input', () => {
      const m = (Number(slider.value) / 1000) ** 2 * MAX_RISE_M;
      const rounded =
        m < 2
          ? Math.round(m * 20) / 20
          : m < 10
            ? Math.round(m * 2) / 2
            : Math.round(m);
      setRise(rounded);
      value.textContent = formatRise(rise);
      presets
        .querySelectorAll('button')
        .forEach((b) =>
          b.classList.toggle('is-on', Number(b.dataset.rise) === rise),
        );
    });
    const presets = el(doc, 'div', 'adam-maps-presets');
    for (const p of SEA_LEVEL_PRESETS) {
      const b = el(doc, 'button', 'adam-chip adam-maps-preset', p.label);
      b.type = 'button';
      b.dataset.rise = String(p.rise);
      b.title = `${formatRise(p.rise)}${p.note ? ` · ${p.note}` : ''}`;
      b.classList.toggle('is-on', p.rise === rise);
      b.addEventListener('click', () => {
        if (!entries.some((e) => e.source.kind === 'sealevel'))
          add('sea-level');
        setRise(p.rise, { immediate: true });
        render();
      });
      presets.append(b);
    }
    block.append(value, slider, presets);
    block.append(
      el(
        doc,
        'p',
        'adam-maps-note',
        'Global mean rise above 1995–2014 (IPCC AR6). Local rise differs with subsidence, ocean currents and tides.',
      ),
    );
    return block;
  }

  // ── Heat ─────────────────────────────────────────────────────────────
  async function runTool(name, args) {
    const exec = getConsole().shepherd?.executor;
    if (!exec) return { ok: false, error: 'still loading' };
    return JSON.parse(await exec.run(name, args));
  }

  function currentStyle() {
    return (
      getConsole().styleManager?.activeStyle ||
      (thermalOn ? 'thermal' : 'normal')
    );
  }

  async function thermalFilter(on) {
    const want = on ?? currentStyle() !== 'thermal';
    const r = await runTool('set_visual_style', {
      style: want ? 'thermal' : 'normal',
    });
    thermalOn = r.ok !== false ? want : thermalOn;
    render();
    return { ok: r.ok !== false, thermal: thermalOn };
  }
  let thermalOn = false;

  /** Where the heat is: FIRMS detections summed by country and by 1° cell. */
  async function heatRanking({ draw = true } = {}) {
    const intel = getConsole().intel;
    const dm = getConsole().dataManager;
    if (!dm?.isEnabled?.('local-firms')) {
      await runTool('set_layers', {
        layers: [{ id: 'local-firms', enabled: true }],
      });
      heatNote = 'satellite fires switched on — loading detections…';
      render();
      for (
        let i = 0;
        i < 20 && !(intel?.getRecords?.('local-firms') || []).length;
        i += 1
      )
        await new Promise((r) => setTimeout(r, 750));
    }
    const fires = intel?.getRecords?.('local-firms') || [];
    if (!fires.length) {
      heatNote =
        'no satellite heat detections loaded (FIRMS needs FIRMS_MAP_KEY on the server)';
      render();
      return { ok: false, error: heatNote };
    }
    const [{ loadCountryIndex }, { heatByCountry, hotCells }] =
      await Promise.all([
        import('../../intel/countryLookup.js'),
        import('../../intel/heat.js'),
      ]);
    const { lookup } = await loadCountryIndex();
    const byCountry = heatByCountry(fires, lookup, { limit: 15 });
    const cells = hotCells(fires, lookup, { limit: 10 });
    heat = { byCountry, cells, at: new Date().toISOString() };
    heatNote = '';
    if (draw)
      getConsole().shepherd?.overlay?.drawOverlay?.({
        title: 'hottest places · satellite heat',
        nodes: cells.map((c, i) => ({
          id: `heat-${i}`,
          label: `${c.country} · ${c.frpMw.toLocaleString('en-US')} MW`,
          lat: c.lat,
          lon: c.lon,
          kind: 'heat',
        })),
        fly: true,
      });
    render();
    return {
      ok: true,
      detections: byCountry.detections,
      totalMw: byCountry.totalMw,
      countries: byCountry.countries,
      hottestPlaces: cells,
      note: 'FIRMS fire radiative power over the last 24 h: fires, gas flares, volcanoes and industrial heat alike.',
    };
  }

  function heatBlock() {
    const block = el(doc, 'div', 'adam-maps-heat');
    const row = el(doc, 'div', 'adam-maps-presets');
    const filter = el(doc, 'button', 'adam-chip', LABEL_THERMAL);
    filter.type = 'button';
    filter.classList.toggle('is-on', thermalOn);
    filter.title =
      'Thermal camera look for the whole view (white-hot / ironbow)';
    filter.addEventListener('click', () => void thermalFilter());
    const rank = el(doc, 'button', 'adam-chip', LABEL_HEAT_RANK);
    rank.type = 'button';
    rank.title = 'Satellite heat detections summed by country and place';
    rank.addEventListener('click', () => void heatRanking());
    row.append(filter, rank);
    block.append(row);
    if (heatNote) block.append(el(doc, 'p', 'adam-maps-note', heatNote));
    if (heat) {
      const list = el(doc, 'ol', 'adam-maps-heat-list');
      for (const c of heat.byCountry.countries.slice(0, 10))
        list.append(
          el(
            doc,
            'li',
            '',
            `${c.country} — ${c.frpMw.toLocaleString('en-US')} MW · ${c.share}% · ${c.detections} detections`,
          ),
        );
      block.append(list);
      block.append(
        el(
          doc,
          'p',
          'adam-maps-note',
          `${heat.byCountry.detections.toLocaleString('en-US')} detections, ${heat.byCountry.totalMw.toLocaleString('en-US')} MW in the last 24 h (NASA FIRMS). Fires, gas flares, volcanoes and industry all count; the ten hottest places are marked on the globe.`,
        ),
      );
    }
    return block;
  }

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    header.append(el(doc, 'h2', 'adam-ops-title', LABEL_TITLE));
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(close);
    header.append(
      el(
        doc,
        'p',
        'adam-meta adam-ops-sub',
        entries.length
          ? `${entries.length} layer${entries.length === 1 ? '' : 's'} over the base map · top of the list draws on top`
          : 'Stack other maps over the base map, each with its own opacity.',
      ),
    );
    const body = el(doc, 'div', 'adam-ops-body adam-maps-body');

    if (entries.length) {
      body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'stack'));
      const ul = el(doc, 'ul', 'adam-maps-list');
      [...entries]
        .map((e, i) => [e, i])
        .reverse()
        .forEach(([e, i]) => ul.append(stackRow(e, i)));
      body.append(ul);
    }

    body.append(
      el(doc, 'h3', 'adam-meta adam-ops-section', 'future coast · sea level'),
      riseBlock(),
    );

    for (const group of OVERLAY_GROUPS) {
      const sources = OVERLAY_SOURCES.filter((s) => s.group === group.id);
      // The future-coast sources sit straight under the rise control.
      if (group.id !== 'future')
        body.append(el(doc, 'h3', 'adam-meta adam-ops-section', group.label));
      if (group.id === 'heat') body.append(heatBlock());
      const list = el(doc, 'div', 'adam-maps-catalog');
      for (const s of sources) {
        const on = entries.some((e) => e.source.id === s.id);
        const b = el(doc, 'button', 'adam-maps-source');
        b.type = 'button';
        b.classList.toggle('is-on', on);
        b.title = s.note || s.credit || '';
        b.append(
          el(doc, 'span', '', s.label),
          el(doc, 'span', 'adam-maps-source-act', on ? LABEL_ON : LABEL_ADD),
        );
        b.addEventListener('click', () => (on ? remove(s.id) : add(s.id)));
        list.append(b);
      }
      body.append(list);
    }

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'import a map'));
    const form = el(doc, 'form', 'adam-maps-import');
    const url = el(doc, 'input', 'adam-input');
    url.type = 'url';
    url.placeholder = 'https://…/{z}/{x}/{y}.png · MapServer · WMS';
    url.setAttribute('aria-label', 'Tile URL');
    const name = el(doc, 'input', 'adam-input');
    name.type = 'text';
    name.placeholder = 'name (optional)';
    name.setAttribute('aria-label', 'Layer name');
    for (const input of [url, name])
      input.addEventListener('keydown', (e) => e.stopPropagation());
    const go = el(doc, 'button', 'adam-chip', LABEL_IMPORT);
    go.type = 'submit';
    form.append(url, name, go);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const result = importUrl(url.value, name.value);
      importNote = result.ok ? '' : result.error;
      render();
    });
    body.append(form);
    if (importNote)
      body.append(el(doc, 'p', 'adam-maps-note is-error', importNote));
    body.append(
      el(
        doc,
        'p',
        'adam-maps-note',
        'XYZ templates ({z}/{x}/{y}, {-y}, {s}), WMTS REST templates, ArcGIS MapServer URLs and WMS URLs with layers=. HTTPS only; the stack is remembered in this browser.',
      ),
    );

    const scroll = card.querySelector('.adam-maps-body')?.scrollTop || 0;
    card.replaceChildren(header, body);
    body.scrollTop = scroll;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        doc.querySelector('#adam-ops-flyout .adam-ops-close')?.click();
      render();
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Map layers: stack other maps, sea level rise, import a map';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(card.hidden));
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

  const onRailClick = (event) => {
    const target = event.target.closest?.('.adam-ops-rail-btn');
    if (target && target !== chip && !card.hidden) setOpen(false);
  };
  doc.addEventListener('click', onRailClick, true);
  cleanups.push(() => doc.removeEventListener('click', onRailClick, true));
  const onKey = (event) => {
    if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  // Restore the remembered stack.
  try {
    const saved = restoreStack(
      JSON.parse(storage?.getItem(STORE_KEY) || 'null'),
    );
    rise = saved.rise;
    for (const l of saved.layers)
      add(l.source, { alpha: l.alpha, show: l.show });
  } catch {
    /* nothing remembered */
  }

  function list() {
    return {
      rise,
      stack: [...entries].reverse().map((e) => ({
        id: e.source.id,
        label: e.source.label,
        opacity: e.alpha,
        show: e.show,
        loading: Boolean(e.loading),
        error: e.error || null,
        credit: e.source.credit,
      })),
    };
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    add: (id, opts) => add(id, opts),
    remove,
    setAlpha,
    setShow,
    move,
    setRise: (m) => setRise(m, { immediate: true }),
    importUrl,
    list,
    catalog: () =>
      OVERLAY_SOURCES.map((s) => ({
        id: s.id,
        label: s.label,
        group: s.group,
      })),
    presets: () => SEA_LEVEL_PRESETS.map((p) => ({ ...p })),
    heatRanking,
    thermalFilter,
    destroy() {
      destroyed = true;
      clearTimeout(riseTimer);
      for (const e of entries) detach(e);
      entries = [];
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
