// Instance graph over the parsed GLB + all appearance/position operations.
// Plain Mesh per instance (no InstancedMesh): counts are small (hundreds)
// and per-instance material state is the whole point of the viewer.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { InlineDRACOLoader } from './inline-draco.js';
import { timed, note } from './diag.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const cleanName = (name) => (name || '').replace(/-\d+$/, '');

export function parseGlbBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(new InlineDRACOLoader());
    // parse(), never load(): load() would fetch, which file:// forbids.
    loader.parse(arrayBuffer, '', resolve, (e) => reject(e instanceof Error ? e : new Error(String(e && e.message || e))));
  });
}

// ---------------------------------------------------------------------------
// Graph build
// ---------------------------------------------------------------------------

// The 'shaded' render style paints parts the way a CAD viewport does; these
// two knobs plus the albedo lift below are its material half (the renderer/
// light half lives in scene.js RENDER_STYLES).
const SHADED_ROUGHNESS_FLOOR = 0.55;
// Screen-lift: c' = c + L·(1−c). Keeps saturated colors essentially
// untouched but raises pure black to charcoal, so faces and engravings on
// black-anodized parts stay readable — SolidWorks' viewport does the same.
const SHADED_BLACK_LIFT = 0.10;

// One shaded twin per source material: metalness off (metals paint like
// everything else — SolidWorks' RealView-off behaviour), satin roughness so
// nothing gleams, black lifted to charcoal. A full clone, so texture maps,
// transparency and emissive carry over; derive() keys its cache on material
// uuid, so real and shaded derived states never collide.
function shadedTwinFor(real, twinOf) {
  let twin = twinOf.get(real);
  if (!twin) {
    twin = real.clone();
    if (twin.metalness !== undefined) {
      twin.metalness = 0;
      twin.roughness = Math.max(SHADED_ROUGHNESS_FLOOR, twin.roughness);
    }
    if (twin.color) {
      const c = twin.color, L = SHADED_BLACK_LIFT;
      c.setRGB(c.r + L * (1 - c.r), c.g + L * (1 - c.g), c.b + L * (1 - c.b));
    }
    twinOf.set(real, twin);
  }
  return twin;
}

// Point every mesh at the base material matching the render style ('shaded'
// or 'realistic'); the next updateVisuals re-derives every ghost/opacity/
// highlight clone from the right base.
export function setMaterialStyle(model, style) {
  const shaded = style !== 'realistic';
  for (const mesh of model.meshRecords.keys()) {
    if (mesh.userData.__baseReal) {
      mesh.userData.__base = shaded ? mesh.userData.__baseShaded : mesh.userData.__baseReal;
    }
  }
}

// Free everything a replaced model owns (sidecar re-drop): geometries and
// their BVHs and edge geometries (all reached by the traverse — edge
// LineSegments and veil overlays are children), the source materials and
// their shaded twins, every matCache clone derived from either, and the
// textures the materials reference. Module-shared state (edgeMat, the
// overlay materials, other models' cache entries) stays.
export function disposeModel(model) {
  const geos = new Set();
  const mats = new Set();
  model.root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    if (o.userData && o.userData.__baseReal) {
      mats.add(o.userData.__baseReal);
      mats.add(o.userData.__baseShaded);
    } else if (o.isMesh && Array.isArray(o.material)) {
      // Multi-material meshes never get twins or a __baseReal pointer, but
      // their materials are still this model's to free.
      for (const m of o.material) if (m) mats.add(m);
    }
  });
  for (const g of geos) {
    if (g.boundsTree) g.disposeBoundsTree();
    g.dispose();
  }
  const textures = new Set();
  for (const m of mats) {
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                        'aoMap', 'emissiveMap', 'alphaMap']) {
      if (m[slot]) textures.add(m[slot]);
    }
    for (const [key, clone] of matCache) {
      if (key.startsWith(m.uuid + '|')) {
        clone.dispose();
        matCache.delete(key);
      }
    }
    m.dispose();
  }
  for (const t of textures) t.dispose();
}

