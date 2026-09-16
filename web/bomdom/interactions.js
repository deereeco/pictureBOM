// Toolbar, keyboard, context menu, drag-move, explode, splitter, help,
// theme toggle and the "Open" viewing scope. Exposes app.actions — the one
// set of operations panel rows, menus and keys all call.

import * as THREE from 'three';
import * as M from './model.js';
import { copyText, joinPartNumbers, copiedToast } from './clipboard.js';
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

// Part edges are a reader preference (unlike up axis, which belongs to the
// model), so one global key — same idea as picturebom-theme. Missing -> on.
const EDGES_KEY = 'picturebom-bomdom-edges';

function readStoredEdges() {
  try {
    return localStorage.getItem(EDGES_KEY) !== 'off';
  } catch {
    return true;
  }
}

function storeEdges(on) {
  try {
    localStorage.setItem(EDGES_KEY, on ? 'on' : 'off');
  } catch { /* ignore */ }
}

// Render style is a reader preference like edges. Missing -> 'shaded' (the
// CAD-viewport look); 'realistic' is the opt-in photo look.
const STYLE_KEY = 'picturebom-bomdom-style';

function readStoredStyle() {
  try {
    return localStorage.getItem(STYLE_KEY) === 'realistic' ? 'realistic' : 'shaded';
  } catch {
    return 'shaded';
  }
}

function storeStyle(style) {
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch { /* ignore */ }
}

