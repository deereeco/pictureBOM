// Saved views (issue #16): "Save view state" writes a small .json capturing
// everything posed — camera, explode setup + amount, moved/rotated parts,
// hidden/ghosted flags, the open scope, trails and instruction-mode state.
// Dropping that file onto any copy of the SAME BomDom restores the exact
// view. Deliberately light (Dominic: "keep it light and simple"): no baked
// HTML copies, no URL links — just a file you can park next to the export.

import * as M from './model.js';

const FORMAT = 'bomdom-view';
const VERSION = 1;

export function initViewState(app) {
  const sel = app.sel;

  function serialize() {
    const model = app.model;
    const viewer = app.viewer;
    const recs = [];
    for (const rec of model.records) {
      const f = rec.flags;
      const moved = rec.dragDelta.lengthSq() > 0;
      const rotated = !M.isIdentityQuat(rec.dragQuat);
      if (!f.hidden && !f.ghost && f.opacity === 1 && !moved && !rotated) continue;
      const e = { i: rec.id };
      if (f.hidden) e.h = 1;
      if (f.ghost) e.g = 1;
      if (f.opacity !== 1) e.o = f.opacity;
      if (moved) e.d = rec.dragDelta.toArray();
      if (rotated) e.q = rec.dragQuat.toArray();
      recs.push(e);
    }
    const scope = sel.scope
      ? (sel.scope.anchorId != null
        ? { anchorId: sel.scope.anchorId, label: sel.scope.label }
        : { recIds: [...sel.scope.recIds], label: sel.scope.label })
      : null;
    const instr = app.instructions && app.instructions.on
      ? app.instructions.stateForSave() : null;
    return {
      format: FORMAT,
      version: VERSION,
      // Restores only make sense against the same export: name + record
      // count is a cheap, honest identity check (ids are per-model).
      assembly: (app.meta.assembly && app.meta.assembly.name) || 'assembly',
      recordCount: model.records.length,
      saved: new Date().toISOString(),
      camera: {
        position: viewer.camera.position.toArray(),
        target: viewer.controls.target.toArray(),
        upAxis: viewer.upAxis,
      },
      explode: {
        f: model.explodeF,
        // The APPLIED setup, never the popover's half-edited state: radios
        // changed without pressing Apply must not poison the saved file.
        cfg: app.actions.getAppliedExplodeCfg(),
        trails: !!app.explodeTrailsOn,
      },
      records: recs,
      scope,
      instructions: instr,
    };
  }

  function apply(v) {
    const model = app.model;
    if (!model) { app.ui.toast('Load the 3D model first, then drop the view file'); return false; }
    if (!v || v.format !== FORMAT) { app.ui.toast('Not a BomDom view file'); return false; }
    if (v.version > VERSION) {
      app.ui.toast('This view file is from a newer pictureBOM — update to open it');
      return false;
    }
    const asm = (app.meta.assembly && app.meta.assembly.name) || 'assembly';
    if (v.assembly !== asm || v.recordCount !== model.records.length) {
      app.ui.toast(`This view belongs to "${v.assembly}" — it can't be applied here`);
      return false;
    }

    // A live gesture would keep writing the pre-restore pose from its stale
    // drag snapshots the moment the pointer moves again.
    if (app.triad && app.triad.dragging()) app.triad.cancelDrag();
    if (app.dragging) { app.ui.toast('Finish the drag first, then drop the view'); return false; }

    // Only real, validated record ids touch the model — a hand-edited file
    // with "map"/"__proto__" ids must refuse cleanly, not crash mid-restore.
    const recAt = (i) => (Number.isInteger(i) && i >= 0 && i < model.records.length
      ? model.records[i] : null);

    // Clean slate, then pose. Order matters: appearance flags first (scope
    // and explode recomputes read effective visibility), explode BEFORE the
    // drag offsets are restored (unit centers must be measured at true home,
    // matching how the vectors were computed when the view was made), camera
    // after all framing side effects, instructions last (they read
    // everything). Any snap-back still animating is orphaned first, or it
    // would keep lerping the restored pose back toward zero.
    M.cancelPoseTweens(model);
    if (app.instructions && app.instructions.on) app.instructions.set(false);
    sel.clearSelection();
    sel.setScope(null);
    if (app.ui.clearFilters) app.ui.clearFilters(); // same clean slate resetAll uses
    M.resetAppearance(model);
    for (const rec of model.records) {
      rec.dragDelta.set(0, 0, 0);
      rec.dragQuat.identity();
      rec.flags.moved = false;
      // applyPositions skips untouched records, so anything displaced BEFORE
      // this restore must be put home explicitly (bit-exact copies, the same
      // values applyPositions writes at rest).
      rec.object.position.copy(rec.homePos);
      rec.object.quaternion.copy(rec.homeQuat);
    }
    for (const e of v.records || []) {
      const rec = recAt(e.i);
      if (!rec) continue;
      if (e.h) rec.flags.hidden = true;
      if (e.g) rec.flags.ghost = true;
      if (typeof e.o === 'number') rec.flags.opacity = e.o;
    }
    app.events.emit('appearance'); // updateVisuals: flags -> object.visible

    if (v.scope) {
      const anchorRec = recAt(v.scope.anchorId);
      if (anchorRec) {
        sel.setScope({
          label: v.scope.label || 'saved view',
          recIds: M.scopeSetFor([anchorRec]),
          anchorId: anchorRec.id,
        });
      } else if (Array.isArray(v.scope.recIds)) {
        sel.setScope({
          label: v.scope.label || 'saved view',
          recIds: new Set(v.scope.recIds.filter((id) => recAt(id))),
          anchorId: null,
        });
      }
    }

    const ex = v.explode || {};
    app.actions.applyExplodeState(ex.cfg || {}, ex.f || 0);

    // Now the hand-moves, composed on top of the freshly computed explode.
    let anyMoved = false;
    for (const e of v.records || []) {
      const rec = recAt(e.i);
      if (!rec || (!e.d && !e.q)) continue;
      if (Array.isArray(e.d) && e.d.length === 3 && e.d.every(Number.isFinite)) {
        rec.dragDelta.fromArray(e.d);
      }
      if (Array.isArray(e.q) && e.q.length === 4 && e.q.every(Number.isFinite)) {
        rec.dragQuat.fromArray(e.q);
      }
      M.refreshMovedFlag(rec);
      anyMoved = true;
    }
    if (anyMoved) M.applyPositions(model, model.explodeF);
    if (app.trails) app.trails.set(!!ex.trails);

    // Camera last among the 3D bits — scope/explode paths reframe on their
    // own, and the saved eye must win.
    const cam = v.camera || {};
    if (cam.upAxis) app.actions.setUpAxis(cam.upAxis, { snapView: false });
    if (Array.isArray(cam.position) && Array.isArray(cam.target)) {
      app.viewer.camera.position.fromArray(cam.position);
      app.viewer.controls.target.fromArray(cam.target);
      app.viewer.controls.update();
    }
    app.viewer.invalidate();

    if (v.instructions && app.instructions) {
      app.instructions.restoreState(v.instructions);
    }
    app.events.emit('positions');
    app.ui.toast('View restored' + (v.saved ? ` (saved ${String(v.saved).slice(0, 10)})` : ''));
    return true;
  }

  function save() {
    if (!app.model) { app.ui.toast('No 3D model loaded'); return; }
    const v = serialize();
    const name = (v.assembly || 'assembly').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'assembly';
    const blob = new Blob([JSON.stringify(v, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}_view_${v.saved.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    app.ui.toast('View saved — restore it from Export → Restore view state, or drop the file on the viewer');
  }

  function restoreFile(file) {
    const reader = new FileReader();
    reader.onerror = () => app.ui.toast('Could not read the dropped file');
    reader.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(reader.result); } catch (e) { /* handled below */ }
      if (!parsed) { app.ui.toast(`"${file.name}" is not a BomDom view file`); return; }
      apply(parsed);
    };
    reader.readAsText(file);
  }

  // Drop a saved view anywhere on the 3D area. The sidecar drop zone routes
  // its .json drops here too; embedded mode needs its own guards so a stray
  // drop never navigates the page away.
  const viewport = document.getElementById('viewport');
  viewport.addEventListener('dragover', (ev) => ev.preventDefault());
  viewport.addEventListener('drop', (ev) => {
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!file || !/\.json$/i.test(file.name)) return; // .glb belongs to the sidecar flow
    ev.preventDefault();
    restoreFile(file);
  });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());

  app.viewstate = { serialize, apply, save, restoreFile };
}
