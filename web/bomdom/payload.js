// Payload decode pipeline, shared by META, GLB and the Draco wasm:
//   <script type=text/plain> textContent -> base64 -> bytes -> gunzip.
// No fetch/XHR anywhere (data: URIs included): this page runs from file://
// behind corporate proxies where any request is a hazard.

import { diag, timed } from './diag.js';

// trackPath=false for side payloads (the Draco wasm) so they don't clobber
// the diagnostics line's record of how the main GLB was decoded.
export function b64ToBytes(b64, trackPath = true) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    if (trackPath) diag.decodePath = 'Uint8Array.fromBase64';
    return Uint8Array.fromBase64(b64);
  }
  // Common corporate path (Chrome/Edge < 140): chunked atob into a
  // preallocated buffer. Slice length must be a multiple of 4 so each
  // chunk is independently decodable.
  if (trackPath) diag.decodePath = 'chunked atob';
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

// Async, chunked variant for the multi-MB GLB slot: same decode, but it
// reports progress and yields between slices so the loading bar can paint.
// Yields only while the tab is visible — in a hidden window setTimeout is
// throttled to ~1s per hop (and rAF never fires), which would turn a
// sub-second decode into many seconds while nobody is watching the bar.
export async function b64ToBytesAsync(b64, onProgress) {
  const native = typeof Uint8Array.fromBase64 === 'function';
  diag.decodePath = native ? 'Uint8Array.fromBase64 (chunked)' : 'chunked atob';
  const pad = b64.endsWith('=') ? (b64.endsWith('==') ? 2 : 1) : 0;
  // May overshoot if the slot picked up whitespace — trimmed by subarray below.
  const out = new Uint8Array(Math.floor(b64.length / 4) * 3 - pad);
  const SLICE = 1 << 22; // ~4 MB of base64 per slice
  let o = 0;
  // Whole-string decodes forgive internal whitespace (an editor hard-wrapping
  // a hand-edited export is real input), so the chunked one must too: strip
  // any whitespace per slice and carry the sub-quad remainder into the next
  // slice, so every decoded chunk except the last is a multiple of 4.
  let carry = '';
  let lastYield = performance.now();
  for (let i = 0; i < b64.length; i += SLICE) {
    let part = carry + b64.slice(i, i + SLICE);
    if (/\s/.test(part)) part = part.replace(/\s+/g, '');
    const last = i + SLICE >= b64.length;
    const take = last ? part.length : part.length - (part.length % 4);
    carry = part.slice(take);
    part = part.slice(0, take);
    if (!part) continue;
    if (native) {
      const bytes = Uint8Array.fromBase64(part);
      out.set(bytes, o);
      o += bytes.length;
    } else {
      const bin = atob(part);
      for (let j = 0; j < bin.length; j++) out[o++] = bin.charCodeAt(j);
    }
    if (onProgress) onProgress(o, out.length);
    if (document.visibilityState === 'visible' && performance.now() - lastYield > 40) {
      await new Promise((r) => setTimeout(r));
      lastYield = performance.now();
    }
  }
  if (onProgress) onProgress(o, o); // close the stage even after an overshoot
  return o === out.length ? out : out.subarray(0, o);
}

export async function gunzipToArrayBuffer(bytes, onProgress) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  if (!onProgress) return new Response(stream).arrayBuffer();
  // gzip's trailer holds the decompressed size mod 2^32 — an exact progress
  // denominator for any payload this exporter writes (far under 4 GB).
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isize = bytes.length >= 4 ? dv.getUint32(bytes.length - 4, true) : 0;
  const reader = stream.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, Math.max(isize, got));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
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
  const defaults = { allow_exports: true, up_axis: 'y' };
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

// onProgress(phase, done, total) with phase 'unpack' (base64) or 'inflate'
// (gunzip) — both byte-measured, feeding the boot loading bar.
export async function decodeGlb(onProgress) {
  const t0 = performance.now();
  let text = takeSlotText('bomdom-glb');
  if (!text) throw new Error('embedded GLB payload is empty');
  let bytes = await b64ToBytesAsync(
    text, onProgress && ((done, total) => onProgress('unpack', done, total)));
  text = null;
  const buf = await gunzipToArrayBuffer(
    bytes, onProgress && ((done, total) => onProgress('inflate', done, total)));
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
