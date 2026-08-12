// Move-mode triad (issue #13): a 6-DOF gizmo shown over the selection while
// move mode is on. Arrows slide along the MODEL axes against a cursor-zone
// ruler (pointer near the ruler snaps to tick values, pulling away is free),
// rings turn about them against a 15° protractor (outer band snaps, inside is
// free), and the amber center ball free-moves in the view plane like the
// classic body drag. Clicking an arrow or ring without dragging opens a
// type-in for an exact distance / angle. Interaction contracts honoured:
// M.applyPositions only (never object.position directly), 'positions-live'
// per frame and 'positions' at rest, app.dragging while a gesture is live,
// and viewer.controls re-read through its getter on every gesture.

import * as THREE from 'three';
import * as M from './model.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const rad = THREE.MathUtils.degToRad;

const AXIS_DIRS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];
const AXIS_NAMES = ['X', 'Y', 'Z'];
// Ring-drag angle basis (right-handed): angle runs from u1 toward u2.
const RING_BASIS = [[1, 2], [2, 0], [0, 1]];

// Gizmo proportions in triad-local units; the group is rescaled every camera
// change so the triad keeps a constant screen size. Validated in the issue-13
// prototype: arrows cross each ring at only two thin points and the arrow
// corridor wins there (pick priority center > shaft > ring).
const ARROW_START = 0.24;
const HEAD_LEN = 0.16, HEAD_R = 0.06;
const SHAFT_R = 0.02, HIT_SHAFT_R = 0.095;
const RING_R = 0.62, RING_TUBE = 0.016, HIT_RING_TUBE = 0.08;
const CENTER_R = 0.09, HIT_CENTER_R = 0.18;
const PROT_R = 0.82;            // protractor radius (triad units)
const TRIAD_SCREEN = 0.26;      // triad arm length as a fraction of camera distance
const SNAP_PX = 26;             // ruler corridor half-width (screen px)
const RING_SNAP_FRAC = 0.88;    // ring snaps at/outside this fraction of its radius
const ROT_SNAP_DEG = 15;
const MIN_TICK_PX = 34;         // ruler ticks never sit closer than this
const CLICK_SLOP_PX = 4;
const CENTER_COLOR = 0xc9a227;  // fixed, like measure's canvas marker colours

// Display units mirror the measure tool's (world units are meters).
const UNITS_KEY = 'picturebom-bomdom-units';
const UNITS = {
  mm: { scale: 1000, suffix: 'mm', freeDec: 1 },
  cm: { scale: 100, suffix: 'cm', freeDec: 2 },
  m: { scale: 1, suffix: 'm', freeDec: 4 },
  in: { scale: 1000 / 25.4, suffix: 'in', freeDec: 2 },
};

function readUnit() {
  try {
    const u = localStorage.getItem(UNITS_KEY);
    return UNITS[u] ? u : 'mm';
  } catch { return 'mm'; }
}

// Smallest 1-2-5 step (in display units) whose ticks are at least
// MIN_TICK_PX apart on screen at the current zoom. Exported for
// scripts/verify_triad_math.mjs.
export function pickStep(pxPerWorld, unit) {
  const minDisp = (MIN_TICK_PX / Math.max(pxPerWorld, 1e-9)) * UNITS[unit].scale;
  const k = Math.floor(Math.log10(minDisp));
  for (const m of [1, 2, 5, 10, 20, 50]) {
    const s = m * Math.pow(10, k);
    if (s >= minDisp - 1e-12) return s;
  }
  return Math.pow(10, k + 2);
}

// Closest param t on the line origin + t*dir to the ray (both dirs unit
// length): the workhorse of arrow drags. Exported for the verifier.
export function lineParam(origin, dir, rayOrigin, rayDir) {
  const w0x = origin.x - rayOrigin.x;
  const w0y = origin.y - rayOrigin.y;
  const w0z = origin.z - rayOrigin.z;
  const b = dir.x * rayDir.x + dir.y * rayDir.y + dir.z * rayDir.z;
  const d0 = dir.x * w0x + dir.y * w0y + dir.z * w0z;
  const e = rayDir.x * w0x + rayDir.y * w0y + rayDir.z * w0z;
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-9) return -d0; // axis parallel to the ray
  return (b * e - d0) / denom;
}

