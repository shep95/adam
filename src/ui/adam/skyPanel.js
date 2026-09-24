/**
 * SKY: the live environment at the point the camera is looking at — local
 * time, day phase, sun and moon (position, rise/set, phase), the brightest
 * stars above the horizon, which way shadows fall, and current weather.
 * Time controls move the lighting: live, scrub ±24 h, jump to sunrise /
 * noon / sunset / midnight, or play at 60× to 3600×.
 *
 * Opens from the ops rail (L). All dynamic text goes through textContent.
 */
import './skyPanel.css';
import { skyReading, compassPoint } from '../../environment/astronomy.js';
import { PLAY_SPEEDS } from '../../environment/liveEnvironment.js';
import {
  loadTzLookup,
  zoneFor,
  formatZoneTime,
} from '../../shepherd/localTime.js';
import { weatherCodeLabel } from '../../data/regionalModel.js';

const RAD = 180 / Math.PI;
const HOUR = 3_600_000;
const SIMULATED = ' · simulated';
const NOW_LABEL = 'now';

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function btn(doc, label, onClick, className = 'sky-btn') {
  const b = el(doc, 'button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export function viewCenter(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const ray = viewer.camera.getPickRay({
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2,
  });
  const hit = ray && scene.globe.pick(ray, scene);
  const carto = hit
    ? scene.globe.ellipsoid.cartesianToCartographic(hit)
    : viewer.camera.positionCartographic;
  return { lat: carto.latitude * RAD, lon: carto.longitude * RAD };
}

