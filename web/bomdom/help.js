// Mouse & keyboard help sheet: a keyboard map with the bound keys lit and
// colored by what they do, plus short Mouse / Ctrl / Shift lists. Every entry
// is a one-liner; the longer how-to text lives in a grey hover tooltip
// (focus and tap show it too), so the sheet stays scannable.
//
// The sheet opens from the settings gear (settings.js) or the ? key
// (interactions.js); both just unhide #helpOverlay.

const $ = (id) => document.getElementById(id);

const GROUPS = {
  view: 'View',
  select: 'Select',
  show: 'Show & hide',
  levels: 'Assembly levels',
  tools: 'Tools',
  app: 'App',
};

// Lit keys: [key cap, group, label under the cap, tooltip title, tooltip detail]
const KEYS = {
  Esc: ['select', 'Clear', 'Clear / close', 'Cancels a triad drag, closes a menu, clears the selection, then leaves the current mode'],
  1: ['view', 'Front', 'Front view'],
  2: ['view', 'Back', 'Back view'],
  3: ['view', 'Left', 'Left view'],
  4: ['view', 'Right', 'Right view'],
  5: ['view', 'Top', 'Top view'],
  6: ['view', 'Bottom', 'Bottom view'],
  0: ['view', 'Iso', 'Isometric view'],
  E: ['show', 'Edges', 'Part edges on / off'],
  R: ['show', 'Reset', 'Reset all', 'Appearance, positions and explode'],
  I: ['show', 'Isolate', 'Isolate selection'],
  O: ['levels', 'Open', 'Open the selection', 'View it alone; ↑ or Top asm climbs back out'],
  P: ['show', 'Panel', 'Parts panel on / off'],
  A: ['levels', 'Assembly', 'Assembly mode', 'Hover highlights a subassembly and a click selects it; double-click opens it; with D, drag whole subassemblies'],
  D: ['tools', 'Move', 'Move mode', 'Selecting shows a triad: drag its arrows to slide, its rings to turn; near the ruler snaps to steps; click one to type an exact value'],
  F: ['view', 'Frame', 'Frame selection', 'Frames everything when nothing is selected'],
  H: ['show', 'Hide', 'Hide selection', 'Shift + H unhides the last hidden part(s)'],
  X: ['show', 'Section', 'Section view on / off'],
  N: ['tools', 'Note', 'Add a note', 'Pins it where the pointer rests on a part (otherwise click a spot); right-click a part → Note on whole part; Sketch draws on the view; … on a note edits, moves or deletes it (Change its view… re-saves the view it opens in); Share notes sends a notes file or a BomDom copy, and dropping either on the viewer merges it'],
  M: ['tools', 'Measure', 'Measure mode', 'Click two points; corners, edges, holes and faces snap; hole readouts offer center / min / max'],
  ',': ['app', 'Settings', 'Settings', 'Theme, units, animations, diagnostics line'],
  '?': ['app', 'Help', 'This help'],
  '↑': ['levels', 'Up', 'Up one level', 'Shift + ↑ goes straight to the top assembly'],
  '↓': ['levels', 'Down', 'Down one level', 'Heads for the selection, or back the way you came; Shift + ↓ dives to the selection’s own subassembly'],
};

const ROWS = [
  { pad: 0, keys: ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] },
  { pad: 1, keys: ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'] },
  { pad: 2, keys: ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'] },
  { pad: 3, keys: ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '?'] },
];

