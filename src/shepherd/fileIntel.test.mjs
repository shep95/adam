import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOC_CHAR_LIMIT,
  classifyFile,
  documentPrompt,
  documentText,
  isGeoJson,
} from './fileIntel.js';

test('files are routed by type and extension', () => {
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }), 'image');
  assert.equal(classifyFile({ name: 'zones.geojson', type: '' }), 'geo');
  assert.equal(classifyFile({ name: 'route.kmz', type: '' }), 'geo');
  assert.equal(classifyFile({ name: 'report.md', type: '' }), 'document');
  assert.equal(classifyFile({ name: 'notes', type: 'text/plain' }), 'document');
  assert.equal(
    classifyFile({ name: 'data.json', type: 'application/json' }),
    'document',
  );
  assert.equal(classifyFile({ name: 'x.exe', type: '' }), null);
});

test('GeoJSON detection', () => {
  assert.ok(isGeoJson({ type: 'FeatureCollection', features: [] }));
  assert.ok(isGeoJson({ type: 'Point', coordinates: [0, 0] }));
  assert.ok(!isGeoJson({ type: 'Other' }));
  assert.ok(!isGeoJson([]));
});

test('document text strips markup and caps length', () => {
  const html = documentText(
    '<html><style>x{}</style><p>Port of&nbsp;Aden</p><script>1</script></html>',
    'a.html',
  );
  assert.equal(html.text, 'Port of Aden');
  const long = documentText('x'.repeat(DOC_CHAR_LIMIT + 10), 'a.txt');
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, DOC_CHAR_LIMIT);
});

test('document prompt frames the text and keeps the privacy line', () => {
  const p = documentPrompt({ name: 'r.txt', text: 'hello', truncated: false });
  assert.match(p, /\[document: r\.txt\]\nhello\n\[end of document\]/);
  assert.match(p, /do not profile private individuals/);
  assert.match(
    documentPrompt({ name: 'r', text: '', truncated: true }, 'just summarise'),
    /^just summarise/,
  );
});