export function buildGraph(gltf, meta) {
  const t0 = performance.now();
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const assoc = gltf.parser && gltf.parser.associations;
  const nodeIdxOf = (obj) => {
    if (!assoc) return undefined;
    const a = assoc.get(obj);
    return a && a.nodes !== undefined ? a.nodes : undefined;
  };

  let anyPartId = false;
  root.traverse((o) => { if (o.userData && o.userData.partId !== undefined) anyPartId = true; });
  const partByFold = new Map();
  for (const p of meta.parts) partByFold.set(p.name.toLowerCase(), p);
  if (!anyPartId) note('GLB has no extras.partId — matching parts by node name');

  function partIdFor(obj) {
    if (obj.userData && obj.userData.partId !== undefined) return obj.userData.partId;
    const p = partByFold.get(cleanName(obj.name).toLowerCase());
    return p ? p.id : null;
  }

  // A node object may BE a Mesh (single primitive) or a Group whose direct
  // Mesh children carry no glTF node index of their own (multi-primitive).
  function ownMeshes(obj) {
    const meshes = obj.isMesh ? [obj] : [];
    for (const c of obj.children) {
      if (c.isMesh && nodeIdxOf(c) === undefined) meshes.push(c);
    }
    return meshes;
  }

  const records = [];
  const meshRecords = new Map();

  function makeRecord(obj, parentRec, depth, meshes, nodeIdx) {
    const rec = {
      id: records.length,
      nodeIdx: nodeIdx === undefined ? null : nodeIdx,
      partId: meshes.length ? partIdFor(obj) : null,
      name: obj.name || '',
      object: obj,
      meshes,
      parent: parentRec,
      children: [],
      depth,
      homePos: obj.position.clone(),
      homeQuat: obj.quaternion.clone(),
      explodeVec: new THREE.Vector3(),
      seqT: 0, // sequenced explode: this unit's start within the slider range
      dragDelta: new THREE.Vector3(),
      dragQuat: new THREE.Quaternion(), // triad rotation offset, parent-local
      flags: { hidden: false, ghost: false, opacity: 1, moved: false },
    };
    records.push(rec);
    if (parentRec) parentRec.children.push(rec);
    for (const m of meshes) meshRecords.set(m, rec);
    return rec;
  }

  function visit(obj, parentRec, depth) {
    const meshes = obj === root ? [] : ownMeshes(obj);
    // Children that are glTF nodes in their own right (primitive meshes of a
    // multi-primitive node are claimed by ownMeshes above, not visited).
    const childObjs = obj.children.filter((c) => !(c.isMesh && nodeIdxOf(c) === undefined));
    let rec = parentRec;
    if (obj !== root && (meshes.length || childObjs.length)) {
      rec = makeRecord(obj, parentRec, depth, meshes, nodeIdxOf(obj));
      depth += 1;
    }
    for (const c of childObjs) visit(c, rec, depth);
  }
  visit(root, null, 0);

  // Mirrored instances: negative world determinant flips triangle winding,
  // so their materials must render DoubleSide. The payload's mirrored_nodes
  // list covers our own GLBs; the determinant check covers dropped files.
  const mirroredIdx = new Set(meta.mirrored_nodes || []);
  const twinOf = new Map(); // source material -> shaded twin (shared across instances)
  for (const [mesh, rec] of meshRecords) {
    const real = Array.isArray(mesh.material) ? null : mesh.material;
    mesh.userData.__base = real;
    // Faces are pushed back a hair so edge lines never z-fight. Must happen
    // here, before the first updateVisuals AND before the shaded twins are
    // cloned: derive()'s clones inherit the offset from their base and the
    // matCache is never invalidated.
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m) { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; }
    }
    if (real) {
      mesh.userData.__baseReal = real;
      mesh.userData.__baseShaded = shadedTwinFor(real, twinOf);
    }
    if (mesh.matrixWorld.determinant() < 0 ||
        (rec.nodeIdx !== null && mirroredIdx.has(rec.nodeIdx))) {
      mesh.userData.__ds = true;
    }
  }

  const rootRecs = records.filter((r) => !r.parent);

  const uniqueGeometries = new Set();
  let triangles = 0;
  for (const mesh of meshRecords.keys()) {
    uniqueGeometries.add(mesh.geometry);
    const g = mesh.geometry;
    triangles += Math.floor((g.index ? g.index.count
      : (g.attributes.position ? g.attributes.position.count : 0)) / 3);
  }
  // SolidWorks' exporter writes wrong accessor POSITION min/max on many
  // primitives (observed on ~30-45% of a real export, boxes off by up to
  // ~0.6 m), and GLTFLoader seeds boundingBox/boundingSphere from exactly
  // that metadata. Everything below — framing, marquee centers, measurement
  // snap radii, the section-plane range — needs bounds computed from the
  // decoded vertices instead.
  for (const g of uniqueGeometries) {
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  const bounds = new THREE.Box3().setFromObject(root);
  const diagLen = bounds.isEmpty() ? 1 : (bounds.getSize(new THREE.Vector3()).length() || 1);

  const byPartId = new Map();
  for (const rec of records) {
    if (rec.partId === null || !rec.meshes.length) continue;
    if (!byPartId.has(rec.partId)) byPartId.set(rec.partId, []);
    byPartId.get(rec.partId).push(rec);
  }
  const partById = new Map(meta.parts.map((p) => [p.id, p]));

  // BOM row name (casefolded) -> records; part records key by their linked
  // bom_name, group records by their cleaned node name.
  const byBomName = new Map();
  const addName = (key, rec) => {
    if (!key) return;
    key = key.toLowerCase();
    if (!byBomName.has(key)) byBomName.set(key, []);
    byBomName.get(key).push(rec);
  };
  for (const rec of records) {
    const p = rec.partId !== null && rec.meshes.length ? partById.get(rec.partId) : null;
    if (p) addName(p.bom_name || p.name, rec);
    else addName(cleanName(rec.name), rec);
  }

  const model = {
    root, records, rootRecs, meshRecords, byPartId, byBomName, partById,
    bounds, diagLen, uniqueGeometries, triangles,
    pickables: [], explodeF: 0, hiddenInstances: 0, bvhReady: false,
  };
  model.defaultExplodeMode = defaultExplodeMode(model);
  model.defaultExplodePlane = defaultExplodePlane(model);
  computeExplodeVectors(model, null);
  timed('graph build', performance.now() - t0);
  return model;
}

