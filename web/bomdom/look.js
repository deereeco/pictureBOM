// Colors & lighting (issue #25): viewport background, Brightness / Contrast,
// one color per part or per subassembly, and per-part paint from the
// context menu. Everything here is remembered PER ASSEMBLY (Dominic's pick):
// one localStorage entry keyed by assembly name, like the up axis — a look
// tuned for the black optics cage should not follow you into the printer.
// Nothing is written into the BomDom file itself, so exports never grow.
//
// Precedence of paint on a part: color-by-property (filter.js, an overlay the
// reader toggles) > per-part paint > whole-model scheme > the exported color.

import * as THREE from 'three';
import * as M from './model.js';

const KEY_PREFIX = 'picturebom-bomdom-look:';

// Fixed paint swatches (Q5: swatches only). Adjacent pairs stay apart in hue
// and value so two neighbouring painted parts never blur together.
export const SWATCHES = ['#f08a24', '#e34948', '#eda100', '#1baf7a', '#2a78d6',
  '#4a3aa7', '#e87ba4', '#8a94a1', '#f4f6f8', '#2b2f36'];

const BG_PRESETS = { white: '#ffffff', grey: '#6f7782', black: '#000000' };
const BG_KINDS = ['theme', 'white', 'grey', 'black', 'custom', 'gradient'];
const SCHEMES = ['original', 'part', 'subasm'];
// The default backdrop is a spotlight: black at the edges, mid grey at the
// centre (Dominic, 2026-09-16: "a really nice almost spot-like look"). It
// pairs with the dark theme the viewer now opens in; "Theme" stays a click
// away for anyone who wants the flat backdrop back.
const DEFAULTS = {
  bg: 'gradient', bgColor: '#ffffff',
  gradA: '#000000', gradB: '#6b7380', gradShape: 'radial',
  brightness: 50, contrast: 50,
  scheme: 'original',
  colors: {}, // paint key ('p<partId>' | 'n<recId>') -> '#rrggbb'
};
// Parts a subassembly scheme cannot place (the open level's own geometry).
const UNPLACED = 0xb0b6be;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const isHex = (v) => typeof v === 'string' && HEX_RE.test(v);
const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 50)));

