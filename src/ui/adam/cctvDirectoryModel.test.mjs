import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countryFor,
  formatKm,
  groupDirectory,
  nearestCameras,
  searchCameras,
} from './cctvDirectoryModel.js';

const cams = [
  {
    id: 'a1',
    name: 'Congress & 6th',
    city: 'Austin',
    cityId: 'austin',
    provider: 'Austin Transportation & Public Works',
    lat: 30.268,
    lon: -97.742,
    feedType: 'image',
  },
  {
    id: 't1',
    name: 'I-35 @ Riverside',
    cityId: 'tx-aus',
    provider: 'TxDOT',
    lat: 30.25,
    lon: -97.73,
    feedType: 'image',
  },
  {
    id: 'c1',
    name: 'US-101 at Vine',
    cityId: 'ca-d7',
    provider: 'Caltrans',
    lat: 34.1,
    lon: -118.33,
    feedType: 'hls',
  },
  {
    id: 'l1',
    name: 'Tower Bridge',
    city: 'London',
    cityId: 'london',
    provider: 'Transport for London',
    lat: 51.505,
    lon: -0.075,
    feedType: 'mp4',
  },
  {
    id: 'f1',
    name: 'vt4 Helsinki',
    city: 'Finland',
    cityId: 'finland',
    provider: 'Fintraffic',
    lat: 60.17,
    lon: 24.94,
  },
  {
    id: 'n1',
    name: 'Harbour Bridge',
    cityId: 'nsw',
    provider: 'Live Traffic NSW',
    lat: -33.85,
    lon: 151.21,
  },
  { id: 'bad', name: 'no position', cityId: 'austin' },
];

test('country is derived from region id or agency', () => {
  assert.deepEqual(cams.slice(0, 6).map(countryFor), [
    'US',
    'US',
    'US',
    'GB',
    'FI',
    'AU',
  ]);
  assert.equal(countryFor({ cityId: 'british-columbia' }), 'CA');
  assert.equal(countryFor({ cityId: 'tallinn' }), 'EE');
  assert.equal(countryFor({ cityId: 'warendorf-x' }), 'DE');
});

test('directory groups by country then agency, largest first', () => {
  const dir = groupDirectory(cams);
  assert.equal(dir[0].code, 'US');
  assert.equal(dir[0].count, 3);
  assert.equal(dir[0].agencies.length, 3);
  const caltrans = dir[0].agencies.find((a) => a.provider === 'Caltrans');
  assert.equal(caltrans.video, 1);
  assert.equal(caltrans.anchor.id, 'c1');
  assert.equal(
    dir.reduce((s, c) => s + c.count, 0),
    6,
    'invalid rows skipped',
  );
});

test('search matches every word across name, city, agency and country', () => {
  assert.deepEqual(
    searchCameras(cams, 'bridge').map((c) => c.id),
    ['l1', 'n1'],
  );
  assert.deepEqual(
    searchCameras(cams, 'bridge united kingdom').map((c) => c.id),
    ['l1'],
  );
  assert.deepEqual(
    searchCameras(cams, 'txdot i-35').map((c) => c.id),
    ['t1'],
  );
  assert.deepEqual(searchCameras(cams, '  '), []);
});

test('nearest cameras are ranked by distance', () => {
  const near = nearestCameras(cams, 30.27, -97.74, 2);
  assert.deepEqual(
    near.map((n) => n.camera.id),
    ['a1', 't1'],
  );
  assert.ok(near[0].km < 1);
  assert.equal(formatKm(0.25), '250 m');
  assert.equal(formatKm(12.34), '12.3 km');
  assert.equal(formatKm(8123), '8,123 km');
});
