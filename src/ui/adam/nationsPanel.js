/**
 * NATIONS (N): state and institutional mapping.
 *
 *   profile          name, official name, capital, region, area, borders, UN
 *   capital          fly to the seat of government
 *   government       legislature, executive, ministries, courts, embassies
 *                    around the capital, from OpenStreetMap, as an overlay
 *   infrastructure   ADAM's infrastructure layers switched on and framed on
 *                    the country
 *   summits          publicly announced multilateral summit venues
 *
 * Institutions and events only — never the whereabouts of any person.
 * All dynamic text goes through textContent.
 */
import './nationsPanel.css';
import {
  NATIONAL_INFRASTRUCTURE_LAYERS,
  describeNation,
  findNation,
  governmentQuery,
  institutionsFromOverpass,
  loadNations,
} from '../../nations/nationProfile.js';
import { orderedSummits } from '../../nations/summits.js';
import { telecomProfile } from '../../nations/telecomData.js';

const OWNERSHIP_KINDS = ['ports', 'airports', 'power', 'dams', 'refineries'];
const CONTROL_COLORS = {
  state: '#00D4FF',
  'foreign-state': '#FF5A5F',
  foreign: '#FFB454',
  private: '#9AA7AD',
};
const CONTROL_LABELS = {
  state: 'state-owned (domestic)',
  'foreign-state': 'foreign state',
  foreign: 'foreign company',
  private: 'private (domestic)',
};

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

/** Framing range for a country from its area (metres of camera range). */
export function countryRangeM(areaKm2) {
  const a = Number(areaKm2);
  if (!Number.isFinite(a) || a <= 0) return 400_000;
  return Math.max(60_000, Math.min(6_000_000, Math.sqrt(a) * 2600));
}

