// "Share notes → BomDom with notes": this page writes out a copy of its own
// file with the review notes baked in. The page cannot re-read itself from
// file://, so boot captures what it needs FIRST, before anything mutates the
// DOM: each payload slot's text (kept as one string; the decoders read it from
// slotText instead of the node) and the shell markup with those slots emptied.
// A copy is the shell with every slot refilled — the same bytes the exporter
// wrote, single-quoted slot ids included (refresh_demo.py and the smoke
// scripts find the slots by them).
//
// Runs while the viewer's inline script is executing, so the parser has not
// reached anything after it yet — shell.html keeps the license comment ABOVE
// that script for exactly this reason.

import { slotText } from './payload.js';

const SLOTS = [
  ['bomdom-mode', 'text/plain'],
  ['bomdom-config', 'text/plain'],
  ['bomdom-notes', 'application/json'],
  ['bomdom-meta', 'text/plain'],
  ['bomdom-glb', 'text/plain'],
];
const mark = (id) => `\u0000BOMDOM-SLOT:${id}\u0000`;

let shell = null;

export function captureShell() {
  try {
    for (const [id] of SLOTS) {
      const el = document.getElementById(id);
      if (!el) continue;
      slotText.set(id, el.textContent);
      el.textContent = ''; // the decoders read slotText; the copy refills it
    }
    let html = document.documentElement.outerHTML;
    for (const [id, type] of SLOTS) {
      const tag = `<script type="${type}" id="${id}"></script>`;
      if (!html.includes(tag)) {
        // An export from before review notes has no notes slot: add one so
        // its copies can carry notes too. Any other missing slot = no copies.
        const metaTag = '<script type="text/plain" id="bomdom-meta"></script>';
        if (id !== 'bomdom-notes' || !html.includes(metaTag)) return;
        html = html.replace(metaTag, (m) => `${tag}\n${m}`);
      }
      html = html.replace(tag, () => mark(id));
    }
    // Undo the two things that ran before us: the theme resolver's attribute
    // and the loading card the one-line script unhid.
    html = html.replace(/^<html([^>]*?) data-theme="[a-z]+"/, '<html$1');
    html = html.replace('<div id="loadingCard" class="loading-card">',
      '<div id="loadingCard" class="loading-card hidden">');
    shell = '<!DOCTYPE html>\n' + html;
  } catch (e) {
    console.warn('[BomDom] self-copy capture failed', e);
    shell = null;
  } finally {
    // The small slots go back in the page: the config block must still be
    // there for anyone hand-editing a browser "Save page as" copy. META and
    // GLB stay empty (the decoders drop those nodes anyway).
    for (const id of ['bomdom-mode', 'bomdom-config', 'bomdom-notes']) {
      const el = document.getElementById(id);
      if (el && slotText.has(id)) el.textContent = slotText.get(id);
    }
  }
}

export const canCopy = () => shell != null;

// Size of a copy without building one (the Share menu shows it).
export function copySize() {
  if (!shell) return 0;
  let n = shell.length;
  for (const [id] of SLOTS) if (id !== 'bomdom-notes') n += (slotText.get(id) || '').length;
  return n;
}

// notes: the review-notes document object (or null for an empty slot).
export function buildCopy(notes) {
  if (!shell) throw new Error('this page cannot save a copy of itself');
  let out = shell;
  for (const [id, type] of SLOTS) {
    let content = slotText.get(id) || '';
    if (id === 'bomdom-notes') {
      // "<" escaped so no note text can ever close the script element.
      content = notes ? JSON.stringify(notes).replace(/</g, '\\u003c') : '';
    }
    out = out.replace(mark(id), () => `<script type='${type}' id='${id}'>${content}</script>`);
  }
  return out;
}
