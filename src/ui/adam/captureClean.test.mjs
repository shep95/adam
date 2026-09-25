import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  pngChunkTypes,
  recordingBitrate,
  samePixels,
  scrubMp4,
  scrubWebm,
  stripPngMetadata,
} from './captureClean.js';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : 0);
  return Buffer.concat([len, body, crc]);
}

function png(extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Buffer.from([0, 1, 2, 3, 255]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      ...extra,
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

test('PNG: text, time, EXIF, ICC and dpi chunks are dropped; pixels untouched', () => {
  const dirty = png([
    chunk('sRGB', Buffer.from([0])),
    chunk('iCCP', Buffer.from('Display P3 profile\0\0xyz')),
    chunk('tEXt', Buffer.from('Software\0Chrome')),
    chunk('tIME', Buffer.alloc(7)),
    chunk('eXIf', Buffer.from('GPS')),
    chunk('pHYs', Buffer.alloc(9)),
  ]);
  const clean = stripPngMetadata(dirty);
  assert.deepEqual(pngChunkTypes(clean), ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  assert.ok(clean.length < dirty.length);
  const idat = (b) => {
    const s = Buffer.from(b).toString('latin1');
    return s.slice(s.indexOf('IDAT'), s.indexOf('IEND'));
  };
  assert.equal(idat(clean), idat(dirty));
  assert.deepEqual(stripPngMetadata(clean), clean, 'idempotent');
});

// Minimal EBML writer for the test.
const vint = (n) => Buffer.from([0x80 | n]);
const el = (id, data) =>
  Buffer.concat([Buffer.from(id), vint(data.length), data]);

test('WebM: muxing/writing app, title and date are blanked in place', () => {
  const info = el(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])),
      el([0x4d, 0x80], Buffer.from('Chrome')),
      el([0x57, 0x41], Buffer.from('Chrome')),
      el([0x44, 0x61], Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
    ]),
  );
  const cluster = el([0x1f, 0x43, 0xb6, 0x75], Buffer.from('Chrome-pixels'));
  const file = new Uint8Array(
    Buffer.concat([
      el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm'))),
      Buffer.from([
        0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]),
      info,
      cluster,
    ]),
  );
  const out = scrubWebm(file);
  assert.equal(out.length, file.length);
  const s = Buffer.from(out).toString('latin1');
  assert.equal(
    (s.match(/Chrome/g) || []).length,
    1,
    'only cluster payload keeps it',
  );
  assert.ok(s.includes('Chrome-pixels'));
  assert.ok(s.includes('webm'));
});

const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length);
  h.write(type, 4, 'ascii');
  return Buffer.concat([h, body]);
};

test('MP4: times zeroed, udta/meta become free, sizes unchanged', () => {
  const times = Buffer.from([
    0, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe, 1, 2,
  ]);
  const file = new Uint8Array(
    Buffer.concat([
      box('ftyp', Buffer.from('isom')),
      box(
        'moov',
        box('mvhd', times),
        box('trak', box('tkhd', times), box('mdia', box('mdhd', times))),
        box('udta', Buffer.from('©tooChrome')),
      ),
      box('mdat', Buffer.from('frames')),
    ]),
  );
  const out = scrubMp4(file);
  assert.equal(out.length, file.length);
  const s = Buffer.from(out).toString('latin1');
  assert.ok(!s.includes('udta') && s.includes('free'));
  assert.ok(!s.includes('\xde\xad\xbe\xef'));
  assert.ok(s.includes('frames'));
});

test('bitrate follows the picture and codec; pixel comparison is exact', () => {
  assert.equal(recordingBitrate(1920, 1080, 30, 'video/mp4'), 5_287_680);
  assert.ok(
    recordingBitrate(1920, 1080, 30, 'video/webm;codecs=vp9') < 5_287_680,
  );
  assert.equal(recordingBitrate(320, 200), 2_000_000);
  assert.equal(recordingBitrate(7680, 4320), 16_000_000);
  assert.ok(samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
  assert.ok(!samePixels(new Uint8Array([1, 2]), new Uint8Array([1, 3])));
});
