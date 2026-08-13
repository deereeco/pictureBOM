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
      // Effective visibility from selection state: object.visible is only
      // stamped on hidden subtree ROOTS (descendants keep a stale true), and
      // may not be repainted yet when an event reaches us.
      if (rec.explodeVec.lengthSq() === 0
        || M.isEffectivelyHidden(rec, app.sel.scope, app.sel.filter)) continue;
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

  // Throttled rebuild: 'appearance' fires every ~12ms during lazy edge
  // builds and 'positions-live' on every scrub frame — rebuilding whole
  // geometry that often is pure churn. Rebuild at most every 50ms with one
  // trailing rebuild so the final state is always exact.
  let lastRebuild = 0;
  let rebuildTimer = 0;
  function requestRebuild() {
    if (!app.explodeTrailsOn && !lines) return; // nothing shown, nothing to clear
    const now = performance.now();
    if (now - lastRebuild > 50) {
      lastRebuild = now;
      rebuild();
      return;
    }
    if (rebuildTimer) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = 0;
      lastRebuild = performance.now();
      rebuild();
    }, 60);
  }

  app.explodeTrailsOn = false; // Dominic's call: hidden by default, they get messy
  app.trails = {
    set(on) {
      app.explodeTrailsOn = !!on;
      rebuild();
    },
    refresh: rebuild,
  };

  app.events.on('positions', requestRebuild);
  app.events.on('positions-live', requestRebuild);
  app.events.on('appearance', requestRebuild); // hide/isolate changes which units show
  app.events.on('filter', requestRebuild); // facet filters change visibility too
  app.events.on('model', () => { clear(); invalidate(); });
}