// ---------------------------------------------------------------------------
// Explode
// ---------------------------------------------------------------------------

export function worldDeltaToLocal(parent, worldDelta, refPoint) {
  // Delta-only transform robust to scaled/rotated ancestors: map two world
  // points through the inverse and subtract.
  const inv = parent.matrixWorld.clone().invert();
  const a = refPoint.clone().applyMatrix4(inv);
  const b = refPoint.clone().add(worldDelta).applyMatrix4(inv);
  return b.sub(a);
}

function dominantAxis(v) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax === 0 && ay === 0 && az === 0) return new THREE.Vector3(0, 1, 0);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x), 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(v.y), 0);
  return new THREE.Vector3(0, 0, Math.sign(v.z));
}

// The single all-encompassing root record, when the export has one.
export function rootWrapper(model) {
  return (model.rootRecs.length === 1 && model.rootRecs[0].children.length)
    ? model.rootRecs[0] : null;
}

// A single all-encompassing root record explodes its children instead.
export function topRecs(model) {
  const w = rootWrapper(model);
  return w ? w.children : model.rootRecs;
}

export function topAncestorOf(model, rec) {
  const tops = new Set(topRecs(model));
  for (let r = rec; r; r = r.parent) if (tops.has(r)) return r;
  return null;
}

// Assembly-mode resolution: the ancestor of rec one level below stopRec (the
// open subassembly — or the all-encompassing root when unscoped). A rec that
// sits directly under stopRec, or outside its subtree entirely (an ancestor
// grouping node's own geometry), resolves to itself.
export function levelTargetOf(model, rec, stopRec) {
  const stop = stopRec || rootWrapper(model);
  if (stop) {
    let inside = false;
    for (let a = rec; a; a = a.parent) if (a === stop) { inside = true; break; }
    if (!inside || rec === stop) return rec;
  }
  let r = rec;
  while (r.parent && r.parent !== stop) r = r.parent;
  return r;
}

// The selected record whose subtree contains rec (rec itself counts), or
// null. Lets a click or drag on one part act on its selected subassembly.
export function selectedAncestorOf(selectedIds, rec) {
  for (let a = rec; a; a = a.parent) if (selectedIds.has(a.id)) return a;
  return null;
}

// SolidWorks instance suffixes read badly raw: "CARRIAGE-2" -> "CARRIAGE #2".
export function instanceLabel(name) {
  const m = /^(.*?)-(\d+)$/.exec(name || '');
  return m ? m[1] + ' #' + m[2] : (name || '');
}

function smallestExtentAxis(model) {
  const s = model.bounds.isEmpty() ? null : model.bounds.getSize(new THREE.Vector3());
  if (!s) return null;
  return [['x', s.x], ['y', s.y], ['z', s.z]].sort((a, b) => a[1] - b[1]);
}

export function defaultExplodeMode(model) {
  const ext = smallestExtentAxis(model);
  if (!ext) return 'radial';
  // Plate-shaped assemblies explode along the plate normal (the smallest
  // extent); near-isotropic ones explode radially.
  return ext[0][1] * 1.4 >= ext[2][1] ? 'radial' : ext[0][0];
}

// Default radial plane = the plane OF the plate: its normal is the assembly's
// smallest-extent axis.
export function defaultExplodePlane(model) {
  const ext = smallestExtentAxis(model);
  if (!ext) return 'free';
  return { x: 'yz', y: 'xz', z: 'xy' }[ext[0][0]];
}

