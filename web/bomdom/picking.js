// Canvas picking: BVH-accelerated click select, double-click frame,
// right-click context menu (only when not dragged). Deliberately no hover
// pick — moving the pointer over the model must not recolour anything; the
// BOM list on the right is the only thing that drives hover highlighting.

import * as THREE from 'three';
import { boxOfRecs } from './model.js';

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
    const hits = raycaster.intersectObjects(model.pickables, false);
    if (!hits.length) return null;
    const rec = model.meshRecords.get(hits[0].object);
    return rec ? { rec, point: hits[0].point.clone() } : null;
  }
  app.pick = pick;
  app.raycaster = raycaster;

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
      if (!hit) { app.sel.clearSelection(); return; }
      if (ev.ctrlKey || ev.metaKey) app.sel.toggle(hit.rec.id);
      else app.sel.select([hit.rec.id]);
    } else if (ev.button === 2) {
      const hit = pick(ev);
      app.ui.showContextMenu(ev.clientX, ev.clientY, hit ? hit.rec : null);
    }
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('dblclick', (ev) => {
    const hit = pick(ev);
    if (hit) viewer.frameBox(boxOfRecs([hit.rec]));
  });
}
