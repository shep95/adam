import test from 'node:test';
import assert from 'node:assert/strict';
import { hoverLines, isOpenWater, placeFromZone } from './hoverContextModel.js';

test('hormuz: the strait, the zone, the watch item, open water', () => {
  const lines = hoverLines(
    { lat: 26.5, lon: 56.4 },
    {
      zone: 'Etc/GMT-4',
      localTime: '12:03 GMT+4',
      zones: [
        {
          name: 'box',
          ring: [
            [56, 26],
            [57, 26],
            [57, 27],
            [56, 27],
          ],
        },
      ],
      mission: {
        areas: [{ lat: 26.5, lon: 56.3, radiusKm: 100, label: 'Hormuz' }],
      },
      watch: [
        { score: 72, title: 'ORBIT', lat: 26.6, lon: 56.5 },
        { score: 90, title: 'FAR', lat: 0, lon: 0 },
      ],
    },
  );
  assert.match(lines[0], /^Strait of Hormuz · ~39 km wide/);
  assert.ok(lines.includes('inside zone box'));
  assert.ok(lines.includes('mission area Hormuz'));
  assert.ok(lines.includes('watch 72 · orbit'));
  assert.ok(!lines.some((l) => /far/.test(l)));
  assert.equal(lines.at(-1), 'open water · 12:03 GMT+4');
});

test('land reads its time zone; bad zones read as water', () => {
  assert.equal(placeFromZone('America/Chicago'), 'Chicago · america time zone');
  assert.equal(isOpenWater('Etc/GMT+6'), true);
  assert.equal(isOpenWater(null), true);
  assert.deepEqual(
    hoverLines({ lat: 30.27, lon: -97.74 }, { zone: 'America/Chicago' }),
    ['Chicago · america time zone'],
  );
});