export function installNationsPanel({
  viewer,
  overlay,
  placeSearch,
  runGevAction,
  room,
  doc = document,
  fetchImpl = (...a) => fetch(...a),
}) {
  const cleanups = [];
  let nations = [];
  let current = null;
  let capitalPoint = null;

  const card = el(doc, 'section', 'adam-panel sky-card nat-card');
  card.id = 'adam-nations';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Nations');
  const head = el(doc, 'header', 'sky-head');
  const close = btn(doc, '×', () => setOpen(false), 'sky-close');
  close.setAttribute('aria-label', 'Close');
  head.append(
    el(doc, 'div', 'sky-kicker', 'NATIONS · STATE & INFRASTRUCTURE'),
    close,
  );

  const form = el(doc, 'form', 'nat-search');
  const input = el(doc, 'input', 'nat-input');
  input.placeholder = 'country or ISO code — france, JPN, brazil';
  input.setAttribute('aria-label', 'Country');
  input.setAttribute('list', 'adam-nations-list');
  input.autocomplete = 'off';
  const list = el(doc, 'datalist');
  list.id = 'adam-nations-list';
  form.append(
    input,
    list,
    btn(doc, 'OPEN', () => form.requestSubmit()),
  );
  const status = el(doc, 'div', 'nat-status', '');

  const profile = el(doc, 'div', 'nat-profile');
  profile.hidden = true;
  const actions = el(doc, 'div', 'sky-row nat-actions');
  actions.hidden = true;
  const summitsBox = el(doc, 'div', 'nat-summits');
  const detailBox = el(doc, 'div', 'nat-detail');

  card.append(head, form, status, profile, actions, detailBox, summitsBox);
  doc.body.append(card);
  cleanups.push(() => card.remove());

  const say = (text) => {
    status.textContent = text || '';
  };

  loadNations()
    .then((data) => {
      nations = data;
      for (const n of data) list.append(new Option(n.n, n.n));
    })
    .catch(() => say('country list unavailable'));

  async function capitalOf(n) {
    const cap = n.cap[0];
    if (cap && placeSearch?.geocode) {
      try {
        const res = await placeSearch.geocode(`${cap}, ${n.n}`);
        const p = res?.place;
        if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
          return {
            lat: p.lat,
            lon: p.lng,
            label: `${cap} · capital of ${n.n}`,
          };
      } catch {
        /* fall back to the centroid */
      }
    }
    return { lat: n.ll[0], lon: n.ll[1], label: `${n.n} (centroid)` };
  }

  function renderProfile(n) {
    const d = describeNation(n);
    profile.replaceChildren(
      el(doc, 'div', 'nat-name', d.name),
      el(doc, 'div', 'nat-official', d.official),
      el(
        doc,
        'div',
        'nat-facts',
        [
          `capital ${d.capital || '—'}`,
          d.region,
          `${Math.round(d.areaKm2 || 0).toLocaleString('en-US')} km²`,
          d.landlocked ? 'landlocked' : 'coastal',
          d.unMember ? 'UN member' : 'not a UN member',
          d.iso3,
        ].join(' · '),
      ),
    );
    if (n.b.length) {
      const borders = el(doc, 'div', 'nat-borders');
      borders.append(el(doc, 'span', 'sky-cell-title', 'BORDERS '));
      for (const code of n.b) {
        const other = nations.find((x) => x.a3 === code);
        borders.append(
          btn(doc, other?.n || code, () => void open(code), 'nat-chip'),
        );
      }
      profile.append(borders);
    }
    profile.hidden = false;
    actions.replaceChildren(
      btn(doc, 'CAPITAL', () => void flyCapital()),
      btn(doc, 'GOVERNMENT DISTRICT', () => void mapGovernment()),
      btn(doc, 'NATIONAL INFRASTRUCTURE', () => void mapInfrastructure()),
      btn(doc, 'telecom links', () => void mapTelecom()),
      btn(doc, 'who owns it', () => void mapOwnership()),
      btn(doc, 'ASK SHEPHERD', () =>
        room?.ask(
          `national infrastructure and institutions profile of ${n.n}: seat of government, key ministries, energy, ports, airports, cables, borders and chokepoints. use the nation tools, mark what matters on the map, and give confidence.`,
        ),
      ),
    );
    actions.hidden = false;
  }

  async function open(query) {
    if (!nations.length) nations = await loadNations();
    const n = findNation(nations, query);
    if (!n) {
      say(`no country matches “${query}”`);
      return null;
    }
    current = n;
    capitalPoint = null;
    detailBox.replaceChildren();
    input.value = n.n;
    say('');
    renderProfile(n);
    return n;
  }

  async function flyCapital(n = current) {
    if (!n) return null;
    say('locating capital…');
    capitalPoint = await capitalOf(n);
    overlay.dropPin({
      lat: capitalPoint.lat,
      lon: capitalPoint.lon,
      label: capitalPoint.label,
      range: 9000,
    });
    say(capitalPoint.label);
    return capitalPoint;
  }

  async function mapGovernment(n = current) {
    if (!n) return null;
    const cap = capitalPoint || (await flyCapital(n));
    say('mapping institutions from openstreetmap…');
    try {
      const response = await fetchImpl('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(governmentQuery(cap.lat, cap.lon)),
      });
      if (!response.ok) throw new Error(`overpass HTTP ${response.status}`);
      const nodes = institutionsFromOverpass(await response.json());
      overlay.drawOverlay({
        title: `${n.n} · government district`,
        nodes,
        fly: nodes.length > 0,
      });
      const counts = {};
      for (const node of nodes)
        counts[node.kind] = (counts[node.kind] || 0) + 1;
      say(
        nodes.length
          ? Object.entries(counts)
              .map(([k, v]) => `${v} ${k}`)
              .join(' · ')
          : 'no named institutions mapped near the capital',
      );
      return {
        ok: true,
        capital: cap,
        total: nodes.length,
        byKind: counts,
        sample: nodes.slice(0, 12).map((x) => `${x.kind}: ${x.label}`),
      };
    } catch (error) {
      say(`institutions unavailable: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  function detailRows(title, rows) {
    detailBox.append(el(doc, 'div', 'sky-cell-title nat-detail-title', title));
    const ul = el(doc, 'ul', 'nat-detail-list');
    for (const r of rows) ul.append(el(doc, 'li', '', r));
    detailBox.append(ul);
  }

  /** International connectivity: cables, landing stations, linked countries, exchanges. */
  async function mapTelecom(n = current) {
    if (!n) return null;
    say('building the telecom graph…');
    try {
      const t = await telecomProfile(n.a2, { fetchImpl });
      const here = t.centroid(n.a2) || n.ll;
      const nodes = [
        { id: n.a2, label: n.n, lat: here[0], lon: here[1], kind: 'country' },
      ];
      const links = [];
      for (const nb of t.neighbours) {
        const ll = t.centroid(nb.country);
        if (!ll) continue;
        nodes.push({
          id: nb.country,
          label: `${nb.name} · ${nb.cables} cable${nb.cables === 1 ? '' : 's'}`,
          lat: ll[0],
          lon: ll[1],
          kind: 'linked country',
        });
        links.push({ from: n.a2, to: nb.country, label: `${nb.cables}` });
      }
      for (const st of t.stations)
        nodes.push({
          id: `ls-${st.id}`,
          label: `${st.name} · ${st.cables} cable${st.cables === 1 ? '' : 's'}`,
          lat: st.lat,
          lon: st.lon,
          kind: 'landing station',
        });
      for (const [i, ix] of t.exchanges.entries())
        if (Number.isFinite(ix.lat))
          nodes.push({
            id: `ix-${i}`,
            label: `${ix.name}${ix.networks ? ` · ${ix.networks} networks` : ''}`,
            lat: ix.lat,
            lon: ix.lon,
            kind: 'internet exchange',
          });
      overlay.drawOverlay({
        title: `${n.n} · telecom links`,
        nodes,
        links,
        fly: true,
      });
      detailBox.replaceChildren();
      const s = t.summary;
      detailRows('telecom', [
        `${s.cables} submarine cables · ${s.landingStations} landing stations`,
        `direct cable links to ${s.directlyLinkedCountries} countries · ${s.internetExchanges} internet exchanges`,
        ...t.neighbours
          .slice(0, 12)
          .map(
            (x) => `${x.name} — ${x.cables} cable${x.cables === 1 ? '' : 's'}`,
          ),
      ]);
      detailBox.append(el(doc, 'div', 'nat-detail-note', t.sources));
      say(`${s.cables} cables · ${s.directlyLinkedCountries} linked countries`);
      const { centroid: _c, ...plain } = t;
      return { ok: true, ...plain, cables: t.cables.slice(0, 40) };
    } catch (error) {
      say(`telecom graph unavailable: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /** Who owns and operates a kind of infrastructure, from Wikidata. */
  async function mapOwnership(n = current, kind = 'ports') {
    if (!n) return null;
    if (!OWNERSHIP_KINDS.includes(kind)) kind = 'ports';
    say(`asking wikidata who owns ${kind} in ${n.n}…`);
    detailBox.replaceChildren();
    const kinds = el(doc, 'div', 'sky-row nat-kinds');
    for (const k of OWNERSHIP_KINDS) {
      const b = btn(doc, k, () => void mapOwnership(n, k), 'nat-chip');
      b.classList.toggle('is-on', k === kind);
      kinds.append(b);
    }
    detailBox.append(kinds);
    try {
      const res = await fetchImpl(
        `/api/ownership?country=${n.a2}&kind=${kind}`,
        { credentials: 'same-origin' },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      for (const f of body.features)
        f.properties['marker-color'] = CONTROL_COLORS[f.properties.control];
      const files = globalThis.__godsEyeView?.shepherd?.files;
      if (files && body.features.length)
        await files.load(
          new File(
            [JSON.stringify(body)],
            `ownership-${n.a2}-${kind}.geojson`,
            { type: 'application/geo+json' },
          ),
        );
      const s = body.summary;
      detailRows(
        `${kind} · ${s.sites} sites with an owner or operator on record`,
        [
          ...Object.entries(s.byControl)
            .filter(([, v]) => v)
            .map(([k, v]) => `${CONTROL_LABELS[k]} — ${v}`),
          ...Object.entries(s.byOwnerCountry).map(
            ([c, v]) =>
              `owned from ${nations.find((x) => x.a2 === c)?.n || c} — ${v}`,
          ),
          ...s.topParties.slice(0, 8).map((p) => `${p.name} — ${p.sites}`),
        ],
      );
      detailBox.append(el(doc, 'div', 'nat-detail-note', body.source));
      say(`${s.sites} ${kind} mapped by owner`);
      return { ok: true, country: n.n, kind, summary: s, source: body.source };
    } catch (error) {
      say(`ownership unavailable: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  async function mapInfrastructure(n = current) {
    if (!n) return null;
    say('switching on infrastructure layers…');
    const results = [];
    for (const layerId of NATIONAL_INFRASTRUCTURE_LAYERS) {
      try {
        const r = await runGevAction('set_layer_visibility', {
          layerId,
          enabled: true,
        });
        results.push({ layerId, ok: r?.ok !== false });
      } catch (error) {
        results.push({ layerId, ok: false, error: error.message });
      }
    }
    overlay.flyToPoint(n.ll[0], n.ll[1], countryRangeM(n.km2));
    const on = results.filter((r) => r.ok).length;
    say(`${on}/${results.length} infrastructure layers on · framed on ${n.n}`);
    return { ok: on > 0, layers: results };
  }

  function renderSummits() {
    summitsBox.replaceChildren(
      el(doc, 'div', 'sky-cell-title', 'SUMMITS · PUBLIC VENUES'),
    );
    for (const s of orderedSummits().slice(0, 8)) {
      const row = el(doc, 'button', `nat-summit is-${s.status}`);
      row.type = 'button';
      const when =
        s.status === 'live'
          ? 'in session'
          : s.status === 'upcoming'
            ? `in ${s.daysAway} d`
            : s.start.slice(0, 7);
      row.append(
        el(doc, 'span', 'nat-summit-name', `${s.series} · ${s.venue}`),
        el(doc, 'span', 'nat-summit-when', `${when}${s.approx ? ' ≈' : ''}`),
      );
      row.title = `${s.name} — ${s.host}, ${s.start} to ${s.end}${s.approx ? ' (announced window; confirm with the host)' : ''}`;
      row.addEventListener('click', () =>
        overlay.dropPin({
          lat: s.lat,
          lon: s.lon,
          label: `${s.series} ${s.start.slice(0, 4)} · ${s.venue}`,
          range: 6000,
        }),
      );
      summitsBox.append(row);
    }
    summitsBox.append(btn(doc, 'ALL SUMMITS ON GLOBE', () => showSummits()));
  }

  function showSummits() {
    const list = orderedSummits();
    overlay.drawOverlay({
      title: 'multilateral summits',
      nodes: list.map((s) => ({
        id: s.id,
        label: `${s.series} ${s.start.slice(0, 4)} · ${s.venue}`,
        lat: s.lat,
        lon: s.lon,
        kind: 'event',
        confidence: s.approx ? 0.6 : 0.95,
        note: `${s.name}, ${s.start} – ${s.end} (${s.status})`,
      })),
      fly: true,
    });
    return list.map((s) => ({
      id: s.id,
      name: s.name,
      venue: s.venue,
      host: s.host,
      start: s.start,
      end: s.end,
      status: s.status,
      approx: Boolean(s.approx),
    }));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void open(input.value);
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());

  // Rail chip.
  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Nations: state and infrastructure mapping (N)';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(
    el(doc, 'span', 'adam-ops-rail-label', 'NATIONS'),
    el(doc, 'kbd', 'adam-ops-rail-key', 'N'),
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

  function setOpen(openNow) {
    card.hidden = !openNow;
    chip.setAttribute('aria-pressed', String(openNow));
    if (openNow) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        globalThis.__godsEyeView?.opsDeck?.toggleView?.('brief', false);
      doc.getElementById('adam-sky') &&
        !doc.getElementById('adam-sky').hidden &&
        globalThis.__godsEyeView?.skyPanel?.close();
      renderSummits();
      card.classList.remove('adam-lock-in');
      void card.offsetWidth;
      card.classList.add('adam-lock-in');
      setTimeout(() => input.focus({ preventScroll: true }), 50);
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
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      setOpen(card.hidden);
    } else if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    /** Shepherd: profile a nation and optionally map it. */
    async profile({
      country,
      government = false,
      infrastructure = false,
      capital = true,
    } = {}) {
      const n = await open(String(country || ''));
      if (!n) return { ok: false, error: `no country matches "${country}"` };
      setOpen(true);
      const out = { ok: true, nation: describeNation(n) };
      if (capital || government) out.capital = await flyCapital(n);
      if (government) out.government = await mapGovernment(n);
      if (infrastructure) out.infrastructure = await mapInfrastructure(n);
      return out;
    },
    showSummits,
    async telecom({ country } = {}) {
      const n = await open(String(country || ''));
      if (!n) return { ok: false, error: `no country matches "${country}"` };
      setOpen(true);
      return mapTelecom(n);
    },
    async ownership({ country, kind } = {}) {
      const n = await open(String(country || ''));
      if (!n) return { ok: false, error: `no country matches "${country}"` };
      setOpen(true);
      return mapOwnership(n, kind);
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
