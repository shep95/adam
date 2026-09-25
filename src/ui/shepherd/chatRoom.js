/**
 * Shepherd chat room: a full-height rail on the right edge. Text in, streamed
 * text out, tool activity shown inline as quiet one-line receipts, images by
 * button / paste / drop. Opens with S; Esc returns focus to the globe.
 *
 * All dynamic text goes through textContent (see renderText.js).
 */
import './chatRoom.css';
import { renderReply } from './renderText.js';
import {
  classifyFile,
  documentPrompt,
  documentText,
  isGeoJson,
} from '../../shepherd/fileIntel.js';

const OPEN_KEY = 'adam.shepherd.open';
const SEND_LABEL = Object.freeze({ idle: 'send', busy: 'stop' });
const AUTO_ROUTE = 'auto';
const MAX_EDGE_PX = 1600;
const TOOL_LABELS = {
  get_console_state: 'reading console',
  set_layers: 'switching layers',
  set_layer_visibility: 'switching layer',
  track_flight: 'locating aircraft',
  set_contact_filter: 'filtering contacts',
  create_alert_zone: 'arming alert zone',
  drop_pin: 'placing pin',
  osint_overlay: 'drawing overlay',
  clear_osint_overlay: 'clearing overlay',
  export_report: 'exporting report',
  set_3d_buildings: '3d buildings',
  fly_to_location: 'flying',
  search_places: 'searching places',
};

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
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
    /* ignore */
  }
}

/** Downscale an image file to a JPEG/PNG base64 payload under the edge cap. */
export async function imagePayload(file, doc = document) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error('png, jpeg, webp or gif only');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(
    1,
    MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height),
  );
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.86);
  return {
    mime: 'image/jpeg',
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    preview: dataUrl,
    name: file.name,
  };
}

function toolLabel(name) {
  return TOOL_LABELS[name] || name.replace(/_/g, ' ');
}

const AUDIT_LABEL = 'log';
const AUDIT_EXPORT = 'json';
const AUDIT_CLEAR = 'clr';
const CHALLENGE_LABEL = '2nd';
export const CHALLENGE_PROMPT = [
  'Second opinion. Challenge your previous answer as a red-team analyst would:',
  '1. The strongest alternative interpretation of the same evidence, and one more if it exists.',
  '2. Which of your claims rest on data you actually read this session, and which were assumed.',
  '3. What specific observation would raise or lower your confidence, and how to get it with the console (tools you could run).',
  '4. Your revised confidence line.',
  'Do not simply restate the answer. If a tool would settle a point now, run it.',
].join('\n');

