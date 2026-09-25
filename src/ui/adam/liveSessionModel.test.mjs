import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./liveSession.js', import.meta.url), 'utf8')
  .replace(/import '\.\/[^']+\.css';\n/g, '')
  .replace("import * as Cesium from 'cesium';", 'const Cesium = {};');
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

test('invite links round-trip', () => {
  const url = mod.inviteUrl(
    { origin: 'https://adam.example', pathname: '/', search: '' },
    'AbCdEfGhIjKlMnOp',
  );
  assert.equal(url, 'https://adam.example/#live=AbCdEfGhIjKlMnOp');
  assert.equal(mod.roomFromHash('#live=AbCdEfGhIjKlMnOp'), 'AbCdEfGhIjKlMnOp');
  assert.equal(
    mod.roomFromHash('#scene=x&live=AbCdEfGhIjKlMnOp'),
    'AbCdEfGhIjKlMnOp',
  );
  assert.equal(mod.roomFromHash('#live=bad'), null);
});

test('presence keeps the latest view per operator and drops leavers and the idle', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const at = (s) => new Date(now - s * 1000).toISOString();
  const people = mod.presence(
    [
      { kind: 'hello', clientId: 'a', from: 'ana', at: at(50) },
      {
        kind: 'view',
        clientId: 'a',
        from: 'ana',
        at: at(10),
        payload: { lat: 1, lon: 2, alt: 3 },
      },
      { kind: 'hello', clientId: 'b', from: 'ben', at: at(30) },
      { kind: 'bye', clientId: 'b', from: 'ben', at: at(5) },
      { kind: 'hello', clientId: 'c', from: 'cy', at: at(600) },
    ],
    now,
  );
  assert.deepEqual(
    people.map((p) => p.name),
    ['ana'],
  );
  assert.equal(people[0].view.lon, 2);
});
