// Right panel: Parts list + Structure tree + search. Renders from META
// alone (works with no 3D at all); 3D ops route through app.actions and
// silently no-op until a model is loaded.

import * as M from './model.js';
import { buildBomTree } from './bom.js';

const $ = (id) => document.getElementById(id);

const ICON_EYE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_GHOST = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" opacity="0.35"/><circle cx="12" cy="12" r="4" opacity="0.7"/></svg>';
const ICON_ISOLATE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>';
const ICON_CHEVRON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_PART = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M5 7l7 4 7-4M12 11v10"/></svg>';
const ICON_ASM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/></svg>';

export function initPanel(app) {
  const meta = app.meta;
  const partsList = $('partsList');
  const treeEl = $('structureTree');

  // ---- tabs ------------------------------------------------------------
  let activeTab = 'parts';
  for (const btn of document.querySelectorAll('.panel-tabs .seg-btn')) {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      for (const b of document.querySelectorAll('.panel-tabs .seg-btn')) {
        b.classList.toggle('is-active', b === btn);
      }
      for (const body of document.querySelectorAll('[data-tab-body]')) {
        body.classList.toggle('hidden', body.dataset.tabBody !== activeTab);
      }
      if (activeTab === 'structure') revealSelection();
    });
  }

  // Assembly-total instances per BOM name (Parts pill and Structure "×n each").
  const totalByName = new Map();
  for (const e of app.bom.entries) {
    if (e.kind === 'part') totalByName.set(e.name.toLowerCase(), e.part.instances);
  }

  // ---- helpers into the 3D model ----------------------------------------
  const recsForPart = (part) =>
    app.model ? (app.model.byPartId.get(part.id) || []) : [];
  const recsForName = (name) =>
    app.model ? (app.model.byBomName.get((name || '').toLowerCase()) || []) : [];

  function withRecs(recs, fn) {
    if (app.model && recs.length) fn(recs);
  }

  function rowActionButtons(getRecs, label, vendorUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';
    const mk = (html, title, onClick) => {
      const b = document.createElement('button');
      b.className = 'ra-btn';
      b.innerHTML = html;
      b.title = title;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onClick(ev);
      });
      wrap.appendChild(b);
      return b;
    };
    mk(ICON_EYE, 'Hide / show', () => withRecs(getRecs(), (r) => app.actions.toggleHidden(r)));
    mk(ICON_GHOST, 'Transparency cycle (100/50/15)', () => withRecs(getRecs(), (r) => app.actions.cycleOpacity(r)));
    mk(ICON_ISOLATE, 'Isolate', () => withRecs(getRecs(), (r) => app.actions.isolate(r, false)));
    mk('&#8943;', 'More', (ev) => {
      const recs = getRecs();
      app.ui.showMenu(ev.clientX, ev.clientY, [
        { head: label },
        { label: 'Hide all instances', onClick: () => withRecs(recs, (r) => app.actions.hide(r)), disabled: !recs.length },
        { label: 'Isolate (ghost rest)', onClick: () => withRecs(recs, (r) => app.actions.isolate(r, true)), disabled: !recs.length },
        { label: 'Make transparent', onClick: () => withRecs(recs, (r) => app.actions.cycleOpacity(r)), disabled: !recs.length },
        { label: 'Snap back', onClick: () => withRecs(recs, (r) => app.actions.snapBack(r)), disabled: !recs.length },
        { sep: true },
        { label: 'Open', onClick: () => withRecs(recs, (r) => app.actions.open(r, label)), disabled: !recs.length },
        vendorUrl ? { label: 'Vendor page', href: vendorUrl } : null,
      ]);
    });
    return wrap;
  }

  // ---- parts list --------------------------------------------------------
  function buildPartsList() {
    partsList.innerHTML = '';
    if (!app.bom.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'parts-empty';
      empty.textContent = 'No parts in payload.';
      partsList.appendChild(empty);
      return;
    }
    for (const entry of app.bom.entries) {
      const el = document.createElement('div');
      el.className = 'part-row';
      const name = entry.name;
      const row = entry.row;
      const part = entry.part || null;

      const thumbUri = part && part.thumbnail;
      if (thumbUri) {
        const img = document.createElement('img');
        img.className = 'part-thumb';
        img.src = thumbUri; // data URI from META — no request
        img.alt = '';
        el.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'part-thumb is-blank';
        ph.textContent = 'no img';
        el.appendChild(ph);
      }

      const main = document.createElement('div');
      main.className = 'part-main';
      const no = document.createElement('div');
      no.className = 'part-no';
      no.textContent = name;
      main.appendChild(no);
      if (row && row.description) {
        const d = document.createElement('div');
        d.className = 'part-desc';
        d.textContent = row.description;
        d.title = row.description;
        main.appendChild(d);
      }
      if (row && row.vendor) {
        const v = document.createElement('div');
        v.className = 'part-vendor';
        v.textContent = row.vendor + (row.vendor_part_no ? ' · ' + row.vendor_part_no : '');
        main.appendChild(v);
      }
      el.appendChild(main);

      const side = document.createElement('div');
      side.className = 'part-side';
      const qty = document.createElement('span');
      qty.className = 'qty-pill';
      qty.textContent = '×' + (part ? part.instances : (row && row.quantity != null ? row.quantity : '?'));
      qty.title = 'total in assembly';
      side.appendChild(qty);
      if (entry.kind === 'row') {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'Not in 3D view';
        b.title = entry.reason === 'hidden'
          ? 'Hidden in the model — no geometry was exported'
          : 'No matching 3D node found';
        side.appendChild(b);
      } else if (part && !part.matched) {
        el.title = name + ' (not in BOM)';
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'not in BOM';
        side.appendChild(b);
      }
      el.appendChild(side);

      if (entry.kind === 'part') {
        const getRecs = () => recsForPart(part);
        el.appendChild(rowActionButtons(getRecs, name, row && row.vendor_url));
        el.addEventListener('pointerenter', () => {
          const recs = getRecs();
          if (recs.length) app.sel.setHover({ ids: recs.map((r) => r.id), partId: part.id });
        });
        el.addEventListener('pointerleave', () => app.sel.setHover(null));
        el.addEventListener('click', (ev) => {
          const recs = getRecs();
          if (!recs.length) return;
          app.sel.select(recs.map((r) => r.id), { additive: ev.ctrlKey || ev.metaKey });
        });
        el.addEventListener('dblclick', () => withRecs(getRecs(), (r) => app.actions.frame(r)));
      }

      entry.el = el;
      // Filter matches every part/vendor field a user might remember.
      entry.searchText = [name, part && part.name, part && part.bom_name,
        row && row.description, row && row.vendor,
        row && row.vendor_part_no].filter(Boolean).join(' ').toLowerCase();
      partsList.appendChild(el);
    }
  }

  // ---- structure tree ----------------------------------------------------
  const tree = buildBomTree(meta);
  const nodeByName = new Map(); // casefold row name -> first tree node

  function buildTreeRow(node, depth) {
    const holder = document.createElement('div');
    const el = document.createElement('div');
    el.className = 'tree-row';
    el.style.paddingLeft = 4 + depth * 14 + 'px';
    const row = node.row;
    const isAsm = (row.type || '').toLowerCase() === 'assembly' || node.children.length > 0;

    const chev = document.createElement('button');
    chev.className = 'tree-chevron';
    if (node.children.length) chev.innerHTML = ICON_CHEVRON;
    el.appendChild(chev);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = isAsm ? ICON_ASM : ICON_PART;
    el.appendChild(icon);

    const nameEl = document.createElement('span');
    nameEl.className = 'tree-name';
    nameEl.textContent = row.name;
    nameEl.title = row.name + (row.description ? ' — ' + row.description : '');
    el.appendChild(nameEl);

    if (row.quantity != null) {
      const q = document.createElement('span');
      q.className = 'tree-qty';
      // "×4 each" whenever the assembly total differs from the per-parent
      // count — Parts says ×16, Structure says ×4, this is the bridge.
      const total = totalByName.get((row.name || '').toLowerCase());
      const differs = total !== undefined && Number(total) !== Number(row.quantity);
      q.textContent = '×' + row.quantity + (differs ? ' each' : '');
      q.title = differs
        ? `${row.quantity} per parent · ${total} total in assembly`
        : `${row.quantity} per parent`;
      el.appendChild(q);
    }

    const getRecs = () => {
      const direct = recsForName(row.name);
      // Ops on an assembly row apply to the whole subtree; the record's own
      // subtree is already implied by record hierarchy.
      return direct;
    };
    el.appendChild(rowActionButtons(getRecs, row.name, row.vendor_url));

    el.addEventListener('pointerenter', () => {
      const recs = getRecs();
      if (recs.length) app.sel.setHover({ ids: recs.map((r) => r.id) });
    });
    el.addEventListener('pointerleave', () => app.sel.setHover(null));
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.tree-chevron')) return;
      const recs = getRecs();
      if (recs.length) app.sel.select(recs.map((r) => r.id), { additive: ev.ctrlKey || ev.metaKey });
    });
    el.addEventListener('dblclick', () => withRecs(getRecs(), (r) => app.actions.frame(r)));

    holder.appendChild(el);
    node.el = el;
    node.holder = holder;
    node.kidsEl = null;
    node.searchText = [row.name, row.description, row.vendor,
      row.vendor_part_no].filter(Boolean).join(' ').toLowerCase();
    if (!nodeByName.has(row.name.toLowerCase())) nodeByName.set(row.name.toLowerCase(), node);

    if (node.children.length) {
      chev.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleNode(node, depth);
      });
    }
    return holder;
  }

  function toggleNode(node, depth, forceOpen) {
    const open = forceOpen !== undefined ? forceOpen : !node.el.classList.contains('is-open');
    node.el.classList.toggle('is-open', open);
    if (open && !node.kidsEl) {
      // Lazy expansion: children rendered on first open.
      node.kidsEl = document.createElement('div');
      node.kidsEl.className = 'tree-kids';
      for (const c of node.children) node.kidsEl.appendChild(buildTreeRow(c, depth + 1));
      node.holder.appendChild(node.kidsEl);
      applySearchToTree(); // newly rendered rows must honor the active filter
    }
    if (node.kidsEl) node.kidsEl.classList.toggle('hidden', !open);
  }

  function buildTree() {
    treeEl.innerHTML = '';
    if (!tree.roots.length) {
      const empty = document.createElement('div');
      empty.className = 'parts-empty';
      empty.textContent = 'No BOM structure in payload.';
      treeEl.appendChild(empty);
      return;
    }
    for (const n of tree.roots) treeEl.appendChild(buildTreeRow(n, 0));
  }

  function expandAncestors(node) {
    const chain = [];
    for (let p = node.parent; p; p = p.parent) chain.unshift(p);
    let depth = 0;
    for (const p of chain) {
      toggleNode(p, depth, true);
      depth += 1;
    }
  }

  function revealSelection() {
    if (!app.model || !app.sel.selected.size) return;
    const first = app.model.records[[...app.sel.selected][0]];
    if (!first) return;
    const part = first.partId !== null ? app.model.partById.get(first.partId) : null;
    const name = (part ? (part.bom_name || part.name) : M.cleanName(first.name)) || '';
    const node = nodeByName.get(name.toLowerCase());
    if (!node) return;
    expandAncestors(node);
    if (node.el) node.el.scrollIntoView({ block: 'nearest' });
  }

  // ---- search ------------------------------------------------------------
  const searchInput = $('searchInput');
  const searchCount = $('searchCount');
  let query = '';

  function applySearchToParts() {
    let hits = 0, total = 0;
    for (const entry of app.bom.entries) {
      if (!entry.el) continue;
      total += 1;
      const hit = !query || entry.searchText.includes(query);
      entry.el.style.display = hit ? '' : 'none';
      if (hit) hits += 1;
    }
    searchCount.textContent = query ? `${hits} of ${total}` : '';
  }

  function applySearchToTree() {
    const walk = (node) => {
      if (node.el) {
        node.el.classList.toggle('is-dim', !!query && !node.searchText.includes(query));
      }
      for (const c of node.children) walk(c);
    };
    for (const n of tree.roots) walk(n);
  }

  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    applySearchToParts();
    applySearchToTree();
  });
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      searchInput.value = '';
      query = '';
      applySearchToParts();
      applySearchToTree();
      searchInput.blur();
      ev.stopPropagation();
    }
  });

  // ---- state sync ----------------------------------------------------------
  function selectedPartIds() {
    const out = new Set();
    if (!app.model) return out;
    for (const id of app.sel.selected) {
      const rec = app.model.records[id];
      if (!rec) continue;
      for (const s of M.subtree(rec)) if (s.partId !== null) out.add(s.partId);
    }
    return out;
  }

  function syncRows() {
    const hoverPart = app.sel.hover && app.sel.hover.partId !== undefined ? app.sel.hover.partId : null;
    const hoverIds = new Set(app.sel.hover ? app.sel.hover.ids : []);
    const selParts = selectedPartIds();
    let firstSelected = null;
    for (const entry of app.bom.entries) {
      if (!entry.el || entry.kind !== 'part') continue;
      const pid = entry.part.id;
      const recs = recsForPart(entry.part);
      const hovered = pid === hoverPart || recs.some((r) => hoverIds.has(r.id));
      const selected = selParts.has(pid);
      entry.el.classList.toggle('is-hover', hovered);
      entry.el.classList.toggle('is-selected', selected);
      const allHidden = !!recs.length && !!app.model &&
        recs.every((r) => M.isEffectivelyHidden(r, app.sel.scope));
      entry.el.classList.toggle('is-off', allHidden);
      if (selected && !firstSelected) firstSelected = entry.el;
    }
    return firstSelected;
  }

  app.events.on('hover', () => syncRows());
  app.events.on('selection', () => {
    const el = syncRows();
    if (el && activeTab === 'parts') el.scrollIntoView({ block: 'nearest' });
    if (activeTab === 'structure') revealSelection();
  });
  app.events.on('appearance', () => syncRows());
  app.events.on('scope', () => syncRows());
  app.events.on('model', () => syncRows());

  buildPartsList();
  buildTree();
}
