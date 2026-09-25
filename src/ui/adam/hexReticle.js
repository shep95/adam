/**
 * Hexagonal tracking reticle: a regular hexagon (cyan #00d4ff, 1.5px, no
 * fill) cut with five facet lines between non-adjacent vertices, like a
 * gemstone seen flat. Outer frame at 100% opacity, facets at 40%.
 *
 * All animation is CSS and loops: the frame turns slowly, each facet
 * shimmers on its own phase, a trace runs round the frame, and the centre
 * pip pulses. `public/reticle-hex.svg` is the same mark as a standalone
 * asset on the #0a0c0f field; in the console it floats on the globe with no
 * background.
 */

const R = 44;
const C = 50;
/** Pointy-top vertices, clockwise from the top. */
export const HEX_VERTICES = Array.from({ length: 6 }, (_, k) => {
  const a = ((-90 + 60 * k) * Math.PI) / 180;
  return [
    Math.round((C + R * Math.cos(a)) * 100) / 100,
    Math.round((C + R * Math.sin(a)) * 100) / 100,
  ];
});

/** Facets: vertex pairs two or three apart (never adjacent). */
export const HEX_FACETS = [
  [0, 2],
  [0, 4],
  [1, 3],
  [3, 5],
  [1, 4],
];

export const RETICLE_CSS = `
.hxr { overflow: visible; }
.hxr * { vector-effect: non-scaling-stroke; }
.hxr-frame { fill: none; stroke: #00d4ff; stroke-width: 1.5; stroke-linejoin: miter; }
.hxr-spin { transform-origin: 50px 50px; animation: hxr-spin 14s linear infinite; }
.hxr-facet { stroke: #00d4ff; stroke-width: 1.5; stroke-opacity: 0.4; fill: none;
  animation: hxr-shimmer 3.2s ease-in-out infinite; }
.hxr-facet:nth-child(2) { animation-delay: -0.64s; }
.hxr-facet:nth-child(3) { animation-delay: -1.28s; }
.hxr-facet:nth-child(4) { animation-delay: -1.92s; }
.hxr-facet:nth-child(5) { animation-delay: -2.56s; }
.hxr-trace { fill: none; stroke: #00d4ff; stroke-width: 1.5; stroke-linecap: square;
  stroke-dasharray: 22 242; animation: hxr-trace 2.6s linear infinite; }
.hxr-pip { fill: #00d4ff; transform-origin: 50px 50px; animation: hxr-pip 1.6s ease-in-out infinite; }
@keyframes hxr-spin { to { transform: rotate(360deg); } }
@keyframes hxr-shimmer { 0%, 100% { stroke-opacity: 0.4; } 50% { stroke-opacity: 0.12; } }
@keyframes hxr-trace { to { stroke-dashoffset: -264; } }
@keyframes hxr-pip { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.6); } }
@media (prefers-reduced-motion: reduce) {
  .hxr-spin, .hxr-facet, .hxr-trace, .hxr-pip { animation: none; }
}`;

/**
 * @param {{background?: string|null, size?: number, title?: string}} [options]
 * @returns {string} SVG markup.
 */
export function hexReticleSvg({
  background = null,
  size = 100,
  title = '',
} = {}) {
  const pts = HEX_VERTICES.map(([x, y]) => `${x},${y}`).join(' ');
  const facets = HEX_FACETS.map(
    ([a, b]) =>
      `<line class="hxr-facet" x1="${HEX_VERTICES[a][0]}" y1="${HEX_VERTICES[a][1]}" x2="${HEX_VERTICES[b][0]}" y2="${HEX_VERTICES[b][1]}"/>`,
  ).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="hxr" viewBox="0 0 100 100" width="${size}" height="${size}"${title ? ' role="img"' : ' aria-hidden="true"'}>`,
    title ? `<title>${title}</title>` : '',
    `<style>${RETICLE_CSS}</style>`,
    background
      ? `<rect x="-50" y="-50" width="200" height="200" fill="${background}"/>`
      : '',
    `<g class="hxr-spin">`,
    `<g class="hxr-facets">${facets}</g>`,
    `<polygon class="hxr-frame" points="${pts}"/>`,
    `<polygon class="hxr-trace" points="${pts}" pathLength="264"/>`,
    `</g>`,
    `<circle class="hxr-pip" cx="50" cy="50" r="1.6"/>`,
    `</svg>`,
  ].join('');
}
