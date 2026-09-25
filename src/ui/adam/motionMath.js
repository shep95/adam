/** Pure helpers for the motion language (motion.js). */

/** Layers newly enabled between two snapshots of enabled ids. */
export function newlyEnabled(before, after) {
  return [...after].filter((id) => !before.has(id));
}

/** Evenly thinned slice of positions for a trace of at most `max` points. */
export function thinPositions(positions, max = 160) {
  if (positions.length <= max) return positions.slice();
  const step = (positions.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => positions[Math.round(i * step)]);
}
