/**
 * Emoji and ad-hoc glyphs → Material Symbols. The interface speaks in one
 * icon family: layer rows, rail cards and any status text that still carries
 * an emoji render the matching symbol instead.
 *
 * Every symbol named here must be listed in index.html's icon_names subset
 * (src/ui/iconGlyphs.test.mjs checks), or it renders as its own name.
 */

export const GLYPH_SYMBOLS = Object.freeze({
  '✈️': 'flight',
  '✈': 'flight',
  '🎖️': 'military_tech',
  '🎖': 'military_tech',
  '📷': 'photo_camera',
  '📡': 'satellite_alt',
  '🔥': 'local_fire_department',
  '📹': 'videocam',
  '🌋': 'volcano',
  '🚌': 'directions_bus',
  '🚊': 'tram',
  '🚇': 'subway',
  '🚆': 'train',
  '⛴️': 'directions_boat',
  '⛴': 'directions_boat',
  '🚏': 'signpost',
  '⚡': 'bolt',
  '⚓': 'anchor',
  '⬡': 'hexagon',
  '⛔': 'block',
  '🚀': 'rocket_launch',
  '☁': 'cloud',
  '☁️': 'cloud',
  '◉': 'radar',
  ϟ: 'thunderstorm',
  '🚲': 'pedal_bike',
  '🌬': 'air',
  '🌬️': 'air',
  '🚗': 'directions_car',
  '🛰️': 'satellite_alt',
  '🛰': 'satellite_alt',
  '🚶': 'directions_walk',
  '🧭': 'explore',
  '📍': 'location_on',
  '🌊': 'waves',
  '🌙': 'dark_mode',
  '🌡️': 'thermostat',
  '🌡': 'thermostat',
  '✦': 'auto_awesome',
  '❄': 'ac_unit',
  '❄️': 'ac_unit',
  '🔎': 'search',
  '🔍': 'search',
  '🔗': 'link',
  '🛸': 'blur_on',
  '⚠️': 'warning',
  '⚠': 'warning',
  '🔴': 'radio_button_checked',
  '🟡': 'radio_button_checked',
  '➜': 'arrow_forward',
  '✨': 'auto_awesome',
  // Geometric glyphs some layers use as row icons.
  '◎': 'adjust',
  '▣': 'select_all',
  '◭': 'change_history',
  '▲': 'change_history',
  '▰': 'view_stream',
  '═': 'power_input',
  '⌬': 'hub',
  '⌖': 'my_location',
  '⋈': 'join_inner',
  '⊟': 'check_box_outline_blank',
  '≋': 'waves',
});

/** Material symbol for a glyph, or null when it has none. */
export function symbolForGlyph(glyph) {
  const key = String(glyph ?? '').trim();
  return GLYPH_SYMBOLS[key] || GLYPH_SYMBOLS[key.replace(/️/g, '')] || null;
}

/** Render an icon slot: a symbol when known, the original glyph otherwise. */
export function setIcon(node, glyph) {
  const symbol = symbolForGlyph(glyph);
  // Test doubles and very old DOMs may lack classList; the text still lands.
  if (symbol) {
    node.classList?.add?.('material-symbols-outlined', 'adam-glyph');
    node.textContent = symbol;
  } else {
    node.classList?.remove?.('material-symbols-outlined', 'adam-glyph');
    node.textContent = glyph || '';
  }
}
