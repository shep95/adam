/**
 * Scene share links: a selected scene document, deflated and base64url
 * encoded into the URL fragment (`#scene=`). The fragment never reaches a
 * server. Opening such a link stages the scene in the normal import review —
 * nothing is applied until the operator presses Apply.
 */

export const SCENE_LINK_PARAM = 'scene';
/** Longest fragment we hand out; beyond this, download the JSON instead. */
export const SCENE_LINK_MAX_CHARS = 60_000;
const MAX_DECODED_BYTES = 5 * 1024 * 1024;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text))
    throw new Error('scene link is malformed');
  const b64 =
    text.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Scene JSON text → fragment payload. */
export async function encodeSceneLink(jsonText) {
  const deflated = await pipe(
    new TextEncoder().encode(jsonText),
    new CompressionStream('deflate-raw'),
  );
  return toBase64Url(deflated);
}

/** Fragment payload → scene JSON text (bounded). */
export async function decodeSceneLink(payload) {
  const inflated = await pipe(
    fromBase64Url(payload),
    new DecompressionStream('deflate-raw'),
  );
  if (inflated.byteLength > MAX_DECODED_BYTES)
    throw new Error('scene link is too large');
  return new TextDecoder().decode(inflated);
}

/** Full link for the current page. */
export function sceneLinkUrl(payload, loc = globalThis.location) {
  return `${loc.origin}${loc.pathname}#${SCENE_LINK_PARAM}=${payload}`;
}

/** Payload from a location hash, or null. */
export function scenePayloadFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const value = params.get(SCENE_LINK_PARAM);
  return value && value.length <= SCENE_LINK_MAX_CHARS ? value : null;
}
