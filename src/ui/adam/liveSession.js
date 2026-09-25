/**
 * SESSION: work one picture with other operators.
 *
 *   start      creates a room and an invite link (#live=<room>); opening
 *              the link joins it
 *   who        everyone in the room, with where they are looking
 *   follow     your camera follows another operator's view
 *   share      your view goes out as you move; pins you drop at the view
 *              centre reach everyone; short notes form a room chat
 *
 * Events go through /api/session (long poll). Nothing is shared until you
 * start or join a room, and leaving stops it.
 */
import * as Cesium from 'cesium';
import './volcanoPanel.css';
import './liveSession.css';

const LABEL_TITLE = 'session';
const LABEL_COPIED = 'copied';
const NAME_KEY = 'adam.session.name';
const RAD = 180 / Math.PI;

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function roomFromHash(hash) {
  const m = /[#&]live=([A-Za-z0-9_-]{12,32})/.exec(String(hash || ''));
  return m ? m[1] : null;
}

export function inviteUrl(location, room) {
  const base = `${location.origin}${location.pathname}${location.search}`;
  return `${base}#live=${room}`;
}

/** Fold events into who is here (last hello/view per client, 2 min window). */
export function presence(events, now = Date.now(), windowMs = 120_000) {
  const by = new Map();
  for (const e of events) {
    if (!e.clientId) continue;
    if (e.kind === 'bye') {
      by.delete(e.clientId);
      continue;
    }
    const at = Date.parse(e.at) || now;
    const cur = by.get(e.clientId) || { clientId: e.clientId, name: e.from };
    cur.name = e.from || cur.name;
    cur.lastAt = at;
    if (e.kind === 'view') cur.view = e.payload;
    by.set(e.clientId, cur);
  }
  return [...by.values()].filter((p) => now - p.lastAt < windowMs);
}

export function installLiveSession({
  viewer,
  doc = document,
  fetchImpl = (...a) => globalThis.fetch(...a),
  getConsole = () => globalThis.__godsEyeView || {},
}) {
  const cleanups = [];
  const clientId = (
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  )
    .replace(/[^a-z0-9-]/gi, '')
    .slice(0, 36);
  let name = (() => {
    try {
      return globalThis.localStorage?.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  })();
  let room = null;
  let seq = 0;
  let events = [];
  let following = null;
  let polling = false;
  let error = '';
  let lastViewSent = 0;
  const pins = new Cesium.CustomDataSource('adam-session');
  viewer.dataSources.add(pins);
  cleanups.push(() => viewer.dataSources.remove(pins, true));

  async function post(kind, payload = {}) {
    if (!room) return null;
    try {
      const r = await fetchImpl(`/api/session/${room}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          from: name || 'operator',
          clientId,
          payload,
        }),
      });
      return r.ok ? r.json() : null;
    } catch {
      return null;
    }
  }

  function viewNow() {
    const c = viewer.camera.positionCartographic;
    return {
      lat: c.latitude * RAD,
      lon: c.longitude * RAD,
      alt: c.height,
      heading: viewer.camera.heading * RAD,
      pitch: viewer.camera.pitch * RAD,
    };
  }

  function apply(e) {
    if (e.clientId === clientId) return;
    if (e.kind === 'pin') {
      const color = Cesium.Color.fromCssColorString('#FF9F0A');
      pins.entities.add({
        position: Cesium.Cartesian3.fromDegrees(e.payload.lon, e.payload.lat),
        point: {
          pixelSize: 9,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${e.from}: ${e.payload.label || 'pin'}`,
          font: '500 12px "ADAM Sans", sans-serif',
          fillColor: color,
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString('#061015').withAlpha(0.8),
          pixelOffset: new Cesium.Cartesian2(10, -8),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else if (e.kind === 'view' && following === e.clientId) {
      const v = e.payload;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.alt),
        orientation: {
          heading: (v.heading || 0) / RAD,
          pitch: (v.pitch ?? -90) / RAD,
          roll: 0,
        },
        duration: 1.2,
      });
    } else if (e.kind === 'overlay' && e.payload?.overlay) {
      getConsole().shepherd?.overlay?.drawOverlay?.({
        ...e.payload.overlay,
        append: true,
        fly: false,
      });
    } else if (e.kind === 'note') {
      getConsole().shepherd?.room?.notice?.(`${e.from}: ${e.payload.text}`);
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    while (room) {
      try {
        const r = await fetchImpl(
          `/api/session/${room}/events?after=${seq}&wait=20`,
        );
        const body = await r.json();
        if (!r.ok) {
          error = body.error || `HTTP ${r.status}`;
          render();
          await new Promise((res) => setTimeout(res, 5000));
          continue;
        }
        error = '';
        for (const e of body.events || []) {
          seq = Math.max(seq, e.seq);
          events.push(e);
          apply(e);
        }
        if (events.length > 400) events = events.slice(-300);
        if (body.events?.length) render();
      } catch {
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
    polling = false;
  }

  async function start() {
    const r = await fetchImpl('/api/session', { method: 'POST' });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    return join(body.id);
  }

  async function join(id) {
    try {
      name = globalThis.localStorage?.getItem(NAME_KEY) || name;
    } catch {
      /* ignore */
    }
    room = id;
    seq = 0;
    events = [];
    pins.entities.removeAll();
    const params = new URLSearchParams(location.hash.slice(1));
    params.set('live', id);
    history.replaceState(null, '', `#${params.toString()}`);
    await post('hello');
    await post('view', viewNow());
    void poll();
    render();
    return { ok: true, room, invite: inviteUrl(location, room) };
  }

  async function leave() {
    if (!room) return { ok: true };
    await post('bye');
    room = null;
    following = null;
    const params = new URLSearchParams(location.hash.slice(1));
    params.delete('live');
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}${params.toString() ? `#${params}` : ''}`,
    );
    render();
    return { ok: true };
  }

  // Share the view as it settles; say hello every minute.
  cleanups.push(
    viewer.camera.moveEnd.addEventListener(() => {
      if (!room || Date.now() - lastViewSent < 1500) return;
      lastViewSent = Date.now();
      void post('view', viewNow());
    }),
  );
  const hello = setInterval(() => room && post('hello'), 60_000);
  cleanups.push(() => clearInterval(hello));

  function pinHere(label = '') {
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
    const p = { lat: carto.latitude * RAD, lon: carto.longitude * RAD, label };
    getConsole().shepherd?.overlay?.dropPin?.({ ...p, fly: false });
    return post('pin', p);
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-space adam-session');
  card.id = 'adam-session';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Live session');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(el(doc, 'h2', 'adam-ops-title', LABEL_TITLE), close);
    const body = el(doc, 'div', 'adam-ops-body adam-volc-body');

    const nameInput = el(doc, 'input', 'adam-input adam-volc-search');
    nameInput.placeholder = 'your name in the room';
    nameInput.value = name;
    nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    nameInput.addEventListener('change', () => {
      name = nameInput.value.trim().slice(0, 40);
      try {
        globalThis.localStorage?.setItem(NAME_KEY, name);
      } catch {
        /* ignore */
      }
      if (room) void post('hello');
    });
    body.append(nameInput);

    const actions = el(doc, 'div', 'adam-volc-kinds adam-space-controls');
    if (!room) {
      const b = el(doc, 'button', 'adam-chip', 'start a session');
      b.type = 'button';
      b.addEventListener(
        'click',
        () => void start().catch((e) => ((error = e.message), render())),
      );
      actions.append(b);
    } else {
      const copy = el(doc, 'button', 'adam-chip', 'copy invite link');
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteUrl(location, room));
          copy.textContent = LABEL_COPIED;
        } catch {
          copy.textContent = inviteUrl(location, room);
        }
      });
      const pin = el(doc, 'button', 'adam-chip', 'pin view centre');
      pin.type = 'button';
      pin.addEventListener(
        'click',
        () => void pinHere(name ? `${name}'s pin` : 'pin'),
      );
      const out = el(doc, 'button', 'adam-chip', 'leave');
      out.type = 'button';
      out.addEventListener('click', () => void leave());
      actions.append(copy, pin, out);
    }
    body.append(actions);
    if (error) body.append(el(doc, 'p', 'adam-volc-note', error));

    if (room) {
      const people = presence(events);
      body.append(
        el(
          doc,
          'h3',
          'adam-meta adam-ops-section',
          `in the room · ${people.length}`,
        ),
      );
      for (const p of people) {
        const row = el(doc, 'div', 'adam-space-planet adam-session-person');
        const me = p.clientId === clientId;
        row.append(
          el(doc, 'span', 'adam-volc-swatch'),
          el(doc, 'span', 'adam-space-name', `${p.name}${me ? ' (you)' : ''}`),
          el(
            doc,
            'span',
            'adam-space-sub',
            p.view
              ? `${p.view.lat.toFixed(2)}, ${p.view.lon.toFixed(2)} · ${Math.round(p.view.alt / 1000)} km`
              : '',
          ),
        );
        if (!me) {
          const f = el(
            doc,
            'button',
            `adam-chip${following === p.clientId ? ' is-on' : ''}`,
            following === p.clientId ? 'following' : 'follow',
          );
          f.type = 'button';
          f.addEventListener('click', () => {
            following = following === p.clientId ? null : p.clientId;
            if (following && p.view)
              apply({ kind: 'view', clientId: p.clientId, payload: p.view });
            render();
          });
          row.append(f);
        }
        body.append(row);
      }
      body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'notes'));
      const log = el(doc, 'div', 'adam-session-log');
      for (const e of events
        .filter((x) => x.kind === 'note' || x.kind === 'pin')
        .slice(-30))
        log.append(
          el(
            doc,
            'div',
            'adam-space-sub',
            e.kind === 'note'
              ? `${e.from}: ${e.payload.text}`
              : `${e.from} pinned ${e.payload.label || ''} at ${e.payload.lat.toFixed(3)}, ${e.payload.lon.toFixed(3)}`,
          ),
        );
      body.append(log);
      const form = el(doc, 'form', 'adam-session-form');
      const msg = el(doc, 'input', 'adam-input');
      msg.placeholder = 'note to the room';
      msg.addEventListener('keydown', (e) => e.stopPropagation());
      form.append(msg);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = msg.value.trim();
        if (!text) return;
        msg.value = '';
        events.push({
          kind: 'note',
          from: name || 'you',
          clientId,
          payload: { text },
          seq: -1,
        });
        void post('note', { text });
        render();
      });
      body.append(form);
    }
    body.append(
      el(
        doc,
        'p',
        'adam-volc-note',
        'Only people with the invite link (and access to this console) can join. Views, pins and notes are shared; rooms expire after 12 hours.',
      ),
    );
    card.replaceChildren(header, body);
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) render();
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Live session: share the picture with other operators';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(card.hidden));
  const dock = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    const keys = [...rail.children].find((c) => /keys/i.test(c.textContent));
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

  // Joining from an invite link.
  const invited =
    roomFromHash(location.hash) || roomFromHash(globalThis.__adamLaunchHash);
  if (invited) {
    setTimeout(() => {
      void join(invited).then(() => setOpen(true));
    }, 1200);
  }

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    start,
    join,
    leave,
    pinHere,
    note: (text) => post('note', { text: String(text || '') }),
    shareOverlay: (overlay, title) => post('overlay', { overlay, title }),
    follow(nameOrId) {
      const p = presence(events).find(
        (x) =>
          x.clientId === nameOrId ||
          x.name.toLowerCase() === String(nameOrId || '').toLowerCase(),
      );
      following = p ? p.clientId : null;
      render();
      return { ok: Boolean(p), following: p?.name || null };
    },
    state: () => ({
      room,
      invite: room ? inviteUrl(location, room) : null,
      people: presence(events).map((p) => ({
        name: p.name,
        view: p.view || null,
      })),
      following,
    }),
    destroy() {
      void leave();
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
