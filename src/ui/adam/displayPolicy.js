/**
 * Fixed display policy (operator directive):
 *
 *   scope      a plain on/off switch; when on it runs at 100%
 *   HUD        always the TACTICAL layout; the layout picker is gone
 *   removed    Bloom, Sharpen and Clean UI (and the V shortcut)
 *
 * The controls stay in the markup, hidden, because the shell's bindings and
 * share-link restore read them; this module pins their state through the
 * shell's own paths so storage and share links agree with what is shown.
 */
import './displayPolicy.css';

export const SCOPE_FEATHER_PCT = 100;

/**
 * Visual preset profile. `ops` (default) puts the operational sensor modes
 * first and hides the non-operational looks; `full` shows all seven.
 * Set VITE_ADAM_PRESET_PROFILE=full at build time for the full list.
 */
export const PRESET_PROFILES = Object.freeze({
  ops: Object.freeze(['normal', 'surveillance', 'thermal', 'retro']),
  full: Object.freeze([
    'normal',
    'surveillance',
    'thermal',
    'retro',
    'noir',
    'snow',
    'anime',
  ]),
});

export function presetProfile(value) {
  return String(value || '').toLowerCase() === 'full' ? 'full' : 'ops';
}

function applyPresetProfile(doc, profile) {
  const order = PRESET_PROFILES[profile];
  doc.documentElement.dataset.adamPresets = profile;
  for (const btn of doc.querySelectorAll(
    '#style-buttons .style-btn[data-style]',
  )) {
    const index = order.indexOf(btn.dataset.style);
    btn.hidden = index < 0;
    btn.style.order = String(index < 0 ? 99 : index);
  }
}

function setRange(input, value) {
  if (!input || String(input.value) === String(value)) return;
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelect(select, value) {
  if (!select || select.value === value) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

export function applyDisplayPolicy({
  styleManager,
  doc = document,
  profile = presetProfile(import.meta.env?.VITE_ADAM_PRESET_PROFILE),
}) {
  applyPresetProfile(doc, profile);
  const enforce = () => {
    setRange(doc.getElementById('scope-feather-slider'), SCOPE_FEATHER_PCT);
    setSelect(doc.getElementById('hud-layout-select'), 'tactical');
    try {
      if (styleManager?.bloomEnabled)
        styleManager.setBloom?.({ enabled: false });
      if (styleManager?.sharpenEnabled)
        styleManager.setSharpen?.({ enabled: false });
      if (doc.body.classList.contains('ui-clean-view'))
        styleManager.toggleCleanView?.(false);
    } catch (error) {
      console.warn('[adam] display policy:', error);
    }
  };
  enforce();
  // Share links and stored sessions restore after boot; re-pin once they land.
  const late = [800, 3000].map((ms) => setTimeout(enforce, ms));
  return {
    enforce,
    destroy() {
      late.forEach(clearTimeout);
    },
  };
}
