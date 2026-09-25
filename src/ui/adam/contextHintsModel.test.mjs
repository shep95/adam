import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./contextHints.js', import.meta.url), 'utf8')
  .replace("import './contextHints.css';", '')
  .replace(
    /import \{ sunPosition \} from '[^']+';/,
    'const sunPosition = () => ({ altitude: 10 });',
  );
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

test('the right hint for the moment, each once', () => {
  const plane = { id: 'flights:abc', aircraft: true };
  assert.equal(mod.pickHint({ altM: 9e6, tracked: plane }), 'cockpit');
  assert.equal(
    mod.pickHint(
      { altM: 9e6, tracked: plane },
      new Set(['cockpit:flights:abc']),
    ),
    null,
  );
  assert.equal(mod.pickHint({ altM: 900, overLand: true }), 'street');
  assert.equal(
    mod.pickHint({ altM: 900, overLand: true }, new Set(['street'])),
    null,
  );
  assert.equal(
    mod.pickHint({ altM: 2e6, night: true, nightVision: false }),
    'night',
  );
  assert.equal(
    mod.pickHint({ altM: 2e6, night: true, nightVision: true }),
    null,
  );
  assert.equal(mod.pickHint({ altM: 2e7, night: true }), null);
  assert.equal(
    mod.pickHint({ altM: 9e6, tracked: { id: 'ais:1', vessel: true } }),
    'vessel',
  );
});

test('street view and mapillary links open at the point', () => {
  assert.equal(
    mod.streetViewUrl(48.8584, 2.2945),
    'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=48.858400,2.294500',
  );
  assert.match(mod.mapillaryUrl(1, 2), /lat=1\.000000&lng=2\.000000/);
});