const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
const PLANES = {
  xy: { normal: AXES.z, u: AXES.x, v: AXES.y },
  yz: { normal: AXES.x, u: AXES.y, v: AXES.z },
  xz: { normal: AXES.y, u: AXES.x, v: AXES.z },
};
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// cfg: { anchorRecId, mode: 'radial'|'x'|'y'|'z', plane: 'xy'|'yz'|'xz'|'free',
// spread: 'both'|'one', internal: 'none'|'light'|'full', sequenced: bool } —
// null cfg / null fields use computed defaults. The anchor instance (default:
// largest bounding volume, usually the base plate) never moves. scopeAnchor:
// explode WITHIN that open subassembly (its children become the moving units)
// instead of the assembly's top level. isHidden: effective-visibility
// predicate (rec) => bool — computed from selection state, NOT object.visible,
// because event handlers may run before updateVisuals has repainted the flags.
export function computeExplodeVectors(model, cfg, scopeAnchor = null, isHidden = null) {
  const mode = (cfg && cfg.mode) || model.defaultExplodeMode || 'radial';
  const spread = (cfg && cfg.spread) || 'both';
  const planeName = (cfg && cfg.plane) || model.defaultExplodePlane || 'free';
  const internalFactor = { none: 0, light: 0.4, full: 1 }[(cfg && cfg.internal) || 'light'];
  const hidden = isHidden || (() => false);
  const diag = model.diagLen;

  // Centers must be measured at home positions.
  const f = model.explodeF;
  if (f) applyPositions(model, 0);

  const box = new THREE.Box3();
  const info = [];
  // Units the user cannot see sit the explode out: hidden parts used to fly
  // invisibly, skew the distance normalization, and even win the auto-anchor
  // pick.
  const units = scopeAnchor ? scopeAnchor.children : topRecs(model);
  for (const rec of units) {
    if (hidden(rec)) continue;
    box.setFromObject(rec.object);
    if (box.isEmpty()) continue;
    const size = box.getSize(new THREE.Vector3());
    info.push({
      rec,
      center: box.getCenter(new THREE.Vector3()),
      volume: Math.max(size.x * size.y * size.z, 1e-12),
    });
  }
  if (!info.length) {
    // Nothing visible to explode (a leaf scope, everything hidden): keep the
    // previous vectors and sequencing rather than silently wiping an active
    // explode out from under the slider.
    if (f) applyPositions(model, f);
    return;
  }
  for (const rec of model.records) rec.explodeVec.set(0, 0, 0);

  let anchorInfo = null;
  if (cfg && cfg.anchorRecId != null && model.records[cfg.anchorRecId]) {
    // The unit containing the picked anchor — works for scoped units too,
    // where the old "top ancestor" resolution would overshoot the scope.
    const target = model.records[cfg.anchorRecId];
    anchorInfo = info.find((i) => {
      for (let a = target; a; a = a.parent) if (a === i.rec) return true;
      return false;
    }) || null;
  }
  if (!anchorInfo) anchorInfo = info.reduce((a, b) => (b.volume > a.volume ? b : a));
  const aCenter = anchorInfo.center;
  const others = info.filter((i) => i !== anchorInfo);

  const setVec = (rec, worldDisp, refPoint) => {
    rec.explodeVec.copy(worldDeltaToLocal(rec.object.parent, worldDisp, refPoint));
  };

  if (mode === 'radial') {
    const plane = PLANES[planeName] || null; // 'free' -> spherical
    let maxDist = 1e-9;
    for (const i of others) maxDist = Math.max(maxDist, i.center.distanceTo(aCenter));
    others.forEach((i, idx) => {
      const dist = i.center.distanceTo(aCenter);
      let dir = i.center.clone().sub(aCenter);
      if (plane) dir.addScaledVector(plane.normal, -dir.dot(plane.normal)); // project onto plane
      if (dir.length() < diag * 1e-4) {
        // Parts stacked on the anchor's normal axis fan out deterministically
        // instead of all collapsing onto one ray.
        dir = plane
          ? plane.u.clone().multiplyScalar(Math.cos(idx * GOLDEN_ANGLE))
              .addScaledVector(plane.v, Math.sin(idx * GOLDEN_ANGLE))
          : dominantAxis(i.rec.homePos);
      }
      dir.normalize().multiplyScalar((0.3 + dist / maxDist) * diag * 0.5);
      setVec(i.rec, dir, i.center);
    });
  } else {
    const axis = AXES[mode];
    if (spread === 'both') {
      const projA = aCenter.dot(axis);
      let maxAbs = 1e-9;
      for (const i of others) maxAbs = Math.max(maxAbs, Math.abs(i.center.dot(axis) - projA));
      const k = (diag * 0.6) / maxAbs;
      for (const i of others) {
        setVec(i.rec, axis.clone().multiplyScalar((i.center.dot(axis) - projA) * k), i.center);
      }
    } else {
      // One direction: lift everything off the anchor along +axis, spaced by
      // projection rank so the existing stacking order is preserved.
      const ranked = [...others].sort((p, q) => p.center.dot(axis) - q.center.dot(axis));
      const spacing = (diag * 0.6) / Math.max(1, ranked.length);
      ranked.forEach((i, idx) => {
        setVec(i.rec, axis.clone().multiplyScalar((idx + 1) * spacing), i.center);
      });
    }
  }

  // Nested subassemblies open up internally by a controllable amount ('none'
  // keeps them rigid, 'light' is the classic hint, 'full' spreads them like
  // a real explode); the anchor subtree always stays fully rigid.
  if (internalFactor > 0) {
    const assignInternal = (rec, origin, depth) => {
      box.setFromObject(rec.object);
      if (box.isEmpty()) return;
      const c = box.getCenter(new THREE.Vector3());
      if (depth > 0) {
        let dir = c.clone().sub(origin);
        if (dir.length() < diag * 1e-4) dir = dominantAxis(rec.homePos);
        dir.normalize().multiplyScalar(internalFactor * diag * 0.6 * Math.pow(0.5, depth));
        rec.explodeVec.add(worldDeltaToLocal(rec.object.parent, dir, c));
      }
      for (const child of rec.children) assignInternal(child, c, depth + 1);
    };
    for (const i of others) assignInternal(i.rec, i.center, 0);
  }

  // Sequenced fly-out: each moving unit owns a window of the slider range,
  // farthest-flying first, so scrubbing (or the Apply tween) plays the
  // assembly apart one unit at a time. seqT is the window's start, inherited
  // by the unit's whole subtree so internal spread rides along.
  model.explodeSeq = !!(cfg && cfg.sequenced);
  for (const rec of model.records) rec.seqT = 0;
  if (model.explodeSeq && others.length) {
    const ranked = [...others].sort(
      (a, b) => b.rec.explodeVec.lengthSq() - a.rec.explodeVec.lengthSq());
    ranked.forEach((i, idx) => {
      const t = idx / ranked.length;
      for (const r of subtree(i.rec)) r.seqT = t;
    });
  }

  model.explodeAnchorId = anchorInfo.rec.id;
  if (f) applyPositions(model, f);
}

