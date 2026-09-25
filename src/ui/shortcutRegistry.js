/**
 * Every keyboard shortcut the application binds, in one list, so the `?`
 * overlay can show what is live in the current mode. The owning modules still
 * bind their own keys; this registry only describes them. When you add a
 * binding, add its row here (src/ui/shortcutRegistry.test.mjs checks the
 * known bindings stay listed).
 */

export const SHORTCUT_MODES = Object.freeze(['globe', 'tracking', 'cockpit']);

export const SHORTCUTS = Object.freeze([
  {
    keys: ['?'],
    action: 'Show or hide this shortcut reference',
    group: 'ADAM',
    modes: ['globe', 'tracking', 'cockpit'],
  },
  {
    keys: ['B'],
    action: 'Situational brief across all loaded layers',
    group: 'ADAM',
    modes: ['globe', 'tracking', 'cockpit'],
  },
  {
    keys: ['A'],
    action: 'Alert triggers',
    group: 'ADAM',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['G'],
    action: 'Filters: time window, region, altitude, vessel type',
    group: 'ADAM',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['P'],
    action: 'Pin the tracked contact to the comparison rail',
    group: 'ADAM',
    modes: ['tracking', 'cockpit'],
  },
  {
    keys: ['S'],
    action: 'Open or close Shepherd, the text analyst',
    group: 'ADAM',
    modes: ['globe', 'tracking', 'cockpit'],
  },
  {
    keys: ['L'],
    action: 'Live environment: sun, moon, stars, shadows, weather, time',
    group: 'ADAM',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['N'],
    action: 'Nations: state institutions, infrastructure and summit venues',
    group: 'ADAM',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['R'],
    action: 'Rewind: scrub the last 45 minutes of tracks',
    group: 'ADAM',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['Space'],
    action: 'Hold to talk to the voice analyst',
    group: 'Voice',
    modes: ['globe', 'tracking', 'cockpit'],
  },
  {
    keys: ['1'],
    action: 'Style: Normal',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['2'],
    action: 'Style: CRT',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['3'],
    action: 'Style: NVG (night vision)',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['4'],
    action: 'Style: FLIR (thermal)',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['5'],
    action: 'Style: Anime',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['6'],
    action: 'Style: Noir',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['7'],
    action: 'Style: Snow',
    group: 'Visual style',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['H'],
    action: 'Toggle the intelligence HUD',
    group: 'View',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['O'],
    action: 'Toggle orbit around the view target',
    group: 'View',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['D'],
    action: 'Cycle object detection density',
    group: 'View',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['`'],
    action: 'Toggle the frame-rate readout',
    group: 'View',
    modes: ['globe', 'tracking', 'cockpit'],
  },
  {
    keys: ['F'],
    action: 'Open or close Data Layers',
    group: 'Panels',
    modes: ['globe', 'tracking'],
  },
  {
    keys: ['C'],
    action: 'Open or close the CCTV panel',
    group: 'Panels',
    modes: ['globe'],
  },
  {
    keys: ['C'],
    action: 'Enter the cockpit of the tracked aircraft',
    group: 'Tracking',
    modes: ['tracking'],
  },
  {
    keys: ['C'],
    action: 'Leave the cockpit',
    group: 'Cockpit',
    modes: ['cockpit'],
  },
  {
    keys: ['Esc'],
    action: 'Stop tracking the selected contact',
    group: 'Tracking',
    modes: ['tracking'],
  },
  {
    keys: ['Esc'],
    action: 'Leave the cockpit',
    group: 'Cockpit',
    modes: ['cockpit'],
  },
  {
    keys: ['Esc'],
    action: 'Close search, menus and dialogs',
    group: 'Panels',
    modes: ['globe'],
  },
]);

/** Current shortcut mode from document state. */
export function currentShortcutMode(
  doc = typeof document === 'undefined' ? null : document,
  viewer = null,
) {
  if (doc?.body?.classList?.contains('cockpit-mode')) return 'cockpit';
  if (viewer?.trackedEntity) return 'tracking';
  return 'globe';
}

/** Shortcuts active in a mode, grouped in registry order. */
export function shortcutsForMode(mode) {
  const groups = new Map();
  for (const shortcut of SHORTCUTS) {
    if (!shortcut.modes.includes(mode)) continue;
    if (!groups.has(shortcut.group)) groups.set(shortcut.group, []);
    groups.get(shortcut.group).push(shortcut);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
