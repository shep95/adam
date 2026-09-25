/**
 * WHAT'S HERE: a place dossier for any point — photos of the street,
 * landmarks and buildings (Wikimedia Commons, Street View, Mapillary),
 * Wikipedia pages about what stands there, named places from OpenStreetMap
 * with their websites, and a one-click web search through Shepherd.
 *
 * Places and structures only. It does not look up residents or owners, and
 * Shepherd is asked in the same terms.
 */
import './placeDossier.css';
import {
  OSM_RADIUS_M,
  normalizeOsmPlaces,
  osmPlaceQuery,
} from './placeDossierModel.js';

export { normalizeOsmPlaces, osmPlaceQuery };

const LABEL_TITLE = "what's here";
const LABEL_CLOSE = '×';
const LABEL_WEB = 'find web pages about this place';

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function link(doc, href, text, className = '') {
  const a = el(doc, 'a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export function installPlaceDossier({
  getShepherd = () => globalThis.__godsEyeView?.shepherd,
  doc = document,
} = {}) {
  const card = el(doc, 'section', 'adam-panel adam-place');
  card.hidden = true;
  card.setAttribute('aria-label', 'What is here');
  doc.body.append(card);
  let token = 0;

  function header(title, sub) {
    const h = el(doc, 'header', 'adam-place-head');
    const t = el(doc, 'div', 'adam-place-titles');
    t.append(
      el(doc, 'span', 'adam-place-kicker', LABEL_TITLE),
      el(doc, 'h2', 'adam-place-title', title),
    );
    if (sub) t.append(el(doc, 'span', 'adam-place-sub', sub));
    const x = el(doc, 'button', 'adam-place-close', LABEL_CLOSE);
    x.type = 'button';
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', close);
    h.append(t, x);
    return h;
  }

  function close() {
    card.hidden = true;
    token += 1;
  }

  async function open(lat, lon, { radius = 600 } = {}) {
    const my = ++token;
    card.hidden = false;
    card.replaceChildren(
      header(`${lat.toFixed(5)}, ${lon.toFixed(5)}`, 'looking…'),
    );
    const [place, osm] = await Promise.all([
      fetch(`/api/place?lat=${lat}&lon=${lon}&radius=${radius}`, {
        credentials: 'same-origin',
      })
        .then((r) =>
          r.ok
            ? r.json()
            : r
                .json()
                .then((b) => Promise.reject(new Error(b.error || r.status))),
        )
        .catch((e) => ({ error: e.message })),
      fetch('/api/overpass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(osmPlaceQuery(lat, lon)),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then(normalizeOsmPlaces)
        .catch(() => []),
    ]);
    if (my !== token) return null;
    const title =
      place?.wikipedia?.[0]?.distanceM < 250
        ? place.wikipedia[0].title
        : osm[0]?.name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    const body = el(doc, 'div', 'adam-place-body');

    // Street-level first: what it looks like on the ground.
    if (place?.streetView) {
      const fig = el(doc, 'figure', 'adam-place-hero');
      const img = el(doc, 'img');
      img.alt = `Street View near ${title}`;
      img.loading = 'lazy';
      img.src = `/api/place/streetview?lat=${place.streetView.lat}&lon=${place.streetView.lon}`;
      fig.append(
        img,
        el(
          doc,
          'figcaption',
          '',
          `Street View${place.streetView.date ? ` · ${place.streetView.date}` : ''} · © Google`,
        ),
      );
      body.append(fig);
    }
    const photos = [
      ...(place?.photos || []),
      ...(place?.streetLevel || []).map((m) => ({
        thumb: m.thumb,
        url: m.url,
        title: `street level ${m.capturedAt || ''}`,
        license: 'CC BY-SA (Mapillary)',
        author: null,
      })),
    ];
    if (photos.length) {
      body.append(
        el(doc, 'h3', 'adam-place-section', `photos · ${photos.length}`),
      );
      const grid = el(doc, 'div', 'adam-place-grid');
      for (const p of photos.slice(0, 18)) {
        if (!p.thumb) continue;
        const a = link(doc, p.url, '', 'adam-place-photo');
        const img = el(doc, 'img');
        img.src = p.thumb;
        img.loading = 'lazy';
        img.alt = p.description || p.title || 'photo';
        a.title = [p.title, p.author && `by ${p.author}`, p.license, p.date]
          .filter(Boolean)
          .join(' · ');
        a.append(img);
        grid.append(a);
      }
      body.append(grid);
    }
    if (place?.wikipedia?.length) {
      body.append(el(doc, 'h3', 'adam-place-section', 'about this place'));
      for (const w of place.wikipedia.slice(0, 6)) {
        const row = el(doc, 'div', 'adam-place-article');
        if (w.thumb) {
          const img = el(doc, 'img');
          img.src = w.thumb;
          img.alt = '';
          img.loading = 'lazy';
          row.append(img);
        }
        const text = el(doc, 'div');
        text.append(link(doc, w.url, w.title, 'adam-place-link'));
        if (w.distanceM != null)
          text.append(
            el(
              doc,
              'span',
              'adam-place-dist',
              ` · ${w.distanceM < 1000 ? `${w.distanceM} m` : `${(w.distanceM / 1000).toFixed(1)} km`}`,
            ),
          );
        if (w.extract)
          text.append(el(doc, 'p', 'adam-place-extract', w.extract));
        row.append(text);
        body.append(row);
      }
    }
    if (osm.length) {
      body.append(
        el(
          doc,
          'h3',
          'adam-place-section',
          `named places within ${OSM_RADIUS_M} m`,
        ),
      );
      const list = el(doc, 'ul', 'adam-place-osm');
      for (const p of osm) {
        const li = el(doc, 'li');
        li.append(
          el(doc, 'span', 'adam-place-osm-name', p.name),
          el(
            doc,
            'span',
            'adam-place-dist',
            ` · ${p.kind}${p.levels ? ` · ${p.levels} levels` : ''}${p.start ? ` · built ${p.start}` : ''}`,
          ),
        );
        if (p.website)
          li.append(' ', link(doc, p.website, 'website', 'adam-place-link'));
        if (p.wikipedia) {
          const [lang, ...rest] = p.wikipedia.split(':');
          li.append(
            ' ',
            link(
              doc,
              `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(rest.join(':'))}`,
              'wikipedia',
              'adam-place-link',
            ),
          );
        }
        list.append(li);
      }
      body.append(list);
    }
    if (
      !photos.length &&
      !place?.wikipedia?.length &&
      !osm.length &&
      !place?.streetView
    )
      body.append(
        el(
          doc,
          'p',
          'adam-place-empty',
          place?.error
            ? `No results (${place.error}).`
            : 'No public photos or pages found within this radius.',
        ),
      );

    const actions = el(doc, 'div', 'adam-place-actions');
    const web = el(doc, 'button', 'adam-chip', LABEL_WEB);
    web.type = 'button';
    web.addEventListener('click', () =>
      getShepherd()?.room?.ask?.(
        `search the web for public pages, images and documents about the place at ${lat.toFixed(5)}, ${lon.toFixed(5)}${title ? ` (${title})` : ''} — the street, landmarks, buildings, history, planning or heritage records, news about the site. list the links with one line each. places and structures only: no residents, owners or other private people.`,
      ),
    );
    actions.append(
      web,
      link(
        doc,
        `https://commons.wikimedia.org/wiki/Special:Map/16/${lat}/${lon}`,
        'commons map',
        'adam-chip',
      ),
      link(
        doc,
        `https://www.openstreetmap.org/#map=18/${lat}/${lon}`,
        'openstreetmap',
        'adam-chip',
      ),
    );
    body.append(actions);
    body.append(
      el(
        doc,
        'p',
        'adam-place-note',
        'Public photos and pages about places and structures; credits and licences on each item. Not a lookup of who lives at or owns an address.',
      ),
    );
    card.replaceChildren(
      header(
        title,
        `${lat.toFixed(5)}, ${lon.toFixed(5)} · within ${radius} m`,
      ),
      body,
    );
    return {
      ok: true,
      title,
      photos: photos.length,
      pages: (place?.wikipedia || [])
        .slice(0, 8)
        .map((w) => ({ title: w.title, url: w.url, distanceM: w.distanceM })),
      places: osm
        .slice(0, 12)
        .map((p) => ({ name: p.name, kind: p.kind, website: p.website })),
      streetView: Boolean(place?.streetView),
      sources: place?.sources || null,
    };
  }

  const onKey = (e) => {
    if (e.key === 'Escape' && !card.hidden) close();
  };
  doc.addEventListener('keydown', onKey);
  return {
    open,
    close,
    destroy() {
      doc.removeEventListener('keydown', onKey);
      card.remove();
    },
  };
}
