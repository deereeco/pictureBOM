// Payload decode pipeline, shared by META, GLB and the Draco wasm:
//   <script type=text/plain> textContent -> base64 -> bytes -> gunzip.
// No fetch/XHR anywhere (data: URIs included): this page runs from file://
// behind corporate proxies where any request is a hazard.

import { diag, timed } from './diag.js';

export function b64ToBytes(b64) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    diag.decodePath = 'Uint8Array.fromBase64';
    return Uint8Array.fromBase64(b64);
  }
  // Common corporate path (Chrome/Edge < 140): chunked atob into a
  // preallocated buffer. Slice length must be a multiple of 4 so each
  // chunk is independently decodable.
  diag.decodePath = 'chunked atob';
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((b64.length / 4) * 3 - pad);
  const SLICE = 1 << 20;
  let o = 0;
  for (let i = 0; i < b64.length; i += SLICE) {
    const bin = atob(b64.slice(i, i + SLICE));
    for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
  }
  return out;
}

export async function gunzipToArrayBuffer(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function takeSlotText(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`payload slot #${id} is missing from the document`);
  const text = el.textContent.trim();
  el.remove(); // free the DOM copy; the JS string is nulled by the caller
  return text;
}

export function readMode() {
  const mode = takeSlotText('bomdom-mode');
  if (mode !== 'embedded' && mode !== 'sidecar') {
    throw new Error(`unknown payload mode ${JSON.stringify(mode)}`);
  }
  return mode;
}

export function readConfig() {
  // Deliberately plain JSON (never compressed) so the file owner can open the
  // HTML in a text editor and flip options after export. The slot is READ but
  // NOT removed — hand-editors should still find it in saved copies of a
  // loaded page. Anything unparseable falls back to defaults (fail open: a
  // typo while hand-editing must not silently brick the menu).
  const defaults = { allow_exports: true };
  const el = document.getElementById('bomdom-config');
  if (!el) return defaults;
  try {
    return { ...defaults, ...JSON.parse(el.textContent.trim()) };
  } catch {
    console.warn('[BomDom] bomdom-config is not valid JSON; using defaults');
    return defaults;
  }
}

export async function decodeMeta() {
  const t0 = performance.now();
  let text = takeSlotText('bomdom-meta');
  if (!text) throw new Error('META payload is empty');
  let bytes = b64ToBytes(text);
  text = null;
  const buf = await gunzipToArrayBuffer(bytes);
  bytes = null;
  const meta = JSON.parse(new TextDecoder().decode(buf));
  timed('meta decode', performance.now() - t0);
  return meta;
}

export async function decodeGlb() {
  const t0 = performance.now();
  let text = takeSlotText('bomdom-glb');
  if (!text) throw new Error('embedded GLB payload is empty');
  let bytes = b64ToBytes(text);
  text = null;
  const buf = await gunzipToArrayBuffer(bytes);
  bytes = null;
  timed('glb decode', performance.now() - t0);
  return buf;
}

export function dropRemainingSlots() {
  for (const id of ['bomdom-mode', 'bomdom-meta', 'bomdom-glb']) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
}

// data:image/...;base64,XXX -> { bytes, mime } without any request.
export function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  const head = uri.slice(0, comma);
  if (!/;base64$/.test(head)) return null;
  const mime = head.slice(5, head.indexOf(';'));
  const bin = atob(uri.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}
