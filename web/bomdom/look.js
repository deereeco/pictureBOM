// Part colors (issue #25): one color per part or per subassembly, and per-part
// paint from the context menu. Remembered PER ASSEMBLY: one localStorage
// entry keyed by assembly name, like the up axis. Nothing is written into the
// BomDom file itself, so exports never grow.
//
// The room (theme chrome + backdrop) is deliberately NOT a setting: the theme
// toggle switches both together (scene.js THEME_BACKDROPS). Dominic, after a
// day with background presets and lighting sliders: "all these customizations
// … make it less intuitive for a user to just 'get it' right away."
//
// Precedence of paint on a part: color-by-property (filter.js, an overlay the
// reader toggles) > per-part paint > whole-model scheme > the exported color.

import * as THREE from 'three';
import * as M from './model.js';

const KEY_PREFIX = 'picturebom-bomdom-look:';

// Fixed paint swatches. Adjacent pairs stay apart in hue and value so two
// neighbouring painted parts never blur together.
export const SWATCHES = ['#f08a24', '#e34948', '#eda100', '#1baf7a', '#2a78d6',
  '#4a3aa7', '#e87ba4', '#8a94a1', '#f4f6f8', '#2b2f36'];

export const SCHEMES = [['original', 'Original'], ['part', 'By part'], ['subasm', 'By subassembly']];
// Parts a subassembly scheme cannot place (the open level's own geometry).
const UNPLACED = 0xb0b6be;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const isHex = (v) => typeof v === 'string' && HEX_RE.test(v);

