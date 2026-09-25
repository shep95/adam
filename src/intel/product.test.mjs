import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProduct, confidenceWord } from './product.js';

test('product: marking top and bottom, all sections, escaped content', () => {
  const html = buildProduct({
    title: 'Hormuz <watch>',
    marking: 'UNCLASSIFIED // TRAINING',
    at: Date.UTC(2026, 8, 25, 7, 30),
    bluf: 'Two vessels went dark.',
    assessment: 'Line one\n\nLine <two>',
    mapImage: 'data:image/png;base64,AAAA',
    findings: [
      {
        id: 'F-001',
        subject: 'RUNNER dark',
        location: { lat: 26.5, lon: 56.3, label: 'Hormuz' },
        time: '2026-09-25T07:00Z',
        confidence: 0.6,
        source: 'AIS',
        assessment: 'x',
        alternative: 'coverage gap',
      },
    ],
    watch: [
      { score: 80, title: 'ORBIT', label: 'y', lat: 1, lon: 2, why: 'z' },
    ],
    actions: [{ at: 0, tool: 'set_layers', args: '{"a":"<b>"}', ok: true }],
    sources: [
      { name: 'AIS', source: 'aisstream', feedState: 'nominal', count: 10 },
    ],
  });
  assert.equal((html.match(/UNCLASSIFIED \/\/ TRAINING/g) || []).length, 2);
  for (const h of [
    'Bottom line up front',
    'Map extract',
    'Findings',
    'Contact log',
    'Event log',
    'Analyst actions',
    'Sources',
    'Confidence key',
  ])
    assert.ok(html.includes(h), h);
  assert.ok(html.includes('Hormuz &lt;watch&gt;'));
  assert.ok(!html.includes('<watch>'));
  assert.ok(html.includes('Line &lt;two&gt;'));
  assert.ok(html.includes('moderate (0.60)'));
  assert.ok(html.includes('Alternative: coverage gap'));
  assert.ok(html.includes('2026-09-25T07:30:00Z'));
  assert.ok(!/<script/i.test(html));
});

test('non-data images are refused; confidence words', () => {
  const html = buildProduct({ mapImage: 'https://evil/x.png' });
  assert.ok(!html.includes('evil'));
  assert.equal(confidenceWord(0.85), 'high');
  assert.equal(confidenceWord(0.2), 'very low');
  assert.equal(confidenceWord(null), 'not stated');
});
