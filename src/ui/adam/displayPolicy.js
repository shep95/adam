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

export function applyDisplayPolicy({ styleManager, doc = document }) {
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
