/**
 * SETTINGS: how the interface looks and reads.
 *
 *   interface font / data font   loaded from Google Fonts under the stable
 *                                names "ADAM Sans" / "ADAM Mono", so CSS and
 *                                canvas labels all follow the choice
 *   text size                    the whole interface, 70–150 %
 *   lettering                    lowercase (default) or as written
 *   panels                       drag the corner of a card to resize it;
 *                                sizes are remembered, and can be reset
 *   night side                   natural, or night vision (green)
 *   language                     interface language
 *   logo                         use your own image as logo and favicon
 *
 * Everything is stored in this browser only.
 */
import './uiSettings.css';

export const SETTINGS_KEY = 'adam.settings.v1';
const SIZES_KEY = 'adam.panel-sizes.v1';
const LOGO_KEY = 'adam.brand.logo.v1';
const SCALE_KEY = 'adam.ui.scale';
const LABEL_TITLE = 'settings';

export const SANS_FONTS = [
  { id: 'geist', label: 'Geist', family: 'Geist', axis: 'wght@300..700' },
  { id: 'inter', label: 'Inter', family: 'Inter', axis: 'wght@300..700' },
  { id: 'manrope', label: 'Manrope', family: 'Manrope', axis: 'wght@300..700' },
  {
    id: 'space-grotesk',
    label: 'Space Grotesk',
    family: 'Space Grotesk',
    axis: 'wght@300..700',
  },
  { id: 'sora', label: 'Sora', family: 'Sora', axis: 'wght@300..700' },
  { id: 'outfit', label: 'Outfit', family: 'Outfit', axis: 'wght@300..700' },
  { id: 'dm-sans', label: 'DM Sans', family: 'DM Sans', axis: 'wght@300..700' },
  {
    id: 'jakarta',
    label: 'Plus Jakarta Sans',
    family: 'Plus Jakarta Sans',
    axis: 'wght@300..700',
  },
  {
    id: 'plex-sans',
    label: 'IBM Plex Sans',
    family: 'IBM Plex Sans',
    axis: 'wght@300;400;500;600;700',
  },
  {
    id: 'noto-sans',
    label: 'Noto Sans (all scripts)',
    family: 'Noto Sans',
    axis: 'wght@300..700',
  },
  { id: 'system', label: 'system font', family: null },
];

export const MONO_FONTS = [
  {
    id: 'geist-mono',
    label: 'Geist Mono',
    family: 'Geist Mono',
    axis: 'wght@300..700',
  },
  {
    id: 'jetbrains',
    label: 'JetBrains Mono',
    family: 'JetBrains Mono',
    axis: 'wght@300..700',
  },
  {
    id: 'plex-mono',
    label: 'IBM Plex Mono',
    family: 'IBM Plex Mono',
    axis: 'wght@300;400;500;600;700',
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    family: 'Fira Code',
    axis: 'wght@300..700',
  },
  {
    id: 'roboto-mono',
    label: 'Roboto Mono',
    family: 'Roboto Mono',
    axis: 'wght@300..700',
  },
  {
    id: 'dm-mono',
    label: 'DM Mono',
    family: 'DM Mono',
    axis: 'wght@300;400;500',
  },
  {
    id: 'space-mono',
    label: 'Space Mono',
    family: 'Space Mono',
    axis: 'wght@400;700',
  },
  { id: 'system-mono', label: 'system mono', family: null },
];

export const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['pt', 'Português'],
  ['it', 'Italiano'],
  ['nl', 'Nederlands'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['pl', 'Polski'],
  ['tr', 'Türkçe'],
  ['ar', 'العربية'],
  ['he', 'עברית'],
  ['fa', 'فارسی'],
  ['hi', 'हिन्दी'],
  ['bn', 'বাংলা'],
  ['ur', 'اردو'],
  ['id', 'Bahasa Indonesia'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['zh', '中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['sw', 'Kiswahili'],
];

export const DEFAULTS = Object.freeze({
  sans: 'geist',
  mono: 'geist-mono',
  scale: 1,
  lettering: 'lowercase',
  resizable: true,
  night: 'natural',
  language: null,
});

const SYSTEM_SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SYSTEM_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Google Fonts CSS URL for one family. */
export function googleFontUrl(font) {
  if (!font?.family) return null;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family).replace(/%20/g, '+')}:${font.axis}&display=swap`;
}

/** Rename the family in Google's @font-face CSS to our stable alias. */
export function aliasFontCss(css, family, alias) {
  const esc = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(css).replace(
    new RegExp(`font-family:\\s*['"]${esc}['"]`, 'g'),
    `font-family: '${alias}'`,
  );
}

