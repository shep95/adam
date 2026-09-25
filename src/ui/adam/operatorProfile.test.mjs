import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  applyProfile,
  canonicalJson,
  collectProfile,
  profileKeyAllowed,
  sealProfile,
  verifyProfile,
} from './operatorProfile.js';

const subtle = webcrypto.subtle;

function memoryStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    map,
  };
}

test('allow list: operator settings in, secrets and strangers out', () => {
  assert.ok(profileKeyAllowed('adam.intel.alerts.v1'));
  assert.ok(profileKeyAllowed('godsEyeView.v6.panelPos.layers'));
  assert.ok(!profileKeyAllowed('adam.voice.daily.v1'));
  assert.ok(!profileKeyAllowed('godsEyeView.v6.panelPos.apiKey'));
  assert.ok(!profileKeyAllowed('something.else'));
});

test('canonical JSON sorts keys at every depth', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }),
    '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
  );
});

test('round trip: collect, seal, verify, apply', async () => {
  const src = memoryStorage({
    'adam.intel.alerts.v1': '[{"id":"r1"}]',
    'adam.ui.scale': '1.2',
    'adam.voice.daily.v1': '{"spent":3}',
    'random.key': 'x',
  });
  const body = collectProfile({
    storage: src,
    shepherdPrefs: { provider: 'claude', apiKey: 'nope' },
    label: 'night shift',
    now: new Date('2026-09-25T00:00:00Z'),
  });
  assert.deepEqual(Object.keys(body.keys), [
    'adam.intel.alerts.v1',
    'adam.ui.scale',
  ]);
  assert.deepEqual(body.shepherd.prefs, { provider: 'claude' });
  const sealed = await sealProfile(body, {
    subtle,
    sign: async (digest) => ({
      alg: 'HMAC-SHA256',
      keyId: 'k',
      sig: `s-${digest}`,
    }),
  });
  const file = JSON.parse(JSON.stringify(sealed));
  const check = await verifyProfile(file, {
    subtle,
    verify: async (digest, sig) => sig.sig === `s-${digest}`,
  });
  assert.equal(check.ok, true);
  assert.equal(check.signed, true);
  assert.equal(check.verified, true);
  const dst = memoryStorage();
  assert.deepEqual(applyProfile(file, { storage: dst }), [
    'adam.intel.alerts.v1',
    'adam.ui.scale',
  ]);
  assert.equal(dst.getItem('adam.ui.scale'), '1.2');
});

test('tampering and foreign signatures are refused', async () => {
  const body = collectProfile({
    storage: memoryStorage({ 'adam.ui.scale': '1' }),
  });
  const sealed = await sealProfile(body, { subtle });
  assert.equal(sealed.signature, null);
  const unsigned = await verifyProfile(sealed, { subtle });
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.signed, false);
  const edited = { ...sealed, keys: { 'adam.ui.scale': '1.4' } };
  assert.match((await verifyProfile(edited, { subtle })).reason, /checksum/);
  const signed = { ...sealed, signature: { sig: 'x', keyId: 'y' } };
  const foreign = await verifyProfile(signed, {
    subtle,
    verify: async () => false,
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /signature/);
  assert.match(
    (await verifyProfile({ format: 'x' }, { subtle })).reason,
    /not an ADAM/,
  );
});

test('apply ignores keys outside the allow list even in a valid file', () => {
  const dst = memoryStorage();
  applyProfile(
    {
      keys: { 'adam.ui.scale': '1', 'evil.key': 'x', 'adam.intel.pins.v1': 5 },
    },
    { storage: dst },
  );
  assert.deepEqual([...dst.map.keys()], ['adam.ui.scale']);
});
