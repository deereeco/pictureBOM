// Toolbar, keyboard, context menu, drag-move, explode, splitter, help,
// theme toggle and the "Open" viewing scope. Exposes app.actions — the one
// set of operations panel rows, menus and keys all call.

import * as THREE from 'three';
import * as M from './model.js';
import { normalizeUp, DEFAULT_UP } from './scene.js';

const $ = (id) => document.getElementById(id);

// Up axis is remembered per assembly: the same viewer template opens many
// different models, and "Z is up" is a property of the model, not the reader.
const UP_KEY_PREFIX = 'picturebom-bomdom-up:';

function upStorageKey(meta) {
  const name = (meta && meta.assembly && meta.assembly.name) || 'assembly';
  return UP_KEY_PREFIX + String(name).toLowerCase();
}

export function readStoredUpAxis(meta) {
  try {
    return normalizeUp(localStorage.getItem(upStorageKey(meta)));
  } catch {
    return null; // private mode / file:// with storage blocked
  }
}

function storeUpAxis(meta, axis) {
  try {
    localStorage.setItem(upStorageKey(meta), axis);
  } catch { /* ignore */ }
}

export function initInteractions(app) {
  const sel = app.sel;

  const refresh = () => app.events.emit('appearance');
  const invalidate = () => { if (app.viewer) app.viewer.invalidate(); };

  const selectedRecs = () =>
    app.model ? [...sel.selected].map((id) => app.model.records[id]).filter(Boolean) : [];

  const hoverOrSelected = () => {
    if (!app.model) return [];
    if (sel.hover && sel.hover.recId !== undefined && sel.hover.recId !== null) {
      const rec = app.model.records[sel.hover.recId];
      if (rec) return [rec];
    }
    return selectedRecs();
  };

  // ---- actions ---------------------------------------------------------
  const actions = {
    hide(recs) { M.setHidden(recs, true); refresh(); },
    show(recs) { M.setHidden(recs, false); refresh(); },
    toggleHidden(recs) {
      const anyVisible = recs.some((r) => !r.flags.hidden);
      M.setHidden(recs, anyVisible);
      refresh();
    },
    cycleOpacity(recs) { M.cycleOpacity(recs); refresh(); },
    isolate(recs, ghostRest) {
      if (!app.model || !recs.length) return;
      M.isolate(app.model, recs, !!ghostRest);
      refresh();
    },
    frame(recs) {
      if (!app.viewer || !app.model) return;
      const target = recs && recs.length ? recs : app.model.rootRecs;
      app.model.root.updateWorldMatrix(true, true);
      const pts = M.pointsOfRecs(target);
      if (pts.length) app.viewer.framePoints(pts);
    },
    open(recs, label) {
      if (!app.model || !recs.length) return;
      sel.setScope({ label, recIds: M.scopeSetFor(recs) });
      actions.frame(recs);
    },
    closeScope() {
      if (!sel.scope) return;
      sel.setScope(null);
      if (app.model) actions.frame(null);
    },
    snapBack(recs) {
      if (!app.viewer || !app.model) return;
      M.snapBack(app.model, recs, app.viewer.addTween,
        () => { M.applyPositions(app.model, app.model.explodeF); invalidate(); },
        () => app.events.emit('positions'));
    },
    resetPositions() {
      if (!app.model) return;
      actions.snapBack(M.movedRecs(app.model));
      tweenExplodeTo(0);
    },
    resetAll() {
      // Facet filters + color-by clear even with no model (they filter the
      // panel list in degraded mode too).
      if (app.ui.clearFilters) app.ui.clearFilters();
      if (!app.model) return;
      sel.setScope(null);
      sel.clearSelection();
      M.resetAppearance(app.model);
      actions.resetPositions();
      refresh();
    },
    setMoveMode(on) {
      app.moveMode = on;
      $('btnMove').classList.toggle('is-on', on);
      $('gl').classList.toggle('is-move', on);
    },
    // name ('iso', 'top', ...) or a world direction from the axis gizmo.
    setView(nameOrDir) {
      if (!app.viewer) return;
      app.viewer.setView(nameOrDir);
      actions.frame(selectedRecs()); // no selection -> refits the assembly
    },
    setUpAxis(axis, opts) {
      if (!app.viewer) return;
      const applied = app.viewer.setUpAxis(axis, opts);
      storeUpAxis(app.meta, applied);
      if (app.ui.syncAxisGizmo) app.ui.syncAxisGizmo();
      actions.frame(selectedRecs());
    },
  };
  app.actions = actions;

  // ---- explode (guided setup popover) ----------------------------------
  const slider = $('explodeSlider');
  slider.addEventListener('input', () => {
    if (!app.model) return;
    M.applyPositions(app.model, parseFloat(slider.value));
    invalidate();
  });
  // Exploded parts must never fly out of view: reframe when the gesture ends.
  slider.addEventListener('change', () => actions.frame(null));

  function tweenExplodeTo(target) {
    if (!app.model || !app.viewer) return;
    const from = app.model.explodeF;
    if (Math.abs(target - from) < 1e-3) return;
    app.viewer.addTween({
      duration: 500,
      update: (k) => {
        const f = from + (target - from) * k;
        slider.value = String(f);
        M.applyPositions(app.model, f);
      },
      done: () => actions.frame(null),
    });
  }

  // Session-persistent setup; null fields fall back to model defaults.
  app.explodeCfg = { anchorRecId: null, mode: null, plane: null, spread: 'both' };
  const explodeMenu = $('explodeMenu');

  function anchorName() {
    const id = app.explodeCfg.anchorRecId;
    if (id == null || !app.model || !app.model.records[id]) return null;
    const rec = app.model.records[id];
    const part = rec.partId !== null ? app.model.partById.get(rec.partId) : null;
    return part ? (part.bom_name || part.name) : (M.cleanName(rec.name) || rec.name);
  }

  // text: a string, or a Node for the colour-coded axis labels.
  function popRadio(name, value, checked, text, onChange, disabled) {
    const lab = document.createElement('label');
    lab.className = 'menu-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = name;
    r.value = value;
    r.checked = checked;
    r.disabled = !!disabled;
    r.addEventListener('change', onChange);
    lab.appendChild(r);
    if (text instanceof Node) lab.appendChild(text);
    else lab.appendChild(document.createTextNode(' ' + text));
    return lab;
  }

  function popHead(container, text) {
    const h = document.createElement('div');
    h.className = 'menu-head';
    h.textContent = text;
    container.appendChild(h);
  }

  function popNote(container, text) {
    const n = document.createElement('div');
    n.className = 'pop-note';
    n.textContent = text;
    n.title = text;
    container.appendChild(n);
    return n;
  }

  // The one place X/Y/Z gets rendered: same colour as the corner gizmo, with
  // an arrow on whichever axis is currently pointing up on screen.
  function axisLabel(letter, { markUp = true } = {}) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(' '));
    const s = document.createElement('span');
    s.className = 'ax-text ax-' + letter;
    s.textContent = letter.toUpperCase();
    frag.appendChild(s);
    if (markUp && app.viewer && app.viewer.upAxis[1] === letter) {
      const arrow = document.createElement('span');
      arrow.textContent = app.viewer.upAxis[0] === '-' ? ' ↓' : ' ↑';
      arrow.title = 'currently up on screen';
      frag.appendChild(arrow);
    }
    return frag;
  }

  function buildExplodePopover() {
    const cfg = app.explodeCfg;
    const mode = cfg.mode || (app.model ? app.model.defaultExplodeMode : 'radial');
    explodeMenu.innerHTML = '';
    const head = (t) => popHead(explodeMenu, t);

    head('Anchor (stays fixed)');
    const aRow = document.createElement('div');
    aRow.className = 'pop-inline';
    aRow.appendChild(popRadio('bdExAnchor', 'auto', cfg.anchorRecId == null, 'Auto',
      () => { cfg.anchorRecId = null; buildExplodePopover(); }));
    const pickBtn = document.createElement('button');
    pickBtn.className = 'pop-mini-btn';
    pickBtn.textContent = cfg.anchorRecId == null ? 'Pick…' : 'Re-pick…';
    pickBtn.addEventListener('click', enterAnchorPick);
    aRow.appendChild(pickBtn);
    explodeMenu.appendChild(aRow);
    popNote(explodeMenu, cfg.anchorRecId == null
      ? 'Auto: largest part (usually the base plate)'
      : 'Anchor: ' + anchorName());

    head('Direction (model axes)');
    const dRow = document.createElement('div');
    dRow.className = 'pop-inline';
    dRow.appendChild(popRadio('bdExDir', 'radial', mode === 'radial', 'Radial',
      () => { cfg.mode = 'radial'; buildExplodePopover(); }));
    for (const letter of ['x', 'y', 'z']) {
      dRow.appendChild(popRadio('bdExDir', letter, mode === letter, axisLabel(letter),
        () => { cfg.mode = letter; buildExplodePopover(); }));
    }
    explodeMenu.appendChild(dRow);

    if (mode === 'radial') {
      head('Plane');
      const pRow = document.createElement('div');
      pRow.className = 'pop-inline';
      const plane = cfg.plane || (app.model ? app.model.defaultExplodePlane : 'free');
      for (const [value, text] of [['xy', 'XY'], ['yz', 'YZ'], ['xz', 'XZ'], ['free', 'Free (3D)']]) {
        pRow.appendChild(popRadio('bdExPlane', value, plane === value, text,
          () => { cfg.plane = value; }));
      }
      explodeMenu.appendChild(pRow);
    } else {
      head('Spread');
      const sRow = document.createElement('div');
      sRow.className = 'pop-inline';
      sRow.appendChild(popRadio('bdExSpread', 'both', cfg.spread !== 'one', 'Both directions (±)',
        () => { cfg.spread = 'both'; }));
      sRow.appendChild(popRadio('bdExSpread', 'one', 'one' === cfg.spread, 'One direction (+)',
        () => { cfg.spread = 'one'; }));
      explodeMenu.appendChild(sRow);
    }

    const btns = document.createElement('div');
    btns.className = 'pop-actions';
    const apply = document.createElement('button');
    apply.className = 'pop-btn pop-btn-primary';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => { closeMenus(); applyExplodeCfg(); });
    const collapse = document.createElement('button');
    collapse.className = 'pop-btn';
    collapse.textContent = 'Collapse';
    collapse.addEventListener('click', () => { closeMenus(); tweenExplodeTo(0); });
    btns.appendChild(apply);
    btns.appendChild(collapse);
    explodeMenu.appendChild(btns);
  }

  function applyExplodeCfg() {
    if (!app.model) return;
    M.computeExplodeVectors(app.model, app.explodeCfg);
    if (app.model.explodeF < 0.05) tweenExplodeTo(0.6);
    else {
      M.applyPositions(app.model, app.model.explodeF);
      invalidate();
      actions.frame(null);
    }
  }

  function enterAnchorPick() {
    closeMenus();
    app.anchorPickMode = true;
    canvas.classList.add('is-pick');
    app.ui.toast('Click the part that stays fixed (Esc to cancel)');
  }
  function exitAnchorPick() {
    app.anchorPickMode = false;
    canvas.classList.remove('is-pick');
  }
  app.ui.anchorPicked = (rec) => {
    exitAnchorPick();
    if (rec && app.model) {
      const top = M.topAncestorOf(app.model, rec);
      if (top) app.explodeCfg.anchorRecId = top.id;
    } else {
      app.ui.toast('No part there — anchor unchanged');
    }
    buildExplodePopover();
    explodeMenu.classList.remove('hidden');
  };

  $('btnExplode').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!app.model) return;
    if (!explodeMenu.classList.contains('hidden')) {
      explodeMenu.classList.add('hidden');
      return;
    }
    closeMenus();
    buildExplodePopover();
    explodeMenu.classList.remove('hidden');
  });

  // ---- view (up axis + standard views) ---------------------------------
  const viewMenu = $('viewMenu');
  const VIEW_BUTTONS = [
    ['iso', 'Iso'], ['top', 'Top'], ['front', 'Front'], ['right', 'Right'],
    ['fit', 'Fit'], ['bottom', 'Bottom'], ['back', 'Back'], ['left', 'Left'],
  ];

  function buildViewPopover() {
    const up = app.viewer ? app.viewer.upAxis : DEFAULT_UP;
    viewMenu.innerHTML = '';
    popHead(viewMenu, 'Which way is up');

    const uRow = document.createElement('div');
    uRow.className = 'pop-inline';
    for (const letter of ['x', 'y', 'z']) {
      uRow.appendChild(popRadio('bdUpAxis', letter, up[1] === letter,
        axisLabel(letter, { markUp: false }),
        () => { actions.setUpAxis(up[0] + letter); buildViewPopover(); }));
    }
    viewMenu.appendChild(uRow);

    const flip = document.createElement('label');
    flip.className = 'pop-check';
    const flipBox = document.createElement('input');
    flipBox.type = 'checkbox';
    flipBox.checked = up[0] === '-';
    flipBox.addEventListener('change', () => {
      actions.setUpAxis((flipBox.checked ? '-' : '+') + up[1]);
      buildViewPopover();
    });
    flip.appendChild(flipBox);
    flip.appendChild(document.createTextNode(' Flip (model is upside down)'));
    viewMenu.appendChild(flip);

    popNote(viewMenu, `Orbit spins around ${up[0] === '-' ? '−' : ''}${up[1].toUpperCase()}`);
    popNote(viewMenu, 'X/Y/Z always mean the model’s own axes');

    popHead(viewMenu, 'Standard views');
    const grid = document.createElement('div');
    grid.className = 'view-grid';
    for (const [name, text] of VIEW_BUTTONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pop-btn';
      b.textContent = text;
      b.addEventListener('click', () => {
        if (name === 'fit') actions.frame(selectedRecs());
        else actions.setView(name);
      });
      grid.appendChild(b);
    }
    viewMenu.appendChild(grid);
  }

  function openViewMenu() {
    if (!app.viewer) return;
    closeMenus();
    buildViewPopover();
    viewMenu.classList.remove('hidden');
  }
  app.ui.openViewMenu = openViewMenu;

  $('btnView').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!viewMenu.classList.contains('hidden')) {
      viewMenu.classList.add('hidden');
      return;
    }
    openViewMenu();
  });

  $('btnMove').addEventListener('click', () => actions.setMoveMode(!app.moveMode));
  $('btnReset').addEventListener('click', () => actions.resetAll());

  // ---- drag-move -------------------------------------------------------
  // This pointerdown registers BEFORE OrbitControls' (createViewer runs
  // later in boot), so disabling the controls here prevents the same
  // gesture from ever starting an orbit.
  const canvas = $('gl');
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !app.model || !app.viewer) return;
    if (app.anchorPickMode) return; // resolved as a click on pointerup
    if (ev.ctrlKey || ev.metaKey) { startMarquee(ev); return; }
    if (!(app.moveMode || ev.shiftKey)) return;
    const hit = app.pick(ev);
    if (!hit) return;
    startDrag(ev, hit);
  });

  function startDrag(ev, hit) {
    const { viewer } = app;
    // Dragging a member of a multi-selection moves the whole selection;
    // records whose ancestor is also selected ride along with the ancestor.
    let targets = (sel.selected.has(hit.rec.id) && sel.selected.size > 1)
      ? selectedRecs() : [hit.rec];
    const targetIds = new Set(targets.map((r) => r.id));
    targets = targets.filter((r) => {
      for (let a = r.parent; a; a = a.parent) if (targetIds.has(a.id)) return false;
      return true;
    });
    viewer.controls.enabled = false;
    app.dragging = true;
    canvas.classList.add('is-dragging');
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    sel.setHover(null);

    // Camera-facing plane through the grab point; one plane intersection
    // per pointermove.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      viewer.camera.getWorldDirection(new THREE.Vector3()).negate(), hit.point);
    const startDeltas = targets.map((r) => r.dragDelta.clone());
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const worldPoint = new THREE.Vector3();

    const planeHit = (e) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, viewer.camera);
      return ray.ray.intersectPlane(plane, worldPoint) ? worldPoint : null;
    };

    const onMove = (e) => {
      const p = planeHit(e);
      if (!p) return;
      const worldDelta = p.clone().sub(hit.point);
      targets.forEach((r, i) => {
        // Reference point cancels out of the affine delta map — one point works for all.
        r.dragDelta.copy(startDeltas[i]).add(
          M.worldDeltaToLocal(r.object.parent, worldDelta, hit.point));
        r.flags.moved = r.dragDelta.lengthSq() > 0;
      });
      M.applyPositions(app.model, app.model.explodeF);
      invalidate();
    };
    const onUp = (e) => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      viewer.controls.enabled = true;
      app.dragging = false;
      canvas.classList.remove('is-dragging');
      app.events.emit('positions');
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  // ---- marquee (Ctrl+drag box select) -----------------------------------
  function startMarquee(ev) {
    const { viewer } = app;
    viewer.controls.enabled = false; // pre-empt orbit for this gesture
    const marquee = $('marquee');
    const viewportEl = $('viewport');
    const startX = ev.clientX, startY = ev.clientY;
    let active = false; // becomes true past the click-slop threshold

    const onMove = (e) => {
      if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
        active = true;
        app.dragging = true; // hover + click-select stand down
        marquee.classList.remove('hidden');
      }
      if (!active) return;
      const vr = viewportEl.getBoundingClientRect();
      marquee.style.left = Math.min(startX, e.clientX) - vr.left + 'px';
      marquee.style.top = Math.min(startY, e.clientY) - vr.top + 'px';
      marquee.style.width = Math.abs(e.clientX - startX) + 'px';
      marquee.style.height = Math.abs(e.clientY - startY) + 'px';
    };
    const teardown = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      viewer.controls.enabled = true;
      marquee.classList.add('hidden');
    };
    const onUp = (e) => {
      teardown();
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (!active) return; // tiny ctrl-click: picking's pointerup toggles as before
      selectMarquee(e);
      app.dragging = false; // after picking's pointerup already ran (registered earlier)
    };
    const onCancel = () => { teardown(); app.dragging = false; };
    const onKey = (e) => {
      if (e.key === 'Escape') { // cancel mid-drag, keep the selection as it was
        e.stopPropagation();
        teardown();
        app.dragging = false;
      }
    };
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);

    function selectMarquee(e) {
      const minX = Math.min(startX, e.clientX), maxX = Math.max(startX, e.clientX);
      const minY = Math.min(startY, e.clientY), maxY = Math.max(startY, e.clientY);
      const cr = canvas.getBoundingClientRect();
      const ids = [];
      const seen = new Set();
      for (const mesh of app.model.pickables) { // visible, non-ghost meshes only
        const rec = app.model.meshRecords.get(mesh);
        if (!rec || seen.has(rec.id)) continue;
        seen.add(rec.id);
        const c = M.recWorldCenter(rec);
        if (!c) continue;
        c.project(viewer.camera);
        if (c.z < -1 || c.z > 1) continue; // behind the camera / past far plane
        const px = cr.left + ((c.x + 1) / 2) * cr.width;
        const py = cr.top + ((1 - c.y) / 2) * cr.height;
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) ids.push(rec.id);
      }
      if (ids.length) sel.select(ids, { additive: true }); // Ctrl semantics: adds
    }
  }

  // ---- context menu ----------------------------------------------------
  const ctxMenu = $('ctxMenu');

  function closeMenus() {
    ctxMenu.classList.add('hidden');
    $('exportMenu').classList.add('hidden');
    $('explodeMenu').classList.add('hidden');
    viewMenu.classList.add('hidden');
  }
  app.ui.closeMenus = closeMenus;
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || (!t.closest('.dropdown') && !t.closest('.menu-anchor'))) closeMenus();
  });

  function menuItem(label, onClick, { disabled = false, href = null } = {}) {
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'menu-item';
    el.textContent = label;
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; }
    if (disabled) el.disabled = true;
    el.addEventListener('click', () => { closeMenus(); if (onClick) onClick(); });
    return el;
  }

  // items: {label,onClick,href,disabled} | {head} | {sep}. null items skipped.
  app.ui.showMenu = (x, y, items) => {
    ctxMenu.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'menu-sep';
        ctxMenu.appendChild(s);
      } else if (it.head) {
        const h = document.createElement('div');
        h.className = 'menu-head';
        h.textContent = it.head;
        ctxMenu.appendChild(h);
      } else {
        ctxMenu.appendChild(menuItem(it.label, it.onClick, it));
      }
    }
    ctxMenu.classList.remove('hidden');
    // Position after layout so the menu never overflows the window.
    ctxMenu.style.left = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8) + 'px';
  };

  app.ui.showContextMenu = (x, y, rec) => {
    const items = [];
    if (rec) {
      // On a member of the current multi-selection the menu operates on the
      // WHOLE selection (marquee -> right-click -> isolate).
      const multi = sel.selected.has(rec.id) && sel.selected.size > 1;
      const n = sel.selected.size;
      const targets = multi ? selectedRecs() : [rec];
      const insts = M.allInstances(app.model, rec);
      const part = rec.partId !== null ? app.model.partById.get(rec.partId) : null;
      const label = multi ? `${n} selected`
        : (part ? (part.bom_name || part.name) : (M.cleanName(rec.name) || 'part'));
      const row = part ? app.bom.rowFor(part) : null;
      const anyMoved = targets.some((r) => r.flags.moved || r.dragDelta.lengthSq() > 0);
      items.push(
        { head: label },
        { label: multi ? `Hide ${n} selected` : 'Hide', onClick: () => actions.hide(targets) },
        !multi && insts.length > 1
          ? { label: `Hide all instances (${insts.length})`, onClick: () => actions.hide(insts) } : null,
        { label: multi ? `Isolate ${n} selected` : 'Isolate', onClick: () => actions.isolate(targets, false) },
        { label: multi ? `Isolate ${n} selected (ghost rest)` : 'Isolate (ghost rest)', onClick: () => actions.isolate(targets, true) },
        { label: multi ? `Make ${n} selected transparent` : 'Make transparent', onClick: () => actions.cycleOpacity(targets) },
        { sep: true },
        { label: 'Move', onClick: () => { actions.setMoveMode(true); app.ui.toast(multi ? 'Move mode on — drag any selected part to move all (M to exit)' : 'Move mode on — drag the part (M to exit)'); } },
        anyMoved
          ? { label: multi ? `Snap back ${n} selected` : 'Snap back', onClick: () => actions.snapBack(targets) } : null,
        { sep: true },
        { label: multi ? `Open ${n} selected` : 'Open', onClick: () => actions.open(targets, label) },
        !multi && row && row.vendor_url ? { label: 'Vendor page', href: row.vendor_url } : null,
      );
    } else {
      items.push(
        { label: 'Show all', onClick: () => { if (app.model) { M.resetAppearance(app.model); refresh(); } } },
        { label: 'Reset positions', onClick: () => actions.resetPositions() },
        { label: 'Reset all', onClick: () => actions.resetAll() },
      );
    }
    app.ui.showMenu(x, y, items);
  };

  // ---- scope chip ------------------------------------------------------
  app.events.on('scope', (scope) => {
    $('scopeChip').classList.toggle('hidden', !scope);
    if (scope) $('scopeLabel').textContent = 'Viewing: ' + scope.label;
  });
  $('scopeClose').addEventListener('click', () => actions.closeScope());

  // ---- keyboard --------------------------------------------------------
  window.addEventListener('keydown', (ev) => {
    const inField = ev.target && (ev.target.matches ? ev.target.matches('input, textarea, select') : false);
    if (ev.key === 'Escape') {
      if (app.anchorPickMode) { exitAnchorPick(); return; }
      if (inField) { ev.target.blur(); return; }
      closeMenus();
      if (!$('helpOverlay').classList.contains('hidden')) { $('helpOverlay').classList.add('hidden'); return; }
      if (sel.clearSelection()) return;
      if (sel.scope) actions.closeScope();
      return;
    }
    if (inField) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // never shadow browser shortcuts
    const key = ev.key.toLowerCase();
    // CAD-style number keys for the standard views.
    const VIEW_KEYS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 0: 'iso' };
    if (VIEW_KEYS[ev.key]) { actions.setView(VIEW_KEYS[ev.key]); return; }
    if (key === 'm') actions.setMoveMode(!app.moveMode);
    else if (key === 'h') { const t = hoverOrSelected(); if (t.length) { actions.hide(t); sel.setHover(null); } }
    else if (key === 'i') { const t = hoverOrSelected(); if (t.length) actions.isolate(t, false); }
    else if (key === 'f') actions.frame(selectedRecs());
    else if (ev.key === '?') $('helpOverlay').classList.toggle('hidden');
  });

  // ---- help ------------------------------------------------------------
  $('btnHelp').addEventListener('click', () => $('helpOverlay').classList.toggle('hidden'));
  $('helpClose').addEventListener('click', () => $('helpOverlay').classList.add('hidden'));
  $('helpOverlay').addEventListener('click', (ev) => {
    if (ev.target === $('helpOverlay')) $('helpOverlay').classList.add('hidden');
  });

  // ---- panel splitter --------------------------------------------------
  const splitter = $('splitter');
  const panel = $('panel');
  splitter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    splitter.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startW = panel.getBoundingClientRect().width;
    const onMove = (e) => {
      const w = Math.max(240, Math.min(window.innerWidth * 0.65, startW + (startX - e.clientX)));
      panel.style.width = w + 'px';
    };
    const onUp = () => {
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });

  // ---- theme toggle (mirrors pictureBOM's static/app.js) ---------------
  const THEME_KEY = 'picturebom-theme'; // must match the inline boot script
  let themeTransitionTimer = null;
  function setTheme(theme) {
    document.documentElement.classList.add('theme-transition');
    document.documentElement.setAttribute('data-theme', theme);
    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(
      () => document.documentElement.classList.remove('theme-transition'), 300);
  }
  $('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  });
  // Follow OS theme changes only until the user makes an explicit choice.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { /* ignore */ }
    if (stored !== 'light' && stored !== 'dark') setTheme(e.matches ? 'dark' : 'light');
  });
}