const easeExplode = (f) => f * (2 - f);

export function isIdentityQuat(q) {
  return q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1;
}

// flags.moved is the cheap "this part is displaced" bit the footer, context
// menu and measure staleness all read; rotation counts as moved.
export function refreshMovedFlag(rec) {
  rec.flags.moved = rec.dragDelta.lengthSq() > 0 || !isIdentityQuat(rec.dragQuat);
}

// Each unit's share of the slider range in sequenced mode; windows overlap
// so the play-out flows instead of stuttering.
const SEQ_WINDOW = 0.45;

// Whether the explode is actually displacing this record right now — in
// sequenced mode a unit whose window hasn't started yet is bit-exactly at
// home, so measurements on it are still valid.
export function explodeEngaged(model, rec) {
  if (rec.explodeVec.lengthSq() === 0) return false;
  const fc = Math.max(0, Math.min(1, model.explodeF));
  if (fc <= 0) return false;
  if (!model.explodeSeq) return true;
  return (fc - rec.seqT * (1 - SEQ_WINDOW)) / SEQ_WINDOW > 0;
}

// World bounds of everything effectively visible (hide flags + scope +
// facet filter, resolved from selection state so it is correct even before
// updateVisuals repaints object.visible). Empty box when nothing shows.
export function visibleBounds(model, scope, filter) {
  const box = new THREE.Box3();
  const one = new THREE.Box3();
  for (const rec of model.records) {
    if (!rec.meshes.length || isEffectivelyHidden(rec, scope, filter)) continue;
    for (const mesh of rec.meshes) {
      if (!mesh.geometry) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      one.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      box.union(one);
    }
  }
  return box;
}

export function applyPositions(model, f) {
  model.explodeF = f;
  const fc = Math.max(0, Math.min(1, f));
  const eGlobal = easeExplode(fc);
  const seq = !!model.explodeSeq;
  for (const rec of model.records) {
    const rotated = !isIdentityQuat(rec.dragQuat);
    if (rec.explodeVec.lengthSq() === 0 && rec.dragDelta.lengthSq() === 0
        && !rotated && !rec.flags.moved) continue;
    const e = seq
      ? easeExplode(Math.max(0, Math.min(1, (fc - rec.seqT * (1 - SEQ_WINDOW)) / SEQ_WINDOW)))
      : eGlobal;
    rec.object.position.copy(rec.homePos)
      .addScaledVector(rec.explodeVec, e)
      .add(rec.dragDelta);
    // copy() restores homeQuat bit-exactly at rest — measure's poseMoved
    // compares matrix floats with !==, so the home pose must be identical.
    rec.object.quaternion.copy(rec.homeQuat);
    if (rotated) rec.object.quaternion.premultiply(rec.dragQuat);
  }
  model.root.updateMatrixWorld(true);
}

// Rotate a record rigidly about a world-space pivot. The orientation offset
// and the position swing both land in dragQuat/dragDelta, so explode
// composition, snap back and reset keep working unchanged. start is the
// drag-start snapshot { delta, quat, worldPos }. Assumes rigid (unscaled)
// ancestor transforms — true for BomDom's own exports; a scaled foreign GLB
// would swing about a slightly wrong pivot, nothing worse.
const _rwq = new THREE.Quaternion();
const _rwqInv = new THREE.Quaternion();
const _rwqLocal = new THREE.Quaternion();
const _rwSwing = new THREE.Vector3();
export function applyWorldRotation(rec, qWorld, pivot, start) {
  const parent = rec.object.parent;
  parent.getWorldQuaternion(_rwq);
  _rwqInv.copy(_rwq).invert();
  // The world rotation expressed in the parent's frame: Qp⁻¹ · qw · Qp.
  _rwqLocal.copy(_rwqInv).multiply(qWorld).multiply(_rwq);
  rec.dragQuat.copy(_rwqLocal).multiply(start.quat);
  _rwSwing.copy(start.worldPos).sub(pivot).applyQuaternion(qWorld)
    .add(pivot).sub(start.worldPos);
  rec.dragDelta.copy(start.delta)
    .add(worldDeltaToLocal(parent, _rwSwing, start.worldPos));
  // moved stays true for the WHOLE gesture — applyPositions must keep writing
  // this record even when a snapped drag passes back through exactly zero
  // (skipping there would leave the previous frame's pose on screen). The
  // gesture's owner re-runs refreshMovedFlag when the pointer comes to rest.
  rec.flags.moved = true;
}

// ---------------------------------------------------------------------------
// Appearance: derived-material cache + one DFS that resolves every mesh
// ---------------------------------------------------------------------------

const HL_NONE = 0, HL_SELECTED = 1, HL_HOVER = 2;
const matCache = new Map();

