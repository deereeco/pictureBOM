// Instruction mode (issue #12): balloons every visible part like an assembly
// drawing, numbers the parts list to match, and prints a landscape sheet —
// ballooned view + numbered checklist — through the browser's print dialog
// (Save as PDF is one click there). Numbering follows the decisions locked on
// the issue: one number per unique part (quantity in the list), kept
// subassemblies are one balloon + one row, flatten-all or per-subassembly
// flattening folds their parts into the numbering instead. Everything is
// event-driven: the mode costs nothing while it is off.

import * as THREE from 'three';
import * as M from './model.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const BALLOON_OFFSET_PX = 46;   // balloon center's push-out from the part center
const MAX_BALLOONS = 200;       // beyond this, duplicate balloons drop automatically
const ONE_PAGE_ROW_LIMIT = 16;  // more rows than this -> checklist flows to page 2+
const ONE_PAGE_COL_LIMIT = 2;   // more optional columns than this -> list starts on page 2
const PRINT_KEY = 'picturebom-bomdom-instr-print';

function readPrintSettings() {
  const def = { orient: 'landscape', layout: 'one', cols: { desc: true, vendor: false, thumb: true } };
  try {
    const s = JSON.parse(localStorage.getItem(PRINT_KEY) || 'null');
    if (!s) return def;
    return {
      orient: s.orient === 'portrait' ? 'portrait' : 'landscape',
      layout: s.layout === 'split' ? 'split' : 'one',
      cols: { desc: !!(s.cols && s.cols.desc), vendor: !!(s.cols && s.cols.vendor), thumb: !!(s.cols && s.cols.thumb) },
    };
  } catch { return def; }
}
function storePrintSettings(s) {
  try { localStorage.setItem(PRINT_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function initInstructions(app) {
  const viewer = app.viewer;
  const viewport = $('viewport');
  const canvas = $('gl');
  const sel = app.sel;
  const invalidate = viewer.invalidate;

  const st = {
    on: false,
    flattenAll: false,
    flattenSet: new Set(),   // cleaned subassembly names folded into the numbering
    dupBalloons: true,       // every instance gets a balloon (Dominic: default on)
    checked: new Map(),      // item key -> bool, per-session only
    ownScope: false,         // we opened the isolation scope, so exit closes it
    items: [],
    balloons: [],            // { item, rec, world: Vector3, el }
    print: readPrintSettings(),
  };

  // ---- DOM: leader-line layer, chip, list container ----------------------
  const leads = document.createElementNS(SVG_NS, 'svg');
  leads.setAttribute('class', 'instr-leads hidden');
  viewport.appendChild(leads);

  const chip = document.createElement('div');
  chip.className = 'instr-chip hidden';
  viewport.appendChild(chip);

  const partsList = $('partsList');
  const list = document.createElement('div');
  list.className = 'panel-body instr-list hidden';
  list.dataset.tabBody = 'parts'; // rides the Parts tab like the list it replaces
  partsList.parentElement.insertBefore(list, partsList.nextSibling);

  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);

  // ---- items: the numbered rows -------------------------------------------
  const asmKey = (rec) => (M.cleanName(rec.name) || 'assembly').toLowerCase();

  function computeItems() {
    const items = [];
    const groups = new Map();
    if (!app.model) return items;
    const grab = (key, make) => {
      let it = groups.get(key);
      if (!it) {
        it = make();
        it.key = key;
        it.recs = [];
        groups.set(key, it);
        items.push(it);
      }
      return it;
    };
    const visit = (rec) => {
      if (M.isEffectivelyHidden(rec, sel.scope, sel.filter)) return;
      const isAsm = rec.children.length > 0;
      if (isAsm && !st.flattenAll && !st.flattenSet.has(asmKey(rec))) {
        // A kept subassembly is one item: one balloon per copy, one row.
        const name = M.cleanName(rec.name) || rec.name || 'subassembly';
        grab('a:' + asmKey(rec), () => ({
          kind: 'asm', name,
          row: app.bom.rowByName.get(name.toLowerCase()) || null,
          part: null,
        })).recs.push(rec);
        return; // its parts stay inside
      }
      if (rec.meshes.length) {
        const part = rec.partId !== null ? app.model.partById.get(rec.partId) : null;
        const name = part ? (part.bom_name || part.name) : (M.cleanName(rec.name) || rec.name);
        const key = part ? 'p:' + part.id : 'n:' + name.toLowerCase();
        grab(key, () => ({
          kind: 'part', name,
          row: part ? app.bom.rowFor(part) : (app.bom.rowByName.get(name.toLowerCase()) || null),
          part,
        })).recs.push(rec);
      }
      for (const c of rec.children) visit(c);
    };
    // Inside an "Open" scope on a subassembly, ITS parts are the instruction
    // items (numbering one row that says "the subassembly you are looking at"
    // helps nobody) — the same units rule scope-aware explode uses.
    const anchor = sel.scope && sel.scope.anchorId != null
      ? app.model.records[sel.scope.anchorId] : null;
    const roots = anchor && anchor.children.length ? anchor.children : M.topRecs(app.model);
    for (const rec of roots) visit(rec);
    items.forEach((it, i) => { it.n = i + 1; });
    return items;
  }

  function unitCenter(rec) {
    return M.recWorldCenter(rec)
      || M.boxOfRecs([rec]).getCenter(new THREE.Vector3());
  }

  // ---- balloons ------------------------------------------------------------
  const _proj = new THREE.Vector3();
  function toViewportPx(world) {
    _proj.copy(world).project(viewer.camera);
    const cr = canvas.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    return {
      x: (_proj.x * 0.5 + 0.5) * cr.width + (cr.left - vr.left),
      y: (-_proj.y * 0.5 + 0.5) * cr.height + (cr.top - vr.top),
      behind: _proj.z > 1 || _proj.z < -1,
    };
  }

  function clearBalloons() {
    for (const b of st.balloons) b.el.remove();
    st.balloons = [];
    leads.replaceChildren();
  }

  function buildBalloons() {
    clearBalloons();
    if (!st.on) return;
    const total = st.items.reduce((a, it) => a + it.recs.length, 0);
    const dups = st.dupBalloons && total <= MAX_BALLOONS;
    chip.querySelector('.ic-note').textContent =
      st.dupBalloons && !dups ? `${total} instances — showing one balloon per item` : '';
    for (const item of st.items) {
      const recs = dups ? item.recs : [item.recs[0]];
      for (const rec of recs) {
        const el = document.createElement('div');
        el.className = 'instr-balloon';
        el.textContent = String(item.n);
        el.title = item.name;
        el.addEventListener('pointerenter', () => sel.setHover({ ids: item.recs.map((r) => r.id) }));
        el.addEventListener('pointerleave', () => sel.setHover(null));
        el.addEventListener('click', () => sel.select(item.recs.map((r) => r.id)));
        viewport.appendChild(el);
        st.balloons.push({ item, rec, world: unitCenter(rec), el });
      }
    }
    layoutBalloons();
  }

  // Balloon sits pushed out from the part along the direction away from the
  // view center, with a leader line back to the part — the drawing look.
  function layoutBalloons() {
    if (!st.on) return;
    leads.replaceChildren();
    const w = viewport.clientWidth, h = viewport.clientHeight;
    leads.setAttribute('width', w);
    leads.setAttribute('height', h);
    leads.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const clip = app.section && app.section.enabled ? app.section.plane : null;
    for (const b of st.balloons) {
      const p = toViewportPx(b.world);
      const cut = clip && clip.distanceToPoint(b.world) < 0;
      if (p.behind || cut || p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) {
        b.el.classList.add('hidden');
        continue;
      }
      b.el.classList.remove('hidden');
      let dx = p.x - w / 2, dy = p.y - h / 2;
      const len = Math.hypot(dx, dy);
      if (len < 1) { dx = 0.7; dy = -0.7; } else { dx /= len; dy /= len; }
      const bx = p.x + dx * BALLOON_OFFSET_PX;
      const by = p.y + dy * BALLOON_OFFSET_PX;
      b.el.style.left = bx + 'px';
      b.el.style.top = by + 'px';
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', p.x);
      line.setAttribute('y1', p.y);
      line.setAttribute('x2', bx);
      line.setAttribute('y2', by);
      line.setAttribute('class', 'il-line');
      leads.appendChild(line);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', p.x);
      dot.setAttribute('cy', p.y);
      dot.setAttribute('r', 2.2);
      dot.setAttribute('class', 'il-dot');
      leads.appendChild(dot);
    }
  }

  // ---- checklist (right panel, Parts tab) ---------------------------------
  function buildList() {
    list.replaceChildren();
    if (!st.on) return;
    for (const item of st.items) {
      const el = document.createElement('div');
      el.className = 'instr-row';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'instr-check';
      check.checked = !!st.checked.get(item.key);
      check.title = 'Check off as you assemble (resets when the page closes)';
      check.addEventListener('click', (ev) => ev.stopPropagation());
      check.addEventListener('change', () => {
        st.checked.set(item.key, check.checked);
        el.classList.toggle('is-checked', check.checked);
      });
      el.appendChild(check);
      el.classList.toggle('is-checked', check.checked);

      const num = document.createElement('span');
      num.className = 'instr-num';
      num.textContent = String(item.n);
      el.appendChild(num);

      const thumbUri = item.part && item.part.thumbnail;
      if (thumbUri) {
        const img = document.createElement('img');
        img.className = 'part-thumb';
        img.src = thumbUri;
        img.alt = '';
        el.appendChild(img);
      }

      const main = document.createElement('div');
      main.className = 'part-main';
      const name = document.createElement('div');
      name.className = 'part-no';
      name.textContent = item.name;
      main.appendChild(name);
      if (item.row && item.row.description) {
        const d = document.createElement('div');
        d.className = 'part-desc';
        d.textContent = item.row.description;
        d.title = item.row.description;
        main.appendChild(d);
      }
      el.appendChild(main);

      const side = document.createElement('div');
      side.className = 'part-side';
      const qty = document.createElement('span');
      qty.className = 'qty-pill';
      qty.textContent = '×' + item.recs.length;
      qty.title = 'in this view';
      side.appendChild(qty);
      if (item.kind === 'asm') {
        const fl = document.createElement('button');
        fl.className = 'instr-flatten';
        fl.textContent = 'Flatten';
        fl.title = 'Number this subassembly’s parts individually instead';
        fl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          st.flattenSet.add(item.key.slice(2));
          rebuild();
        });
        side.appendChild(fl);
      }
      el.appendChild(side);

      el.addEventListener('pointerenter', () => sel.setHover({ ids: item.recs.map((r) => r.id) }));
      el.addEventListener('pointerleave', () => sel.setHover(null));
      el.addEventListener('click', (ev) => sel.select(item.recs.map((r) => r.id), { additive: ev.ctrlKey || ev.metaKey }));
      el.addEventListener('dblclick', () => app.actions.frame(item.recs));
      item.el = el;
      list.appendChild(el);
    }
  }

  function syncListRows() {
    if (!st.on) return;
    const hoverIds = new Set(sel.hover ? sel.hover.ids : []);
    for (const item of st.items) {
      if (!item.el) continue;
      item.el.classList.toggle('is-hover', item.recs.some((r) => hoverIds.has(r.id)));
      item.el.classList.toggle('is-selected',
        item.recs.some((r) => !!M.selectedAncestorOf(sel.selected, r)));
    }
  }

  // ---- chip ---------------------------------------------------------------
  function buildChip() {
    chip.replaceChildren();
    const title = document.createElement('span');
    title.className = 'ic-title';
    title.textContent = 'Instructions';
    chip.appendChild(title);

    const mkCheck = (label, checked, titleText, onChange) => {
      const lab = document.createElement('label');
      lab.title = titleText;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.addEventListener('change', () => onChange(box.checked));
      lab.appendChild(box);
      lab.appendChild(document.createTextNode(' ' + label));
      chip.appendChild(lab);
      return box;
    };
    mkCheck('All balloons', st.dupBalloons,
      'Balloon every copy of a part; off = one balloon per item number',
      (on) => { st.dupBalloons = on; buildBalloons(); invalidate(); });
    mkCheck('Flatten subassemblies', st.flattenAll,
      'Number every part individually instead of one row per subassembly',
      (on) => { st.flattenAll = on; rebuild(); });

    if (st.flattenSet.size) {
      const restore = document.createElement('button');
      restore.textContent = 'Restore subassemblies';
      restore.title = 'Undo per-row Flatten choices';
      restore.addEventListener('click', () => { st.flattenSet.clear(); rebuild(); });
      chip.appendChild(restore);
    }

    const setup = document.createElement('button');
    setup.textContent = 'Page setup ▾';
    setup.addEventListener('click', (ev) => { ev.stopPropagation(); togglePageSetup(); });
    chip.appendChild(setup);

    const print = document.createElement('button');
    print.className = 'ic-print';
    print.textContent = 'Print / PDF';
    print.addEventListener('click', () => printInstructions());
    chip.appendChild(print);

    const note = document.createElement('span');
    note.className = 'ic-note';
    chip.appendChild(note);

    const exit = document.createElement('button');
    exit.textContent = '✕';
    exit.title = 'Exit instructions (Esc)';
    exit.addEventListener('click', () => set(false));
    chip.appendChild(exit);
  }

  // ---- page setup popover ---------------------------------------------------
  const setupPop = document.createElement('div');
  setupPop.className = 'instr-setup hidden';
  viewport.appendChild(setupPop);

  function togglePageSetup() {
    if (!setupPop.classList.contains('hidden')) { setupPop.classList.add('hidden'); return; }
    buildPageSetup();
    setupPop.classList.remove('hidden');
  }
  function buildPageSetup() {
    setupPop.replaceChildren();
    const p = st.print;
    const head = (t) => {
      const h = document.createElement('div');
      h.className = 'menu-head';
      h.textContent = t;
      setupPop.appendChild(h);
    };
    const radio = (name, value, checked, label, onChange) => {
      const lab = document.createElement('label');
      lab.className = 'menu-radio';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = name;
      r.checked = checked;
      r.addEventListener('change', () => { onChange(value); storePrintSettings(p); });
      lab.appendChild(r);
      lab.appendChild(document.createTextNode(' ' + label));
      setupPop.appendChild(lab);
    };
    const check = (label, checked, onChange) => {
      const lab = document.createElement('label');
      lab.className = 'pop-check';
      const b = document.createElement('input');
      b.type = 'checkbox';
      b.checked = checked;
      b.addEventListener('change', () => { onChange(b.checked); storePrintSettings(p); });
      lab.appendChild(b);
      lab.appendChild(document.createTextNode(' ' + label));
      setupPop.appendChild(lab);
    };
    head('Paper');
    radio('icOrient', 'landscape', p.orient === 'landscape', 'Landscape (fits the view best)', (v) => { p.orient = v; });
    radio('icOrient', 'portrait', p.orient !== 'landscape', 'Portrait', (v) => { p.orient = v; });
    head('Layout');
    radio('icLayout', 'one', p.layout === 'one', 'Everything on one page when it fits', (v) => { p.layout = v; });
    radio('icLayout', 'split', p.layout !== 'one', 'View on page 1, list follows', (v) => { p.layout = v; });
    head('List columns');
    check('Pictures', p.cols.thumb, (v) => { p.cols.thumb = v; });
    check('Description', p.cols.desc, (v) => { p.cols.desc = v; });
    check('Vendor', p.cols.vendor, (v) => { p.cols.vendor = v; });
    const note = document.createElement('div');
    note.className = 'pop-note';
    note.textContent = 'Long lists continue on page 2 automatically; with many columns the list starts there for clarity.';
    setupPop.appendChild(note);
  }
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || (!t.closest('.instr-setup') && !t.closest('.instr-chip'))) {
      setupPop.classList.add('hidden');
    }
  });

  // ---- print ----------------------------------------------------------------
  // The GL buffer is not preserved: render, then read the pixels immediately,
  // then draw the balloons on top in 2D canvas space.
  function captureBallooned() {
    viewer.renderer.render(viewer.scene, viewer.camera);
    const gl = viewer.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = gl.width;
    out.height = gl.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(gl, 0, 0);
    const cr = gl.getBoundingClientRect();
    const sx = gl.width / cr.width, sy = gl.height / cr.height;
    const px = (v) => v * sx; // uniform DPR — sx === sy for our renderer
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2b9187';
    ctx.lineWidth = px(1.4);
    ctx.font = `700 ${px(12)}px "Cascadia Code", Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const vr = viewport.getBoundingClientRect();
    const offX = vr.left - cr.left, offY = vr.top - cr.top;
    for (const b of st.balloons) {
      if (b.el.classList.contains('hidden')) continue;
      const bx = (parseFloat(b.el.style.left) + offX) * sx;
      const by = (parseFloat(b.el.style.top) + offY) * sy;
      const p = toViewportPx(b.world);
      const ax = (p.x + offX) * sx, ay = (p.y + offY) * sy;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(ax, ay, px(2.2), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(bx, by, px(11), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.beginPath();
      ctx.arc(bx, by, px(11), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.fillText(String(b.item.n), bx, by + px(0.5));
    }
    return out.toDataURL('image/png');
  }

  function printInstructions() {
    if (!st.items.length) { app.ui.toast('Nothing visible to print'); return; }
    const p = st.print;
    const optionalCols = (p.cols.thumb ? 1 : 0) + (p.cols.desc ? 1 : 0) + (p.cols.vendor ? 1 : 0);
    const onePage = p.layout === 'one'
      && st.items.length <= ONE_PAGE_ROW_LIMIT
      && optionalCols <= ONE_PAGE_COL_LIMIT;
    pageStyle.textContent = `@media print { @page { size: A4 ${p.orient}; margin: 10mm; } }`;

    const asm = (app.meta.assembly && app.meta.assembly.name) || 'assembly';
    const sheet = $('printSheet');
    sheet.replaceChildren();
    sheet.className = 'instr-print' + (onePage ? ' is-onepage' : '');

    const h1 = document.createElement('h1');
    h1.textContent = asm + ' — assembly instructions';
    sheet.appendChild(h1);
    const sub = document.createElement('div');
    sub.className = 'print-sub';
    sub.textContent = `${st.items.length} items · ${new Date().toLocaleDateString()}` +
      ` · pictureBOM BomDom${app.meta.app_version ? ' v' + app.meta.app_version : ''}`;
    sheet.appendChild(sub);

    const body = document.createElement('div');
    body.className = 'ip-body';
    sheet.appendChild(body);

    const fig = document.createElement('div');
    fig.className = 'ip-view';
    const img = document.createElement('img');
    img.src = captureBallooned();
    img.alt = '';
    fig.appendChild(img);
    body.appendChild(fig);

    const listWrap = document.createElement('div');
    listWrap.className = 'ip-list' + (onePage ? '' : ' ip-break');
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const heads = ['', '#'];
    if (p.cols.thumb) heads.push('Picture');
    heads.push('Part');
    if (p.cols.desc) heads.push('Description');
    heads.push('Qty');
    if (p.cols.vendor) heads.push('Vendor');
    for (const h of heads) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const item of st.items) {
      const tr = document.createElement('tr');
      const box = document.createElement('td');
      box.className = 'ordered-box';
      box.textContent = '☐';
      tr.appendChild(box);
      const n = document.createElement('td');
      n.className = 'ip-num';
      n.textContent = String(item.n);
      tr.appendChild(n);
      if (p.cols.thumb) {
        const td = document.createElement('td');
        if (item.part && item.part.thumbnail) {
          const im = document.createElement('img');
          im.src = item.part.thumbnail;
          im.alt = '';
          td.appendChild(im);
        }
        tr.appendChild(td);
      }
      const name = document.createElement('td');
      name.className = 'part mono';
      name.textContent = item.name + (item.kind === 'asm' ? ' (subassembly)' : '');
      tr.appendChild(name);
      if (p.cols.desc) {
        const td = document.createElement('td');
        td.textContent = (item.row && item.row.description) || '';
        tr.appendChild(td);
      }
      const qty = document.createElement('td');
      qty.className = 'num';
      qty.textContent = String(item.recs.length);
      tr.appendChild(qty);
      if (p.cols.vendor) {
        const td = document.createElement('td');
        const r = item.row;
        td.textContent = r ? [r.vendor, r.vendor_part_no].filter(Boolean).join(' ') : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    listWrap.appendChild(table);
    body.appendChild(listWrap);
    window.print();
  }

  // ---- mode lifecycle --------------------------------------------------------
  function rebuild() {
    st.items = computeItems();
    buildChip();
    buildBalloons();
    buildList();
    syncListRows();
    app.events.emit('instructions');
    invalidate();
  }

  function set(on) {
    on = !!on;
    if (on === st.on) return;
    if (on && !app.model) { app.ui.toast('No 3D model loaded'); return; }
    st.on = on;
    app.instructionsMode = on;
    $('btnInstructions').classList.toggle('is-on', on);
    chip.classList.toggle('hidden', !on);
    leads.classList.toggle('hidden', !on);
    list.classList.toggle('hidden', !on);
    partsList.style.display = on ? 'none' : ''; // tab clicks touch class, not style
    if (on) {
      // One canvas owner at a time, like measure/move/assembly.
      if (app.measureMode && app.measure) app.measure.toggle();
      if (app.actions) { app.actions.setMoveMode(false); app.actions.setAssemblyMode(false); }
      // "What they have selected is isolated (if nothing selected, everything)."
      const roots = [...sel.selected].map((id) => app.model.records[id]).filter(Boolean);
      if (roots.length && !sel.scope) {
        st.ownScope = true;
        app.actions.open(roots, roots.length === 1
          ? (M.instanceLabel(roots[0].name) || 'selection') : `${roots.length} selected`);
      }
      rebuild();
      app.ui.toast('Instruction mode — balloons match the numbered list; Print / PDF is in the chip (Esc to exit)');
    } else {
      setupPop.classList.add('hidden');
      clearBalloons();
      list.replaceChildren();
      if (st.ownScope) {
        st.ownScope = false;
        if (sel.scope) app.actions.closeScope();
      }
      app.events.emit('instructions');
      invalidate();
    }
  }

  // ---- follow the app ---------------------------------------------------------
  const rebuildIfOn = () => { if (st.on) rebuild(); };
  app.events.on('appearance', rebuildIfOn);
  app.events.on('filter', rebuildIfOn);
  app.events.on('scope', rebuildIfOn);
  app.events.on('positions', () => {
    if (!st.on) return;
    for (const b of st.balloons) b.world.copy(unitCenter(b.rec));
    layoutBalloons();
  });
  app.events.on('positions-live', () => {
    if (!st.on) return;
    for (const b of st.balloons) b.world.copy(unitCenter(b.rec));
    layoutBalloons();
  });
  app.events.on('hover', syncListRows);
  app.events.on('selection', syncListRows);
  app.events.on('model', () => {
    st.flattenSet.clear();
    st.flattenAll = false;
    st.checked.clear();
    if (st.on) set(false);
  });
  viewer.onCameraChange(() => { if (st.on) layoutBalloons(); });

  $('btnInstructions').addEventListener('click', () => set(!st.on));

  app.instructions = {
    set,
    toggle: () => set(!st.on),
    get on() { return st.on; },
    items: () => st.items,
    refresh: rebuildIfOn,
  };
}
