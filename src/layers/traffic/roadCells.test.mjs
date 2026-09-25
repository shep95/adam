import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_DEG,
  cellsForBounds,
  createRoadCellCache,
  ringBounds,
} from './roadCells.js';

const road = (coords) => ({ coordinates: coords, type: 'primary', oneway: 0 });

test('ring bounds are cell aligned and 3x3', () => {
  const b = ringBounds({ lat: 30.27, lon: -97.74 });
  assert.equal(cellsForBounds(b).length, 9);
  assert.ok(Math.abs((b.north - b.south) / CELL_DEG - 3) < 1e-9);
  assert.ok(b.south <= 30.27 && b.north >= 30.27);
});

test('a window inside the prefetched ring is served from cells', () => {
  const cache = createRoadCellCache();
  const ring = ringBounds({ lat: 30.27, lon: -97.74 });
  const long = road([
    [-97.79, 30.23],
    [-97.7, 30.31],
  ]);
  const local = road([
    [-97.745, 30.265],
    [-97.744, 30.266],
  ]);
  const far = road([
    [-90, 10],
    [-90.1, 10.1],
  ]);
  cache.ingest(ring, [long, local, far]);
  const view = { south: 30.25, west: -97.77, north: 30.3, east: -97.72 };
  const hit = cache.lookup(view);
  assert.ok(hit);
  assert.equal(hit.filter((r) => r === long).length, 1, 'deduplicated');
  assert.ok(hit.includes(local));
  assert.ok(!hit.includes(far));
  assert.equal(cache.missing(view), false);
});

test('a window leaving the ring misses; empty cells still count as complete', () => {
  const cache = createRoadCellCache();
  const ring = ringBounds({ lat: 0.07, lon: 0.07 });
  cache.ingest(ring, []);
  assert.deepEqual(
    cache.lookup({ south: 0.05, west: 0.05, north: 0.1, east: 0.1 }),
    [],
  );
  assert.equal(
    cache.lookup({ south: 0.12, west: 0.05, north: 0.17, east: 0.1 }),
    null,
  );
});

test('capacity evicts the oldest cells', () => {
  const cache = createRoadCellCache({ maxCells: 9 });
  cache.ingest(ringBounds({ lat: 0.07, lon: 0.07 }), []);
  cache.ingest(ringBounds({ lat: 1.07, lon: 1.07 }), []);
  assert.equal(cache.size, 9);
  assert.equal(
    cache.lookup({ south: 0.05, west: 0.05, north: 0.1, east: 0.1 }),
    null,
  );
});
