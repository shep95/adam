import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HK_IMAGE_ORIGIN,
  loadHongKongSourcesFromOpenData,
  loadNycSourcesFromOpenData,
  nycCameraToSource,
  parseHongKongCameras,
} from '../../server/providers/cctv/worldPacks.js';

test('nyc cameras normalise and pin the image host', () => {
  const cam = nycCameraToSource({
    id: '0bcfbc92-d455-4f62-846a-32afbefa3b4b',
    name: '1 Ave @ 42 St',
    latitude: 40.7488,
    longitude: -73.9695,
    area: 'Manhattan',
    isOnline: 'true',
    imageUrl: 'https://evil.example/x.jpg',
  });
  assert.equal(cam.id, 'nyc-0bcfbc92-d455-4f62-846a-32afbefa3b4b');
  assert.equal(
    cam.url,
    'https://webcams.nyctmc.org/api/cameras/0bcfbc92-d455-4f62-846a-32afbefa3b4b/image',
  );
  assert.equal(cam.city, 'Manhattan');
  assert.equal(
    nycCameraToSource({ id: 'abcd', latitude: 0, longitude: 0 }),
    null,
  );
  assert.equal(
    nycCameraToSource({
      id: 'abcd',
      latitude: 40.7,
      longitude: -74,
      isOnline: false,
    }),
    null,
  );
});

test('hong kong xml parses into pinned cameras', async () => {
  const xml = `<?xml version="1.0"?><image-list>
<image><key>H429F</key><region>Hong Kong Island</region><district>Central &amp; Western</district><description>Connaught Road Central near Exchange Square</description><easting>833546</easting><northing>816182</northing><latitude>22.2842</latitude><longitude>114.1588</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image>
<image><key>BAD KEY!</key><latitude>22.3</latitude><longitude>114.1</longitude></image>
<image><key>K109F</key><latitude>40</latitude><longitude>114.1</longitude></image>
</image-list>`;
  const cams = parseHongKongCameras(xml);
  assert.equal(cams.length, 1);
  assert.equal(cams[0].url, `${HK_IMAGE_ORIGIN}H429F.JPG`);
  assert.equal(cams[0].city, 'Central & Western, Hong Kong');
  const loaded = await loadHongKongSourcesFromOpenData({
    fetchImpl: async () => ({ ok: true, text: async () => xml }),
  });
  assert.equal(loaded.length, 1);
  const nyc = await loadNycSourcesFromOpenData({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(nyc, []);
});
