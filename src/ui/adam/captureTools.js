/**
 * Capture and scale, on the top action bar:
 *
 *   snapshot   a PNG of the live view: globe, weather, and a caption strip
 *              (place, UTC and local time, #houseofasher) — instant, no prompt
 *   record     the whole tab with its instruments via screen capture (the
 *              browser asks once); falls back to the globe canvas alone when
 *              tab capture is refused or unsupported. Saves MP4 or WebM.
 *   ui scale   80–140% for every panel and control; the globe is untouched
 */
import './captureTools.css';
import {
  UI_SCALES,
  clampScale,
  pickRecorderType,
  stampName,
} from './captureMath.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../../renderGovernor.js';

const SCALE_KEY = 'adam.ui.scale';
const MAX_RECORD_MS = 15 * 60_000;
const RAD = 180 / Math.PI;

function readScale() {
  try {
    return clampScale(globalThis.localStorage?.getItem(SCALE_KEY) ?? 1);
  } catch {
    return 1;
  }
}

function save(blob, name, doc) {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function iconButton(doc, symbol, label) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const icon = doc.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = symbol;
  b.append(icon);
  return b;
}

export function installCaptureTools({ viewer, doc = document }) {
  const bar = doc.getElementById('top-center-actions');
  const cleanups = [];
  if (!bar) return { destroy() {} };

  // ── UI scale ────────────────────────────────────────────────────────────
  const applyScale = (scale) => {
    doc.documentElement.style.setProperty('--adam-ui-scale', String(scale));
    doc.documentElement.dataset.uiScale = String(scale);
    try {
      globalThis.localStorage?.setItem(SCALE_KEY, String(scale));
    } catch {
      /* ignore */
    }
  };
  applyScale(readScale());

  const scaleBtn = iconButton(doc, 'format_size', 'Interface scale');
  scaleBtn.classList.add('adam-cap-btn');
  const pop = doc.createElement('div');
  pop.className = 'adam-panel adam-scale-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', 'Interface scale');
  for (const s of UI_SCALES) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'adam-scale-opt';
    b.textContent = `${Math.round(s * 100)}%`;
    b.addEventListener('click', () => {
      applyScale(s);
      render();
    });
    b.dataset.scale = String(s);
    pop.append(b);
  }
  const render = () => {
    const cur = readScale();
    for (const b of pop.children)
      b.setAttribute('aria-pressed', String(Number(b.dataset.scale) === cur));
  };
  scaleBtn.addEventListener('click', () => {
    pop.hidden = !pop.hidden;
    render();
  });
  const outside = (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !scaleBtn.contains(e.target))
      pop.hidden = true;
  };
  doc.addEventListener('pointerdown', outside, true);
  cleanups.push(() => doc.removeEventListener('pointerdown', outside, true));

  // ── Snapshot ────────────────────────────────────────────────────────────
  const snapBtn = iconButton(doc, 'photo_camera', 'Snapshot the view');
  snapBtn.classList.add('adam-cap-btn');
  const flash = doc.createElement('div');
  flash.className = 'adam-cap-flash';
  doc.body.append(flash);

  async function snapshot() {
    viewer.render();
    const src = viewer.scene.canvas;
    const w = src.width;
    const h = src.height;
    const strip = Math.round(Math.max(28, h * 0.035));
    const out = doc.createElement('canvas');
    out.width = w;
    out.height = h + strip;
    const ctx = out.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const fx = doc.querySelector('canvas.adam-weather-fx');
    if (fx && fx.style.opacity !== '0') ctx.drawImage(fx, 0, 0, w, h);
    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, h, w, strip);
    const carto = viewer.camera.positionCartographic;
    const now = new Date();
    const local = doc.getElementById('hud-localtime')?.textContent || '';
    const left = `ADAM · ${(carto.latitude * RAD).toFixed(5)}, ${(carto.longitude * RAD).toFixed(5)} · alt ${Math.round(carto.height)} m`;
    const right = `${now.toISOString().replace(/\.\d+Z$/, 'Z')}${local ? ` · ${local.toUpperCase()}` : ''} · #HOUSEOFASHER`;
    ctx.font = `500 ${Math.round(strip * 0.42)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#00d4ff';
    ctx.fillText(left, strip * 0.5, h + strip / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(216, 230, 238, 0.7)';
    ctx.fillText(right, w - strip * 0.5, h + strip / 2);
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    if (blob) save(blob, stampName('adam', 'png'), doc);
    flash.classList.remove('is-on');
    void flash.offsetWidth;
    flash.classList.add('is-on');
  }
  snapBtn.addEventListener('click', () => void snapshot());

  // ── Record ──────────────────────────────────────────────────────────────
  const recBtn = iconButton(doc, 'fiber_manual_record', 'Record the view');
  recBtn.classList.add('adam-cap-btn', 'adam-rec-btn');
  const timer = doc.createElement('span');
  timer.className = 'adam-rec-time';
  timer.hidden = true;
  recBtn.append(timer);
  let recorder = null;
  let stream = null;
  let started = 0;
  let tick = null;
  let limit = null;

  async function openStream() {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, displaySurface: 'browser' },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
      return { stream: s, scope: 'tab' };
    } catch {
      const canvas = viewer.scene.canvas;
      if (typeof canvas.captureStream !== 'function')
        throw new Error('recording is not supported in this browser');
      holdContinuousRender('adam-recording');
      return { stream: canvas.captureStream(30), scope: 'globe' };
    }
  }

  async function startRecording() {
    const type = pickRecorderType();
    if (!globalThis.MediaRecorder)
      throw new Error('recording is not supported in this browser');
    const opened = await openStream();
    stream = opened.stream;
    const chunks = [];
    recorder = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: 8_000_000,
    });
    recorder.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
    recorder.onstop = () => {
      const mime = recorder?.mimeType || type || 'video/webm';
      save(
        new Blob(chunks, { type: mime }),
        stampName(
          `adam-${opened.scope}`,
          mime.includes('mp4') ? 'mp4' : 'webm',
        ),
        doc,
      );
      cleanupRecording();
    };
    for (const track of stream.getVideoTracks())
      track.addEventListener('ended', () => stopRecording());
    recorder.start(1000);
    started = Date.now();
    doc.documentElement.dataset.adamRecordingSince = String(started);
    recBtn.classList.add('is-recording');
    recBtn.title = `Stop recording (${opened.scope === 'tab' ? 'full view' : 'globe only'})`;
    timer.hidden = false;
    tick = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    limit = setTimeout(() => stopRecording(), MAX_RECORD_MS);
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function cleanupRecording() {
    clearInterval(tick);
    clearTimeout(limit);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    recorder = null;
    releaseContinuousRender('adam-recording');
    delete doc.documentElement.dataset.adamRecordingSince;
    recBtn.classList.remove('is-recording');
    recBtn.title = 'Record the view';
    timer.hidden = true;
    timer.textContent = '';
  }

  recBtn.addEventListener('click', async () => {
    if (recorder) return stopRecording();
    try {
      await startRecording();
    } catch (error) {
      recBtn.title = error.message;
      cleanupRecording();
    }
  });

  const divider = doc.createElement('span');
  divider.className = 'adam-cap-divider';
  divider.setAttribute('aria-hidden', 'true');
  bar.append(divider, snapBtn, recBtn, scaleBtn);
  doc.body.append(pop);
  cleanups.push(() => {
    stopRecording();
    divider.remove();
    snapBtn.remove();
    recBtn.remove();
    scaleBtn.remove();
    pop.remove();
    flash.remove();
  });

  return {
    snapshot,
    startRecording,
    stopRecording,
    setScale: (s) => applyScale(clampScale(s)),
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
