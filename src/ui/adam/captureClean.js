/**
 * Clean captures before they reach the operator's disk.
 *
 *   PNG    keep only the chunks that define the pixels (IHDR, PLTE, tRNS,
 *          IDAT, IEND, sRGB, gAMA, cHRM); drop text, time, EXIF, physical
 *          size and embedded ICC profiles (a display profile fingerprints
 *          the machine)
 *   WebM   blank the muxing/writing application strings and title, zero the
 *          creation date (EBML Info element)
 *   MP4    zero creation/modification times (mvhd, tkhd, mdhd) and turn
 *          udta/meta boxes into free space, keeping every offset valid
 *
 * All pure byte work on Uint8Arrays; no pixels change.
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'tRNS',
  'IDAT',
  'IEND',
  'sRGB',
  'gAMA',
  'cHRM',
]);

const u32 = (b, i) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const type4 = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** PNG chunk types in order (for tests and diagnostics). */
export function pngChunkTypes(bytes) {
  const out = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    out.push(type4(bytes, i + 4));
    i += 12 + len;
  }
  return out;
}

/** @param {Uint8Array} bytes @returns {Uint8Array} */
export function stripPngMetadata(bytes) {
  if (!PNG_SIG.every((v, k) => bytes[k] === v)) return bytes;
  const parts = [bytes.subarray(0, 8)];
  let size = 8;
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    const end = i + 12 + len;
    if (end > bytes.length) break;
    if (PNG_KEEP.has(type4(bytes, i + 4))) {
      parts.push(bytes.subarray(i, end));
      size += end - i;
    }
    i = end;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ── EBML (WebM) ───────────────────────────────────────────────────────────
function readVint(b, i) {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
  let value = first & (0xff >> len);
  for (let k = 1; k < len; k += 1) value = value * 256 + b[i + k];
  return { len, value };
}

function readId(b, i) {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len += 1;
  let id = 0;
  for (let k = 0; k < len; k += 1) id = id * 256 + b[i + k];
  return { len, id };
}

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_BLANK_STRINGS = new Set([0x4d80, 0x5741, 0x7ba9]); // MuxingApp, WritingApp, Title
const EBML_DATE = 0x4461;

/** @param {Uint8Array} bytes @returns {Uint8Array} (a scrubbed copy) */
export function scrubWebm(bytes) {
  const out = bytes.slice();
  // Walk: EBML header, then Segment (size may be unknown), find Info.
  let i = 0;
  const limit = Math.min(out.length, 1 << 20);
  const header = readId(out, i);
  if (!header || header.id !== 0x1a45dfa3) return out;
  const hSize = readVint(out, i + header.len);
  i += header.len + hSize.len + hSize.value;
  const seg = readId(out, i);
  if (!seg || seg.id !== EBML_SEGMENT) return out;
  const segSize = readVint(out, i + seg.len);
  i += seg.len + segSize.len;
  while (i < limit) {
    const el = readId(out, i);
    if (!el) break;
    const size = readVint(out, i + el.len);
    if (!size) break;
    const body = i + el.len + size.len;
    if (el.id === EBML_INFO) {
      let j = body;
      const end = Math.min(body + size.value, out.length);
      while (j < end) {
        const child = readId(out, j);
        if (!child) break;
        const cs = readVint(out, j + child.len);
        if (!cs) break;
        const cb = j + child.len + cs.len;
        if (EBML_BLANK_STRINGS.has(child.id)) out.fill(0x20, cb, cb + cs.value);
        else if (child.id === EBML_DATE) out.fill(0, cb, cb + cs.value);
        j = cb + cs.value;
      }
      break;
    }
    // Cluster reached without Info: nothing to scrub.
    if (el.id === 0x1f43b675) break;
    i = body + size.value;
  }
  return out;
}

// ── ISO BMFF (MP4) ──────────────────────────────────────────────────────────
const MP4_CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
]);
const MP4_TIMED = new Set(['mvhd', 'tkhd', 'mdhd']);

function walkBoxes(b, start, end, visit) {
  let i = start;
  while (i + 8 <= end) {
    let size = u32(b, i);
    const type = type4(b, i + 4);
    let header = 8;
    if (size === 1) {
      size = u32(b, i + 8) * 2 ** 32 + u32(b, i + 12);
      header = 16;
    } else if (size === 0) size = end - i;
    if (size < header || i + size > end) break;
    visit(type, i, header, size);
    if (MP4_CONTAINERS.has(type)) walkBoxes(b, i + header, i + size, visit);
    i += size;
  }
}

/** @param {Uint8Array} bytes @returns {Uint8Array} (a scrubbed copy) */
export function scrubMp4(bytes) {
  const out = bytes.slice();
  walkBoxes(out, 0, out.length, (type, i, header) => {
    if (type === 'udta' || type === 'meta') {
      out.set([0x66, 0x72, 0x65, 0x65], i + 4); // 'free'
    } else if (MP4_TIMED.has(type)) {
      const v = out[i + header];
      const n = v === 1 ? 16 : 8; // creation + modification times
      out.fill(0, i + header + 4, i + header + 4 + n);
    }
  });
  return out;
}

/** Scrub by container type. */
export function scrubMedia(bytes, mime = '') {
  if (/png/i.test(mime)) return stripPngMetadata(bytes);
  if (/mp4|quicktime/i.test(mime)) return scrubMp4(bytes);
  if (/webm|matroska/i.test(mime)) return scrubWebm(bytes);
  return bytes;
}

/**
 * Video bitrate sized to the picture instead of a fixed 8 Mb/s: bits per
 * pixel per frame, tuned for screen content (sharp UI text, a moving globe).
 */
export function recordingBitrate(width, height, fps = 30, mime = '') {
  const bpp = /vp9|av01|av1/i.test(mime) ? 0.06 : 0.085;
  const bits = Math.round(width * height * fps * bpp);
  return Math.max(2_000_000, Math.min(16_000_000, bits));
}

/** True when two RGBA buffers are identical (lossless round-trip check). */
export function samePixels(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
