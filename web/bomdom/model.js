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
      dragDelta: new THREE.Vector3(),
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
  for (const [mesh, rec] of meshRecords) {
    mesh.userData.__base = Array.isArray(mesh.material) ? null : mesh.material;
    if (mesh.matrixWorld.determinant() < 0 ||
        (rec.nodeIdx !== null && mirroredIdx.has(rec.nodeIdx))) {
      mesh.userData.__ds = true;
    }
  }

  const rootRecs = records.filter((r) => !r.parent);
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

  const uniqueGeometries = new Set();
  let triangles = 0;
  for (const mesh of meshRecords.keys()) {
    uniqueGeometries.add(mesh.geometry);
    const g = mesh.geometry;
    triangles += Math.floor((g.index ? g.index.count
      : (g.attributes.position ? g.attributes.position.count : 0)) / 3);
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

// A single all-encompassing root record explodes its children instead.
export function topRecs(model) {
  return (model.rootRecs.length === 1 && model.rootRecs[0].children.length)
    ? model.rootRecs[0].children : model.rootRecs;
}

export function topAncestorOf(model, rec) {
  const tops = new Set(topRecs(model));
  for (let r = rec; r; r = r.parent) if (tops.has(r)) return r;
  return null;
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
// spread: 'both'|'one' } — null cfg / null fields use computed defaults. The
// anchor instance (default: largest bounding volume, usually the base plate)
// never moves.
export function computeExplodeVectors(model, cfg) {
  const mode = (cfg && cfg.mode) || model.defaultExplodeMode || 'radial';
  const spread = (cfg && cfg.spread) || 'both';
  const planeName = (cfg && cfg.plane) || model.defaultExplodePlane || 'free';
  const diag = model.diagLen;

  // Centers must be measured at home positions.
  const f = model.explodeF;
  if (f) applyPositions(model, 0);
  for (const rec of model.records) rec.explodeVec.set(0, 0, 0);

  const box = new THREE.Box3();
  const info = [];
  for (const rec of topRecs(model)) {
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
    if (f) applyPositions(model, f);
    return;
  }

  let anchorInfo = null;
  if (cfg && cfg.anchorRecId != null && model.records[cfg.anchorRecId]) {
    const top = topAncestorOf(model, model.records[cfg.anchorRecId]);
    anchorInfo = info.find((i) => i.rec === top) || null;
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

  // Nested subassemblies keep a light internal radial spread; the anchor
  // subtree stays fully rigid.
  const assignInternal = (rec, origin, depth) => {
    box.setFromObject(rec.object);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    if (depth > 0) {
      let dir = c.clone().sub(origin);
      if (dir.length() < diag * 1e-4) dir = dominantAxis(rec.homePos);
      dir.normalize().multiplyScalar(0.4 * diag * 0.6 * Math.pow(0.5, depth));
      rec.explodeVec.add(worldDeltaToLocal(rec.object.parent, dir, c));
    }
    for (const child of rec.children) assignInternal(child, c, depth + 1);
  };
  for (const i of others) assignInternal(i.rec, i.center, 0);

  model.explodeAnchorId = anchorInfo.rec.id;
  if (f) applyPositions(model, f);
}

const easeExplode = (f) => f * (2 - f);

export function applyPositions(model, f) {
  model.explodeF = f;
  const e = easeExplode(Math.max(0, Math.min(1, f)));
  for (const rec of model.records) {
    if (rec.explodeVec.lengthSq() === 0 && rec.dragDelta.lengthSq() === 0 && !rec.flags.moved) continue;
    rec.object.position.copy(rec.homePos)
      .addScaledVector(rec.explodeVec, e)
      .add(rec.dragDelta);
  }
  model.root.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// Appearance: derived-material cache + one DFS that resolves every mesh
// ---------------------------------------------------------------------------

const HL_NONE = 0, HL_SELECTED = 1, HL_HOVER = 2;
const matCache = new Map();

function derive(base, ghost, opacity, highlight, ds) {
  if (!base) return base;
  if (!ghost && opacity >= 1 && highlight === HL_NONE && !ds) return base;
  const key = `${base.uuid}|${ghost ? 'g' : 'o' + opacity}|h${highlight}|${ds ? 'd' : ''}`;
  let m = matCache.get(key);
  if (!m) {
    m = base.clone();
    if (ds) m.side = THREE.DoubleSide;
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
      // Tinting the albedo is what actually reads under ACES tone mapping on
      // bright parts; emissive alone washes out. Selected > hover.
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

function countMeshRecs(rec) {
  let n = rec.meshes.length ? 1 : 0;
  for (const c of rec.children) n += countMeshRecs(c);
  return n;
}

export function updateVisuals(model, sel) {
  const hoverSet = new Set(sel.hover ? sel.hover.ids : []);
  const selSet = sel.selected;
  const scopeSet = sel.scope ? sel.scope.recIds : null;
  const pickables = [];
  let hiddenInstances = 0;

  const dfs = (rec, inhGhost, inhOpacity, inhHover, inhSel) => {
    const f = rec.flags;
    const hidden = f.hidden || (scopeSet !== null && !scopeSet.has(rec.id));
    rec.object.visible = !hidden;
    if (hidden) {
      hiddenInstances += countMeshRecs(rec);
      return;
    }
    const ghost = inhGhost || f.ghost;
    const opacity = Math.min(inhOpacity, f.opacity);
    const hovered = inhHover || hoverSet.has(rec.id);
    const selected = inhSel || selSet.has(rec.id);
    const hl = hovered ? HL_HOVER : selected ? HL_SELECTED : HL_NONE;
    for (const mesh of rec.meshes) {
      if (mesh.userData.__base) {
        mesh.material = derive(mesh.userData.__base, ghost, opacity, hl, !!mesh.userData.__ds);
      }
      setOverlay(mesh, hl);
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

export function isEffectivelyHidden(rec, scope) {
  const scopeSet = scope ? scope.recIds : null;
  for (let r = rec; r; r = r.parent) {
    if (r.flags.hidden) return true;
    if (scopeSet !== null && !scopeSet.has(r.id)) return true;
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

export function snapBack(model, recs, addTween, onFrame, onDone) {
  let i = 0;
  for (const rec of recs) {
    if (rec.dragDelta.lengthSq() === 0 && !rec.flags.moved) continue;
    const from = rec.dragDelta.clone();
    addTween({
      duration: 300,
      delay: i++ * 20, // staggered
      update: (k) => {
        rec.dragDelta.copy(from).multiplyScalar(1 - k);
        onFrame();
      },
      done: () => {
        rec.dragDelta.set(0, 0, 0);
        rec.flags.moved = false;
        onFrame();
        if (onDone) onDone();
      },
    });
  }
  return i;
}

export function movedRecs(model) {
  return model.records.filter((r) => r.flags.moved || r.dragDelta.lengthSq() > 0);
}

// ---------------------------------------------------------------------------
// Lazy BVH: built in small time slices after first paint; raycasting works
// (slower) before it finishes because acceleratedRaycast falls back when a
// geometry has no boundsTree yet.
// ---------------------------------------------------------------------------

export function buildBVHLazily(model) {
  const geos = [...model.uniqueGeometries];
  let i = 0;
  const t0 = performance.now();
  const step = () => {
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
    }
  };
  setTimeout(step, 60);
}