export function initLook(app) {
  const $ = (id) => document.getElementById(id);
  const sel = app.sel;
  const storageKey = KEY_PREFIX +
    String((app.meta.assembly && app.meta.assembly.name) || 'assembly').toLowerCase();

  // ---- state + storage ---------------------------------------------------
  const state = { ...DEFAULTS, colors: {} };

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* absent / blocked */ }
    if (!raw || typeof raw !== 'object') return;
    // Validate field by field: a hand-edited or stale entry must degrade to
    // the defaults, never throw halfway through boot.
    if (BG_KINDS.includes(raw.bg)) state.bg = raw.bg;
    if (isHex(raw.bgColor)) state.bgColor = raw.bgColor;
    if (isHex(raw.gradA)) state.gradA = raw.gradA;
    if (isHex(raw.gradB)) state.gradB = raw.gradB;
    if (raw.gradShape === 'radial' || raw.gradShape === 'linear') state.gradShape = raw.gradShape;
    if (raw.brightness !== undefined) state.brightness = clamp100(raw.brightness);
    if (raw.contrast !== undefined) state.contrast = clamp100(raw.contrast);
    if (SCHEMES.includes(raw.scheme)) state.scheme = raw.scheme;
    if (raw.colors && typeof raw.colors === 'object') {
      for (const [k, v] of Object.entries(raw.colors)) {
        if (/^[pn]\d+$/.test(k) && isHex(v)) state.colors[k] = v.toLowerCase();
      }
    }
  }

  function isDefault() {
    return DEFAULTS.bg === state.bg && DEFAULTS.bgColor === state.bgColor &&
      DEFAULTS.gradA === state.gradA && DEFAULTS.gradB === state.gradB &&
      DEFAULTS.gradShape === state.gradShape && state.brightness === 50 &&
      state.contrast === 50 && state.scheme === 'original' &&
      Object.keys(state.colors).length === 0;
  }

  function save() {
    try {
      if (isDefault()) localStorage.removeItem(storageKey); // an untouched look leaves no trace
      else localStorage.setItem(storageKey, JSON.stringify(state));
    } catch { /* private mode / storage blocked: the look still applies this session */ }
  }

  // ---- background + lighting -> viewer -----------------------------------
  function backgroundSpec() {
    if (state.bg === 'gradient') {
      return { kind: 'gradient', a: state.gradA, b: state.gradB, shape: state.gradShape };
    }
    if (state.bg === 'custom') return { kind: 'color', color: state.bgColor };
    if (BG_PRESETS[state.bg]) return { kind: 'color', color: BG_PRESETS[state.bg] };
    return { kind: 'theme' };
  }
  function applyBackground() { if (app.viewer) app.viewer.setBackground(backgroundSpec()); }
  function applyLighting() {
    if (app.viewer) app.viewer.setLighting({ brightness: state.brightness, contrast: state.contrast });
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
    const painted = Object.keys(state.colors).length;
    if (painted) {
      for (const rec of model.records) {
        if (!rec.meshes.length) continue;
        const hex = state.colors[keyOf(rec)];
        if (hex) colors.set(rec.id, parseInt(hex.slice(1), 16));
      }
    }
    model.lookColor = colors.size ? colors : null;
    app.events.emit('appearance');
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

  function clearPaint() {
    state.colors = {};
    save();
    recomputeColors();
  }

  // ---- context menu Color row --------------------------------------------
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

  // ---- popover -----------------------------------------------------------
  const menu = $('lookMenu');

  const head = (text) => {
    const h = document.createElement('div');
    h.className = 'menu-head';
    h.textContent = text;
    menu.appendChild(h);
    return h;
  };
  const note = (text) => {
    const n = document.createElement('div');
    n.className = 'pop-note';
    n.textContent = text;
    n.title = text;
    menu.appendChild(n);
    return n;
  };
  const radio = (name, value, checked, text, onChange) => {
    const lab = document.createElement('label');
    lab.className = 'menu-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = name;
    r.value = value;
    r.checked = checked;
    r.addEventListener('change', onChange);
    lab.appendChild(r);
    lab.appendChild(document.createTextNode(' ' + text));
    return lab;
  };
  const colorInput = (value, title, onInput) => {
    const c = document.createElement('input');
    c.type = 'color';
    c.className = 'look-color';
    c.value = value;
    c.title = title;
    c.setAttribute('aria-label', title);
    c.addEventListener('input', () => onInput(c.value));
    return c;
  };
  const slider = (label, value, onInput) => {
    const row = document.createElement('div');
    row.className = 'look-slider-row';
    const l = document.createElement('span');
    l.textContent = label;
    const s = document.createElement('input');
    s.type = 'range';
    s.min = 0;
    s.max = 100;
    s.step = 1;
    s.value = value;
    s.title = `${label} (double-click to reset)`;
    s.setAttribute('aria-label', label);
    s.addEventListener('input', () => onInput(Number(s.value)));
    s.addEventListener('dblclick', () => { s.value = 50; onInput(50); });
    row.appendChild(l);
    row.appendChild(s);
    menu.appendChild(row);
    return s;
  };

  function setBg(kind) {
    state.bg = kind;
    save();
    applyBackground();
    build();
  }

  function build() {
    menu.innerHTML = '';

    // Head row: title + the way back to the View menu it came from.
    const top = document.createElement('div');
    top.className = 'look-head';
    const t = document.createElement('div');
    t.className = 'menu-head';
    t.textContent = 'Background';
    top.appendChild(t);
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'pop-mini-btn';
    back.textContent = '‹ View';
    back.title = 'Back to the View menu';
    back.addEventListener('click', () => { if (app.ui.openViewMenu) app.ui.openViewMenu(); });
    top.appendChild(back);
    menu.appendChild(top);

    const bgRow = document.createElement('div');
    bgRow.className = 'pop-inline';
    for (const [kind, label] of [['theme', 'Theme'], ['white', 'White'], ['grey', 'Grey'], ['black', 'Black']]) {
      bgRow.appendChild(radio('bdLookBg', kind, state.bg === kind, label, () => setBg(kind)));
    }
    menu.appendChild(bgRow);

    const bgRow2 = document.createElement('div');
    bgRow2.className = 'pop-inline';
    const custom = radio('bdLookBg', 'custom', state.bg === 'custom', 'Custom', () => setBg('custom'));
    custom.appendChild(document.createTextNode(' '));
    custom.appendChild(colorInput(state.bgColor, 'Background color', (v) => {
      state.bgColor = v;
      if (state.bg !== 'custom') { state.bg = 'custom'; custom.querySelector('input[type=radio]').checked = true; }
      save();
      applyBackground();
    }));
    bgRow2.appendChild(custom);
    bgRow2.appendChild(radio('bdLookBg', 'gradient', state.bg === 'gradient', 'Gradient', () => setBg('gradient')));
    menu.appendChild(bgRow2);

    if (state.bg === 'gradient') {
      // Two colors and a shape. The reverse of either shape is the same
      // gradient with the colors swapped, so ⇄ covers bottom→top and
      // centre→edge without two more radios.
      const g = document.createElement('div');
      g.className = 'look-grad-row';
      const linear = state.gradShape === 'linear';
      g.appendChild(colorInput(state.gradA, linear ? 'Top color' : 'Edge color', (v) => {
        state.gradA = v; save(); applyBackground();
      }));
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'pop-mini-btn look-swap';
      swap.textContent = '⇄';
      swap.title = 'Swap the two colors';
      swap.addEventListener('click', () => {
        [state.gradA, state.gradB] = [state.gradB, state.gradA];
        save();
        applyBackground();
        build();
      });
      g.appendChild(swap);
      g.appendChild(colorInput(state.gradB, linear ? 'Bottom color' : 'Centre color', (v) => {
        state.gradB = v; save(); applyBackground();
      }));
      menu.appendChild(g);
      const shape = document.createElement('div');
      shape.className = 'look-grad-row';
      shape.appendChild(radio('bdLookGrad', 'linear', linear, 'Top → bottom', () => {
        state.gradShape = 'linear'; save(); applyBackground(); build();
      }));
      shape.appendChild(radio('bdLookGrad', 'radial', !linear, 'Centre → edge', () => {
        state.gradShape = 'radial'; save(); applyBackground(); build();
      }));
      menu.appendChild(shape);
    }

    head('Lighting');
    slider('Brightness', state.brightness, (v) => { state.brightness = v; save(); applyLighting(); });
    slider('Contrast', state.contrast, (v) => { state.contrast = v; save(); applyLighting(); });

    head('Part colors');
    const sRow = document.createElement('div');
    sRow.className = 'pop-inline';
    for (const [scheme, label] of [['original', 'Original'], ['part', 'By part'], ['subasm', 'By subassembly']]) {
      sRow.appendChild(radio('bdLookScheme', scheme, state.scheme === scheme, label, () => {
        state.scheme = scheme;
        save();
        recomputeColors();
        build();
      }));
    }
    menu.appendChild(sRow);
    const painted = Object.keys(state.colors).length;
    if (painted) {
      const n = note(`${painted} part${painted === 1 ? '' : 's'} painted from the right-click menu`);
      n.style.display = 'flex';
      n.style.alignItems = 'center';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'pop-mini-btn';
      clear.textContent = 'Unpaint all';
      clear.addEventListener('click', () => { clearPaint(); build(); });
      n.appendChild(clear);
    } else {
      note('Right-click a part to paint it a color');
    }

    const actions = document.createElement('div');
    actions.className = 'pop-actions';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pop-btn';
    reset.textContent = 'Reset look';
    reset.title = 'Back to the exported colors, spotlight background and tuned lighting for this assembly';
    reset.disabled = isDefault();
    reset.addEventListener('click', () => { resetLook(); build(); });
    actions.appendChild(reset);
    menu.appendChild(actions);
  }

  function resetLook() {
    Object.assign(state, DEFAULTS, { colors: {} });
    save();
    applyBackground();
    applyLighting();
    recomputeColors();
  }

  function openLookMenu() {
    if (!app.viewer) return;
    app.ui.closeMenus();
    build();
    menu.classList.remove('hidden');
    app.ui.clampMenu(menu);
  }
  app.ui.openLookMenu = openLookMenu;

  // ---- wiring ------------------------------------------------------------
  load();
  applyBackground();
  applyLighting();
  // Paint is keyed by part number, so it survives a sidecar re-drop; the
  // record-id map must be rebuilt for the new graph either way.
  app.events.on('model', recomputeColors);
  // Subassembly colors follow the level in view.
  app.events.on('scope', () => { if (state.scheme === 'subasm') recomputeColors(); });
  if (app.model) recomputeColors();

  app.look = { state, swatchRow, paint, paintOf, clearPaint, reset: resetLook, open: openLookMenu };
}
