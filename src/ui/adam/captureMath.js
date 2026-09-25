/** Pure helpers for snapshot, recording and interface scale. */

export const UI_SCALES = Object.freeze([0.8, 0.9, 1, 1.15, 1.3, 1.4]);

export function stampName(prefix, ext, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.${ext}`;
}

export function pickRecorderType(
  isSupported = (t) => globalThis.MediaRecorder?.isTypeSupported?.(t),
) {
  for (const type of [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ])
    if (isSupported(type)) return type;
  return '';
}

export function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return UI_SCALES.reduce(
    (best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best),
    1,
  );
}