export function initLook(app) {
  const sel = app.sel;
  const storageKey = KEY_PREFIX +
    String((app.meta.assembly && app.meta.assembly.name) || 'assembly').toLowerCase();

  // ---- state + storage ---------------------------------------------------
  const state = { scheme: 'original', colors: {} }; // colors: 'p<partId>'|'n<recId>' -> '#rrggbb'

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* absent / blocked */ }
    if (!raw || typeof raw !== 'object') return;
    // Field by field: a stale 0.18.0 entry (it also held backgrounds and
    // sliders) or a hand-edited one must degrade to defaults, never throw.
    if (SCHEMES.some(([k]) => k === raw.scheme)) state.scheme = raw.scheme;
    if (raw.colors && typeof raw.colors === 'object') {
      for (const [k, v] of Object.entries(raw.colors)) {
        if (/^[pn]\d+$/.test(k) && isHex(v)) state.colors[k] = v.toLowerCase();
      }
    }
  }

  const isDefault = () => state.scheme === 'original' && Object.keys(state.colors).length === 0;

  function save() {
    try {
      if (isDefault()) localStorage.removeItem(storageKey); // untouched colors leave no trace
      else localStorage.setItem(storageKey, JSON.stringify(state));
    } catch { /* private mode / storage blocked: colors still apply this session */ }
  }

  // ---- part colors -> model.lookColor -------------------------------------
  // Paint keys: a part is painted by part number so every instance follows;
  // a mesh record no BOM row claimed falls back to its own record id.
  const keyOf = (rec) => (rec.partId !== null && rec.partId !== undefined ? 'p' + rec.partId : 'n' + rec.id);

  // Evenly spread hues (golden angle) at one saturation and lightness, so
  // neighbours differ in hue alone and every color reads under dark edges.
  const _c = new THREE.Color();
  const hue = (i, offset = 0) => _c.setHSL((((i * 137.508 + offset) % 360) + 360) % 360 / 360, 0.58, 0.55).getHex();

  function schemeColors(model) {
    const out = new Map();
    if (state.scheme === 'part') {
      const index = new Map(); // paint key -> palette index, in first-seen order
      for (const rec of model.records) {
        if (!rec.meshes.length) continue;
        const k = keyOf(rec);
        if (!index.has(k)) index.set(k, index.size);
        out.set(rec.id, hue(index.get(k)));
      }
    } else if (state.scheme === 'subasm') {
      // Units are the children of the level in view: the open subassembly's
      // members, or the top level's. Going Down recolors by the next level.
      const anchor = sel.scope && sel.scope.anchorId != null ? model.records[sel.scope.anchorId] : null;
      const units = anchor ? anchor.children : M.topRecs(model);
      for (const rec of model.records) if (rec.meshes.length) out.set(rec.id, UNPLACED);
      units.forEach((u, i) => {
        for (const r of M.subtree(u)) if (r.meshes.length) out.set(r.id, hue(i, 20));
      });
    }
    return out;
  }

  function recomputeColors() {
    const model = app.model;
    if (!model) return;
    const colors = schemeColors(model);
    if (Object.keys(state.colors).length) {
      for (const rec of model.records) {
        if (!rec.meshes.length) continue;
        const hex = state.colors[keyOf(rec)];
        if (hex) colors.set(rec.id, parseInt(hex.slice(1), 16));
      }
    }
    model.lookColor = colors.size ? colors : null;
    app.events.emit('appearance');
  }

  function setScheme(scheme) {
    if (!SCHEMES.some(([k]) => k === scheme)) return;
    state.scheme = scheme;
    save();
    recomputeColors();
  }

  // Leaf records under the targets, expanded to every instance of each part
  // (painting one bracket paints all four of them).
  function paintTargets(recs) {
    const model = app.model;
    const out = new Map();
    for (const rec of recs) {
      for (const r of M.subtree(rec)) {
        if (!r.meshes.length) continue;
        for (const inst of M.allInstances(model, r)) out.set(inst.id, inst);
      }
    }
    return [...out.values()];
  }

  function paint(recs, hex) {
    if (!app.model) return;
    const keys = new Set(paintTargets(recs).map(keyOf));
    for (const k of keys) {
      if (hex) state.colors[k] = hex.toLowerCase();
      else delete state.colors[k];
    }
    save();
    recomputeColors();
  }

  // The one color every target shares right now, or null when mixed/unpainted.
  function paintOf(recs) {
    if (!app.model) return null;
    let hex = null;
    for (const r of paintTargets(recs)) {
      const c = state.colors[keyOf(r)] || null;
      if (hex === null) hex = c;
      else if (hex !== c) return null;
    }
    return hex;
  }

  // Back to the exported colors: scheme off and every paint removed.
  function resetColors() {
    state.scheme = 'original';
    state.colors = {};
    save();
    recomputeColors();
  }

  // ---- context menu Paint row --------------------------------------------
  function swatchRow(recs) {
    const row = document.createElement('div');
    row.className = 'swatch-row';
    const current = paintOf(recs);
    const anyPainted = paintTargets(recs).some((r) => state.colors[keyOf(r)]);
    for (const hex of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (current === hex ? ' is-on' : '');
      b.style.background = hex;
      b.title = 'Paint ' + hex;
      b.setAttribute('aria-label', 'Paint ' + hex);
      b.addEventListener('click', () => { app.ui.closeMenus(); paint(recs, hex); });
      row.appendChild(b);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'swatch swatch-clear';
    clear.title = 'Original color';
    clear.setAttribute('aria-label', 'Original color');
    clear.disabled = !anyPainted;
    clear.addEventListener('click', () => { app.ui.closeMenus(); paint(recs, null); });
    row.appendChild(clear);
    return row;
  }

  // ---- wiring ------------------------------------------------------------
  load();
  // Paint is keyed by part number, so it survives a sidecar re-drop; the
  // record-id map must be rebuilt for the new graph either way.
  app.events.on('model', recomputeColors);
  // Subassembly colors follow the level in view.
  app.events.on('scope', () => { if (state.scheme === 'subasm') recomputeColors(); });
  if (app.model) recomputeColors();

  app.look = { state, setScheme, swatchRow, paint, paintOf, resetColors, isDefault };
}
