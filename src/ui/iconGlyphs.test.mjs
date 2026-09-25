import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GLYPH_SYMBOLS, symbolForGlyph } from './iconGlyphs.js';

test('every mapped symbol is in the icon font subset', () => {
  const html = readFileSync(
    new URL('../../index.html', import.meta.url),
    'utf8',
  );
  const names = new Set(/icon_names=([a-z0-9_,]+)/.exec(html)[1].split(','));
  const list = [...names];
  assert.deepEqual(list, [...list].sort(), 'Google requires icon_names sorted');
  const missing = [...new Set(Object.values(GLYPH_SYMBOLS))].filter(
    (n) => !names.has(n),
  );
  assert.deepEqual(missing, []);
});

test('glyphs map with or without the emoji variation selector', () => {
  assert.equal(symbolForGlyph('✈️'), 'flight');
  assert.equal(symbolForGlyph('✈'), 'flight');
  assert.equal(symbolForGlyph('plain'), null);
});