export function installShepherdRoom({
  agent,
  client,
  overlay,
  files = null,
  doc = document,
}) {
  const cleanups = [];
  const root = el(doc, 'aside', 'shp-room');
  root.setAttribute('aria-label', 'Shepherd');
  root.setAttribute('role', 'complementary');

  // The opener joins the ops rail (BRIEF · ALERTS · FILTER · KEYS) when it
  // exists, so there is one row of operator verbs and nothing floats over
  // the instruments; until then it waits as a small edge tab.
  const tab = el(doc, 'button', 'shp-tab');
  tab.type = 'button';
  tab.title = 'Shepherd (S)';
  tab.setAttribute('aria-label', 'Open Shepherd');
  tab.setAttribute('aria-pressed', 'false');
  tab.append(
    el(doc, 'span', 'adam-ops-rail-label shp-tab-mark', 'SHEPHERD'),
    el(doc, 'kbd', 'adam-ops-rail-key', 'S'),
  );
  const dockTab = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    tab.className = 'adam-chip adam-ops-rail-btn shp-tab--docked';
    rail.append(tab);
    return true;
  };

  const header = el(doc, 'header', 'shp-head');
  const title = el(doc, 'div', 'shp-title');
  title.append(
    el(doc, 'span', 'shp-name', 'shepherd'),
    el(doc, 'span', 'shp-route', ''),
  );
  const headBtns = el(doc, 'div', 'shp-head-btns');
  const settingsBtn = el(doc, 'button', 'shp-icon-btn', 'cfg');
  settingsBtn.type = 'button';
  settingsBtn.title = 'Providers and memory';
  const closeBtn = el(doc, 'button', 'shp-icon-btn', '×');
  closeBtn.type = 'button';
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close Shepherd');
  const auditBtn = el(doc, 'button', 'shp-icon-btn', AUDIT_LABEL);
  auditBtn.type = 'button';
  auditBtn.title =
    'Action log: every tool Shepherd ran, with arguments and result';
  headBtns.append(auditBtn, settingsBtn, closeBtn);
  header.append(title, headBtns);

  const settings = el(doc, 'section', 'shp-settings');
  settings.hidden = true;
  const audit = el(doc, 'section', 'shp-settings shp-audit');
  audit.hidden = true;
  function renderAudit() {
    audit.replaceChildren();
    const entries = (agent.actionLog?.() || []).slice().reverse();
    const head = el(doc, 'div', 'shp-audit-head');
    head.append(el(doc, 'span', 'shp-meta', `ACTION LOG · ${entries.length}`));
    const exportBtn = el(doc, 'button', 'shp-icon-btn', AUDIT_EXPORT);
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => {
      const blob = new Blob(
        [
          JSON.stringify(
            entries
              .slice()
              .reverse()
              .map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      );
      const url = URL.createObjectURL(blob);
      const a = el(doc, 'a');
      a.href = url;
      a.download = `adam-shepherd-actions-${new Date().toISOString().slice(0, 10)}.json`;
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
    const clearBtn = el(doc, 'button', 'shp-icon-btn', AUDIT_CLEAR);
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      agent.clearActionLog?.();
      renderAudit();
    });
    head.append(exportBtn, clearBtn);
    audit.append(head);
    for (const e of entries.slice(0, 80)) {
      const row = el(doc, 'div', `shp-audit-row${e.ok ? '' : ' is-failed'}`);
      row.append(
        el(
          doc,
          'span',
          'shp-meta',
          new Date(e.at).toISOString().slice(11, 19) + 'Z',
        ),
        el(doc, 'span', 'shp-audit-tool', `${e.ok ? '' : '✕ '}${e.tool}`),
        el(doc, 'span', 'shp-meta shp-audit-args', e.args),
      );
      row.title = e.result;
      audit.append(row);
    }
    if (!entries.length)
      audit.append(el(doc, 'p', 'shp-meta', 'No tool calls yet.'));
  }

  const log = el(doc, 'div', 'shp-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const composer = el(doc, 'form', 'shp-composer');
  const attachments = el(doc, 'div', 'shp-attachments');
  const input = el(doc, 'textarea', 'shp-input');
  input.rows = 1;
  input.placeholder = 'ask, direct, or drop a photo, map file or document';
  input.setAttribute('aria-label', 'Message Shepherd');
  input.spellcheck = true;
  const fileInput = el(doc, 'input');
  fileInput.type = 'file';
  fileInput.accept =
    'image/png,image/jpeg,image/webp,image/gif,.geojson,.json,.kml,.kmz,.txt,.md,.csv,.tsv,.html,.htm,.xml,.log';
  fileInput.hidden = true;
  const row = el(doc, 'div', 'shp-row');
  const attachBtn = el(doc, 'button', 'shp-icon-btn', 'img');
  attachBtn.type = 'button';
  attachBtn.title =
    'Attach a photo to locate, a GeoJSON/KML/KMZ map file, or a text document to read and plot (or paste / drop)';
  const sendBtn = el(doc, 'button', 'shp-send', 'send');
  sendBtn.type = 'submit';
  const challengeBtn = el(doc, 'button', 'shp-icon-btn', CHALLENGE_LABEL);
  challengeBtn.type = 'button';
  challengeBtn.title =
    'Second opinion: Shepherd challenges its last answer — alternatives, what would change its confidence';
  row.append(
    attachBtn,
    challengeBtn,
    el(doc, 'span', 'shp-hint', 'enter to send · shift+enter newline'),
    sendBtn,
  );
  composer.append(attachments, input, row, fileInput);

  root.append(header, settings, audit, log, composer);
  doc.body.append(root);
  if (!dockTab()) {
    doc.body.append(tab);
    let tries = 0;
    const timer = setInterval(() => {
      if (dockTab() || (tries += 1) > 40) clearInterval(timer);
    }, 250);
    cleanups.push(() => clearInterval(timer));
  }
  cleanups.push(() => {
    root.remove();
    tab.remove();
  });

  let pending = [];
  let current = null;
  let typing = null;

  const scroll = () => {
    log.scrollTop = log.scrollHeight;
  };

  function setOpen(open) {
    root.classList.toggle('is-open', open);
    if (open) tab.classList.remove('has-notice');
    tab.setAttribute('aria-pressed', String(open));
    if (!tab.classList.contains('shp-tab--docked'))
      tab.classList.toggle('is-hidden', open);
    doc.body.classList.toggle('adam-shepherd-open', open);
    writeLocal(OPEN_KEY, open ? '1' : '0');
    if (open) setTimeout(() => input.focus({ preventScroll: true }), 210);
  }

  function addNote(text, kind = 'note') {
    const node = el(doc, 'div', `shp-note shp-note--${kind}`, text);
    log.append(node);
    scroll();
    return node;
  }

  function addUser(turn) {
    const node = el(doc, 'div', 'shp-msg shp-msg--user');
    if (turn.imageNote || turn.images?.length) {
      const strip = el(doc, 'div', 'shp-thumbs');
      for (const img of turn.images || []) {
        const thumb = el(doc, 'img', 'shp-thumb');
        thumb.alt = img.name || 'attached image';
        thumb.src = img.preview || `data:${img.mime};base64,${img.data}`;
        thumb.draggable = false;
        strip.append(thumb);
      }
      if (!turn.images?.length)
        strip.append(el(doc, 'span', 'shp-meta', turn.imageNote));
      node.append(strip);
    }
    const shown = turn.display || turn.text;
    if (shown) node.append(el(doc, 'div', 'shp-body', shown));
    log.append(node);
    scroll();
  }

  function startAssistant() {
    const node = el(doc, 'div', 'shp-msg shp-msg--ai');
    const body = el(doc, 'div', 'shp-body');
    node.append(body);
    log.append(node);
    current = { node, body, text: '', frame: 0 };
    showTyping(true);
    scroll();
  }

  function paint() {
    if (!current) return;
    current.frame = 0;
    renderReply(doc, current.body, current.text);
    scroll();
  }

  function showTyping(on) {
    if (on && !typing) {
      typing = el(doc, 'div', 'shp-typing');
      typing.append(el(doc, 'span'), el(doc, 'span'), el(doc, 'span'));
      log.append(typing);
      scroll();
    } else if (!on && typing) {
      typing.remove();
      typing = null;
    }
  }

  function renderHistory() {
    log.replaceChildren();
    const thread = agent.thread();
    if (!thread.length) {
      addNote(
        'shepherd is linked to the console. it can move the camera, switch layers, track aircraft by flight or tail number, filter contacts, arm alert zones, draw osint overlays and locate a photograph.',
      );
      return;
    }
    for (const turn of thread) {
      if (turn.role === 'user') addUser(turn);
      else if (turn.role === 'assistant') {
        if (turn.text) {
          const node = el(doc, 'div', 'shp-msg shp-msg--ai');
          const body = el(doc, 'div', 'shp-body');
          renderReply(doc, body, turn.text);
          node.append(body);
          log.append(node);
        }
      } else if (turn.role === 'tool')
        addNote(`· ${toolLabel(turn.name)}`, 'tool');
    }
    scroll();
  }

  function renderAttachments() {
    attachments.replaceChildren();
    for (const [index, img] of pending.entries()) {
      const chip = el(doc, 'div', 'shp-chip');
      const thumb = el(doc, 'img', 'shp-thumb');
      thumb.src = img.preview;
      thumb.alt = img.name || 'image';
      thumb.draggable = false;
      const locate = el(doc, 'button', 'shp-chip-btn', 'locate');
      locate.type = 'button';
      locate.title = 'Predict where this photo was taken and fly there';
      locate.addEventListener('click', () => geolocate(img));
      const remove = el(doc, 'button', 'shp-chip-btn', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove image');
      remove.addEventListener('click', () => {
        pending.splice(index, 1);
        renderAttachments();
      });
      chip.append(thumb, locate, remove);
      attachments.append(chip);
    }
    attachments.hidden = pending.length === 0;
  }

  async function addFiles(dropped) {
    for (const file of [...dropped].slice(0, 8)) {
      let kind = classifyFile(file);
      let parsedJson = null;
      if (kind === 'document' && /\.json$/i.test(file.name || '')) {
        try {
          parsedJson = JSON.parse(await file.text());
          if (isGeoJson(parsedJson)) kind = 'geo';
        } catch {
          /* plain text then */
        }
      }
      if (kind === 'image') {
        if (pending.length >= 4) continue;
        try {
          pending.push(await imagePayload(file, doc));
        } catch (error) {
          addNote(`image skipped: ${error.message}`, 'error');
        }
      } else if (kind === 'geo') {
        if (!files) continue;
        try {
          const r = await files.load(file);
          addNote(
            `${r.name}: ${r.features} features on the globe (${r.points} points, ${r.lines} lines, ${r.areas} areas)`,
            'tool',
          );
        } catch (error) {
          addNote(`${file.name}: could not draw — ${error.message}`, 'error');
        }
      } else if (kind === 'document') {
        if (agent.busy()) {
          addNote(`${file.name}: wait for the current answer first`, 'error');
          continue;
        }
        const docText = documentText(await file.text(), file.name);
        if (!docText.text) {
          addNote(`${file.name}: no readable text`, 'error');
          continue;
        }
        const ask = input.value.trim();
        input.value = '';
        autosize();
        root.classList.add('is-busy');
        sendBtn.textContent = SEND_LABEL.busy;
        await agent.send({
          text: documentPrompt({ name: file.name, ...docText }, ask),
          display: `${ask || 'read and plot'} · ${file.name} (${Math.round(docText.chars / 1000)}k chars${docText.truncated ? ', truncated' : ''})`,
          task: 'chat',
        });
      } else {
        addNote(
          `${file.name}: unsupported — drop a photo, GeoJSON/KML/KMZ, or a text document`,
          'error',
        );
      }
    }
    renderAttachments();
  }

  async function geolocate(img) {
    pending = pending.filter((p) => p !== img);
    renderAttachments();
    addUser({
      text: input.value.trim() || 'where was this taken?',
      images: [img],
    });
    const hint = input.value.trim();
    input.value = '';
    const note = addNote(
      'reading the image — terrain, script, architecture, road furniture…',
      'tool',
    );
    try {
      const result = await client.geolocate({
        image: { mime: img.mime, data: img.data },
        hint,
      });
      note.remove();
      const top = result.candidates[0];
      overlay.drawOverlay({
        title: 'image geolocation',
        nodes: result.candidates.map((c, i) => ({
          id: `geo-${i}`,
          label: c.place || `candidate ${i + 1}`,
          lat: c.lat,
          lon: c.lon,
          kind: 'place',
          confidence: c.confidence,
        })),
        fly: false,
      });
      overlay.dropPin({
        lat: top.lat,
        lon: top.lon,
        label: top.place,
        range: Math.max(800, Math.min(60_000, top.radiusKm * 1500)),
      });
      const lines = [
        `**${top.place || 'best candidate'}** — ${top.lat.toFixed(4)}, ${top.lon.toFixed(4)} (±${top.radiusKm} km)`,
        ...result.candidates
          .slice(1)
          .map(
            (c) =>
              `- ${c.place || 'candidate'} — ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)} · ${c.confidence.toFixed(2)}`,
          ),
        '',
        `confidence: ${top.confidence.toFixed(2)} · signal: ${top.confidence >= 0.7 ? 'strong' : top.confidence >= 0.4 ? 'moderate' : 'weak'} · evidence: ${result.signals.slice(0, 4).join('; ') || 'visual cues'} · unknown: ${result.unknown.slice(0, 3).join('; ') || 'none stated'}`,
        '',
        `via ${result.provider}`,
      ];
      startAssistant();
      showTyping(false);
      current.text = lines.join('\n');
      paint();
      current = null;
    } catch (error) {
      note.remove();
      handleError(error.message, error.status, error.body);
    }
  }

  function handleError(message, status, body) {
    if (status === 401 && body?.access) return promptAccess();
    addNote(message || 'request failed', 'error');
  }

  function promptAccess() {
    const box = el(doc, 'form', 'shp-access');
    box.append(
      el(
        doc,
        'div',
        'shp-meta',
        'this deployment is private — enter the access token',
      ),
    );
    const field = el(doc, 'input', 'shp-field');
    field.type = 'password';
    field.autocomplete = 'current-password';
    field.placeholder = 'access token';
    const go = el(doc, 'button', 'shp-send', 'unlock');
    go.type = 'submit';
    box.append(field, go);
    box.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await client.unlock(field.value);
        box.replaceWith(
          el(doc, 'div', 'shp-note', 'unlocked. resend your last message.'),
        );
        void loadStatus();
      } catch (error) {
        field.value = '';
        field.placeholder = error.message;
      }
    });
    log.append(box);
    field.focus();
    scroll();
  }

  let status = null;
  async function loadStatus() {
    try {
      status = await client.status();
    } catch (error) {
      status = null;
      if (error.status === 401) return promptAccess();
      if (error.status === 503) addNote(error.message, 'error');
    }
    renderSettings();
    const configured = status?.providers?.filter((p) => p.configured) || [];
    const route = title.querySelector('.shp-route');
    const prefs = agent.prefs();
    route.textContent = configured.length
      ? `· ${prefs.provider || AUTO_ROUTE}${prefs.model ? ` / ${prefs.model}` : ''}`
      : '· offline';
    if (status && !configured.length)
      addNote(
        'no ai provider key is set on the server. add ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, VENICE_API_KEY or OPENROUTER_API_KEY to the deployment environment.',
        'error',
      );
  }

  function renderSettings() {
    settings.replaceChildren();
    const prefs = agent.prefs();
    settings.append(el(doc, 'div', 'shp-meta', 'provider'));
    const select = el(doc, 'select', 'shp-field');
    select.append(new Option('auto — best configured for the task', ''));
    for (const p of status?.providers || []) {
      const opt = new Option(
        `${p.label}${p.configured ? '' : ` — set ${p.keyEnv}`}`,
        p.id,
      );
      opt.disabled = !p.configured;
      select.append(opt);
    }
    select.value = prefs.provider || '';
    settings.append(select);
    settings.append(
      el(doc, 'div', 'shp-meta', 'model (blank = provider default)'),
    );
    const model = el(doc, 'input', 'shp-field');
    model.value = prefs.model || '';
    model.placeholder =
      status?.providers?.find((p) => p.id === prefs.provider)?.model ||
      'default';
    const listId = 'shp-models';
    const datalist = el(doc, 'datalist');
    datalist.id = listId;
    model.setAttribute('list', listId);
    settings.append(model, datalist);
    const count = el(doc, 'div', 'shp-meta', '');
    settings.append(count);
    const loadModels = async () => {
      datalist.replaceChildren();
      count.textContent = '';
      if (!select.value) return;
      try {
        const { models } = await client.models(select.value);
        for (const m of models)
          datalist.append(new Option(m.name || m.id, m.id));
        count.textContent = `${models.length} models available`;
      } catch (error) {
        count.textContent = error.message;
      }
    };
    select.addEventListener('change', async () => {
      model.value = '';
      await agent.setPrefs({ provider: select.value || null, model: null });
      void loadModels();
      void loadStatus();
    });
    model.addEventListener('change', async () => {
      await agent.setPrefs({ model: model.value.trim() || null });
      void loadStatus();
    });
    void loadModels();
    const clear = el(doc, 'button', 'shp-chip-btn', 'forget conversation');
    clear.type = 'button';
    clear.addEventListener('click', async () => {
      await agent.clear();
      renderHistory();
    });
    const clearOverlay = el(doc, 'button', 'shp-chip-btn', 'clear overlays');
    clearOverlay.type = 'button';
    clearOverlay.addEventListener('click', () => overlay.clear());
    const actions = el(doc, 'div', 'shp-settings-actions');
    actions.append(clear, clearOverlay);
    settings.append(actions);
    settings.append(el(doc, 'div', 'shp-meta', 'memory stays on this device.'));
  }

  function onAgentEvent(event) {
    switch (event.type) {
      case 'user':
        addUser(event.turn);
        break;
      case 'assistant-start':
        startAssistant();
        break;
      case 'delta':
        if (!current) startAssistant();
        showTyping(false);
        current.text = event.turn.text;
        if (!current.frame) current.frame = requestAnimationFrame(paint);
        break;
      case 'assistant-end':
        if (current) {
          if (current.frame) cancelAnimationFrame(current.frame);
          if (current.text) paint();
          else current.node.remove();
        }
        current = null;
        showTyping(false);
        break;
      case 'tool-start': {
        const node = addNote(`· ${toolLabel(event.call.name)}`, 'tool');
        node.dataset.call = event.call.id;
        node.classList.add('is-running');
        break;
      }
      case 'tool-end': {
        const node = [...log.querySelectorAll('.shp-note--tool')].find(
          (n) => n.dataset.call === event.call.id,
        );
        let ok = true;
        try {
          ok = JSON.parse(event.result)?.ok !== false;
        } catch {
          ok = true;
        }
        node?.classList.remove('is-running');
        node?.classList.toggle('is-failed', !ok);
        break;
      }
      case 'failover':
        addNote(`${event.from} unavailable — switching`, 'tool');
        break;
      case 'meta':
        title.querySelector('.shp-route').textContent =
          `· ${event.provider} / ${event.model}`;
        break;
      case 'error':
        showTyping(false);
        handleError(event.error, event.status, event.body);
        break;
      case 'notice':
        addNote(event.text, 'tool');
        break;
      case 'idle':
        showTyping(false);
        root.classList.remove('is-busy');
        sendBtn.textContent = SEND_LABEL.idle;
        break;
      default:
    }
  }

  async function submit() {
    if (agent.busy()) {
      agent.abort();
      return;
    }
    const text = input.value.trim();
    const images = pending;
    if (!text && images.length === 1) return geolocate(images[0]);
    if (!text && !images.length) return;
    pending = [];
    renderAttachments();
    input.value = '';
    autosize();
    root.classList.add('is-busy');
    sendBtn.textContent = SEND_LABEL.busy;
    await agent.send({
      text,
      images: images.map(({ mime, data, preview, name }) => ({
        mime,
        data,
        preview,
        name,
      })),
      task: images.length ? 'vision' : 'chat',
    });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  }

  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  on(composer, 'submit', (event) => {
    event.preventDefault();
    void submit();
  });
  on(input, 'keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape') {
      input.blur();
    }
  });
  on(input, 'keyup', (event) => event.stopPropagation());
  on(input, 'input', autosize);
  on(input, 'paste', (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((f) =>
      f.type.startsWith('image/'),
    );
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  });
  on(root, 'dragover', (event) => {
    if ([...(event.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
      event.preventDefault();
      root.classList.add('is-drop');
    }
  });
  on(root, 'dragleave', () => root.classList.remove('is-drop'));
  on(root, 'drop', (event) => {
    event.preventDefault();
    root.classList.remove('is-drop');
    void addFiles(event.dataTransfer?.files || []);
  });
  on(attachBtn, 'click', () => fileInput.click());
  on(fileInput, 'change', () => {
    void addFiles(fileInput.files || []);
    fileInput.value = '';
  });
  on(tab, 'click', () => setOpen(true));
  on(closeBtn, 'click', () => setOpen(false));
  on(auditBtn, 'click', () => {
    audit.hidden = !audit.hidden;
    auditBtn.classList.toggle('is-on', !audit.hidden);
    if (!audit.hidden) renderAudit();
  });
  on(challengeBtn, 'click', () => {
    if (agent.busy() || !agent.lastAnswer?.()) return;
    void agent.send({
      text: CHALLENGE_PROMPT,
      display: 'second opinion on your last answer',
      task: 'chat',
    });
  });
  on(settingsBtn, 'click', () => {
    settings.hidden = !settings.hidden;
    settingsBtn.classList.toggle('is-on', !settings.hidden);
  });
  on(doc, 'keydown', (event) => {
    const t = event.target;
    const typingField = t?.closest?.(
      'input, textarea, select, [contenteditable="true"]',
    );
    if (typingField || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      setOpen(!root.classList.contains('is-open'));
    } else if (
      event.key === 'Escape' &&
      root.classList.contains('is-open') &&
      root.contains(t)
    ) {
      setOpen(false);
    }
  });

  agent.ready.then(() => {
    renderHistory();
    void loadStatus();
  });
  setOpen(readLocal(OPEN_KEY) === '1');

  return {
    onAgentEvent,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!root.classList.contains('is-open')),
    /** An ambient line from the watch engine, without a model call. */
    notice(text) {
      addNote(String(text).slice(0, 400), 'watch');
      if (!root.classList.contains('is-open')) tab.classList.add('has-notice');
    },
    ask(text) {
      setOpen(true);
      input.value = text;
      void submit();
    },
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* gone */
        }
      }
      doc.body.classList.remove('adam-shepherd-open');
    },
  };
}
