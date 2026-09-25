/**
 * CAMERAS: the directory of every public camera ADAM can connect to.
 *
 *   coverage   countries → agencies with camera counts; click to fly there
 *   search     by camera name, road, city, agency or country
 *   nearest    the cameras closest to the view, with distance
 *   CONNECT    turns CCTV on, selects the camera, flies to it, opens its live
 *              feed and drapes the frame on the ground (projection)
 *
 * The catalog comes from /api/cctv/sources, so it works before the CCTV layer
 * is on. ADAM connects only to cameras that transport and city agencies
 * publish openly; private cameras are not reachable and are not listed.
 */
import * as Cesium from 'cesium';
import './cctvDirectory.css';
import {
  countryFor,
  countryName,
  formatKm,
  groupDirectory,
  nearestCameras,
  searchCameras,
} from './cctvDirectoryModel.js';

const LABEL_CONNECT = 'CONNECT';
const LABEL_LIVE = 'LIVE';
const LABEL_TITLE = 'CAMERAS';
const RAD = 180 / Math.PI;
const READY_TIMEOUT_MS = 20_000;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function feedBadge(feedType) {
  return /video|hls|mjpeg|mp4/i.test(feedType || '') ? 'VIDEO' : 'STILLS';
}

export function installCctvDirectory({
  viewer,
  dataManager,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
}) {
  const cleanups = [];
  let catalog = null;
  let loading = null;
  let query = '';
  let connectedId = null;
  let note = '';

  const card = el(doc, 'section', 'adam-panel adam-cctv-dir');
  card.id = 'adam-cctv-dir';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Camera directory');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  const cctvModule = () => dataManager?.layers?.get?.('cctv')?.module || null;

  function layerCameras() {
    try {
      return cctvModule()?.getUIState?.()?.cameras || [];
    } catch {
      return [];
    }
  }

  async function loadCatalog() {
    if (catalog) return catalog;
    loading ??= (async () => {
      try {
        const res = await fetchImpl('/api/cctv/sources', {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        catalog = Array.isArray(body?.sources) ? body.sources : [];
      } catch (error) {
        const fromLayer = layerCameras();
        catalog = fromLayer.length ? fromLayer : [];
        note = catalog.length
          ? ''
          : `Camera catalog unavailable (${error.message}). The CCTV feeds are served by this deployment's /api/cctv route.`;
      } finally {
        loading = null;
      }
      return catalog;
    })();
    return loading;
  }

  function viewCenter() {
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const ray = viewer.camera.getPickRay(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    const hit = ray && scene.globe.pick(ray, scene);
    const carto = hit
      ? Cesium.Cartographic.fromCartesian(hit)
      : viewer.camera.positionCartographic;
    return { lat: carto.latitude * RAD, lon: carto.longitude * RAD };
  }

  function flyTo(lat, lon, height) {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.8,
    });
  }

  async function waitForCamera(id) {
    const started = Date.now();
    while (Date.now() - started < READY_TIMEOUT_MS) {
      if (layerCameras().some((c) => c.id === id)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /** Turn CCTV on, select the camera, open its feed and project it. */
  async function connect(cameraOrId) {
    const cams = await loadCatalog();
    const camera =
      typeof cameraOrId === 'object'
        ? cameraOrId
        : cams.find((c) => c.id === cameraOrId);
    if (!camera) return { ok: false, error: 'camera not in the catalog' };
    note = `Connecting to ${camera.name}…`;
    render();
    try {
      if (!dataManager?.isEnabled?.('cctv'))
        await dataManager?.setEnabled?.('cctv', true, { origin: 'user' });
    } catch (error) {
      note = `Could not turn CCTV on: ${error.message}`;
      render();
      return { ok: false, error: note };
    }
    flyTo(camera.lat, camera.lon, 900);
    const ready = await waitForCamera(camera.id);
    const mod = cctvModule();
    if (!ready || !mod?.selectCamera?.(camera.id, { focus: true })) {
      note = `${camera.name} did not load into the CCTV layer — the feed service may be down; check HEALTH.`;
      render();
      return { ok: false, error: note };
    }
    mod.setParams?.({ showProjection: true });
    const panel = doc.getElementById('cctv-panel');
    if (panel) {
      panel.classList.remove('collapsed', 'adam-rail-idle');
      panel
        .querySelector('.panel-collapse-btn')
        ?.setAttribute('aria-expanded', 'true');
    }
    connectedId = camera.id;
    note = `${LABEL_LIVE}: ${camera.name} · ${camera.provider || ''} · projection on`;
    render();
    return {
      ok: true,
      camera: {
        id: camera.id,
        name: camera.name,
        provider: camera.provider,
        country: countryName(countryFor(camera)),
        lat: camera.lat,
        lon: camera.lon,
        feed: feedBadge(camera.feedType),
      },
    };
  }

  function cameraRow(camera, km) {
    const row = el(doc, 'li', 'adam-cctv-row');
    if (camera.id === connectedId) row.classList.add('is-live');
    const text = el(doc, 'div', 'adam-cctv-row-text');
    text.append(
      el(doc, 'span', 'adam-cctv-name', camera.name || camera.id),
      el(
        doc,
        'span',
        'adam-meta adam-cctv-sub',
        [
          camera.provider,
          countryName(countryFor(camera)),
          feedBadge(camera.feedType),
          km != null ? formatKm(km) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    const btn = el(
      doc,
      'button',
      'adam-cctv-connect',
      camera.id === connectedId ? LABEL_LIVE : LABEL_CONNECT,
    );
    btn.type = 'button';
    btn.addEventListener('click', () => void connect(camera));
    row.append(text, btn);
    return row;
  }

  function render() {
    if (card.hidden) return;
    const cams = catalog || [];
    const header = el(doc, 'header', 'adam-ops-header');
    header.append(
      el(doc, 'span', 'adam-meta adam-ops-kicker', 'ADAM · #HOUSEOFASHER'),
      el(doc, 'h2', 'adam-ops-title', LABEL_TITLE),
    );
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(close);
    const dir = groupDirectory(cams);
    header.append(
      el(
        doc,
        'p',
        'adam-meta adam-ops-sub',
        cams.length
          ? `${cams.length.toLocaleString('en-US')} public cameras · ${dir.reduce((s, c) => s + c.agencies.length, 0)} agencies · ${dir.length} countries`
          : loading
            ? 'Loading the camera catalog…'
            : 'No cameras loaded',
      ),
    );

    const body = el(doc, 'div', 'adam-ops-body adam-cctv-body');
    const search = el(doc, 'input', 'adam-input adam-cctv-search');
    search.type = 'search';
    search.placeholder = 'SEARCH ROAD, CITY, AGENCY OR COUNTRY';
    search.value = query;
    search.setAttribute('aria-label', 'Search cameras');
    search.addEventListener('input', () => {
      query = search.value;
      renderLists();
      search.focus();
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    body.append(search);
    if (note) body.append(el(doc, 'p', 'adam-meta adam-ops-note', note));
    const lists = el(doc, 'div', 'adam-cctv-lists');
    body.append(lists);

    function renderLists() {
      lists.replaceChildren();
      if (query.trim()) {
        const hits = searchCameras(cams, query, 40);
        lists.append(
          el(
            doc,
            'h3',
            'adam-meta adam-ops-section',
            `MATCHES · ${hits.length}${hits.length === 40 ? '+' : ''}`,
          ),
        );
        const ul = el(doc, 'ul', 'adam-cctv-list');
        for (const c of hits) ul.append(cameraRow(c));
        if (!hits.length)
          ul.append(
            el(doc, 'li', 'adam-meta adam-ops-note', 'No camera matches.'),
          );
        lists.append(ul);
        return;
      }
      const center = viewCenter();
      const near = nearestCameras(cams, center.lat, center.lon, 8);
      lists.append(
        el(doc, 'h3', 'adam-meta adam-ops-section', 'NEAREST TO VIEW'),
      );
      const nearUl = el(doc, 'ul', 'adam-cctv-list');
      for (const n of near) nearUl.append(cameraRow(n.camera, n.km));
      lists.append(nearUl);
      lists.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'COVERAGE'));
      for (const country of dir) {
        const block = el(doc, 'div', 'adam-cctv-country');
        block.append(
          el(
            doc,
            'div',
            'adam-cctv-country-name',
            `${country.name.toUpperCase()} · ${country.count.toLocaleString('en-US')}`,
          ),
        );
        for (const a of country.agencies) {
          const b = el(doc, 'button', 'adam-cctv-agency');
          b.type = 'button';
          b.title = `Fly to ${a.provider} coverage`;
          b.append(
            el(doc, 'span', '', a.provider),
            el(
              doc,
              'span',
              'adam-meta',
              `${a.count.toLocaleString('en-US')}${a.video ? ` · ${a.video} video` : ''}`,
            ),
          );
          b.addEventListener('click', () => {
            flyTo(a.anchor.lat, a.anchor.lon, 9_000);
            if (!dataManager?.isEnabled?.('cctv'))
              void dataManager?.setEnabled?.('cctv', true, { origin: 'user' });
          });
          block.append(b);
        }
        lists.append(block);
      }
      lists.append(
        el(
          doc,
          'p',
          'adam-meta adam-ops-note',
          'Public traffic and city cameras published by the agencies above. Private cameras are not reachable and are not listed. PROJECTION drapes the live frame onto the ground from the camera pose; ADJUST in the CCTV panel refines the pose.',
        ),
      );
    }
    renderLists();
    card.replaceChildren(header, body);
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        doc.querySelector('#adam-ops-flyout .adam-ops-close')?.click();
      render();
      if (!catalog) void loadCatalog().then(render);
    }
  }

  // Rail chip, docked before KEYS.
  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Camera directory: find, connect and project public CCTV';
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

  // Keep NEAREST in step with the view.
  cleanups.push(
    viewer.camera.moveEnd.addEventListener(() => {
      if (!card.hidden && !query.trim()) render();
    }),
  );

  // One centre card at a time: another rail chip closes this one.
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

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    connect,
    /** Catalog search for Shepherd: query, or nearest to the view. */
    async find({ query: q = '', limit = 10, near = null } = {}) {
      const cams = await loadCatalog();
      if (q.trim())
        return searchCameras(cams, q, limit).map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          country: countryName(countryFor(c)),
          feed: feedBadge(c.feedType),
        }));
      const center = near && Number.isFinite(near.lat) ? near : viewCenter();
      return nearestCameras(cams, center.lat, center.lon, limit).map((n) => ({
        id: n.camera.id,
        name: n.camera.name,
        provider: n.camera.provider,
        country: countryName(countryFor(n.camera)),
        feed: feedBadge(n.camera.feedType),
        distance: formatKm(n.km),
      }));
    },
    async coverage() {
      const cams = await loadCatalog();
      return groupDirectory(cams).map((c) => ({
        country: c.name,
        cameras: c.count,
        agencies: c.agencies.map((a) => ({
          agency: a.provider,
          cameras: a.count,
          video: a.video,
        })),
      }));
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