export function initInteractions(app) {
  const sel = app.sel;

  const refresh = () => app.events.emit('appearance');
  const invalidate = () => { if (app.viewer) app.viewer.invalidate(); };

  const selectedRecs = () =>
    app.model ? [...sel.selected].map((id) => app.model.records[id]).filter(Boolean) : [];

  const displayName = (rec) => {
    const part = rec.partId !== null && app.model ? app.model.partById.get(rec.partId) : null;
    return part ? (part.bom_name || part.name) : (M.instanceLabel(rec.name) || 'part');
  };

  // What "Copy part number" puts on the clipboard (issue #32): the BOM name
  // for a part, the instance-suffix-free name for a subassembly.
  const partNumberOf = (rec) => {
    const part = rec.partId !== null && app.model ? app.model.partById.get(rec.partId) : null;
    return part ? (part.bom_name || part.name) : (M.cleanName(rec.name) || rec.name || '');
  };
  const uniquePartNumbers = (recs) => [...new Set(recs.map(partNumberOf).filter(Boolean))];
  async function copyPartNumbers(recs) {
    const names = uniquePartNumbers(recs);
    if (!names.length) return false;
    const ok = await copyText(joinPartNumbers(names));
    app.ui.toast(ok ? copiedToast(names) : 'Copy failed — the browser blocked clipboard access');
    return ok;
  }

  // Records none of whose ancestors are also in the set — the units a
  // selection is made of (a selected subassembly counts once, not per part).
  const selectionRoots = (recs) => {
    const ids = new Set(recs.map((r) => r.id));
    return recs.filter((r) => {
      for (let a = r.parent; a; a = a.parent) if (ids.has(a.id)) return false;
      return true;
    });
  };

  const openLabelFor = (recs) => {
    const roots = selectionRoots(recs);
    return roots.length === 1 ? displayName(roots[0]) : `${roots.length} selected`;
  };

  // ---- level navigation state ------------------------------------------
  // The level in view: the opened subassembly record, or null at the top.
  const currentLevelRec = () => (sel.scope && sel.scope.anchorId != null && app.model)
    ? app.model.records[sel.scope.anchorId] || null : null;
  // The records a loose (multi-piece) scope was opened on.
  const scopeRoots = () => (sel.scope && sel.scope.rootIds && app.model)
    ? sel.scope.rootIds.map((id) => app.model.records[id]).filter(Boolean) : [];
  // Nearest record whose subtree holds every rec (null: only the top does).
  const commonAncestor = (recs) => {
    if (!recs.length) return null;
    const holds = (a, r) => { for (let x = r; x; x = x.parent) if (x === a) return true; return false; };
    for (let a = recs[0].parent; a; a = a.parent) if (recs.every((r) => holds(a, r))) return a;
    return null;
  };
  // Direct child of `level` — null meaning the top: the root wrapper's
  // children, or the loose root records when the export has no wrapper.
  const isChildOfLevel = (rec, level) => level
    ? rec.parent === level
    : (!rec.parent || rec.parent === M.rootWrapper(app.model));
  // Levels climbed out of, nearest first. Down retraces them when nothing is
  // selected to steer by, so up-up then down-down lands where you started.
  let downTrail = [];
  // Where Down would go, or null: the child of the current level holding the
  // selection, else the head of the retrace trail. Never a bare part — the
  // stack moves between assembly levels; O still opens a single part.
  function downTargetOf() {
    if (!app.model) return null;
    const cur = currentLevelRec();
    const roots = selectionRoots(selectedRecs());
    if (roots.length) {
      const lca = roots.length === 1 ? roots[0] : commonAncestor(roots);
      if (lca && lca !== cur) {
        const t = M.levelTargetOf(app.model, lca, cur);
        if (t !== cur && t.children.length && isChildOfLevel(t, cur)) return t;
      }
    }
    const head = downTrail.length ? app.model.records[downTrail[0]] : null;
    return head && head.children.length && isChildOfLevel(head, cur) ? head : null;
  }
  // Every level change funnels through here: scope, selection tidy-up, camera.
  function applyScope(recs, label, anchorId) {
    const roots = selectionRoots(recs);
    sel.setScope({ label, recIds: M.scopeSetFor(recs), anchorId, rootIds: roots.map((r) => r.id) });
    // A selection that IS the new scope (or reaches outside it) would tint
    // everything in view — that reads as a render bug. A part deeper inside
    // stays selected: it keeps steering Down on the next press.
    const strictlyInside = (id) => {
      for (let r = app.model.records[id]; r; r = r.parent) if (r.id === anchorId) return id !== anchorId;
      return false;
    };
    if (anchorId == null || ![...sel.selected].every(strictlyInside)) sel.clearSelection();
    actions.frame(recs);
  }

  app.edgesOn = readStoredEdges();
  app.renderStyle = readStoredStyle();

  // The orbit pivot follows what you can SEE — but only when it has to.
  // Rule: if the current pivot still sits inside (a slightly padded) box of
  // the visible parts, the user's framing is respected and nothing moves;
  // only when what they were orbiting is gone (isolate elsewhere, hide the
  // thing under the pivot, hide-others filter) does the pivot glide to the
  // new visible center. Bounds come from selection state, not
  // object.visible, so event ordering vs updateVisuals cannot bite.
  let pivotToken = null;
  function retargetOrbit() {
    if (!app.viewer || !app.model) return;
    app.model.root.updateWorldMatrix(true, true);
    const box = M.visibleBounds(app.model, sel.scope, sel.filter);
    if (box.isEmpty()) return; // everything hidden: keep the old pivot
    const from = app.viewer.controls.target.clone();
    if (box.clone().expandByScalar(app.model.diagLen * 0.05).containsPoint(from)) return;
    const center = box.getCenter(new THREE.Vector3());
    if (center.distanceTo(from) < app.model.diagLen * 1e-3) return;
    const token = pivotToken = {};
    app.viewer.addTween({
      duration: 220,
      update: (k) => {
        if (pivotToken !== token) return; // a newer retarget (or a frame) took over
        // controls is a getter (rebuilt on up-axis changes) — re-read it.
        app.viewer.controls.target.copy(from).lerp(center, k);
        app.viewer.controls.update();
      },
    });
  }

  // ---- actions ---------------------------------------------------------
  // Every explicit hide gesture (H key, context menu, panel eye icon) pushes
  // the recs it actually hid; Shift+H pops the most recent batch that is
  // still hidden. Isolate is not a hide gesture — R already undoes it.
  const hideHistory = [];
  const pushHideUndo = (recs) => {
    const newly = recs.filter((r) => !r.flags.hidden);
    if (newly.length) hideHistory.push(newly);
  };
  // Visibility changed: the explode redistributes over what's left (a
  // re-shown part must rejoin the flown cloud, not sit at home inside it),
  // THEN the pivot re-checks its containment against the new positions.
  const afterVisibilityChange = () => { reexplodeForView(); retargetOrbit(); };
  const actions = {
    hide(recs) { pushHideUndo(recs); M.setHidden(recs, true); refresh(); afterVisibilityChange(); },
    show(recs) { M.setHidden(recs, false); refresh(); afterVisibilityChange(); },
    toggleHidden(recs) {
      const anyVisible = recs.some((r) => !r.flags.hidden);
      if (anyVisible) pushHideUndo(recs);
      M.setHidden(recs, anyVisible);
      refresh();
      afterVisibilityChange();
    },
    unhideLast() {
      // Batches whose parts were re-shown some other way are stale: skip.
      while (hideHistory.length) {
        const batch = hideHistory.pop().filter((r) => r.flags.hidden);
        if (!batch.length) continue;
        M.setHidden(batch, false);
        refresh();
        afterVisibilityChange();
        const rec = batch[0];
        const part = rec.partId !== null ? app.model.partById.get(rec.partId) : null;
        const name = part ? (part.bom_name || part.name) : (M.cleanName(rec.name) || 'part');
        app.ui.toast(batch.length > 1 ? `Unhid ${batch.length} parts` : `Unhid ${name}`);
        return;
      }
      app.ui.toast('Nothing to unhide');
    },
    cycleOpacity(recs) { M.cycleOpacity(recs); refresh(); },
    isolate(recs, ghostRest) {
      if (!app.model || !recs.length) return;
      M.isolate(app.model, recs, !!ghostRest);
      refresh();
      afterVisibilityChange();
    },
    frame(recs) {
      if (!app.viewer || !app.model) return;
      pivotToken = null; // an explicit framing beats any in-flight pivot glide
      const target = recs && recs.length ? recs : app.model.rootRecs;
      app.model.root.updateWorldMatrix(true, true);
      const pts = M.pointsOfRecs(target);
      if (pts.length) app.viewer.framePoints(pts);
    },
    open(recs, label) {
      if (!app.model || !recs.length) return;
      // A single-root scope is anchored: Up walks its parent chain.
      const roots = selectionRoots(recs);
      const anchorId = roots.length === 1 ? roots[0].id : null;
      // Opening the level the retrace trail points at IS a Down step, so the
      // rest of the trail survives; opening anything else starts a new path.
      downTrail = anchorId != null && downTrail[0] === anchorId ? downTrail.slice(1) : [];
      applyScope(recs, label, anchorId);
    },
    openRecs(recs) { actions.open(recs, openLabelFor(recs)); },
    upScope() {
      if (!sel.scope || !app.model) return;
      const anchor = currentLevelRec();
      // A loose multi-part scope has no anchor: climb to the level that holds
      // all its pieces instead.
      const parent = anchor ? anchor.parent : commonAncestor(scopeRoots());
      if (!parent || parent === M.rootWrapper(app.model)) { actions.closeScope(); return; }
      if (anchor) downTrail.unshift(anchor.id);
      applyScope([parent], displayName(parent), parent.id);
    },
    downScope() {
      const t = downTargetOf();
      if (!t) return;
      if (downTrail[0] === t.id) downTrail.shift(); else downTrail = [];
      applyScope([t], displayName(t), t.id);
    },
    // Shift+↓: straight to the selection's own subassembly — or, with nothing
    // selected, to the far end of the retrace trail.
    diveScope() {
      if (!app.model) return;
      const cur = currentLevelRec();
      const wrapper = M.rootWrapper(app.model);
      const roots = selectionRoots(selectedRecs());
      let target = null;
      let used = 0;
      if (roots.length) {
        const lca = roots.length === 1 ? roots[0] : commonAncestor(roots);
        target = lca && lca.children.length ? lca : (lca ? lca.parent : null);
      } else {
        let level = cur;
        for (; used < downTrail.length; used++) {
          const r = app.model.records[downTrail[used]];
          if (!r || !r.children.length || !isChildOfLevel(r, level)) break;
          level = r; target = r;
        }
      }
      if (!target || target === wrapper || target === cur) return;
      downTrail = roots.length ? [] : downTrail.slice(used);
      applyScope([target], displayName(target), target.id);
    },
    closeScope() {
      if (!sel.scope) return;
      // Remember the chain being climbed out of so Down can retrace it.
      const wrapper = app.model ? M.rootWrapper(app.model) : null;
      const chain = [];
      for (let r = currentLevelRec(); r && r !== wrapper; r = r.parent) chain.unshift(r.id);
      downTrail = chain.length ? [...chain, ...downTrail] : [];
      sel.setScope(null);
      if (app.model) actions.frame(null);
    },
    setAssemblyMode(on) {
      on = !!on;
      if (on === !!app.assemblyMode) return;
      app.assemblyMode = on;
      $('btnAssembly').classList.toggle('is-on', on);
      $('gl').classList.toggle('is-assembly', on);
      // Measure and instructions own the canvas's clicks outright: exit them.
      // Move mode COMPOSES with assembly mode — hover, click and drag all
      // resolve through the same subassembly unit (M.assemblyUnitOf), so the
      // preview and the gesture can never disagree.
      if (on && app.measureMode && app.measure) app.measure.toggle();
      if (on && app.instructions && app.instructions.on) app.instructions.set(false);
      // What CANVAS hover resolves to just changed either way — clear a stale
      // preview so it can't promise the old target until the pointer next
      // moves. A panel-row hover stays: no mode changes what a row means.
      if (sel.hover && sel.hover.src === 'canvas') sel.setHover(null);
      if (on) {
        app.ui.toast(app.moveMode
          ? 'Assembly + move — hover shows the subassembly a drag will move (A to exit)'
          : 'Assembly mode — hover highlights a subassembly, click selects it (A to exit)');
      }
    },
    snapBack(recs) {
      if (!app.viewer || !app.model) return;
      M.snapBack(app.model, recs, app.viewer.addTween,
        () => {
          M.applyPositions(app.model, app.model.explodeF);
          app.events.emit('positions-live'); // overlays track parts in flight
          invalidate();
        },
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
      downTrail = []; // a reset is a fresh start, not a level to climb back into
      sel.clearSelection();
      hideHistory.length = 0; // everything is visible again; nothing to undo
      M.resetAppearance(app.model);
      actions.resetPositions();
      refresh();
      retargetOrbit();
    },
    // Saved views restore an explode setup wholesale: it becomes both the
    // pending AND the applied config, exactly as if the user had pressed
    // Apply with these settings at this slider value.
    applyExplodeState(cfg, f) {
      if (!app.model) return;
      explodeTweenToken = {}; // orphan any in-flight explode tween (and its reframe)
      Object.assign(app.explodeCfg, {
        anchorRecId: null, mode: null, plane: null, spread: 'both',
        internal: 'light', sequenced: false,
      }, cfg || {});
      const aid = app.explodeCfg.anchorRecId;
      if (aid != null && (!Number.isInteger(aid) || !app.model.records[aid])) {
        app.explodeCfg.anchorRecId = null; // foreign or hostile id
      }
      appliedExplodeCfg = { ...app.explodeCfg };
      // Authoritative restore: computeExplodeVectors deliberately KEEPS old
      // vectors when the unit set is empty (a leaf scope) — a restore must
      // not inherit the destination's stale vectors through that path.
      for (const rec of app.model.records) {
        rec.explodeVec.set(0, 0, 0);
        rec.seqT = 0;
      }
      app.model.explodeSeq = false;
      M.computeExplodeVectors(app.model, app.explodeCfg, scopeAnchorRec(), effHidden);
      const fc = Math.max(0, Math.min(1, f || 0));
      slider.value = String(fc);
      M.applyPositions(app.model, fc);
      app.events.emit('positions');
      invalidate();
    },
    // Saved views must capture the setup the screen actually shows — the
    // popover cfg may hold half-edited, never-Applied changes.
    getAppliedExplodeCfg() { return { ...appliedExplodeCfg }; },
    setMoveMode(on) {
      on = !!on;
      if (on === !!app.moveMode) return;
      app.moveMode = on;
      $('btnMove').classList.toggle('is-on', on);
      $('gl').classList.toggle('is-move', on);
      if (on) {
        // Measure and instructions own the canvas's clicks outright: a Move
        // button lit while measure keeps eating every click is a lit-but-dead
        // mode. Assembly mode composes instead (see setAssemblyMode).
        if (app.measureMode && app.measure) app.measure.toggle();
        if (app.instructions && app.instructions.on) app.instructions.set(false);
      }
      // Canvas hover resolution changed either way (drag target vs assembly
      // unit vs nothing) — drop a stale canvas preview; the next pointermove
      // rebuilds it. Panel-row hover is mode-independent and stays.
      if (sel.hover && sel.hover.src === 'canvas') sel.setHover(null);
      if (app.triad) app.triad.refresh();
      if (on) {
        app.ui.toast(app.assemblyMode
          ? 'Move + assembly — drag any part to move its whole subassembly (D to exit)'
          : sel.selected.size
            ? 'Move mode — drag the triad to slide or turn, drag a part to move it freely (D to exit)'
            : 'Move mode — drag parts freely, or select one for the move/rotate triad (D to exit)');
      }
    },
    setEdges(on) {
      app.edgesOn = on;
      storeEdges(on);
      // Keep an open View menu's checkbox in step with the E key.
      if (!$('viewMenu').classList.contains('hidden')) buildViewPopover();
      if (!app.model) return; // sidecar pre-drop: the preference still sticks
      app.model.edgesOn = on;
      if (on) {
        const model = app.model;
        M.buildEdgesLazily(model, refresh, () => app.model !== model); // idempotent
      }
      refresh(); // off is a pure flag flip — a running build keeps going
    },
    setRenderStyle(style) {
      app.renderStyle = style;
      storeStyle(style);
      // Keep an open View menu's checkbox in step.
      if (!$('viewMenu').classList.contains('hidden')) buildViewPopover();
      if (app.viewer) app.viewer.setRenderStyle(style); // lights + tone curve
      if (!app.model) return; // sidecar pre-drop: the preference still sticks
      M.setMaterialStyle(app.model, style);
      refresh(); // updateVisuals repoints every mesh at the new base set
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

  // Hide-undo history is per-model: a sidecar re-drop replaces every record
  // object, so old entries could never match anything again. Record ids are
  // per-model too — a scope or selection built on the old graph would land
  // on arbitrary records in the new one.
  app.events.on('model', () => {
    hideHistory.length = 0;
    // Record ids are per-model: a kept anchor would silently resolve to an
    // arbitrary record in the new graph — in the pending cfg AND in the
    // applied snapshot view-driven recomputes read. The slider DOM also kept
    // its old value across re-drops while the new model loaded collapsed.
    app.explodeCfg.anchorRecId = null;
    appliedExplodeCfg = { ...app.explodeCfg };
    slider.value = '0';
    // Unguarded on purpose: on a re-drop, loadModel already nulled the scope
    // silently (before framing), so this emit is what actually hides the
    // scope chip. Harmless on first load — the chip is already hidden.
    sel.setScope(null);
    downTrail = [];
    sel.clearSelection();
  });

  // ---- explode (guided setup popover) ----------------------------------
  // Two movement events: 'positions-live' fires on every explode step (cheap
  // listeners only — stale-flagging measurements, hiding section outlines),
  // 'positions' fires when parts come to rest (full recomputes). Without
  // these, world-space overlays keep rendering at home coordinates while
  // the parts fly apart.
  // The amount slider lives inside the explode popover (like the section
  // slider) but is created once, not per build: tweens, saved-view restores
  // and the model-reset handler write slider.value while the popover is
  // closed or mid-rebuild, and a per-build element would orphan those writes.
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = '0';
  slider.className = 'explode-slider section-slider';
  slider.title = 'Explode amount';
  slider.addEventListener('input', () => {
    if (!app.model) return;
    M.applyPositions(app.model, parseFloat(slider.value));
    app.events.emit('positions-live');
    invalidate();
  });
  // Exploded parts must never fly out of view: reframe when the gesture ends.
  slider.addEventListener('change', () => {
    app.events.emit('positions');
    actions.frame(null);
  });

  // Only one explode tween may drive the slider at a time: the tween loop
  // runs older tweens last, so without the token a Collapse pressed during
  // the 1.6s sequenced play-out would lose to the still-running Apply tween
  // and the model would end fully exploded against the user's wishes.
  let explodeTweenToken = null;
  function tweenExplodeTo(target, duration = 500) {
    if (!app.model || !app.viewer) return;
    const from = app.model.explodeF;
    if (Math.abs(target - from) < 1e-3) return;
    const token = explodeTweenToken = {};
    app.viewer.addTween({
      duration,
      update: (k) => {
        if (explodeTweenToken !== token) return; // superseded
        const f = from + (target - from) * k;
        slider.value = String(f);
        M.applyPositions(app.model, f);
        app.events.emit('positions-live');
      },
      done: () => {
        if (explodeTweenToken !== token) return;
        app.events.emit('positions');
        actions.frame(null);
      },
    });
  }

  // Session-persistent setup; null fields fall back to model defaults.
  app.explodeCfg = {
    anchorRecId: null, mode: null, plane: null, spread: 'both',
    internal: 'light', sequenced: false,
  };
  // Recomputes triggered by view changes (scope, hide/show, filters) must use
  // the last APPLIED setup, not half-edited popover state the user never
  // confirmed with Apply.
  let appliedExplodeCfg = { ...app.explodeCfg };
  const explodeMenu = $('explodeMenu');

  // Explode acts on what you're viewing: with an "Open" scope on a
  // subassembly, its children become the moving units.
  function scopeAnchorRec() {
    return sel.scope && sel.scope.anchorId != null && app.model
      ? app.model.records[sel.scope.anchorId] : null;
  }
  // Effective visibility from selection state — correct even when this
  // handler runs before updateVisuals repaints object.visible.
  const effHidden = (rec) => M.isEffectivelyHidden(rec, sel.scope, sel.filter);

  // The visible set changed (scope, hide/show, facet filter): the moving
  // units and their spacing are stale. Recompute with the applied setup; if
  // parts are currently flown, reposition them under the same slider value.
  function reexplodeForView() {
    if (!app.model) return;
    M.computeExplodeVectors(app.model, appliedExplodeCfg, scopeAnchorRec(), effHidden);
    if (app.model.explodeF >= 0.01) {
      M.applyPositions(app.model, app.model.explodeF);
      app.events.emit('positions');
      invalidate();
    }
  }
  app.events.on('scope', reexplodeForView);

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

    head('Subassembly internals');
    const nRow = document.createElement('div');
    nRow.className = 'pop-inline';
    const internal = cfg.internal || 'light';
    for (const [value, text] of [['none', 'Rigid'], ['light', 'Slight'], ['full', 'Full spread']]) {
      nRow.appendChild(popRadio('bdExInternal', value, internal === value, text,
        () => { cfg.internal = value; }));
    }
    explodeMenu.appendChild(nRow);

    head('Playback');
    const seq = document.createElement('label');
    seq.className = 'pop-check';
    const seqBox = document.createElement('input');
    seqBox.type = 'checkbox';
    seqBox.checked = !!cfg.sequenced;
    seqBox.addEventListener('change', () => { cfg.sequenced = seqBox.checked; });
    seq.appendChild(seqBox);
    seq.appendChild(document.createTextNode(' One part at a time (plays apart in order)'));
    explodeMenu.appendChild(seq);

    const trails = document.createElement('label');
    trails.className = 'pop-check';
    const trailsBox = document.createElement('input');
    trailsBox.type = 'checkbox';
    trailsBox.checked = !!app.explodeTrailsOn;
    trailsBox.addEventListener('change', () => {
      if (app.trails) app.trails.set(trailsBox.checked); // immediate, no Apply needed
    });
    trails.appendChild(trailsBox);
    trails.appendChild(document.createTextNode(' Show trails (lines back to home)'));
    explodeMenu.appendChild(trails);

    head('Amount');
    const sWrap = document.createElement('div');
    sWrap.className = 'section-slider-row';
    sWrap.appendChild(slider); // persistent element — value is already current
    explodeMenu.appendChild(sWrap);

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
    appliedExplodeCfg = { ...app.explodeCfg }; // this setup is now the applied one
    M.computeExplodeVectors(app.model, app.explodeCfg, scopeAnchorRec(), effHidden);
    if (app.model.explodeF < 0.05) {
      // Sequenced mode plays the whole range through, one unit at a time —
      // give it the time and the distance to read as a play-out.
      if (app.explodeCfg.sequenced) tweenExplodeTo(1, 1600);
      else tweenExplodeTo(0.6);
    } else {
      M.applyPositions(app.model, app.model.explodeF);
      app.events.emit('positions');
      invalidate();
      actions.frame(null);
    }
  }

  function enterAnchorPick() {
    closeMenus();
    app.anchorPickMode = true;
    canvas.classList.add('is-pick');
    app.ui.toast('Click the part that stays fixed — the highlight shows what will anchor (Esc to cancel)');
  }
  function exitAnchorPick() {
    app.anchorPickMode = false;
    canvas.classList.remove('is-pick');
    sel.setHover(null); // the anchor-preview highlight must not outlive the pick
  }
  app.ui.anchorPicked = (rec) => {
    exitAnchorPick();
    if (rec && app.model) {
      // Store the raw pick: computeExplodeVectors walks UP from it to find
      // the containing unit, which works both unscoped (top-level ancestor)
      // and inside an open subassembly (pre-resolving to the top ancestor
      // here would overshoot the scoped units and the pick would be ignored).
      app.explodeCfg.anchorRecId = rec.id;
    } else {
      app.ui.toast('No part there — anchor unchanged');
    }
    buildExplodePopover();
    explodeMenu.classList.remove('hidden');
    app.ui.clampMenu(explodeMenu);
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
    app.ui.clampMenu(explodeMenu);
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

    popHead(viewMenu, 'Display');
    const edges = document.createElement('label');
    edges.className = 'pop-check';
    const edgesBox = document.createElement('input');
    edgesBox.type = 'checkbox';
    edgesBox.checked = app.edgesOn;
    edgesBox.addEventListener('change', () => actions.setEdges(edgesBox.checked));
    edges.appendChild(edgesBox);
    edges.appendChild(document.createTextNode(' Show part edges (E)'));
    viewMenu.appendChild(edges);

    const realistic = document.createElement('label');
    realistic.className = 'pop-check';
    const realisticBox = document.createElement('input');
    realisticBox.type = 'checkbox';
    realisticBox.checked = app.renderStyle === 'realistic';
    realisticBox.addEventListener('change', () =>
      actions.setRenderStyle(realisticBox.checked ? 'realistic' : 'shaded'));
    realistic.appendChild(realisticBox);
    realistic.appendChild(document.createTextNode(' Realistic shading (reflections)'));
    viewMenu.appendChild(realistic);

    // Colors & lighting (issue #25) live in their own popover so this menu
    // stays short; it opens in place and offers a way back.
    const lookItem = document.createElement('button');
    lookItem.type = 'button';
    lookItem.className = 'menu-item';
    lookItem.textContent = 'Colors & lighting…';
    lookItem.title = 'Background, brightness, contrast and part colors — remembered for this assembly';
    lookItem.addEventListener('click', () => { if (app.ui.openLookMenu) app.ui.openLookMenu(); });
    viewMenu.appendChild(lookItem);

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
    app.ui.clampMenu(viewMenu);
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
  $('btnAssembly').addEventListener('click', () => actions.setAssemblyMode(!app.assemblyMode));
  $('btnReset').addEventListener('click', () => actions.resetAll());

  // ---- drag-move -------------------------------------------------------
  // This pointerdown registers BEFORE OrbitControls' (createViewer runs
  // later in boot), so disabling the controls here prevents the same
  // gesture from ever starting an orbit.
  const canvas = $('gl');
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !app.model || !app.viewer) return;
    if (app.anchorPickMode) return; // resolved as a click on pointerup
    // Measure mode owns left clicks outright: with move mode (or Shift/Ctrl)
    // active, a measure click would otherwise start a zero-slop drag or a
    // marquee, and picking's app.dragging check would swallow the click.
    if (app.measureMode) return;
    if (ev.ctrlKey || ev.metaKey) { startMarquee(ev); return; }
    // The triad rides above the parts: a grab on one of its handles wins over
    // both the free part drag and (via controls.enabled) the orbit.
    if (app.triad && app.triad.tryStartDrag(ev)) return;
    if (!(app.moveMode || ev.shiftKey)) return;
    const hit = app.pick(ev);
    if (!hit) return;
    startDrag(ev, hit);
  });

  function startDrag(ev, hit) {
    const { viewer } = app;
    // Assembly mode grabs the subassembly unit the hover previews — the same
    // resolution the click select uses, so drag and highlight always agree.
    // Then: dragging any part of a selected subassembly moves the subassembly
    // as a unit; dragging a member of a multi-selection moves the whole
    // selection; records whose ancestor is also selected ride the ancestor.
    const base = app.assemblyMode ? M.assemblyUnitOf(app.model, sel.scope, hit.rec) : hit.rec;
    const eff = M.selectedAncestorOf(sel.selected, base) || base;
    let targets = (sel.selected.has(eff.id) && sel.selected.size > 1)
      ? selectedRecs() : [eff];
    const targetIds = new Set(targets.map((r) => r.id));
    targets = targets.filter((r) => {
      for (let a = r.parent; a; a = a.parent) if (targetIds.has(a.id)) return false;
      return true;
    });
    viewer.controls.enabled = false; // pre-empt orbit for this gesture either way
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    // Nothing else happens until the pointer clears the click slop: a plain
    // click in move mode must stay a click — picking's pointerup selects the
    // part (which is how the triad appears) only while app.dragging is false.
    let active = false;

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
      if (!active) {
        if (Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) <= 4) return;
        active = true;
        app.dragging = true; // hover + click-select stand down
        canvas.classList.add('is-dragging');
        sel.setHover(null);
      }
      const p = planeHit(e);
      if (!p) return;
      const worldDelta = p.clone().sub(hit.point);
      targets.forEach((r, i) => {
        // Reference point cancels out of the affine delta map — one point works for all.
        r.dragDelta.copy(startDeltas[i]).add(
          M.worldDeltaToLocal(r.object.parent, worldDelta, hit.point));
        M.refreshMovedFlag(r); // a triad rotation keeps the part "moved" at zero translation
      });
      M.applyPositions(app.model, app.model.explodeF);
      // Same live event the explode slider fires: measurement staleness and
      // section outlines must track the part through the drag, not snap to
      // reality only at pointerup.
      app.events.emit('positions-live');
      invalidate();
    };
    const onUp = (e) => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      viewer.controls.enabled = true;
      if (!active) return; // plain click: picking's pointerup handles the select
      // Picking's pointerup ran first (registered at boot, before these
      // dynamic listeners) and saw app.dragging still true, so a real drag's
      // release never doubles as a click.
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
        if (px < minX || px > maxX || py < minY || py > maxY) continue;
        // Assembly mode selects units here too — a box over three parts of
        // one subassembly means the subassembly, matching click and drag.
        // (sel.selected is a Set, so unit ids landing twice are harmless.)
        ids.push(app.assemblyMode ? M.assemblyUnitOf(app.model, sel.scope, rec).id : rec.id);
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
    $('sectionMenu').classList.add('hidden');
    viewMenu.classList.add('hidden');
    $('lookMenu').classList.add('hidden');
  }
  app.ui.closeMenus = closeMenus;
  // Toolbar popovers anchor right:0 to their button. On the wrapped narrow
  // toolbar (<=1100px) a left-end button would push its menu past the left
  // page edge, where body{overflow:hidden} clips it — nudge it back on open.
  // On phones (<=600px) the toolbar is a SCROLL container that would clip
  // the menu to the strip itself: escape with fixed positioning under the
  // button, clamped to the viewport and capped to the space below.
  app.ui.clampMenu = (menu) => {
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    if (window.matchMedia('(max-width: 600px)').matches) {
      const b = menu.parentElement.getBoundingClientRect(); // .menu-anchor
      menu.style.position = 'fixed';
      menu.style.top = (b.bottom + 4) + 'px';
      menu.style.right = 'auto';
      const w = menu.offsetWidth;
      menu.style.left = Math.max(4, Math.min(b.right - w, window.innerWidth - w - 4)) + 'px';
      menu.style.maxHeight = Math.max(120, window.innerHeight - b.bottom - 16) + 'px';
      menu.style.overflowY = 'auto';
      return;
    }
    const left = menu.getBoundingClientRect().left;
    if (left < 4) menu.style.right = (left - 4) + 'px';
  };
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

  // items: {label,onClick,href,disabled} | {head} | {sep} | {node} (a ready
  // element, e.g. the paint swatch row). null items skipped.
  app.ui.showMenu = (x, y, items) => {
    ctxMenu.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it.node) {
        ctxMenu.appendChild(it.node);
      } else if (it.sep) {
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
    // Assembly mode: the menu acts on the subassembly unit the hover
    // highlights, not the leaf part under the cursor. Then a click on one
    // part of a selected subassembly means the subassembly.
    if (rec && app.model) {
      if (app.assemblyMode) rec = M.assemblyUnitOf(app.model, sel.scope, rec);
      rec = M.selectedAncestorOf(sel.selected, rec) || rec;
    }
    if (rec) {
      // On a member of the current multi-selection the menu operates on the
      // WHOLE selection (marquee -> right-click -> isolate).
      const multi = sel.selected.has(rec.id) && sel.selected.size > 1;
      const n = sel.selected.size;
      const targets = multi ? selectedRecs() : [rec];
      const insts = M.allInstances(app.model, rec);
      const part = rec.partId !== null ? app.model.partById.get(rec.partId) : null;
      const label = multi ? `${n} selected` : displayName(rec);
      const row = part ? app.bom.rowFor(part) : null;
      // Moved parts anywhere INSIDE the targets: assembly mode resolves the
      // menu to the unit, but a child displaced on its own must still offer
      // Snap back — and snapping the unit back must take it home too.
      const movedIn = [...new Set(targets.flatMap((r) => M.subtree(r)))]
        .filter((r) => r.flags.moved || r.dragDelta.lengthSq() > 0);
      const anyMoved = movedIn.length > 0;
      const copyNames = uniquePartNumbers(selectionRoots(targets));
      items.push(
        { head: label },
        { label: copyNames.length > 1 ? `Copy ${copyNames.length} part numbers` : 'Copy part number',
          onClick: () => copyPartNumbers(selectionRoots(targets)), disabled: !copyNames.length },
        { sep: true },
        { label: multi ? `Hide ${n} selected` : 'Hide', onClick: () => actions.hide(targets) },
        !multi && insts.length > 1
          ? { label: `Hide all instances (${insts.length})`, onClick: () => actions.hide(insts) } : null,
        { label: multi ? `Isolate ${n} selected` : 'Isolate', onClick: () => actions.isolate(targets, false) },
        { label: multi ? `Isolate ${n} selected (ghost rest)` : 'Isolate (ghost rest)', onClick: () => actions.isolate(targets, true) },
        { label: multi ? `Make ${n} selected transparent` : 'Make transparent', onClick: () => actions.cycleOpacity(targets) },
        { sep: true },
        // Paint (issue #25): one part paints all its instances; a selection
        // or an assembly-mode unit paints everything inside it.
        app.look ? { head: multi ? `Paint ${n} selected` : (insts.length > 1 ? `Paint (all ${insts.length} instances)` : 'Paint') } : null,
        app.look ? { node: app.look.swatchRow(targets) } : null,
        { sep: true },
        { label: 'Move', onClick: () => { actions.setMoveMode(true); app.ui.toast(app.assemblyMode ? 'Move mode on — drag moves the whole subassembly (D to exit)' : multi ? 'Move mode on — drag any selected part to move all (D to exit)' : 'Move mode on — drag the part (D to exit)'); } },
        anyMoved
          ? { label: multi ? `Snap back ${n} selected` : 'Snap back', onClick: () => actions.snapBack(movedIn) } : null,
        { sep: true },
        { label: multi ? `Open ${n} selected` : 'Open', onClick: () => actions.open(targets, label) },
        !multi && row && row.vendor_url ? { label: 'Vendor page', href: row.vendor_url } : null,
      );
    } else {
      items.push(
        { label: 'Show all', onClick: () => { if (app.model) { M.resetAppearance(app.model); refresh(); afterVisibilityChange(); } } },
        { label: 'Reset positions', onClick: () => actions.resetPositions() },
        { label: 'Reset all', onClick: () => actions.resetAll() },
      );
    }
    app.ui.showMenu(x, y, items);
  };

  // Facet filters change what's visible too — same explode + pivot rules as
  // hiding. (colorBy also emits 'filter' with no visibility change; the
  // containment guard and the info-empty keep-vectors path make it a no-op.)
  app.events.on('filter', afterVisibilityChange);

  // ---- level navigation stack (Top / Up / Down) -------------------------
  // Always on screen once the export has subassemblies; a direction with
  // nowhere to go greys out rather than disappearing, so the buttons never
  // shift under the cursor. The Structure tab names the level in view.
  const lvlTop = $('lvlTop'), lvlUp = $('lvlUp'), lvlDown = $('lvlDown');
  function syncLevelNav() {
    const model = app.model;
    const hasLevels = !!model && M.topRecs(model).some((r) => r.children.length);
    $('levelNav').classList.toggle('hidden', !hasLevels);
    if (!hasLevels) return;
    const cur = currentLevelRec();
    const inScope = !!sel.scope;
    lvlTop.disabled = !inScope;
    lvlTop.title = inScope ? 'Back to the full assembly (Shift+↑)' : 'Already viewing the full assembly';
    lvlUp.disabled = !inScope;
    const parent = cur ? cur.parent : (inScope ? commonAncestor(scopeRoots()) : null);
    const upName = parent && parent !== M.rootWrapper(model) ? displayName(parent) : 'the full assembly';
    lvlUp.title = inScope ? `Up to ${upName} (↑)` : 'Already at the top level';
    const down = downTargetOf();
    lvlDown.disabled = !down;
    lvlDown.title = down
      ? `Down into ${displayName(down)} (↓)`
      : 'Select a part to head toward it, or climb up first — Down retraces the way you came (↓)';
  }
  app.events.on('scope', syncLevelNav);
  app.events.on('selection', syncLevelNav);
  app.events.on('model', syncLevelNav);
  lvlTop.addEventListener('click', () => actions.closeScope());
  lvlUp.addEventListener('click', () => actions.upScope());
  lvlDown.addEventListener('click', () => actions.downScope());
  syncLevelNav();

  // ---- keyboard --------------------------------------------------------
  window.addEventListener('keydown', (ev) => {
    const inField = ev.target && (ev.target.matches ? ev.target.matches('input, textarea, select') : false);
    if (ev.key === 'Escape') {
      if (app.anchorPickMode) { exitAnchorPick(); return; }
      // A focused text field and an open help overlay outrank measure mode:
      // Esc while typing must blur, not silently drop a measurement point.
      if (inField) { ev.target.blur(); return; }
      // A live triad gesture: Esc aborts it and puts the parts back — it must
      // not also clear the selection the user is about to keep working with.
      if (app.triad && app.triad.dragging()) { app.triad.cancelDrag(); return; }
      // An open dropdown is its own layer: Esc closes it and STOPS — falling
      // through would also drop a pending measurement point or exit measure
      // mode with the same keypress.
      const menuOpen = ['ctxMenu', 'exportMenu', 'explodeMenu', 'sectionMenu', 'viewMenu', 'lookMenu']
        .some((id) => !$(id).classList.contains('hidden'));
      closeMenus();
      if (menuOpen) return;
      if (!$('helpOverlay').classList.contains('hidden')) { $('helpOverlay').classList.add('hidden'); return; }
      if (app.measureMode && app.measure && app.measure.escape()) return;
      // Clearing a selection outranks exiting instruction mode — clicking a
      // balloon to identify a part then pressing Esc must not eject the user
      // from the whole mode (same ordering assembly mode uses).
      if (sel.clearSelection()) return;
      if (app.instructions && app.instructions.on) { app.instructions.set(false); return; }
      if (app.assemblyMode) { actions.setAssemblyMode(false); return; }
      if (sel.scope) actions.closeScope();
      return;
    }
    if (inField) return;
    // A live drag (triad, free move, marquee) froze its camera frame at
    // pointerdown: view keys or mode flips underneath it teleport parts.
    if (app.dragging) return;
    // Ctrl+C with parts selected copies their part numbers — unless text is
    // highlighted somewhere, which is the browser's copy to make.
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 'c') {
      const t = selectedRecs();
      const textHighlighted = !!(window.getSelection && String(window.getSelection()));
      if (t.length && !textHighlighted) {
        ev.preventDefault();
        copyPartNumbers(selectionRoots(t));
      }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // never shadow browser shortcuts
    const key = ev.key.toLowerCase();
    // CAD-style number keys for the standard views.
    const VIEW_KEYS = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 0: 'iso' };
    if (VIEW_KEYS[ev.key]) { actions.setView(VIEW_KEYS[ev.key]); return; }
    // Level navigation: ↑ / ↓ one level, Shift+↑ top, Shift+↓ dive.
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault(); // otherwise a focused panel list scrolls too
      if (ev.key === 'ArrowUp') { if (ev.shiftKey) actions.closeScope(); else actions.upScope(); }
      else if (ev.shiftKey) actions.diveScope();
      else actions.downScope();
      return;
    }
    if (key === 'm') { if (app.measure) app.measure.toggle(); }
    else if (key === 'd') actions.setMoveMode(!app.moveMode);
    else if (key === 'a') actions.setAssemblyMode(!app.assemblyMode);
    else if (key === 'o') { const t = selectedRecs(); if (t.length) actions.open(t, openLabelFor(t)); }
    else if (key === 'e') actions.setEdges(!app.edgesOn);
    else if (key === 'x') { if (app.sectionApi) app.sectionApi.toggle(); }
    else if (key === 'h') {
      if (ev.shiftKey) actions.unhideLast();
      else { const t = selectedRecs(); if (t.length) actions.hide(t); }
    }
    else if (key === 'i') { const t = selectedRecs(); if (t.length) actions.isolate(t, false); }
    else if (key === 'f') actions.frame(selectedRecs());
    else if (key === 'r') actions.resetAll();
    else if (key === 'p') setPanelHidden(!panelHidden);
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
      splitter.removeEventListener('pointercancel', onUp);
    };
    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
    // iOS cancels (rather than ends) a touch drag the browser takes over.
    splitter.addEventListener('pointercancel', onUp);
  });

  // ---- panel hide/show --------------------------------------------------
  // The chevron tab sits at the viewport's right edge — the panel boundary
  // when open, the screen edge when hidden — so it never has to move. The
  // viewport ResizeObserver in scene.js re-fits the canvas on its own.
  const panelToggle = $('panelToggle');
  const PANEL_KEY = 'picturebom-panel:' + ((app.meta.assembly && app.meta.assembly.name) || 'assembly');
  let panelHidden = false;
  try {
    const stored = localStorage.getItem(PANEL_KEY);
    if (stored === 'hidden') panelHidden = true;
    // First visit on a phone leads with the 3D — the drawer would otherwise
    // open over the model before the user has seen it.
    else if (stored !== 'shown') panelHidden = window.matchMedia('(max-width: 600px)').matches;
  } catch (e) { /* ignore */ }
  function applyPanelHidden() {
    panel.classList.toggle('hidden', panelHidden);
    splitter.classList.toggle('hidden', panelHidden);
    // Drives the phone drawer CSS (scrim + tab position) — see style.css.
    $('app').classList.toggle('panel-hidden', panelHidden);
    panelToggle.textContent = panelHidden ? '‹' : '›';
    const label = (panelHidden ? 'Show' : 'Hide') + ' the parts panel (P)';
    panelToggle.title = label;
    panelToggle.setAttribute('aria-label', label);
  }
  function setPanelHidden(hidden, persist = true) {
    panelHidden = !!hidden;
    applyPanelHidden();
    if (!persist) return;
    try { localStorage.setItem(PANEL_KEY, panelHidden ? 'hidden' : 'shown'); } catch (e) { /* ignore */ }
  }
  applyPanelHidden();
  panelToggle.addEventListener('click', () => setPanelHidden(!panelHidden));
  // Double-click the splitter (desktop): a quicker collapse than the tab.
  splitter.addEventListener('dblclick', () => setPanelHidden(true));
  // Phone drawer: tapping the dimmed 3D behind it dismisses (the scrim only
  // renders — and therefore only takes clicks — at <=600px with the panel open).
  $('panelScrim').addEventListener('click', () => setPanelHidden(true));
  // Features whose output lives in the panel (search, instruction checklist)
  // un-hide it rather than filling an invisible list. Programmatic opens do
  // NOT persist — one search keystroke must not overwrite the phone default
  // of leading with the 3D.
  app.ui.setPanelHidden = (hidden) => setPanelHidden(hidden, false);

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