function derive(base, ghost, opacity, highlight, ds, tint = null) {
  if (!base) return base;
  if (!ghost && opacity >= 1 && highlight === HL_NONE && !ds && tint === null) return base;
  const key = `${base.uuid}|${ghost ? 'g' : 'o' + opacity}|h${highlight}|${ds ? 'd' : ''}|t${tint === null ? '' : tint}`;
  let m = matCache.get(key);
  if (!m) {
    m = base.clone();
    if (ds) m.side = THREE.DoubleSide;
    // Color-by-property tint replaces the albedo; the base material is never
    // mutated, so clearing color-by restores the part's own appearance.
    if (tint !== null && m.color) m.color = new THREE.Color(tint);
    if (ghost) {
      m.transparent = true;
      m.opacity = 0.15;
      m.depthWrite = false;
    } else if (opacity < 1) {
      m.transparent = true;
      m.opacity = opacity;
      m.depthWrite = opacity > 0.4;
    }
    if (highlight !== HL_NONE && m.emissive !== undefined) {
      // Tinting the albedo is what actually reads on bright parts under
      // either tone mapping; emissive alone washes out. Selected > hover.
      const accent = new THREE.Color(0x2b9187);
      if (m.color) m.color = m.color.clone().lerp(accent, highlight === HL_SELECTED ? 0.65 : 0.45);
      m.emissive = accent;
      m.emissiveIntensity = highlight === HL_SELECTED ? 0.5 : 0.3;
    }
    matCache.set(key, m);
  }
  return m;
}

// Highlight veil: an overlay child mesh (same geometry, identity local
// transform) drawn over everything with depthTest off — selection stays
// readable regardless of part color and shows through occluders.
const overlayCache = new WeakMap(); // mesh -> overlay Mesh
const overlayMatHover = new THREE.MeshBasicMaterial({
  color: 0x2b9187,
  transparent: true,
  opacity: 0.15,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide, // mirrored instances flip winding
});
const overlayMatSelected = overlayMatHover.clone();
overlayMatSelected.opacity = 0.3;

function setOverlay(mesh, hl) {
  let ov = overlayCache.get(mesh);
  if (hl === HL_NONE) {
    if (ov) ov.visible = false;
    return;
  }
  if (!ov) {
    ov = new THREE.Mesh(mesh.geometry, overlayMatHover); // shared geometry reference
    ov.raycast = () => {}; // picking must ignore the veil
    ov.renderOrder = 999;
    ov.matrixAutoUpdate = false; // identity local transform — rides the mesh
    mesh.add(ov);
    overlayCache.set(mesh, ov);
  }
  ov.material = hl === HL_HOVER ? overlayMatHover : overlayMatSelected;
  ov.visible = true;
}

// ---------------------------------------------------------------------------
// Part edges: one EdgesGeometry per unique BufferGeometry, drawn as a
// LineSegments child of every instance mesh (identity local transform rides
// the mesh, like the veil). Geometries build lazily after the BVH.
// ---------------------------------------------------------------------------

// EdgesGeometry's angle test is inclusive, and coarse SolidWorks tessellation
// emits 12-segment cylinders whose facets meet at exactly 30° — a 30°
// threshold would draw those as wireframe barrels. 40° still catches ≥45°
// feature breaks (chamfers, box corners, hole rims).
const EDGE_THRESHOLD_DEG = 40;
// One EdgesGeometry build cannot be time-sliced internally, and its string-
// hashed edge dictionary costs seconds + hundreds of MB transient on very
// large geometries. Those few lose their edges rather than hitch the page.
const EDGE_MAX_TRIS = 250000;

const edgeGeomCache = new WeakMap(); // source BufferGeometry -> EdgesGeometry (shared across instances)
const edgeLineCache = new WeakMap(); // mesh -> LineSegments child
// toneMapped false: the CSS-picked colour must survive ACES tone mapping.
const edgeMat = new THREE.LineBasicMaterial({ color: 0x38404c, toneMapped: false });

// Mirrors scene.js's theme-reactive background: --edge3d tracks data-theme.
export function initEdgeColor(invalidate) {
  const apply = () => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--edge3d').trim();
    if (c) edgeMat.color.set(c);
    invalidate();
  };
  apply();
  new MutationObserver(apply)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function setEdgeLines(mesh, on) {
  let lines = edgeLineCache.get(mesh);
  if (!on) {
    if (lines) lines.visible = false;
    return;
  }
  if (!lines) {
    const eg = edgeGeomCache.get(mesh.geometry);
    if (!eg) return; // not built (yet) — a later 'appearance' refresh attaches it
    lines = new THREE.LineSegments(eg, edgeMat);
    lines.raycast = () => {}; // picking must ignore edges
    lines.matrixAutoUpdate = false; // identity local transform — rides the mesh
    mesh.add(lines);
    edgeLineCache.set(mesh, lines);
  }
  lines.visible = true;
}

// The measure tool snaps to these CAD-meaningful feature edges; null until
// the lazy edges build reaches this geometry (or if it was skipped for size).
export function edgeGeometryFor(geometry) {
  return edgeGeomCache.get(geometry) || null;
}

function countMeshRecs(rec) {
  let n = rec.meshes.length ? 1 : 0;
  for (const c of rec.children) n += countMeshRecs(c);
  return n;
}