export function readSettings(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(SETTINGS_KEY) || 'null');
    const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!SANS_FONTS.some((f) => f.id === s.sans)) s.sans = DEFAULTS.sans;
    if (!MONO_FONTS.some((f) => f.id === s.mono)) s.mono = DEFAULTS.mono;
    const scale = Number(storage?.getItem(SCALE_KEY));
    s.scale =
      Number.isFinite(scale) && scale > 0 ? scale : Number(s.scale) || 1;
    s.scale = Math.max(0.7, Math.min(1.5, s.scale));
    if (!['lowercase', 'as-written'].includes(s.lettering))
      s.lettering = 'lowercase';
    if (!['natural', 'nvg'].includes(s.night)) s.night = 'natural';
    if (s.language && !LANGUAGES.some(([c]) => c === s.language))
      s.language = null;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function el(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function installUiSettings({
  doc = document,
  storage = globalThis.localStorage,
  fetchImpl = (...a) => globalThis.fetch(...a),
  getConsole = () => globalThis.__godsEyeView || {},
} = {}) {
  const cleanups = [];
  let settings = readSettings(storage);
  const root = doc.documentElement;

  const save = () => {
    try {
      storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
      storage?.setItem(SCALE_KEY, String(settings.scale));
    } catch {
      /* private mode */
    }
  };

  // ── Fonts ──────────────────────────────────────────────────────────────
  async function loadAlias(font, alias, styleId) {
    doc.getElementById(styleId)?.remove();
    if (!font.family) return true;
    const url = googleFontUrl(font);
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(String(res.status));
      const style = el(doc, 'style');
      style.id = styleId;
      style.textContent = aliasFontCss(await res.text(), font.family, alias);
      doc.head.append(style);
      return true;
    } catch {
      // Offline or blocked: the family name itself may still be loaded.
      return false;
    }
  }

  async function applyFonts() {
    const sans = SANS_FONTS.find((f) => f.id === settings.sans);
    const mono = MONO_FONTS.find((f) => f.id === settings.mono);
    root.style.setProperty(
      '--adam-font-sans',
      sans.family
        ? `'ADAM Sans', '${sans.family}', ${SYSTEM_SANS}`
        : SYSTEM_SANS,
    );
    root.style.setProperty(
      '--adam-font-mono',
      mono.family
        ? `'ADAM Mono', '${mono.family}', ${SYSTEM_MONO}`
        : SYSTEM_MONO,
    );
    await Promise.all([
      loadAlias(sans, 'ADAM Sans', 'adam-font-sans'),
      loadAlias(mono, 'ADAM Mono', 'adam-font-mono'),
    ]);
    try {
      await doc.fonts?.ready;
    } catch {
      /* ignore */
    }
    getConsole().viewer?.scene?.requestRender?.();
  }

  // ── Scale, lettering, resizing, night side, language ───────────────────
  function applyScale() {
    root.style.setProperty('--adam-ui-scale', String(settings.scale));
    root.dataset.uiScale = String(settings.scale);
  }
  function applyLettering() {
    root.dataset.case = settings.lettering;
  }
  function applyResize() {
    root.dataset.resize = settings.resizable ? 'on' : 'off';
  }
  function applyNight() {
    getConsole().nightVision?.set?.(settings.night === 'nvg');
  }
  function applyLanguage() {
    const lang =
      settings.language || (globalThis.navigator?.language || 'en').slice(0, 2);
    getConsole().i18n?.setLanguage?.(lang);
  }

  // ── Panel sizes: remember what the operator dragged ────────────────────
  const RESIZABLE =
    '.adam-maps, .adam-cctv-dir, .adam-place, .adam-settings, .adam-ops-flyout, .nat-card, .sky-card, .adam-shepherd-room';
  const readSizes = () => {
    try {
      return JSON.parse(storage?.getItem(SIZES_KEY) || '{}') || {};
    } catch {
      return {};
    }
  };
  let sizes = readSizes();
  const keyOf = (node) =>
    node.id ||
    [...node.classList].find(
      (c) => c.startsWith('adam-') || c.endsWith('-card'),
    ) ||
    null;
  const restoreSize = (node) => {
    const k = keyOf(node);
    const s = k && sizes[k];
    if (!s || !settings.resizable) return;
    node.style.width = `${s[0]}px`;
    node.style.height = `${s[1]}px`;
  };
  const onPointerUp = () => {
    let changed = false;
    for (const node of doc.querySelectorAll(RESIZABLE)) {
      if (node.hidden || !node.style.width) continue;
      const k = keyOf(node);
      const next = [
        Math.round(node.offsetWidth),
        Math.round(node.offsetHeight),
      ];
      if (k && JSON.stringify(sizes[k]) !== JSON.stringify(next)) {
        sizes[k] = next;
        changed = true;
      }
    }
    if (changed)
      try {
        storage?.setItem(SIZES_KEY, JSON.stringify(sizes));
      } catch {
        /* ignore */
      }
  };
  doc.addEventListener('pointerup', onPointerUp, true);
  cleanups.push(() => doc.removeEventListener('pointerup', onPointerUp, true));
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const node = r.target;
      if (
        node.nodeType === 1 &&
        !node.hidden &&
        node.matches?.(RESIZABLE) &&
        !node.style.width
      )
        restoreSize(node);
    }
  });
  observer.observe(doc.body, {
    attributes: true,
    attributeFilter: ['hidden', 'class'],
    subtree: true,
  });
  cleanups.push(() => observer.disconnect());
  function resetSizes() {
    sizes = {};
    try {
      storage?.removeItem(SIZES_KEY);
    } catch {
      /* ignore */
    }
    for (const node of doc.querySelectorAll(RESIZABLE)) {
      node.style.width = '';
      node.style.height = '';
    }
  }

  // ── Logo ───────────────────────────────────────────────────────────────
  function applyLogo() {
    let data = null;
    try {
      data = storage?.getItem(LOGO_KEY) || null;
    } catch {
      data = null;
    }
    for (const img of doc.querySelectorAll('.brand-logo img')) {
      img.dataset.defaultSrc ??= img.getAttribute('src');
      img.src = data || img.dataset.defaultSrc;
    }
    for (const link of doc.querySelectorAll(
      "link[rel='icon'], link[rel='apple-touch-icon']",
    )) {
      link.dataset.defaultHref ??= link.getAttribute('href');
      link.href = data || link.dataset.defaultHref;
      if (link.rel === 'icon') link.type = data ? 'image/png' : 'image/svg+xml';
    }
  }
  async function setLogo(file) {
    if (!file) return { ok: false, error: 'no file' };
    if (!/^image\//.test(file.type))
      return { ok: false, error: 'choose an image' };
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const size = 256;
      const canvas = el(doc, 'canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(
        img,
        (img.naturalWidth - s) / 2,
        (img.naturalHeight - s) / 2,
        s,
        s,
        0,
        0,
        size,
        size,
      );
      storage?.setItem(LOGO_KEY, canvas.toDataURL('image/png'));
      applyLogo();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function clearLogo() {
    try {
      storage?.removeItem(LOGO_KEY);
    } catch {
      /* ignore */
    }
    applyLogo();
  }

  // ── Panel ──────────────────────────────────────────────────────────────
  const card = el(doc, 'section', 'adam-panel adam-settings');
  card.id = 'adam-settings';
  card.hidden = true;
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Settings');
  doc.body.append(card);
  cleanups.push(() => card.remove());

  function row(label, control, note) {
    const r = el(doc, 'label', 'adam-settings-row');
    r.append(el(doc, 'span', 'adam-settings-label', label), control);
    if (note) r.append(el(doc, 'span', 'adam-settings-note', note));
    return r;
  }
  function select(options, value, onChange) {
    const s = el(doc, 'select', 'adam-settings-select');
    for (const [v, text] of options)
      s.append(new Option(text, v, false, v === value));
    s.addEventListener('change', () => onChange(s.value));
    s.addEventListener('keydown', (e) => e.stopPropagation());
    return s;
  }
  function toggle(checked, onChange) {
    const c = el(doc, 'input');
    c.type = 'checkbox';
    c.checked = checked;
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  }

  function render() {
    if (card.hidden) return;
    const header = el(doc, 'header', 'adam-ops-header');
    const close = el(doc, 'button', 'adam-ops-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => setOpen(false));
    header.append(el(doc, 'h2', 'adam-ops-title', LABEL_TITLE), close);
    const body = el(doc, 'div', 'adam-ops-body adam-settings-body');

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'type'));
    body.append(
      row(
        'interface font',
        select(
          SANS_FONTS.map((f) => [f.id, f.label]),
          settings.sans,
          (v) => update({ sans: v }),
        ),
      ),
      row(
        'data font',
        select(
          MONO_FONTS.map((f) => [f.id, f.label]),
          settings.mono,
          (v) => update({ mono: v }),
        ),
      ),
    );
    const preview = el(doc, 'div', 'adam-settings-preview');
    preview.append(
      el(
        doc,
        'div',
        'adam-settings-preview-sans',
        'strait of hormuz · 26.57n 56.25e',
      ),
      el(
        doc,
        'div',
        'adam-settings-preview-mono',
        'mmsi 636019825 · 12.4 kn · 087°',
      ),
    );
    body.append(preview);
    const scale = el(doc, 'input', 'adam-settings-range');
    scale.type = 'range';
    scale.min = '70';
    scale.max = '150';
    scale.step = '5';
    scale.value = String(Math.round(settings.scale * 100));
    const pct = el(doc, 'span', 'adam-settings-note', `${scale.value}%`);
    scale.addEventListener('input', () => {
      pct.textContent = `${scale.value}%`;
      update({ scale: Number(scale.value) / 100 }, { silent: true });
    });
    const scaleRow = row('text and panel size', scale);
    scaleRow.append(pct);
    body.append(scaleRow);
    body.append(
      row(
        'lowercase lettering',
        toggle(settings.lettering === 'lowercase', (on) =>
          update({ lettering: on ? 'lowercase' : 'as-written' }),
        ),
      ),
    );

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'panels'));
    const reset = el(doc, 'button', 'adam-chip', 'reset panel sizes');
    reset.type = 'button';
    reset.addEventListener('click', resetSizes);
    body.append(
      row(
        'resize by dragging the corner',
        toggle(settings.resizable, (on) => update({ resizable: on })),
      ),
      reset,
    );

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'globe'));
    body.append(
      row(
        'night side',
        select(
          [
            ['natural', 'natural'],
            ['nvg', 'night vision (green)'],
          ],
          settings.night,
          (v) => update({ night: v }),
        ),
      ),
    );

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'language'));
    body.append(
      row(
        'interface language',
        select(
          [['', 'browser default'], ...LANGUAGES],
          settings.language || '',
          (v) => update({ language: v || null }),
        ),
        'shepherd answers in the same language',
      ),
    );

    body.append(el(doc, 'h3', 'adam-meta adam-ops-section', 'logo'));
    const file = el(doc, 'input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    const pick = el(doc, 'button', 'adam-chip', 'use my image');
    pick.type = 'button';
    pick.addEventListener('click', () => file.click());
    const note = el(doc, 'span', 'adam-settings-note', '');
    file.addEventListener('change', async () => {
      const r = await setLogo(file.files?.[0]);
      note.textContent = r.ok
        ? 'logo and favicon updated in this browser'
        : r.error;
    });
    const back = el(doc, 'button', 'adam-chip', 'default logo');
    back.type = 'button';
    back.addEventListener('click', clearLogo);
    const logoRow = el(doc, 'div', 'adam-settings-actions');
    logoRow.append(pick, back, file, note);
    body.append(
      logoRow,
      el(
        doc,
        'p',
        'adam-settings-note',
        'for every visitor, commit the image as brand/sheep.png — the build uses it for logo, favicon and share card.',
      ),
    );

    card.replaceChildren(header, body);
  }

  function update(patch, { silent = false } = {}) {
    const before = settings;
    settings = { ...settings, ...patch };
    save();
    if (patch.sans !== undefined || patch.mono !== undefined) void applyFonts();
    if (patch.scale !== undefined) applyScale();
    if (patch.lettering !== undefined) applyLettering();
    if (patch.resizable !== undefined) {
      applyResize();
      if (!settings.resizable) resetSizes();
    }
    if (patch.night !== undefined && patch.night !== before.night) applyNight();
    if (patch.language !== undefined) applyLanguage();
    if (!silent) render();
    return settings;
  }

  function setOpen(open) {
    card.hidden = !open;
    chip.setAttribute('aria-pressed', String(open));
    if (open) {
      const flyout = doc.getElementById('adam-ops-flyout');
      if (flyout && !flyout.hidden)
        doc.querySelector('#adam-ops-flyout .adam-ops-close')?.click();
      render();
    }
  }

  const chip = el(doc, 'button', 'adam-chip adam-ops-rail-btn');
  chip.type = 'button';
  chip.title = 'Settings: fonts, size, panels, night vision, language, logo';
  chip.setAttribute('aria-pressed', 'false');
  chip.append(el(doc, 'span', 'adam-ops-rail-label', LABEL_TITLE));
  chip.addEventListener('click', () => setOpen(card.hidden));
  const dock = () => {
    const rail = doc.getElementById('adam-ops-rail');
    if (!rail) return false;
    rail.append(chip);
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
  const onKey = (event) => {
    if (event.key === 'Escape' && !card.hidden) setOpen(false);
  };
  doc.addEventListener('keydown', onKey);
  cleanups.push(() => doc.removeEventListener('keydown', onKey));

  // Apply what is stored.
  applyScale();
  applyLettering();
  applyResize();
  applyLogo();
  void applyFonts();
  // Night vision and language hook in once their modules load.
  const late = setTimeout(() => {
    if (settings.night !== 'natural') applyNight();
    applyLanguage();
  }, 1500);
  cleanups.push(() => clearTimeout(late));

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    get: () => ({ ...settings }),
    set: (patch) => update(patch || {}),
    fonts: () => ({
      sans: SANS_FONTS.map((f) => f.id),
      mono: MONO_FONTS.map((f) => f.id),
    }),
    setLogo,
    clearLogo,
    resetSizes,
    applyNight,
    applyLanguage,
    destroy() {
      for (const fn of cleanups.splice(0).reverse()) fn();
    },
  };
}
