import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_NAMES, RTL, TERMS, TRANSLATIONS } from './dictionary.js';
import { lookupTable, translateLabel } from './i18n.js';

test('every language translates every term', () => {
  assert.equal(Object.keys(TRANSLATIONS).length, 23);
  for (const [lang, list] of Object.entries(TRANSLATIONS)) {
    assert.equal(
      list.length,
      TERMS.length,
      `${lang} has ${list.length} of ${TERMS.length}`,
    );
    assert.ok(
      list.every((t) => typeof t === 'string' && t.trim()),
      lang,
    );
    assert.ok(LANGUAGE_NAMES[lang], lang);
  }
  assert.ok(RTL.has('ar') && RTL.has('he') && !RTL.has('ja'));
});

test('labels match whole and case-insensitively; other text is left alone', () => {
  const es = lookupTable('es');
  assert.equal(translateLabel('SETTINGS', es), 'ajustes');
  assert.equal(translateLabel(' volcanoes ', es), 'volcanes');
  assert.equal(translateLabel('Kīlauea', es), null);
  assert.equal(translateLabel('settings panel', es), null);
  assert.equal(translateLabel('maps', lookupTable('ja')), '地図');
  assert.equal(lookupTable('xx'), null);
});
