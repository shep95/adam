import test from 'node:test';
import assert from 'node:assert/strict';
import { HEX_FACETS, HEX_VERTICES, hexReticleSvg } from './hexReticle.js';

test('the frame is a regular hexagon', () => {
  const side = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const sides = HEX_VERTICES.map((v, i) => side(v, HEX_VERTICES[(i + 1) % 6]));
  for (const s of sides) assert.ok(Math.abs(s - sides[0]) < 0.05);
});

test('facets join only non-adjacent vertices, 4-5 of them', () => {
  assert.ok(HEX_FACETS.length >= 4 && HEX_FACETS.length <= 5);
  for (const [a, b] of HEX_FACETS) {
    const gap = Math.min((a - b + 6) % 6, (b - a + 6) % 6);
    assert.ok(gap >= 2, `${a}-${b} is adjacent`);
  }
});

test('markup: cyan 1.5px, no fill, facets at 40%, CSS-only looping animation', () => {
  const svg = hexReticleSvg({ background: '#0a0c0f' });
  assert.match(svg, /stroke: #00d4ff; stroke-width: 1\.5/);
  assert.match(svg, /\.hxr-frame \{ fill: none/);
  assert.match(svg, /stroke-opacity: 0\.4/);
  assert.match(svg, /fill="#0a0c0f"/);
  assert.equal(
    (svg.match(/class="hxr-facet"/g) || []).length,
    HEX_FACETS.length,
  );
  assert.equal((svg.match(/infinite/g) || []).length, 4);
  assert.ok(!/<script/i.test(svg));
  assert.ok(!hexReticleSvg().includes('<rect'), 'overlay has no background');
});
