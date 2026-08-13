// Canvas picking: BVH-accelerated click select, double-click frame,
// right-click context menu (only when not dragged). Deliberately no hover
// pick — moving the pointer over the model must not recolour anything; the
// BOM list on the right is the only thing that drives hover highlighting.
// Two exceptions: assembly mode (previewing which subassembly a click would
// select) and move mode (previewing exactly what a drag would grab).

import * as THREE from 'three';
import { assemblyUnitOf, boxOfRecs, selectedAncestorOf } from './model.js';

const CLICK_SLOP_PX = 4;

export function initPicking(app) {
  const { viewer } = app;
  const canvas = viewer.renderer.domElement;
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  const pointer = new THREE.Vector2();

  function pick(ev) {
    const model = app.model;
    if (!model || !model.pickables.length) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, viewer.camera);
    // The raycaster does not honour clipping planes: with a section active,
    // the nearest hit may be on clipped-away material, so walk the full hit
    // list and keep the first point on the visible side of the plane.
    const clipPlane = app.section && app.section.enabled ? app.section.plane : null;
    raycaster.firstHitOnly = !clipPlane;
    const hits = raycaster.intersectObjects(model.pickables, false);
    const hit = clipPlane
      ? hits.find((h) => clipPlane.distanceToPoint(h.point) >= 0)
      : hits[0];
    if (!hit) return null;
    const rec = model.meshRecords.get(hit.object);
    if (!rec) return null;
    return {
      rec,
      point: hit.point.clone(),
      object: hit.object,
      face: hit.face,
      faceIndex: hit.faceIndex,
      distance: hit.distance,
    };
  }
  app.pick = pick;
  app.raycaster = raycaster;

  // Assembly mode: what a hit would select — the subassembly one level below
  // the open scope (or below the top when unscoped).
  function assemblyTarget(rec) {
    return assemblyUnitOf(app.model, app.sel.scope, rec);
  }

  // ---- assembly / move / anchor-pick hover (one raycast per frame at most)
  // Assembly mode previews the subassembly a click would select; move mode
  // previews the exact drag target (the part, or its selected subassembly /
  // whole selection — the same resolution the drag itself uses); explode's
  // anchor picking previews the UNIT a click would anchor.
  const hoverModeOn = () => app.assemblyMode || app.moveMode || app.anchorPickMode;
  let hoverEv = null;
  let hoverRaf = 0;
  canvas.addEventListener('pointermove', (ev) => {
    if (!hoverModeOn()) return;
    if (app.measureMode || app.dragging || ev.buttons !== 0) return;
    hoverEv = ev;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!hoverEv || !hoverModeOn() || app.dragging) return;
      if (app.measureMode) return; // engaged since scheduling
      // Pre-BVH raycasts are brute-force triangle walks — per-frame casts
      // would fight the BVH build for the main thread on big models.
      if (!app.model || !app.model.bvhReady) return;
      // The triad rides above the parts: hovering one of its handles must not
      // tint whatever part happens to sit behind it. (Anchor picking ignores
      // the gizmo entirely — its click does too; hitTest is null whenever the
      // gizmo is hidden, so assembly-only mode never reaches it.)
      if (!app.anchorPickMode && app.triad && app.triad.hitTest(hoverEv)) {
        app.sel.setHover(null);
        return;
      }
      const hit = pick(hoverEv);
      if (!hit) { app.sel.setHover(null); return; }
      let ids;
      if (app.anchorPickMode || (app.assemblyMode && !app.moveMode && !hoverEv.shiftKey)) {
        // Both resolve to the unit one level below the open scope (or the
        // top level) — for anchor picking that is exactly what stays fixed,
        // for assembly mode exactly what a click selects. Shift held means a
        // drag is imminent instead: fall through to the drag resolution.
        ids = [assemblyTarget(hit.rec).id];
      } else {
        // Move mode previews the exact drag target; with assembly mode also
        // on, the drag grabs the whole subassembly unit, so start from it.
        const base = app.assemblyMode ? assemblyTarget(hit.rec) : hit.rec;
        const eff = selectedAncestorOf(app.sel.selected, base) || base;
        // Grabbing a member of a multi-selection drags the WHOLE selection
        // (startDrag's rule) — the preview must claim the same blast radius.
        ids = (app.sel.selected.has(eff.id) && app.sel.selected.size > 1)
          ? [...app.sel.selected] : [eff.id];
      }
      // src tags the origin: mode toggles clear stale CANVAS previews only,
      // never a live panel-row hover (whose meaning no mode changes).
      app.sel.setHover({ ids, src: 'canvas' });
    });
  });
  canvas.addEventListener('pointerleave', () => {
    if (!hoverModeOn()) return;
    // Cancel the queued pick too — a pending callback holding the last
    // in-canvas event would resurrect the highlight after the cursor left
    // (same race measure.js onPointerLeave guards against).
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
    hoverEv = null;
    app.sel.setHover(null);
  });

  // ---- click / context ------------------------------------------------
  let down = null;
  canvas.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, button: ev.button };
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!down || ev.button !== down.button || app.dragging) { down = null; return; }
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > CLICK_SLOP_PX;
    down = null;
    if (moved) return;
    if (ev.button === 0) {
      const hit = pick(ev);
      if (app.anchorPickMode) { // explode setup: "click the part that stays fixed"
        app.ui.anchorPicked(hit ? hit.rec : null);
        return;
      }
      if (app.measureMode && app.measure) { // measure tool owns clicks in its mode
        app.measure.handleClick(ev, hit);
        return;
      }
      if (!hit) { app.sel.clearSelection(); return; }
      // Assembly mode selects the resolved subassembly's grouping record —
      // one id; highlight, hide, isolate and open all inherit down from it.
      const rec = app.assemblyMode ? assemblyTarget(hit.rec) : hit.rec;
      if (ev.ctrlKey || ev.metaKey) app.sel.toggle(rec.id);
      else app.sel.select([rec.id]);
    } else if (ev.button === 2) {
      // In measure mode, right-click first cancels a pending point.
      if (app.measureMode && app.measure && app.measure.handleRightClick()) return;
      const hit = pick(ev);
      app.ui.showContextMenu(ev.clientX, ev.clientY, hit ? hit.rec : null);
    }
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('dblclick', (ev) => {
    if (app.measureMode) return; // two measure clicks, not a frame gesture
    // Double-clicking a triad handle is two type-in clicks gone fast — it
    // must not frame the part that happens to sit behind the gizmo.
    if (app.triad && app.triad.hitTest(ev)) return;
    const hit = pick(ev);
    if (hit) viewer.frameBox(boxOfRecs([app.assemblyMode ? assemblyTarget(hit.rec) : hit.rec]));
  });
}
