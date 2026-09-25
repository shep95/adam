import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('./historyTimeline.js', import.meta.url),
  'utf8',
)
  .replace(/import '\.\/[^']+\.css';\n/g, '')
  .replace("import * as Cesium from 'cesium';", 'const Cesium = {};')
  .replace(
    /from '\.\.\/\.\.\/history\/wars\.js'/,
    `from '${new URL('../../history/wars.js', import.meta.url).href}'`,
  )
  .replace(
    /import \{[^}]+\} from '\.\.\/\.\.\/renderGovernor\.js';/,
    'const governorRequestRender = () => {}, holdContinuousRender = () => {}, releaseContinuousRender = () => {};',
  );
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

test('slider scale gives recent centuries more room and round-trips', () => {
  assert.equal(mod.sliderToYear(0), -500);
  assert.equal(mod.sliderToYear(570), 1914);
  assert.equal(mod.sliderToYear(1000), new Date().getFullYear());
  for (const y of [-400, 0, 1066, 1776, 1916, 1968, 2001])
    assert.ok(
      Math.abs(mod.sliderToYear(mod.yearToSlider(y)) - y) <= 4,
      String(y),
    );
  assert.ok(
    mod.yearToSlider(1945) - mod.yearToSlider(1914) >
      mod.yearToSlider(400) - mod.yearToSlider(300),
  );
});
