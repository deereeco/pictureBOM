// Explode trails: dashed lines from each flying unit's resting spot to where
// it currently sits — the classic exploded-drawing look. Off by default
// (dense assemblies turn them into spaghetti); toggled from the Explode
// popover, session-only. Rebuilt whole on every positions event: the segment
// count is the number of exploded units, so a rebuild is cheaper than
// bookkeeping incremental updates.

import * as THREE from 'three';
import * as M from './model.js';

export function initTrails(app) {
  const viewer = app.viewer;
  const invalidate = viewer.invalidate;

  const group = new THREE.Group();
  group.name = 'bomdom-explode-trails';
  viewer.scene.add(group);

  // toneMapped false so the CSS-picked colour survives tone mapping, same as
  // the part edges; the colour tracks --text-faint through theme flips.
  const mat = new THREE.LineDashedMaterial({
    color: 0x8a94a1,
    transparent: true,
    opacity: 0.9,
    toneMapped: false,
  });
  function applyThemeColor() {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--text-faint').trim();
    if (c) mat.color.set(c);
    invalidate();
  }
  applyThemeColor();
  new MutationObserver(applyThemeColor)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  let lines = null;
  function clear() {
    if (!lines) return;
    group.remove(lines);
    lines.geometry.dispose();
    lines = null;
  }

  const _local = new THREE.Vector3();
  const _p0 = new THREE.Vector3();
  const _p1 = new THREE.Vector3();
  function rebuild() {
    clear();
    const model = app.model;
    if (!app.explodeTrailsOn || !model || model.explodeF <= 0.001) {
      invalidate();
      return;
    }
    const pts = [];
    for (const rec of model.records) {
      if (rec.explodeVec.lengthSq() === 0 || !rec.object.visible) continue;
      // Pure explode displacement in world space: where the unit's origin is
      // now vs. where it would rest with the explode collapsed (user drags
      // and rotations stay in both endpoints, so trails track moved parts).
      _local.copy(rec.homePos).add(rec.dragDelta);
      rec.object.parent.localToWorld(_p0.copy(_local));
      rec.object.getWorldPosition(_p1);
      if (_p0.distanceToSquared(_p1) < 1e-12) continue;
      // Anchor the segment at the unit's visual center, not its local origin
      // (SolidWorks trails read the same way).
      const center = M.recWorldCenter(rec)
        || M.boxOfRecs([rec]).getCenter(new THREE.Vector3());
      pts.push(center.clone().sub(_p1).add(_p0), center.clone());
    }
    if (!pts.length) {
      invalidate();
      return;
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    lines = new THREE.LineSegments(geo, mat);
    mat.dashSize = model.diagLen * 0.012;
    mat.gapSize = model.diagLen * 0.008;
    lines.computeLineDistances();
    lines.raycast = () => {}; // picking must ignore trails
    group.add(lines);
    invalidate();
  }

  app.explodeTrailsOn = false; // Dominic's call: hidden by default, they get messy
  app.trails = {
    set(on) {
      app.explodeTrailsOn = !!on;
      rebuild();
    },
    refresh: rebuild,
  };

  app.events.on('positions', rebuild);
  app.events.on('positions-live', rebuild);
  app.events.on('appearance', rebuild); // hide/isolate changes which units show
  app.events.on('model', () => { clear(); invalidate(); });
}
