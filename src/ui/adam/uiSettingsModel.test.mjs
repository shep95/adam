import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// uiSettings.js imports its CSS; test the pure helpers from source text.
const src = readFileSync(new URL('./uiSettings.js', import.meta.url), 'utf8')
  .replace("import './uiSettings.css';", '')
  .replace(
    "'../../shepherd/userKeys.js'",
    JSON.stringify(new URL('../../shepherd/userKeys.js', import.meta.url).href),
  );
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

test('google font urls and the alias rewrite', () => {
  const geist = mod.SANS_FONTS.find((f) => f.id === 'geist');
  assert.equal(
    mod.googleFontUrl(geist),
    'https://fonts.googleapis.com/css2?family=Geist:wght@300..700&display=swap',
  );
  assert.equal(
    mod.googleFontUrl(mod.MONO_FONTS.find((f) => f.id === 'plex-mono')),
    'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  );
  assert.equal(mod.googleFontUrl({ family: null }), null);
  const css =
    "@font-face {\n  font-family: 'IBM Plex Mono';\n  src: url(x.woff2);\n}";
  assert.match(
    mod.aliasFontCss(css, 'IBM Plex Mono', 'ADAM Mono'),
    /font-family: 'ADAM Mono'/,
  );
});

test('settings read with defaults and bounds', () => {
  const store = (v) => ({
    getItem: (k) =>
      k === mod.SETTINGS_KEY
        ? JSON.stringify(v)
        : k === 'adam.ui.scale'
          ? '9'
          : null,
  });
  const s = mod.readSettings(
    store({
      sans: 'nope',
      mono: 'jetbrains',
      lettering: 'x',
      night: 'nvg',
      language: 'ar',
    }),
  );
  assert.equal(s.sans, 'geist');
  assert.equal(s.mono, 'jetbrains');
  assert.equal(s.lettering, 'lowercase');
  assert.equal(s.night, 'nvg');
  assert.equal(s.language, 'ar');
  assert.equal(s.scale, 1.5);
  assert.deepEqual(mod.readSettings(null), { ...mod.DEFAULTS });
});

test('every language has a native name and the font lists include a system option', () => {
  for (const [code, name] of mod.LANGUAGES) {
    assert.match(code, /^[a-z]{2}$/);
    assert.ok(name.length > 1);
  }
  assert.ok(mod.SANS_FONTS.some((f) => f.family === null));
  assert.ok(mod.MONO_FONTS.some((f) => f.family === null));
});
