import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  SHORTCUTS,
  currentShortcutMode,
  shortcutsForMode,
} from './shortcutRegistry.js';

const listed = (key, mode) =>
  SHORTCUTS.some(
    (s) =>
      s.modes.includes(mode) && s.keys.some((k) => k.toLowerCase() === key),
  );

test('every application shortcut binding is listed for the globe', () => {
  const source = fs.readFileSync(
    new URL('./applicationShortcuts.js', import.meta.url),
    'utf8',
  );
  const letters = [...source.matchAll(/key === '([a-z])'/g)].map((m) => m[1]);
  // V (clean view) was retired with the Clean UI control.
  assert.ok(letters.length >= 5);
  for (const key of letters) assert.ok(listed(key, 'globe'), `${key} missing`);
  for (const digit of ['1', '2', '3', '4', '5', '6', '7'])
    assert.ok(listed(digit, 'globe'), `${digit} missing`);
});

test('ADAM, voice and cockpit keys are listed in their modes', () => {
  assert.ok(listed('?', 'globe'));
  assert.ok(listed('?', 'cockpit'));
  assert.ok(listed('b', 'globe'));
  assert.ok(listed('p', 'tracking'));
  assert.ok(listed('space', 'cockpit'));
  assert.ok(listed('c', 'cockpit'));
  assert.ok(listed('esc', 'tracking'));
});

test('modes are read from document and viewer state', () => {
  const doc = (cockpit) => ({
    body: { classList: { contains: () => cockpit } },
  });
  assert.equal(currentShortcutMode(doc(true), null), 'cockpit');
  assert.equal(
    currentShortcutMode(doc(false), { trackedEntity: {} }),
    'tracking',
  );
  assert.equal(currentShortcutMode(doc(false), {}), 'globe');
  const groups = shortcutsForMode('cockpit').map((g) => g.group);
  assert.ok(groups.includes('Cockpit'));
  assert.ok(!groups.includes('Panels'));
});
