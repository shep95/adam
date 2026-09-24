/**
 * One shared context card for clicked infrastructure and airspace features.
 * Text only (textContent), external links open with noopener, Escape closes.
 */

let card = null;
let removeKey = null;
let generation = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function ensureCard() {
  if (card?.isConnected) return card;
  card = el('aside', 'adam-panel adam-context-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  document.body.append(card);
  return card;
}

/** Render rows into the card body. */
function renderRows(body, rows) {
  const dl = el('dl', 'adam-context-rows');
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === '') continue;
    dl.append(el('dt', 'adam-meta', String(label).toUpperCase()));
    dl.append(el('dd', 'adam-value', value));
  }
  body.replaceChildren(dl);
}

/**
 * @param {{kicker?: string, title: string, rows?: Array<[string, any]>,
 *          link?: ?{href: string, label: string}, note?: ?string,
 *          loadMore?: ?() => Promise<{rows?: Array, note?: string}>,
 *          position?: {x: number, y: number}, accent?: string}} spec
 */
export function showContextCard(spec) {
  const node = ensureCard();
  const current = ++generation;
  node.replaceChildren();
  node.style.setProperty(
    '--card-accent',
    spec.accent || 'var(--accent-primary)',
  );
  const header = el('header', 'adam-context-header');
  header.append(
    el('span', 'adam-meta adam-context-kicker', spec.kicker || 'CONTEXT'),
  );
  header.append(el('h3', 'adam-value adam-context-title', spec.title || ''));
  const close = el('button', 'adam-ops-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', hideContextCard);
  header.append(close);
  node.append(header);
  const body = el('div', 'adam-context-body');
  renderRows(body, spec.rows || []);
  node.append(body);
  const note = el('p', 'adam-meta adam-context-note', spec.note || '');
  node.append(note);
  if (spec.link?.href && /^https:\/\//.test(spec.link.href)) {
    const link = el(
      'a',
      'adam-meta adam-context-link',
      spec.link.label || 'Source',
    );
    link.href = spec.link.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    node.append(link);
  }
  const x = Math.min(
    window.innerWidth - 340,
    Math.max(16, (spec.position?.x ?? 200) + 16),
  );
  const y = Math.min(
    window.innerHeight - 260,
    Math.max(80, (spec.position?.y ?? 200) - 20),
  );
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.hidden = false;
  node.classList.remove('adam-lock-in');
  void node.offsetWidth;
  node.classList.add('adam-lock-in');
  removeKey?.();
  const onKey = (event) => {
    if (event.key === 'Escape') hideContextCard();
  };
  document.addEventListener('keydown', onKey);
  removeKey = () => document.removeEventListener('keydown', onKey);
  if (typeof spec.loadMore === 'function') {
    note.textContent = 'Loading details…';
    spec
      .loadMore()
      .then((more) => {
        if (current !== generation) return;
        if (more?.rows) renderRows(body, more.rows);
        note.textContent = more?.note || spec.note || '';
      })
      .catch(() => {
        if (current !== generation) return;
        note.textContent = spec.note || 'Details are unavailable right now.';
      });
  }
}

export function hideContextCard() {
  generation += 1;
  removeKey?.();
  removeKey = null;
  if (card) card.hidden = true;
}
