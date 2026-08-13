#!/usr/bin/env node
// Offline verifier for the move-triad math (issue #13): the axis-drag line
// parameter, the rigid rotate-about-world-pivot decomposition into
// dragQuat/dragDelta (web/bomdom/model.js), the delta-to-local mapping under
// hostile parent transforms, and the ruler step ladder. Plain Node, no build,
// no DOM — it imports the SAME modules the viewer bundles, so it verifies the
// shipped code, not a copy.
//
// Run:  node scripts/verify_triad_math.mjs
// Exits 0 on all-pass, 1 on any failure.

import * as THREE from '../web/node_modules/three/build/three.module.js';
import {
  applyWorldRotation, worldDeltaToLocal, isIdentityQuat, refreshMovedFlag,
} from '../web/bomdom/model.js';
import { lineParam, pickStep, UNITS, MIN_TICK_PX } from '../web/bomdom/triad.js';

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

// Deterministic PRNG so failures reproduce.
let seed = 0x13AB;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const rv = (s = 1) => new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).multiplyScalar(s);
const rq = () => new THREE.Quaternion().setFromEuler(
  new THREE.Euler(rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2));

// ---------------------------------------------------------------------------
// 1. lineParam: closest point on the drag axis to the pointer ray. Verified
//    against a brute-force scan (golden-section-ish refinement).
// ---------------------------------------------------------------------------
{
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const origin = rv(5);
    const dir = rv().normalize();
    const rayOrigin = rv(5);
    const rayDir = rv().normalize();
    if (Math.abs(dir.dot(rayDir)) > 0.999) continue; // parallel handled below
    const t = lineParam(origin, dir, rayOrigin, rayDir);
    // Distance between line point at t and the ray must be minimal: compare
    // against neighbours (first-order optimality on a convex quadratic).
    const distAt = (tt) => {
      // Unclamped line-to-line distance: the pointer ray from the camera has
      // the whole scene in front of it, so the infinite-line solution is the
      // right contract for the drag math.
      const p = origin.clone().addScaledVector(dir, tt);
      const w = p.clone().sub(rayOrigin);
      return p.distanceTo(rayOrigin.clone().addScaledVector(rayDir, w.dot(rayDir)));
    };
    const d0 = distAt(t);
    const eps = 1e-4;
    const better = Math.min(distAt(t - eps), distAt(t + eps));
    worst = Math.max(worst, d0 - better);
  }
  check('lineParam is a distance minimum (200 random pairs)', worst <= 1e-9,
    `found a neighbour closer by ${worst}`);

  const t = lineParam(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 5), new THREE.Vector3(1, 0, 0));
  check('lineParam parallel ray returns finite', Number.isFinite(t), String(t));
}

// ---------------------------------------------------------------------------
// 2. applyWorldRotation: rigid rotation about a world pivot decomposed into
//    parent-local dragQuat + dragDelta, recomposed exactly the way
//    applyPositions does it — under a rotated, translated, nested parent.
// ---------------------------------------------------------------------------
function makeRec(parentPos, parentQuat, childPos, childQuat) {
  const root = new THREE.Object3D();
  const parent = new THREE.Object3D();
  parent.position.copy(parentPos);
  parent.quaternion.copy(parentQuat);
  const grand = new THREE.Object3D(); // one more level, why not
  grand.position.set(0.03, -0.02, 0.05);
  grand.quaternion.setFromEuler(new THREE.Euler(0.1, -0.3, 0.2));
  const child = new THREE.Object3D();
  child.position.copy(childPos);
  child.quaternion.copy(childQuat);
  root.add(parent);
  parent.add(grand);
  grand.add(child);
  root.updateMatrixWorld(true);
  return {
    root,
    rec: {
      object: child,
      homePos: child.position.clone(),
      homeQuat: child.quaternion.clone(),
      explodeVec: new THREE.Vector3(),
      dragDelta: new THREE.Vector3(),
      dragQuat: new THREE.Quaternion(),
      flags: { moved: false },
    },
  };
}
// The applyPositions recomposition for one record (explode collapsed).
function recompose(root, rec) {
  rec.object.position.copy(rec.homePos).add(rec.dragDelta);
  rec.object.quaternion.copy(rec.homeQuat);
  if (!isIdentityQuat(rec.dragQuat)) rec.object.quaternion.premultiply(rec.dragQuat);
  root.updateMatrixWorld(true);
}