// Combos: [keys (m: = mouse word), group, title, detail]
const LISTS = [
  ['Mouse', [
    [['m:Left drag'], 'view', 'Orbit'],
    [['m:Right drag'], 'view', 'Pan', 'Middle drag pans too'],
    [['m:Wheel'], 'view', 'Zoom'],
    [['m:Click'], 'select', 'Select'],
    [['m:Double-click'], 'view', 'Frame part', 'In Assembly mode it opens the subassembly'],
    [['m:Right-click'], 'select', 'Part menu', 'Acts on the selection: add a note, hide, isolate, paint a color… View ▸ Part colors colors by part or by subassembly'],
    [['m:Axis gizmo'], 'view', 'Look down an axis', 'Bottom left; its caption shows which way is up'],
  ]],
  ['With Ctrl', [
    [['Ctrl', 'm:click'], 'select', 'Add to selection'],
    [['Ctrl', 'm:drag'], 'select', 'Box select', 'Adds to the selection'],
    [['Ctrl', 'C'], 'select', 'Copy part number', 'Copies the selected part number(s); the clipboard button on a list row copies that row'],
    [['Ctrl', 'Z'], 'tools', 'Undo sketch stroke', 'While sketching on a note'],
  ]],
  ['With Shift', [
    [['Shift', 'H'], 'show', 'Unhide last'],
    [['Shift', 'N'], 'tools', 'Note bubbles on / off', 'Hides every note bubble to look at the model alone; same as Bubbles in the Notes tab'],
    [['Shift', 'm:drag'], 'tools', 'Move part', 'Moves the selection; the whole subassembly in Assembly mode'],
    [['Shift', '↑'], 'levels', 'Top assembly'],
    [['Shift', '↓'], 'levels', 'Dive to selection', 'Into the selection’s own subassembly'],
  ]],
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function initHelp() {
  const overlay = $('helpOverlay');
  const body = $('helpBody');
  const tip = $('helpTip');
  if (!overlay || !body || !tip) return;

  // ---- tooltip ---------------------------------------------------------
  let tipFor = null;
  function showTip(target) {
    const title = target.dataset.tipTitle;
    if (!title) return;
    tipFor = target;
    tip.replaceChildren(el('div', 'help-tip-title', title));
    if (target.dataset.tipDetail) tip.append(el('div', 'help-tip-detail', target.dataset.tipDetail));
    tip.classList.remove('hidden');
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const margin = 8;
    let x = r.left + r.width / 2 - t.width / 2;
    x = Math.max(margin, Math.min(x, window.innerWidth - t.width - margin));
    let y = r.top - t.height - 6;
    if (y < margin) y = r.bottom + 6; // no room above: drop below
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }
  function hideTip() { tipFor = null; tip.classList.add('hidden'); }

  const tipped = (node, title, detail) => {
    node.dataset.tipTitle = title;
    if (detail) node.dataset.tipDetail = detail;
    node.tabIndex = 0;
    return node;
  };

  // ---- keyboard map ----------------------------------------------------
  const kb = el('div', 'help-kb');
  const main = el('div', 'help-kb-main');
  const cap = (k) => {
    const def = KEYS[k];
    const c = el('div', 'help-key', null);
    c.append(el('span', 'help-key-cap', k));
    if (!def) return c;
    const [group, label, title, detail] = def;
    c.classList.add('lit', `g-${group}`);
    c.append(el('span', 'help-key-label', label));
    return tipped(c, title, detail);
  };
  for (const row of ROWS) {
    const r = el('div', 'help-kb-row');
    r.style.paddingLeft = `calc(var(--help-key) * ${row.pad * 0.3})`;
    for (const k of row.keys) r.append(cap(k));
    main.append(r);
  }
  const arrows = el('div', 'help-kb-arrows');
  arrows.append(cap('↑'), cap('↓'));
  kb.append(main, arrows);
  const kbWrap = el('div', 'help-kb-wrap');
  kbWrap.append(kb);

  // ---- legend ----------------------------------------------------------
  const legend = el('div', 'help-legend');
  for (const [g, name] of Object.entries(GROUPS)) {
    const s = el('span', `g-${g}`);
    s.append(el('span', 'help-dot'), document.createTextNode(name));
    legend.append(s);
  }

  // ---- mouse / Ctrl / Shift lists ----------------------------------------
  const lists = el('div', 'help-lists');
  for (const [heading, rows] of LISTS) {
    const sec = el('section', 'help-list');
    sec.append(el('div', 'help-list-title', heading));
    for (const [keys, group, title, detail] of rows) {
      const row = el('div', `help-row g-${group}`);
      const ks = el('span', 'help-combo');
      keys.forEach((k, i) => {
        if (i) ks.append(el('span', 'help-plus', '+'));
        ks.append(k.startsWith('m:') ? el('span', 'help-mouse', k.slice(2)) : el('kbd', null, k));
      });
      row.append(el('span', 'help-dot'), ks, el('span', 'help-desc', title));
      sec.append(detail ? tipped(row, title, detail) : row);
    }
    lists.append(sec);
  }

  body.replaceChildren(kbWrap, legend, lists);

  // Detail-bearing entries get a dotted underline cue on their label.
  for (const n of body.querySelectorAll('[data-tip-detail]')) n.classList.add('has-detail');

  // Hover, keyboard focus and tap all show the same tooltip.
  body.addEventListener('pointerover', (ev) => {
    const t = ev.target.closest('[data-tip-title]');
    if (t && t !== tipFor) showTip(t);
  });
  body.addEventListener('pointerleave', hideTip);
  body.addEventListener('pointerout', (ev) => {
    const t = ev.target.closest('[data-tip-title]');
    if (t && !t.contains(ev.relatedTarget)) hideTip();
  });
  body.addEventListener('focusin', (ev) => {
    const t = ev.target.closest('[data-tip-title]');
    if (t) showTip(t);
  });
  body.addEventListener('focusout', hideTip);
  body.addEventListener('scroll', hideTip, true);

  // Closing the sheet (any path: ✕, backdrop, Esc, ?) drops a stray tooltip.
  new MutationObserver(() => {
    if (overlay.classList.contains('hidden')) hideTip();
  }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
}