export { UNITS, MIN_TICK_PX }; // verifier needs the contract, not copies

// Drop float junk from tick labels: 15.000000000002 -> "15".
const trimNum = (n) => String(parseFloat(n.toFixed(6)));

export function initTriad(app) {
  const viewer = app.viewer;
  const canvas = $('gl');
  const viewport = $('viewport');
  const invalidate = viewer.invalidate;

  // ---- DOM overlays (created here, not in shell.html — they only exist for
  // this feature and never render into exports) ---------------------------
  const hud = document.createElementNS(SVG_NS, 'svg');
  hud.setAttribute('class', 'triad-hud');
  viewport.appendChild(hud);
  const tip = document.createElement('div');
  tip.className = 'triad-tip hidden';
  viewport.appendChild(tip);
  const chip = document.createElement('div');
  chip.className = 'triad-chip hidden';
  viewport.appendChild(chip);
  const typeBox = document.createElement('div');
  typeBox.className = 'triad-type hidden';
  const typeInput = document.createElement('input');
  typeInput.type = 'number';
  typeInput.step = 'any';
  typeInput.inputMode = 'decimal';
  const typeUnit = document.createElement('span');
  typeBox.appendChild(typeInput);
  typeBox.appendChild(typeUnit);
  viewport.appendChild(typeBox);

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function sizeHud() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    hud.setAttribute('width', w);
    hud.setAttribute('height', h);
    hud.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  // ---- gizmo -------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'bomdom-triad';
  group.visible = false;
  viewer.scene.add(group);

  const visParts = [];  // { mat, kind, axis } — visible meshes, for hover dimming
  const hitMeshes = []; // invisible fat pick corridors, for raycasting

  const gizmoMat = (color) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
  });
  function addVis(mesh, kind, axis, order) {
    mesh.renderOrder = order;
    mesh.raycast = () => {}; // only the hit corridors are pickable
    visParts.push({ mat: mesh.material, kind, axis });
  }
  function addHit(mesh, kind, axis, pri) {
    mesh.material.opacity = 0;
    mesh.userData = { kind, axis, pri };
    mesh.renderOrder = 1001;
    hitMeshes.push(mesh);
  }

  for (let a = 0; a < 3; a++) {
    const axisGroup = new THREE.Group();
    const shaftLen = 1 - ARROW_START - HEAD_LEN;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(SHAFT_R, SHAFT_R, shaftLen, 12), gizmoMat(0x888888));
    shaft.position.y = ARROW_START + shaftLen / 2;
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(HEAD_R, HEAD_LEN, 20), gizmoMat(0x888888));
    head.position.y = 1 - HEAD_LEN / 2;
    const hitLen = 1 - ARROW_START + 0.08;
    const shaftHit = new THREE.Mesh(
      new THREE.CylinderGeometry(HIT_SHAFT_R, HIT_SHAFT_R, hitLen, 8), gizmoMat(0x888888));
    shaftHit.position.y = ARROW_START + hitLen / 2;
    axisGroup.add(shaft, head, shaftHit);
    if (a === 0) axisGroup.rotation.z = -Math.PI / 2;
    if (a === 2) axisGroup.rotation.x = Math.PI / 2;
    group.add(axisGroup);
    addVis(shaft, 'shaft', a, 1003);
    addVis(head, 'shaft', a, 1003);
    addHit(shaftHit, 'shaft', a, 1);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(RING_R, RING_TUBE, 12, 96), gizmoMat(0x888888));
    const ringHit = new THREE.Mesh(
      new THREE.TorusGeometry(RING_R, HIT_RING_TUBE, 8, 48), gizmoMat(0x888888));
    if (a === 0) { ring.rotation.y = Math.PI / 2; ringHit.rotation.y = Math.PI / 2; }
    if (a === 1) { ring.rotation.x = Math.PI / 2; ringHit.rotation.x = Math.PI / 2; }
    group.add(ring, ringHit);
    addVis(ring, 'ring', a, 1002);
    addHit(ringHit, 'ring', a, 2);
  }
  const centerBall = new THREE.Mesh(
    new THREE.SphereGeometry(CENTER_R, 20, 14), gizmoMat(CENTER_COLOR));
  const centerHit = new THREE.Mesh(
    new THREE.SphereGeometry(HIT_CENTER_R, 10, 8), gizmoMat(CENTER_COLOR));
  group.add(centerBall, centerHit);
  addVis(centerBall, 'center', -1, 1004);
  addHit(centerHit, 'center', -1, 0);

  // Arrow/ring colours follow the shared axis identity tokens (same as the
  // corner gizmo and the explode radios); the center ball stays fixed amber.
  function applyAxisColors() {
    const cs = getComputedStyle(document.documentElement);
    for (let a = 0; a < 3; a++) {
      const hex = cs.getPropertyValue('--axis-' + 'xyz'[a]).trim() || '#888888';
      for (const p of visParts) if (p.axis === a) p.mat.color.set(hex);
    }
    invalidate();
  }
  applyAxisColors();
  new MutationObserver(applyAxisColors)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  function axisHex(a) {
    const p = visParts.find((v) => v.axis === a);
    return '#' + p.mat.color.getHexString();
  }

  // ---- projection helpers ------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  function setRay(ev) {
    const r = canvas.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1,
             -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(_ndc, viewer.camera);
  }
  function viewportPxOf(ev) {
    const r = viewport.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
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
  const lineParamAtRay = (origin, dir) =>
    lineParam(origin, dir, raycaster.ray.origin, raycaster.ray.direction);

  // ---- visibility / placement --------------------------------------------
  let targets = [];

  // Selection roots: records none of whose ancestors are also selected — the
  // same units the free drag and the context menu act on. Hidden/isolated-out
  // parts are excluded: a gizmo floating over nothing, silently moving an
  // invisible part, is worse than no gizmo.
  function computeTargets() {
    const recs = [...app.sel.selected].map((id) => app.model.records[id]).filter(Boolean);
    if (!recs.length) return [];
    const ids = new Set(recs.map((r) => r.id));
    return recs.filter((r) => {
      if (M.isEffectivelyHidden(r, app.sel.scope, app.sel.filter)) return false;
      for (let a = r.parent; a; a = a.parent) if (ids.has(a.id)) return false;
      return true;
    });
  }

  function rescale() {
    const s = viewer.camera.position.distanceTo(group.position) * TRIAD_SCREEN;
    if (Math.abs(s - group.scale.x) > s * 1e-3) {
      group.scale.setScalar(s);
      group.updateMatrixWorld(true); // raycasts may run before the next render
      invalidate();
    }
  }

  function refresh() {
    const on = !!(app.moveMode && !app.measureMode && app.model);
    targets = on ? computeTargets() : [];
    let ok = on && targets.length > 0;
    if (ok) {
      const box = M.boxOfRecs(targets);
      ok = !box.isEmpty();
      if (ok) box.getCenter(group.position);
    }
    if (!ok) {
      if (dragState) cancelDrag();
      closeTypeIn();
    }
    if (group.visible !== ok || ok) invalidate();
    group.visible = ok;
    if (ok) {
      rescale();
      group.updateMatrixWorld(true); // hover may raycast before the pending frame renders
    }
    clearGizmoHover();
  }

  // ---- hover over the gizmo ----------------------------------------------
  let gizmoHover = null; // {kind, axis} | null

  function hitTest(ev) {
    if (!group.visible) return null;
    setRay(ev);
    let hits = raycaster.intersectObjects(hitMeshes, false);
    // A section view clips the gizmo visually (global clipping planes hit
    // every material) — handles the user cannot see must not grab either.
    const clip = app.section && app.section.enabled ? app.section.plane : null;
    if (clip) hits = hits.filter((h) => clip.distanceToPoint(h.point) >= 0);
    if (!hits.length) return null;
    hits.sort((p, q) =>
      (p.object.userData.pri - q.object.userData.pri) || (p.distance - q.distance));
    const h = hits[0];
    return { kind: h.object.userData.kind, axis: h.object.userData.axis, point: h.point.clone() };
  }

  function setOpacities(fn) {
    let changed = false;
    for (const p of visParts) {
      const o = fn(p);
      if (p.mat.opacity !== o) { p.mat.opacity = o; changed = true; }
    }
    if (changed) invalidate();
  }
  function clearGizmoHover() {
    gizmoHover = null;
    tip.classList.add('hidden');
    if (!dragState) {
      setOpacities(() => 1);
      canvas.style.cursor = '';
    }
  }
  function tipTextFor(h) {
    if (h.kind === 'shaft') return 'slide along ' + AXIS_NAMES[h.axis];
    if (h.kind === 'ring') return 'turn about ' + AXIS_NAMES[h.axis];
    return 'free move';
  }
  function setGizmoHover(h, ev) {
    const same = gizmoHover && h && gizmoHover.kind === h.kind && gizmoHover.axis === h.axis;
    if (!h) { if (gizmoHover) clearGizmoHover(); return; }
    gizmoHover = { kind: h.kind, axis: h.axis };
    if (!same) {
      setOpacities((p) => (p.kind === h.kind && p.axis === h.axis) ? 1 : 0.35);
      canvas.style.cursor = 'grab';
      tip.textContent = tipTextFor(h);
      tip.classList.remove('hidden');
    }
    const p = viewportPxOf(ev);
    tip.style.left = (p.x + 16) + 'px';
    tip.style.top = (p.y - 28) + 'px';
  }

  canvas.addEventListener('pointermove', (ev) => {
    if (!group.visible || dragState || ev.buttons !== 0) return;
    setGizmoHover(hitTest(ev), ev);
  });
  canvas.addEventListener('pointerleave', () => { if (!dragState) clearGizmoHover(); });

  // ---- value chip ----------------------------------------------------------
  function showChip(text, snapped, ev) {
    chip.replaceChildren(document.createTextNode(text));
    if (snapped !== null) {
      const tag = document.createElement('span');
      tag.className = 'tc-tag';
      tag.textContent = snapped ? 'snapped' : 'free';
      chip.appendChild(tag);
    }
    chip.classList.toggle('is-snapped', !!snapped);
    const p = viewportPxOf(ev);
    chip.style.left = (p.x + 18) + 'px';
    chip.style.top = (p.y - 34) + 'px';
    chip.classList.remove('hidden');
  }
  const hideChip = () => chip.classList.add('hidden');

  function fmtLen(worldVal, unit, snapped) {
    const u = UNITS[unit];
    const disp = worldVal * u.scale;
    return (snapped ? trimNum(disp) : disp.toFixed(u.freeDec)) + ' ' + u.suffix;
  }
  const fmtDeg = (deg, snapped) => (snapped ? String(Math.round(deg)) : deg.toFixed(1)) + '°';

  // ---- applying moves -------------------------------------------------------
  // snaps: per-target drag-start snapshots {rec, delta, quat, worldPos}.
  // During a gesture flags.moved is held true so applyPositions keeps writing
  // the pose even through exact zero; finishSnaps recomputes the real flag
  // when the gesture ends (so ending AT zero counts as "not moved" again).
  const _wd = new THREE.Vector3();
  function translateSnapsWorld(snaps, refPoint, worldDelta) {
    for (const s of snaps) {
      s.rec.dragDelta.copy(s.delta).add(
        M.worldDeltaToLocal(s.rec.object.parent, worldDelta, refPoint));
      s.rec.flags.moved = true;
    }
  }
  const _rq = new THREE.Quaternion();
  function rotateSnaps(snaps, pivot, axis, deg) {
    if (deg === 0) {
      // Exact zero (the snapped path lands here often): restore the start
      // snapshots verbatim instead of running the pivot math, whose float
      // dust would leave a not-quite-identity dragQuat behind.
      for (const s of snaps) {
        s.rec.dragDelta.copy(s.delta);
        s.rec.dragQuat.copy(s.quat);
        s.rec.flags.moved = true;
      }
      return;
    }
    _rq.setFromAxisAngle(AXIS_DIRS[axis], rad(deg));
    for (const s of snaps) M.applyWorldRotation(s.rec, _rq, pivot, s);
  }
  function finishSnaps(snaps) {
    for (const s of snaps) M.refreshMovedFlag(s.rec);
  }
  function commitLive() {
    M.applyPositions(app.model, app.model.explodeF);
    app.events.emit('positions-live');
    invalidate();
  }

  // ---- drag -----------------------------------------------------------------
  let dragState = null;

  function tryStartDrag(ev) {
    if (dragState) return true; // a second pointer mid-drag: swallow, don't restart
    if (!group.visible || ev.button !== 0) return false;
    const h = hitTest(ev);
    if (!h) return false;
    startDrag(h, ev);
    return true;
  }

  function startDrag(h, ev) {
    closeTypeIn();
    viewer.controls.enabled = false;
    app.dragging = true;
    canvas.classList.add('is-dragging');
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    app.sel.setHover(null);
    tip.classList.add('hidden');
    const unit = readUnit();
    const d = dragState = {
      kind: h.kind, axis: h.axis, unit,
      pointerId: ev.pointerId,
      downX: ev.clientX, downY: ev.clientY, moved: false,
      center: group.position.clone(),
      snaps: targets.map((rec) => ({
        rec,
        delta: rec.dragDelta.clone(),
        quat: rec.dragQuat.clone(),
        worldPos: rec.object.getWorldPosition(new THREE.Vector3()),
      })),
    };
    setRay(ev);
    if (h.kind === 'shaft') {
      const dir = AXIS_DIRS[h.axis];
      d.t0 = lineParamAtRay(d.center, dir);
      // Frozen screen frame for the ruler — the camera cannot move mid-drag.
      const probe = group.scale.x; // one gizmo arm, in world units
      const a = toViewportPx(d.center);
      const b = toViewportPx(new THREE.Vector3().copy(d.center).addScaledVector(dir, probe));
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      d.degenerate = len < 8; // axis nearly edge-on: no meaningful corridor
      d.screenA = a;
      d.screenDx = len ? dx / len : 1;
      d.screenDy = len ? dy / len : 0;
      d.pxPerWorld = len / probe;
      d.stepDisp = pickStep(d.pxPerWorld, unit);
      d.stepWorld = d.stepDisp / UNITS[unit].scale;
    } else if (h.kind === 'ring') {
      const n = AXIS_DIRS[h.axis];
      d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, d.center);
      // Ring plane nearly containing the view ray: intersections land at huge
      // radii and flip sides as the pointer crosses the plane's screen trace,
      // so the angle would jump ~180° per crossing. Refuse the gesture.
      d.degenerate = Math.abs(n.dot(raycaster.ray.direction)) < 0.08;
      d.u1 = AXIS_DIRS[RING_BASIS[h.axis][0]];
      d.u2 = AXIS_DIRS[RING_BASIS[h.axis][1]];
      const hit = new THREE.Vector3();
      const v = (raycaster.ray.intersectPlane(d.plane, hit) ? hit : h.point)
        .clone().sub(d.center);
      d.ang0 = Math.atan2(v.dot(d.u2), v.dot(d.u1));
      d.prev = d.ang0;
      d.acc = 0;
    } else { // center ball — free view-plane move
      const nrm = viewer.camera.getWorldDirection(new THREE.Vector3()).negate();
      d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, d.center);
      const hit = new THREE.Vector3();
      d.hit0 = raycaster.ray.intersectPlane(d.plane, hit) ? hit.clone() : h.point.clone();
    }
    // Everything but the active handle steps far back while dragging.
    setOpacities((p) => {
      const active = h.kind === 'center' ? p.kind === 'center'
        : (p.kind === h.kind && p.axis === h.axis);
      return active ? 1 : 0.12;
    });
    canvas.addEventListener('pointermove', onDragMove);
    canvas.addEventListener('pointerup', onDragUp);
    canvas.addEventListener('pointercancel', onDragCancel);
  }

  const _hit = new THREE.Vector3();
  function onDragMove(ev) {
    const d = dragState;
    if (!d || ev.pointerId !== d.pointerId) return;
    if (!d.moved && Math.hypot(ev.clientX - d.downX, ev.clientY - d.downY) > CLICK_SLOP_PX) {
      d.moved = true;
    }
    // Inside the click slop nothing may touch the model: a jittery click that
    // opens the type-in must leave zero trace (no moved flags, no stale
    // measurements, no 'positions-live').
    if (!d.moved) return;
    setRay(ev);
    if (d.kind === 'shaft') {
      if (d.degenerate) { showChip('axis is edge-on — orbit a little', null, ev); return; }
      const dir = AXIS_DIRS[d.axis];
      const raw = lineParamAtRay(d.center, dir) - d.t0;
      // Near-edge-on axes amplify pointer motion (1/sin²θ) — never let one
      // gesture throw parts further than a couple of assembly diagonals.
      const lim = 2.5 * app.model.diagLen;
      const px = viewportPxOf(ev);
      const distPx = Math.abs((px.x - d.screenA.x) * d.screenDy - (px.y - d.screenA.y) * d.screenDx);
      const snapped = distPx < SNAP_PX;
      let val = snapped ? Math.round(raw / d.stepWorld) * d.stepWorld : raw;
      val = Math.max(-lim, Math.min(lim, val));
      translateSnapsWorld(d.snaps, d.center, _wd.copy(dir).multiplyScalar(val));
      group.position.copy(d.center).addScaledVector(dir, val);
      drawRuler(d, val, snapped);
      showChip(fmtLen(val, d.unit, snapped), snapped, ev);
    } else if (d.kind === 'ring') {
      if (d.degenerate) { showChip('ring is edge-on — orbit a little', null, ev); return; }
      if (!raycaster.ray.intersectPlane(d.plane, _hit)) return;
      const v = _hit.sub(d.center);
      const ang = Math.atan2(v.dot(d.u2), v.dot(d.u1));
      let step = ang - d.prev;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      d.prev = ang;
      // A >69° hop between two pointer events is a plane-crossing artifact
      // (oblique rings flip intersection sides), not a hand motion.
      if (Math.abs(step) > 1.2) { drawProtractor(d, THREE.MathUtils.radToDeg(d.acc), false); return; }
      d.acc += step;
      const snapped = v.length() >= RING_SNAP_FRAC * RING_R * group.scale.x;
      const rawDeg = THREE.MathUtils.radToDeg(d.acc);
      const deg = snapped ? Math.round(rawDeg / ROT_SNAP_DEG) * ROT_SNAP_DEG : rawDeg;
      rotateSnaps(d.snaps, d.center, d.axis, deg);
      drawProtractor(d, deg, snapped);
      showChip(fmtDeg(deg, snapped), snapped, ev);
    } else {
      if (!raycaster.ray.intersectPlane(d.plane, _hit)) return;
      const worldDelta = _wd.copy(_hit).sub(d.hit0);
      translateSnapsWorld(d.snaps, d.center, worldDelta);
      group.position.copy(d.center).add(worldDelta);
      showChip('free move', null, ev);
    }
    commitLive();
  }

  function teardownDrag() {
    canvas.removeEventListener('pointermove', onDragMove);
    canvas.removeEventListener('pointerup', onDragUp);
    canvas.removeEventListener('pointercancel', onDragCancel);
    viewer.controls.enabled = true;
    app.dragging = false;
    canvas.classList.remove('is-dragging');
    hud.replaceChildren();
    hideChip();
    setOpacities(() => 1);
  }
  function onDragUp(ev) {
    const d = dragState;
    if (!d || ev.pointerId !== d.pointerId) return;
    dragState = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    teardownDrag();
    if (!d.moved && (d.kind === 'shaft' || d.kind === 'ring')) {
      openTypeIn(d, ev); // a clean click asks for an exact value; nothing was mutated
      return;
    }
    finishSnaps(d.snaps); // ending back AT zero counts as "not moved" again
    refresh(); // exact re-center (rotation of a group can shift its box center)
    app.events.emit('positions');
  }
  function onDragCancel(ev) {
    if (dragState && ev.pointerId === dragState.pointerId) cancelDrag();
  }
  // Abort the gesture and put everything back where the drag started (Esc,
  // OS pointer cancel, or the selection/model dying under the drag).
  function cancelDrag() {
    const d = dragState;
    dragState = null;
    if (!d) return;
    try { canvas.releasePointerCapture(d.pointerId); } catch (e) { /* ignore */ }
    teardownDrag();
    if (d.moved && app.model) {
      for (const s of d.snaps) {
        s.rec.dragDelta.copy(s.delta);
        s.rec.dragQuat.copy(s.quat);
      }
      finishSnaps(d.snaps);
      M.applyPositions(app.model, app.model.explodeF);
      app.events.emit('positions-live');
      invalidate();
    }
    app.events.emit('positions');
  }

  // ---- type-in (click an arrow / ring, enter an exact value) ---------------
  let typeCtx = null;
  let typeCloseTimer = null;
  function openTypeIn(d, ev) {
    clearTimeout(typeCloseTimer); // a blur from THIS click must not close the new box
    typeCtx = d;
    const p = viewportPxOf(ev);
    typeBox.style.left = Math.min(p.x + 12, Math.max(6, viewport.clientWidth - 160)) + 'px';
    typeBox.style.top = Math.max(p.y - 44, 6) + 'px';
    typeUnit.textContent = d.kind === 'shaft'
      ? UNITS[d.unit].suffix + ' along ' + AXIS_NAMES[d.axis]
      : '° about ' + AXIS_NAMES[d.axis];
    typeInput.value = '';
    typeBox.classList.remove('hidden');
    typeInput.focus();
  }
  function closeTypeIn() {
    clearTimeout(typeCloseTimer);
    if (typeBox.classList.contains('hidden')) return;
    typeBox.classList.add('hidden');
    typeCtx = null;
  }
  typeInput.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // the window key handler must not also react
    if (ev.key === 'Escape') { closeTypeIn(); return; }
    if (ev.key !== 'Enter' || !typeCtx || !app.model) return;
    const v = parseFloat(typeInput.value);
    if (!isFinite(v) || v === 0) { closeTypeIn(); return; }
    const t = typeCtx;
    // Relative move: "25" slides 25 mm along the axis from where the part is
    // now (the snapshots were taken on the click that opened this input).
    if (t.kind === 'shaft') {
      translateSnapsWorld(t.snaps, t.center,
        _wd.copy(AXIS_DIRS[t.axis]).multiplyScalar(v / UNITS[t.unit].scale));
    } else {
      rotateSnaps(t.snaps, t.center, t.axis, v);
    }
    closeTypeIn();
    M.applyPositions(app.model, app.model.explodeF);
    finishSnaps(t.snaps); // after the write, so an exact cancel-out still painted home
    app.events.emit('positions-live');
    app.events.emit('positions');
    refresh();
  });
  typeInput.addEventListener('blur', () => {
    clearTimeout(typeCloseTimer);
    typeCloseTimer = setTimeout(closeTypeIn, 120);
  });

  // ---- ruler / protractor overlays -----------------------------------------
  const _tickW = new THREE.Vector3();
  function drawRuler(d, val, snapped) {
    sizeHud();
    hud.replaceChildren();
    const g = svgEl('g', { opacity: snapped ? '1' : '0.45' });
    const dir = AXIS_DIRS[d.axis];
    const k0 = Math.round(val / d.stepWorld);
    const pA = toViewportPx(_tickW.copy(d.center).addScaledVector(dir, (k0 - 7) * d.stepWorld));
    const pB = toViewportPx(_tickW.copy(d.center).addScaledVector(dir, (k0 + 7) * d.stepWorld));
    g.appendChild(svgEl('line', {
      x1: pA.x, y1: pA.y, x2: pB.x, y2: pB.y,
      class: 'thud-axis', stroke: axisHex(d.axis),
    }));
    const px = -d.screenDy, py = d.screenDx; // screen-perpendicular to the axis
    const labelEvery = d.stepWorld * d.pxPerWorld >= 56 ? 1 : 2;
    for (let k = k0 - 7; k <= k0 + 7; k++) {
      const s = toViewportPx(_tickW.copy(d.center).addScaledVector(dir, k * d.stepWorld));
      if (s.behind) continue;
      const isSnap = snapped && k === k0;
      const len = isSnap ? 12 : (k === 0 ? 11 : 8);
      g.appendChild(svgEl('line', {
        x1: s.x - px * len, y1: s.y - py * len,
        x2: s.x + px * len, y2: s.y + py * len,
        class: 'thud-tick' + (isSnap ? ' is-snap' : (k === 0 ? ' is-zero' : '')),
      }));
      if (k % labelEvery === 0) {
        const t = svgEl('text', {
          x: s.x + px * 26, y: s.y + py * 26,
          class: 'thud-label' + (isSnap ? ' is-snap' : ''),
        });
        t.textContent = trimNum(k * d.stepDisp);
        g.appendChild(t);
      }
    }
    hud.appendChild(g);
  }

  function drawProtractor(d, deg, snapped) {
    sizeHud();
    hud.replaceChildren();
    const g = svgEl('g', { opacity: snapped ? '1' : '0.45' });
    const R = PROT_R * group.scale.x;
    const pt = (ang, r) => toViewportPx(
      _tickW.copy(d.center).addScaledVector(d.u1, Math.cos(ang) * r)
        .addScaledVector(d.u2, Math.sin(ang) * r));
    let path = '';
    for (let a = 0; a <= 360; a += 6) {
      const s = pt(rad(a) + d.ang0, R);
      path += (a === 0 ? 'M' : 'L') + s.x.toFixed(1) + ',' + s.y.toFixed(1);
    }
    g.appendChild(svgEl('path', { d: path, class: 'thud-ring' }));
    // Ticks are relative to the start ray, so snapped angles land on ticks.
    for (let a = 0; a < 360; a += ROT_SNAP_DEG) {
      const bold = a % 45 === 0;
      const s1 = pt(rad(a) + d.ang0, R * (bold ? 0.90 : 0.94));
      const s2 = pt(rad(a) + d.ang0, R);
      g.appendChild(svgEl('line', {
        x1: s1.x, y1: s1.y, x2: s2.x, y2: s2.y,
        class: 'thud-tick' + (bold ? ' is-zero' : ''),
      }));
    }
    const c = toViewportPx(_tickW.copy(d.center));
    const s0 = pt(d.ang0, R);
    const sc = pt(d.ang0 + rad(deg), R);
    g.appendChild(svgEl('line', { x1: c.x, y1: c.y, x2: s0.x, y2: s0.y, class: 'thud-ray' }));
    g.appendChild(svgEl('line', { x1: c.x, y1: c.y, x2: sc.x, y2: sc.y, class: 'thud-cur' }));
    let arc = '';
    const steps = Math.max(2, Math.ceil(Math.abs(deg) / 5));
    for (let i = 0; i <= steps; i++) {
      const s = pt(d.ang0 + rad(deg) * (i / steps), R * 0.55);
      arc += (i === 0 ? 'M' : 'L') + s.x.toFixed(1) + ',' + s.y.toFixed(1);
    }
    g.appendChild(svgEl('path', { d: arc, class: 'thud-cur', 'stroke-width': '1.6' }));
    hud.appendChild(g);
  }

  // ---- follow the app ------------------------------------------------------
  // Nothing but the drag itself may reposition the gizmo mid-gesture: edge
  // builds emit 'appearance' every few ms and would drag the pivot out from
  // under the frozen snap frame. A model swap is the exception — the records
  // under the gesture no longer exist, so the drag dies (and reverts).
  const quietRefresh = () => { if (!dragState) refresh(); };
  app.events.on('selection', quietRefresh);
  app.events.on('scope', quietRefresh);
  app.events.on('appearance', quietRefresh);
  app.events.on('model', () => {
    if (dragState) cancelDrag();
    closeTypeIn(); // its snapshots point at the replaced model's records
    refresh();
  });
  // Any positional change from OUTSIDE a triad gesture (explode scrub, snap
  // back, free drag) invalidates an open type-in's snapshots.
  const onPositions = () => {
    if (dragState) return;
    if (typeCtx) closeTypeIn();
    refresh();
  };
  app.events.on('positions', onPositions);
  app.events.on('positions-live', onPositions);

  // Constant screen size; the type-in closes when its anchor drifts away.
  const _camPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  const _camQ = new THREE.Quaternion();
  viewer.onCameraChange((cam) => {
    const moved = _camPos.distanceToSquared(cam.position) > 1e-12
      || Math.abs(1 - Math.abs(_camQ.dot(cam.quaternion))) > 1e-9;
    _camPos.copy(cam.position);
    _camQ.copy(cam.quaternion);
    if (!moved) return;
    if (group.visible) rescale();
    closeTypeIn();
  });

  app.triad = {
    refresh,
    tryStartDrag,
    hitTest,
    cancelDrag,
    dragging: () => !!dragState,
  };
  refresh();
}