const fmtDeg = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}°`;

export function installSkyPanel({
  viewer,
  environment,
  dataManager,
  doc = document,
  fetchImpl = (...a) => fetch(...a),
}) {
  const cleanups = [];
  const card = el(doc, 'section', 'adam-panel sky-card');
  card.id = 'adam-sky';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Live environment');

  const head = el(doc, 'header', 'sky-head');
  const place = el(doc, 'div', 'sky-place', '—');
  const clockLine = el(doc, 'div', 'sky-clock', '');
  const phaseLine = el(doc, 'div', 'sky-phase', '');
  const close = btn(doc, '×', () => setOpen(false), 'sky-close');
  close.setAttribute('aria-label', 'Close');
  head.append(
    el(doc, 'div', 'sky-kicker', 'LIVE ENVIRONMENT'),
    place,
    clockLine,
    phaseLine,
    close,
  );

  const grid = el(doc, 'div', 'sky-grid');
  const sunBox = el(doc, 'div', 'sky-cell');
  const moonBox = el(doc, 'div', 'sky-cell');
  const shadowBox = el(doc, 'div', 'sky-cell');
  const wxBox = el(doc, 'div', 'sky-cell');
  grid.append(sunBox, moonBox, shadowBox, wxBox);
  const starsLine = el(doc, 'div', 'sky-stars', '');

  // Time controls.
  const time = el(doc, 'div', 'sky-time');
  const liveBtn = btn(
    doc,
    'LIVE',
    () => environment.live(),
    'sky-btn sky-live',
  );
  const slider = el(doc, 'input', 'sky-slider');
  slider.type = 'range';
  slider.min = '-24';
  slider.max = '24';
  slider.step = '0.25';
  slider.value = '0';
  slider.setAttribute('aria-label', 'Hours from now');
  const offsetLabel = el(doc, 'span', 'sky-offset', 'now');
  slider.addEventListener('input', () =>
    environment.setOffset(Number(slider.value) * HOUR),
  );
  const jumps = el(doc, 'div', 'sky-row');
  const jump = (label, pick) =>
    btn(doc, label, () => {
      const target = pick();
      if (target) environment.setDate(target);
    });
  let reading = null;
  let center = viewCenter(viewer);
  const nextAfter = (d) =>
    d && d.valueOf() < Date.now() - HOUR
      ? new Date(d.valueOf() + 24 * HOUR)
      : d;
  jumps.append(
    jump('SUNRISE', () => nextAfter(reading?.sunTimes.rise)),
    jump('NOON', () => nextAfter(reading?.solarNoon)),
    jump('SUNSET', () => nextAfter(reading?.sunTimes.set)),
    jump(
      'MIDNIGHT',
      () =>
        reading?.solarNoon &&
        nextAfter(new Date(reading.solarNoon.valueOf() + 12 * HOUR)),
    ),
  );
  const speeds = el(doc, 'div', 'sky-row');
  const playBtn = btn(doc, '▶', () => {
    const s = environment.snapshot();
    if (s.playing) environment.pause();
    else environment.play(currentSpeed);
  });
  playBtn.setAttribute('aria-label', 'Play or pause time');
  let currentSpeed = 600;
  const speedBtns = PLAY_SPEEDS.filter((s) => s > 1).map((s) => {
    const b = btn(doc, `${s}×`, () => {
      currentSpeed = s;
      environment.play(s);
    });
    b.dataset.speed = String(s);
    return b;
  });
  speeds.append(playBtn, ...speedBtns);
  const sliderRow = el(doc, 'div', 'sky-row');
  sliderRow.append(liveBtn, slider, offsetLabel);
  time.append(sliderRow, jumps, speeds);

  // Toggles.
  const toggles = el(doc, 'div', 'sky-row sky-toggles');
  const toggle = (label, get, set) => {
    const b = btn(doc, label, () => set(!get()));
    b.dataset.toggle = label;
    return b;
  };
  const tLight = toggle(
    'SUNLIGHT',
    () => environment.snapshot().lighting,
    (v) => environment.setLighting(v),
  );
  const tShadow = toggle(
    'SHADOWS',
    () => environment.snapshot().shadows,
    (v) => environment.setShadows(v),
  );
  const tSky = toggle(
    'SUN · MOON · STARS',
    () => environment.snapshot().sky,
    (v) => environment.setSky(v),
  );
  const tRadar = toggle(
    'RADAR',
    () => dataManager?.isEnabled?.('weather-radar'),
    (v) =>
      void dataManager
        ?.setEnabled?.('weather-radar', v, { origin: 'sky' })
        ?.then?.(renderToggles),
  );
  toggles.append(tLight, tShadow, tSky, tRadar);

  card.append(head, grid, starsLine, time, toggles);
  doc.body.append(card);
  cleanups.push(() => card.remove());

  let tzLookup = null;
  loadTzLookup()
    .then((fn) => {
      tzLookup = fn;
      render();
    })
    .catch(() => {});

  // Weather at the view centre, cached per 0.1°.
  const wxCache = new Map();
  let wx = null;
  let wxKey = '';
  async function loadWeather() {
    const key = `${center.lat.toFixed(1)},${center.lon.toFixed(1)}`;
    wxKey = key;
    const hit = wxCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      wx = hit.weather;
      return render();
    }
    wx = { loading: true };
    render();
    try {
      const r = await fetchImpl(
        `/api/weather-effects?latitude=${center.lat.toFixed(4)}&longitude=${center.lon.toFixed(4)}`,
      );
      const body = await r.json();
      if (!r.ok || !body?.weather)
        throw new Error(body?.error || `HTTP ${r.status}`);
      wxCache.set(key, { at: Date.now(), weather: body.weather });
      if (wxKey === key) wx = body.weather;
    } catch (error) {
      if (wxKey === key) wx = { error: error.message };
    }
    render();
  }

  function renderToggles() {
    const s = environment.snapshot();
    tLight.setAttribute('aria-pressed', String(s.lighting));
    tShadow.setAttribute('aria-pressed', String(s.shadows));
    tSky.setAttribute('aria-pressed', String(s.sky));
    tRadar.setAttribute(
      'aria-pressed',
      String(Boolean(dataManager?.isEnabled?.('weather-radar'))),
    );
  }

  function cell(box, title, lines) {
    box.replaceChildren(
      el(doc, 'div', 'sky-cell-title', title),
      ...lines.map((l) => el(doc, 'div', 'sky-cell-line', l)),
    );
  }

  const zone = () =>
    tzLookup ? zoneFor(tzLookup, center.lat, center.lon) : null;
  const localHm = (d) => {
    if (!d) return '—';
    const z = formatZoneTime(zone() || 'UTC', d);
    return z ? z.time.slice(0, 5) : '—';
  };

  function computeReading() {
    reading = skyReading(environment.currentDate(), center.lat, center.lon);
  }

  function render() {
    if (card.hidden) return;
    const s = environment.snapshot();
    const date = s.date;
    const isLive = s.mode === 'live';
    const z = formatZoneTime(zone() || 'UTC', date);
    place.textContent = `${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}${z ? ` · ${z.zone.replace(/_/g, ' ')}` : ''}`;
    clockLine.textContent = z
      ? `${z.abbr} ${z.time} · ${z.date}${isLive ? '' : SIMULATED}`
      : '';
    if (!reading) computeReading();
    const r = reading;
    phaseLine.textContent = r.phase.toUpperCase();
    card.dataset.phase = r.isDay
      ? 'day'
      : r.sun.altitude > -12
        ? 'twilight'
        : 'night';
    const st = r.sunTimes;
    cell(sunBox, 'SUN', [
      `${fmtDeg(r.sun.altitude)} el · ${Math.round(r.sun.azimuth)}° ${compassPoint(r.sun.azimuth)}`,
      st.alwaysUp
        ? 'up all day'
        : st.alwaysDown
          ? 'down all day'
          : `rise ${localHm(st.rise)} · set ${localHm(st.set)}`,
      `noon ${localHm(r.solarNoon)}`,
    ]);
    const mt = r.moonTimes;
    cell(moonBox, 'MOON', [
      `${r.moon.name} · ${Math.round(r.moon.fraction * 100)}% lit`,
      `${fmtDeg(r.moon.altitude)} el · ${Math.round(r.moon.azimuth)}° ${compassPoint(r.moon.azimuth)}`,
      mt.alwaysUp
        ? 'up all day'
        : mt.alwaysDown
          ? 'down all day'
          : `rise ${localHm(mt.rise)} · set ${localHm(mt.set)}`,
    ]);
    cell(
      shadowBox,
      'SHADOWS',
      r.shadow
        ? [
            `fall toward ${Math.round(r.shadow.towardDeg)}° ${compassPoint(r.shadow.towardDeg)}`,
            `${r.shadow.lengthRatio.toFixed(1)}× object height`,
            s.shadows
              ? 'rendered on terrain + buildings'
              : 'turn on SHADOWS to render',
          ]
        : ['sun below horizon', 'no cast shadows', ''],
    );
    if (!wx || wx.loading) cell(wxBox, 'WEATHER', ['reading…', '', '']);
    else if (wx.error)
      cell(wxBox, 'WEATHER', ['unavailable', wx.error.slice(0, 40), '']);
    else
      cell(wxBox, 'WEATHER', [
        `${Math.round(wx.temperatureC)}°C · ${weatherCodeLabel(wx.weatherCode).toLowerCase()}`,
        `wind ${Math.round(wx.windKph ?? 0)} km/h from ${compassPoint(wx.windDirectionDeg ?? 0)} · cloud ${Math.round(wx.cloudCoverPct ?? 0)}%`,
        `vis ${wx.visibilityM != null ? `${(wx.visibilityM / 1000).toFixed(1)} km` : '—'} · precip ${wx.precipitationMm ?? 0} mm`,
      ]);
    starsLine.textContent = r.stars.length
      ? `stars up: ${r.stars.map((x) => `${x.name} ${Math.round(x.altitude)}° ${compassPoint(x.azimuth)}`).join(' · ')}`
      : r.isDay
        ? 'stars: washed out by daylight'
        : 'stars: twilight — brightest appear below −6°';
    const hours = isLive ? 0 : s.offsetMs / HOUR;
    const offsetText = `${hours >= 0 ? '+' : ''}${hours.toFixed(1)} h`;
    if (doc.activeElement !== slider)
      slider.value = String(Math.max(-24, Math.min(24, hours)));
    offsetLabel.textContent = isLive ? NOW_LABEL : offsetText;
    liveBtn.setAttribute('aria-pressed', String(s.mode === 'live'));
    playBtn.textContent = s.playing ? '❚❚' : '▶';
    for (const b of speedBtns)
      b.setAttribute(
        'aria-pressed',
        String(s.playing && Number(b.dataset.speed) === s.speed),
      );
    renderToggles();
  }

  let lastCompute = 0;
  const unsubscribe = environment.subscribe(() => {
    computeReading();
    lastCompute = Date.now();
    render();
  });
  cleanups.push(unsubscribe);
  const ticker = setInterval(() => {
    if (card.hidden) return;
    if (
      Date.now() - lastCompute >
      (environment.snapshot().playing ? 250 : 5000)
    ) {
      computeReading();
      lastCompute = Date.now();
    }
    render();
  }, 1000);
  cleanups.push(() => clearInterval(ticker));

  let moveTimer = null;
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      center = viewCenter(viewer);
      computeReading();
      render();
      if (!card.hidden) void loadWeather();
    }, 400);
  });
  cleanups.push(() => {
    removeMoveEnd();
    clearTimeout(moveTimer);
  });

  // Rail chip: SKY (L), docked beside the other operator verbs.
  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn sky-chip');
  chip.type = 'button';
  chip.title = 'Live environment (L)';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(
    el(doc, 'span', 'adam-ops-rail-label', 'SKY'),
    el(doc, 'kbd', 'adam-ops-rail-key', 'L'),
  );
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

  // One centre flyout at a time: SKY and the ops views share the slot.
  const onRailClick = (event) => {
    const target = event.target.closest?.('.adam-ops-rail-btn');
    if (
      target &&
      target !== chip &&
      !target.classList.contains('shp-tab--docked') &&
      !card.hidden
    )
      setOpen(false);
  };
  doc.addEventListener('click', onRailClick, true);
  cleanups.push(() => doc.removeEventListener('click', onRailClick, true));

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        globalThis.__godsEyeView?.opsDeck?.toggleView?.('brief', false);
      center = viewCenter(viewer);
      computeReading();
      card.classList.remove('adam-lock-in');
      void card.offsetWidth;
      card.classList.add('adam-lock-in');
      render();
      void loadWeather();
    }
  }

  const onKey = (event) => {
    const t = event.target;
    if (
      t?.closest?.('input, textarea, select, [contenteditable="true"]') ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      setOpen(card.hidden);
    } else if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    reading: () => {
      computeReading();
      return {
        center,
        ...reading,
        weather: wx && !wx.loading && !wx.error ? wx : null,
      };
    },
    destroy() {
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
