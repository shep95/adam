import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameBudget } from './frameBudget.js';

function run(budget, frameMs, fromMs, durationMs) {
  let t = fromMs;
  while (t < fromMs + durationMs) {
    t += frameMs;
    budget.sample(frameMs, t);
  }
  return t;
}

test('stays full at 60 fps', () => {
  const b = createFrameBudget();
  run(b, 16.7, 0, 10_000);
  assert.equal(b.reduced, false);
});

test('reduces after sustained slow frames, not on a spike', () => {
  const b = createFrameBudget();
  let t = run(b, 16.7, 0, 2000);
  t = run(b, 60, t, 1000);
  t = run(b, 16.7, t, 2000);
  assert.equal(b.reduced, false);
  run(b, 50, t, 5000);
  assert.equal(b.reduced, true);
});

test('ignores idle gaps and hidden-tab pauses', () => {
  const b = createFrameBudget();
  let t = 0;
  for (let i = 0; i < 200; i += 1) b.sample(900, (t += 900));
  assert.equal(b.reduced, false);
});

test('probes back to full; a failed probe doubles the back-off', () => {
  const b = createFrameBudget({ probeAfterMs: 10_000 });
  let t = run(b, 50, 0, 5000);
  assert.equal(b.reduced, true);
  assert.equal(b.tick(t + 5000), true);
  t += 10_000;
  assert.equal(b.tick(t), false);
  t = run(b, 50, t, 5000);
  assert.equal(b.reduced, true);
  assert.equal(b.probeMs, 20_000);
  t += 20_000;
  b.tick(t);
  run(b, 16, t, 5000);
  assert.equal(b.reduced, false);
  assert.equal(b.probeMs, 10_000);
});