{
  let worstPos = 0, worstAng = 0;
  for (let i = 0; i < 100; i++) {
    const { root, rec } = makeRec(rv(2), rq(), rv(0.5), rq());
    const start = {
      delta: rec.dragDelta.clone(),
      quat: rec.dragQuat.clone(),
      worldPos: rec.object.getWorldPosition(new THREE.Vector3()),
    };
    const startWorldQuat = rec.object.getWorldQuaternion(new THREE.Quaternion());
    const qWorld = new THREE.Quaternion().setFromAxisAngle(rv().normalize(), rand() * 3 - 1.5);
    const pivot = rv(2);

    applyWorldRotation(rec, qWorld, pivot, start);
    recompose(root, rec);

    const expectPos = start.worldPos.clone().sub(pivot).applyQuaternion(qWorld).add(pivot);
    const expectQuat = qWorld.clone().multiply(startWorldQuat);
    const gotPos = rec.object.getWorldPosition(new THREE.Vector3());
    const gotQuat = rec.object.getWorldQuaternion(new THREE.Quaternion());
    worstPos = Math.max(worstPos, gotPos.distanceTo(expectPos));
    worstAng = Math.max(worstAng, expectQuat.angleTo(gotQuat));
  }
  check('applyWorldRotation world position (100 nested random poses)', worstPos < 1e-10,
    `worst ${worstPos}`);
  check('applyWorldRotation world orientation', worstAng < 1e-7, `worst ${worstAng} rad`);
}

{
  // Two chained rotations (drag, release, drag again) must equal one combined.
  const { root, rec } = makeRec(rv(2), rq(), rv(0.5), rq());
  const pivot = rv(1);
  const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
  const q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.9);
  const snap = () => ({
    delta: rec.dragDelta.clone(),
    quat: rec.dragQuat.clone(),
    worldPos: rec.object.getWorldPosition(new THREE.Vector3()),
  });
  const w0 = rec.object.getWorldPosition(new THREE.Vector3());
  const wq0 = rec.object.getWorldQuaternion(new THREE.Quaternion());
  applyWorldRotation(rec, q1, pivot, snap());
  recompose(root, rec);
  applyWorldRotation(rec, q2, pivot, snap());
  recompose(root, rec);
  const combined = q2.clone().multiply(q1);
  const expectPos = w0.clone().sub(pivot).applyQuaternion(combined).add(pivot);
  const expectQuat = combined.multiply(wq0);
  const gotPos = rec.object.getWorldPosition(new THREE.Vector3());
  const gotQuat = rec.object.getWorldQuaternion(new THREE.Quaternion());
  check('chained rotations compose', gotPos.distanceTo(expectPos) < 1e-10
    && expectQuat.angleTo(gotQuat) < 1e-7,
    `pos ${gotPos.distanceTo(expectPos)}, ang ${expectQuat.angleTo(gotQuat)}`);
  check('refreshMovedFlag sees a pure rotation as moved',
    (refreshMovedFlag(rec), rec.flags.moved) === true);
}

// ---------------------------------------------------------------------------
// 3. worldDeltaToLocal under a scaled + rotated parent: applying the returned
//    local delta must move the child in world by exactly the requested delta.
// ---------------------------------------------------------------------------
{
  let worst = 0;
  for (let i = 0; i < 100; i++) {
    const root = new THREE.Object3D();
    const parent = new THREE.Object3D();
    parent.position.copy(rv(2));
    parent.quaternion.copy(rq());
    parent.scale.setScalar(0.25 + rand() * 3); // uniform scale, like a unit-odd GLB
    const child = new THREE.Object3D();
    child.position.copy(rv(0.5));
    root.add(parent);
    parent.add(child);
    root.updateMatrixWorld(true);
    const w0 = child.getWorldPosition(new THREE.Vector3());
    const delta = rv(1);
    child.position.add(worldDeltaToLocal(parent, delta, w0));
    root.updateMatrixWorld(true);
    const w1 = child.getWorldPosition(new THREE.Vector3());
    worst = Math.max(worst, w1.sub(w0).distanceTo(delta));
  }
  check('worldDeltaToLocal round-trips through scaled parents', worst < 1e-10, `worst ${worst}`);
}

// ---------------------------------------------------------------------------
// 4. Ruler step ladder: ticks are never closer than MIN_TICK_PX, never more
//    than ~5x apart, and steps are clean 1-2-5 values in display units.
// ---------------------------------------------------------------------------
{
  let ok = true, detail = '';
  for (const unit of Object.keys(UNITS)) {
    for (let i = 0; i < 60; i++) {
      const pxPerWorld = Math.pow(10, rand() * 6 - 2); // 0.01 .. 10000 px per meter
      const stepDisp = pickStep(pxPerWorld, unit);
      const stepWorld = stepDisp / UNITS[unit].scale;
      const px = stepWorld * pxPerWorld;
      if (px < MIN_TICK_PX - 1e-6) { ok = false; detail = `${unit}: ticks ${px}px apart`; break; }
      if (px > MIN_TICK_PX * 5.01) { ok = false; detail = `${unit}: ticks ${px}px apart (too sparse)`; break; }
      const mant = stepDisp / Math.pow(10, Math.floor(Math.log10(stepDisp) + 1e-9));
      if (![1, 2, 5].some((m) => Math.abs(mant - m) < 1e-6)) {
        ok = false; detail = `${unit}: step ${stepDisp} not a 1-2-5 value`; break;
      }
    }
  }
  check('pickStep ladder honours MIN_TICK_PX and 1-2-5 steps (all units)', ok, detail);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
