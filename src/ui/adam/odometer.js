/**
 * Odometer text: live values roll through their digit axis instead of
 * swapping. Each changed digit rolls independently, up when the value rose
 * and down when it fell, on the same hard-brake curve as the rest of the
 * chrome. Non-digit characters swap in place. Reduced motion swaps instantly.
 */

const ROLL_MS = 260;

function reducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function numericValue(text) {
  const match = /-?[\d,]*\.?\d+/.exec(String(text ?? ''));
  return match ? Number(match[0].replace(/,/g, '')) : null;
}

/**
 * Render `text` into `element`, rolling the digits that changed.
 *
 * @param {HTMLElement} element
 * @param {string|number} value
 */
export function setOdometer(element, value) {
  if (!element) return;
  const next = String(value ?? '');
  const prev = element.dataset.odometer;
  if (prev === next) return;
  element.dataset.odometer = next;
  element.setAttribute('aria-label', next);
  if (prev === undefined || reducedMotion() || prev.length !== next.length) {
    element.textContent = next;
    return;
  }
  const direction =
    (numericValue(next) ?? 0) >= (numericValue(prev) ?? 0) ? 'up' : 'down';
  const doc = element.ownerDocument;
  const fragment = doc.createDocumentFragment();
  for (let i = 0; i < next.length; i += 1) {
    const before = prev[i];
    const after = next[i];
    if (before === after || !/\d/.test(before) || !/\d/.test(after)) {
      fragment.append(doc.createTextNode(after));
      continue;
    }
    const cell = doc.createElement('span');
    cell.className = `adam-odo-cell adam-odo-${direction}`;
    cell.setAttribute('aria-hidden', 'true');
    const strip = doc.createElement('span');
    strip.className = 'adam-odo-strip';
    const from = doc.createElement('span');
    from.textContent = before;
    const to = doc.createElement('span');
    to.textContent = after;
    if (direction === 'up') strip.append(from, to);
    else strip.append(to, from);
    cell.append(strip);
    fragment.append(cell);
  }
  element.replaceChildren(fragment);
  const settle = () => {
    if (element.dataset.odometer === next) element.textContent = next;
  };
  (globalThis.setTimeout || setTimeout)(settle, ROLL_MS + 40);
}
