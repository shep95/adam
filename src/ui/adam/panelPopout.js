/**
 * Pop a panel out into its own window — drag it to a second screen and keep
 * the globe full size. A ⧉ button sits in each panel header. The panel keeps
 * working in the new window (same page, same listeners) and comes back when
 * that window closes. Uses Document Picture-in-Picture where the browser has
 * it (always on top), a popup window otherwise.
 */
const HEADERS = '.adam-ops-header, .sky-head, .adam-place-head';
const CARDS = '.adam-panel, .nat-card, .sky-card';
const LABEL_POP = '⧉';

function copyStyles(from, to) {
  for (const sheet of [...from.styleSheets]) {
    try {
      const style = to.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      to.head.append(style);
    } catch {
      if (sheet.href) {
        const link = to.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        to.head.append(link);
      }
    }
  }
  for (const attr of [...from.documentElement.attributes])
    to.documentElement.setAttribute(attr.name, attr.value);
}

export function installPanelPopout({ doc = document, win = globalThis } = {}) {
  const popped = new Map();

  async function popOut(card) {
    if (popped.has(card)) return popped.get(card).window.focus?.();
    const width = Math.max(320, Math.round(card.offsetWidth || 420));
    const height = Math.max(240, Math.round(card.offsetHeight || 520));
    let child = null;
    try {
      child = win.documentPictureInPicture
        ? await win.documentPictureInPicture.requestWindow({ width, height })
        : win.open('', '', `popup,width=${width},height=${height}`);
    } catch {
      child = win.open('', '', `popup,width=${width},height=${height}`);
    }
    if (!child) return null;
    const cdoc = child.document;
    cdoc.title = card.getAttribute('aria-label') || 'adam';
    copyStyles(doc, cdoc);
    cdoc.body.style.margin = '0';
    cdoc.body.style.background =
      getComputedStyle(doc.body).backgroundColor || '#05090c';
    const placeholder = doc.createComment('adam-popped-panel');
    card.before(placeholder);
    card.classList.add('is-popped');
    card.hidden = false;
    cdoc.body.append(card);
    const back = () => {
      if (!popped.has(card)) return;
      popped.delete(card);
      card.classList.remove('is-popped');
      placeholder.replaceWith(card);
    };
    child.addEventListener('pagehide', back);
    popped.set(card, { window: child, back });
    return child;
  }

  function decorate(root) {
    for (const header of root.querySelectorAll?.(HEADERS) || []) {
      if (header.querySelector('.adam-popout')) continue;
      const card = header.closest(CARDS);
      if (!card) continue;
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'adam-popout';
      b.textContent = LABEL_POP;
      b.title = 'Open in its own window';
      b.setAttribute('aria-label', 'Open in its own window');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = b.closest(CARDS);
        if (c && popped.has(c)) {
          popped.get(c).window.close();
          popped.get(c)?.back();
        } else if (c) void popOut(c);
      });
      header.append(b);
    }
  }

  decorate(doc.body);
  const observer = new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes)
        if (n.nodeType === 1)
          decorate(n.matches?.(HEADERS) ? n.parentElement || n : n);
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  return {
    popOut,
    popped: () => [...popped.keys()].map((c) => c.id || c.className),
    destroy() {
      observer.disconnect();
      for (const { window: w, back } of popped.values()) {
        w.close();
        back();
      }
    },
  };
}