export function updateVisuals(model, sel) {
  const hoverSet = new Set(sel.hover ? sel.hover.ids : []);
  const selSet = sel.selected;
  const scopeSet = sel.scope ? sel.scope.recIds : null;
  // Facet filter: parts outside the matching set are ghosted (context kept)
  // or hidden, per the filter's hide flag. Scope stays the stronger cut.
  const filterIds = sel.filter ? sel.filter.recIds : null;
  const filterHide = !!(sel.filter && sel.filter.hide);
  const recColor = sel.colorBy ? sel.colorBy.recColor : null;
  const pickables = [];
  let hiddenInstances = 0;

  const dfs = (rec, inhGhost, inhOpacity, inhHover, inhSel) => {
    const f = rec.flags;
    const outsideFilter = filterIds !== null && !filterIds.has(rec.id);
    const hidden = f.hidden || (scopeSet !== null && !scopeSet.has(rec.id))
      || (filterHide && outsideFilter);
    rec.object.visible = !hidden;
    if (hidden) {
      hiddenInstances += countMeshRecs(rec);
      return;
    }
    const ghost = inhGhost || f.ghost || (!filterHide && outsideFilter);
    const opacity = Math.min(inhOpacity, f.opacity);
    const hovered = inhHover || hoverSet.has(rec.id);
    const selected = inhSel || selSet.has(rec.id);
    const hl = hovered ? HL_HOVER : selected ? HL_SELECTED : HL_NONE;
    const tint = recColor ? (recColor.has(rec.id) ? recColor.get(rec.id) : null) : null;
    for (const mesh of rec.meshes) {
      if (mesh.userData.__base) {
        // forceDoubleSide: the section view clips closed solids open — back
        // faces stand in for the missing cap so interiors don't vanish.
        const ds = !!mesh.userData.__ds || !!model.forceDoubleSide;
        mesh.material = derive(mesh.userData.__base, ghost, opacity, hl, ds, tint);
      }
      setOverlay(mesh, hl);
      // Ghosted context would defeat its purpose under full-strength edges;
      // the 0.4 cutoff tracks the depthWrite threshold in derive().
      setEdgeLines(mesh, !!model.edgesOn && !ghost && opacity > 0.4);
      if (!ghost) pickables.push(mesh);
    }
    for (const c of rec.children) dfs(c, ghost, opacity, hovered, selected);
  };
  for (const rec of model.rootRecs) dfs(rec, false, 1, false, false);
  model.pickables = pickables;
  model.hiddenInstances = hiddenInstances;
}

// ---------------------------------------------------------------------------
// Record set helpers + ops
// ---------------------------------------------------------------------------

export function subtree(rec) {
  const out = [rec];
  for (const c of rec.children) out.push(...subtree(c));
  return out;
}

export function allInstances(model, rec) {
  if (rec.partId !== null && model.byPartId.has(rec.partId)) return model.byPartId.get(rec.partId);
  return [rec];
}

export function scopeSetFor(recs) {
  const ids = new Set();
  for (const r of recs) {
    for (const s of subtree(r)) ids.add(s.id);
    for (let a = r.parent; a; a = a.parent) ids.add(a.id);
  }
  return ids;
}

export function isEffectivelyHidden(rec, scope, filter) {
  const scopeSet = scope ? scope.recIds : null;
  // Only a hiding filter affects visibility; a ghosting filter keeps parts
  // visible (and exportable), matching how manual ghosting behaves.
  const filterIds = filter && filter.hide && filter.recIds ? filter.recIds : null;
  for (let r = rec; r; r = r.parent) {
    if (r.flags.hidden) return true;
    if (scopeSet !== null && !scopeSet.has(r.id)) return true;
    if (filterIds !== null && !filterIds.has(r.id)) return true;
  }
  return false;
}

export function boxOfRecs(recs) {
  const box = new THREE.Box3();
  const one = new THREE.Box3();
  for (const rec of recs) {
    one.setFromObject(rec.object);
    if (!one.isEmpty()) box.union(one);
  }
  return box;
}

// World-space corners of every visible mesh's own bounding box: a tight point
// cloud for silhouette framing (the aggregate box's corners are empty air on
// elongated assemblies).
export function pointsOfRecs(recs) {
  const pts = [];
  const walk = (obj) => {
    if (!obj.visible) return;
    if (obj.isMesh && obj.geometry) {
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      const b = obj.geometry.boundingBox;
      for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) for (let iz = 0; iz < 2; iz++) {
        pts.push(new THREE.Vector3(ix ? b.max.x : b.min.x,
                                   iy ? b.max.y : b.min.y,
                                   iz ? b.max.z : b.min.z).applyMatrix4(obj.matrixWorld));
      }
    }
    for (const c of obj.children) walk(c);
  };
  for (const rec of recs) walk(rec.object);
  return pts;
}

