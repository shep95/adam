import test from 'node:test';
import assert from 'node:assert/strict';
import { flyToAustin } from '../camera.js';

test('teardown before the initial camera delay prevents a late flight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let flights = 0;
  let cancelled = 0;
  const stop = flyToAustin({
    isDestroyed: () => false,
    camera: {
      setView() {},
      flyTo() {
        flights++;
      },
      cancelFlight() {
        cancelled++;
      },
    },
  });
  stop();
  t.mock.timers.tick(1000);
  assert.equal(flights, 0);
  assert.equal(cancelled, 1);
});

test('the default start is the whole globe, centred on the local side', async (t) => {
  const { flyToGlobe, homeLongitude } = await import('../camera.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const views = [];
  const stop = flyToGlobe(
    {
      isDestroyed: () => false,
      camera: {
        setView: (v) => views.push(v),
        flyTo: (v) => views.push(v),
        cancelFlight() {},
      },
    },
    { lon: -90, lat: 20 },
  );
  t.mock.timers.tick(500);
  assert.equal(views.length, 2);
  stop();
  assert.equal(homeLongitude(300), -75, 'UTC−5 → 75°W');
  assert.equal(homeLongitude(-540), 135, 'UTC+9 → 135°E');
});