// World center of a record's own meshes' combined box (marquee hit point).
export function recWorldCenter(rec) {
  const box = new THREE.Box3();
  const one = new THREE.Box3();
  for (const mesh of rec.meshes) {
    if (!mesh.geometry) continue;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    one.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    box.union(one);
  }
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

export function setHidden(recs, hidden) {
  for (const rec of recs) rec.flags.hidden = hidden;
}

export function setGhost(recs, ghost) {
  for (const rec of recs) {
    rec.flags.ghost = ghost;
    if (ghost) rec.flags.hidden = false;
  }
}

export function cycleOpacity(recs) {
  const cur = recs[0] ? recs[0].flags.opacity : 1;
  const next = cur >= 1 ? 0.5 : cur > 0.2 ? 0.15 : 1;
  for (const rec of recs) {
    rec.flags.opacity = next;
    rec.flags.ghost = false;
  }
  return next;
}

export function isolate(model, keepRecs, ghostRest) {
  const keep = scopeSetFor(keepRecs);
  for (const rec of model.records) {
    if (keep.has(rec.id)) {
      rec.flags.hidden = false;
      rec.flags.ghost = false;
    } else if (ghostRest) {
      rec.flags.ghost = true;
      rec.flags.hidden = false;
    } else {
      rec.flags.hidden = true;
    }
  }
}

export function resetAppearance(model) {
  for (const rec of model.records) {
    rec.flags.hidden = false;
    rec.flags.ghost = false;
    rec.flags.opacity = 1;
  }
}

const IDENTITY_QUAT = new THREE.Quaternion(); // read-only slerp target

// A pose restore (saved views) must be able to orphan every in-flight
// snap-back tween — otherwise a reset started moments earlier keeps lerping
// dragDelta/dragQuat toward zero underneath the freshly restored pose.
export function cancelPoseTweens(model) {
  model.poseEpoch = (model.poseEpoch || 0) + 1;
}

export function snapBack(model, recs, addTween, onFrame, onDone) {
  const epoch = model.poseEpoch || 0;
  let i = 0;
  for (const rec of recs) {
    const rotated = !isIdentityQuat(rec.dragQuat);
    if (rec.dragDelta.lengthSq() === 0 && !rotated && !rec.flags.moved) continue;
    const from = rec.dragDelta.clone();
    const fromQuat = rotated ? rec.dragQuat.clone() : null;
    addTween({
      duration: 300,
      delay: i++ * 20, // staggered
      update: (k) => {
        if ((model.poseEpoch || 0) !== epoch) return; // orphaned by a restore
        rec.dragDelta.copy(from).multiplyScalar(1 - k);
        if (fromQuat) rec.dragQuat.copy(fromQuat).slerp(IDENTITY_QUAT, k);
        onFrame();
      },
      done: () => {
        if ((model.poseEpoch || 0) !== epoch) return;
        rec.dragDelta.set(0, 0, 0);
        rec.dragQuat.identity(); // exact — applyPositions then restores homeQuat bit-exactly
        rec.flags.moved = false;
        onFrame();
        if (onDone) onDone();
      },
    });
  }
  return i;
}

export function movedRecs(model) {
  return model.records.filter((r) =>
    r.flags.moved || r.dragDelta.lengthSq() > 0 || !isIdentityQuat(r.dragQuat));
}

// ---------------------------------------------------------------------------
// Lazy BVH: built in small time slices after first paint; raycasting works
// (slower) before it finishes because acceleratedRaycast falls back when a
// geometry has no boundsTree yet.
// ---------------------------------------------------------------------------

export function buildBVHLazily(model, onDone, isStale) {
  const geos = [...model.uniqueGeometries];
  let i = 0;
  const t0 = performance.now();
  const step = () => {
    // Model replaced (sidecar re-drop): stop, or the loop would rebuild
    // bounds trees on geometries disposeModel just freed.
    if (isStale && isStale()) return;
    const end = performance.now() + 12;
    while (i < geos.length && performance.now() < end) {
      const g = geos[i++];
      if (!g.boundsTree) {
        try { g.computeBoundsTree(); } catch (e) { console.warn('[BomDom] BVH build failed for a geometry', e); }
      }
    }
    if (i < geos.length) setTimeout(step, 0);
    else {
      model.bvhReady = true;
      timed('bvh build', performance.now() - t0);
      if (onDone) onDone();
    }
  };
  setTimeout(step, 60);
}

// Feature edges build the same way, chained after the BVH: they are cosmetic,
// so pick latency always comes first. Smallest geometries go first — a slice
// can only overrun inside one EdgesGeometry call, so any hitch lands last.
export function buildEdgesLazily(model, onProgress, isStale) {
  if (model.edgesBuildStarted) return;
  model.edgesBuildStarted = true;
  const triCount = (g) => Math.floor((g.index ? g.index.count
    : (g.attributes.position ? g.attributes.position.count : 0)) / 3);
  const geos = [...model.uniqueGeometries].sort((a, b) => triCount(a) - triCount(b));
  let i = 0;
  const t0 = performance.now();
  const step = () => {
    if (isStale && isStale()) return; // model was replaced (sidecar re-drop)
    const end = performance.now() + 12;
    while (i < geos.length && performance.now() < end) {
      const g = geos[i++];
      if (edgeGeomCache.has(g)) continue;
      if (triCount(g) > EDGE_MAX_TRIS) {
        note(`part edges skipped for one very large geometry (${triCount(g)} triangles)`);
        continue;
      }
      try { edgeGeomCache.set(g, new THREE.EdgesGeometry(g, EDGE_THRESHOLD_DEG)); }
      catch (e) { console.warn('[BomDom] edges build failed for a geometry', e); }
    }
    onProgress(); // 'appearance' refresh attaches whatever is ready
    if (i < geos.length) setTimeout(step, 0);
    else timed('edges build', performance.now() - t0);
  };
  setTimeout(step, 0);
}
