// Measure tool: two-click distances with snapping and entity fitting.
//
// Accuracy model (verified against real exports offline): SolidWorks
// tessellation vertices lie exactly ON the CAD B-rep surface, and Draco
// quantization puts them on a grid of (part extent)/16383 (~µm). So:
//   - vertex snaps are exact to quantization,
//   - circles/planes/cylinders FITTED through vertices recover true CAD
//     dimensions (hole Ø, face-to-face) to the same order,
//   - a raw pick on a curved facet interior is the only approximate case
//     (chord error), and gets labelled that way.
// Every readout carries a ± estimate derived from the per-part quantization
// step; displayed precision never exceeds it.

import * as THREE from 'three';
import * as M from './model.js';
import {
  fitPlane, fitCircle3D, fitLine3D, fitCylinder,
  lineLineClosest, distPointSegment, segSegClosest,
  planeCircleMinMax, parallelWallMinMax,
} from './fitmath.js';

const $ = (id) => document.getElementById(id);

const UNITS_KEY = 'picturebom-bomdom-units'; // reader preference, like edges
const XYZ_KEY = 'picturebom-bomdom-xyz';     // ΔXYZ readout, same idea; missing -> off
const UNITS = {
  mm: { scale: 1000, suffix: 'mm', maxDec: 3 },
  cm: { scale: 100, suffix: 'cm', maxDec: 4 },
  m: { scale: 1, suffix: 'm', maxDec: 6 },
  in: { scale: 1000 / 25.4, suffix: 'in', maxDec: 4 },
};

const SNAP_PX = 12;             // screen-space snap radius
const QUANT_DIVISOR = 16383;    // 14-bit Draco position grid (measured)
const TESS_ALLOWANCE = 20e-6;   // facet-interior chord allowance (measured ~10 µm)
const FIT_MAX_TRIS = 150000;    // beyond this, face clicks stay plain points
const SOUP_FIT_MAX_TRIS = 60000; // non-indexed adjacency needs position hashing
const CHAIN_MAX = 1024;         // edge-chain walk cap
const PLANE_MAX_TRIS = 8000;    // region-grow caps
const CYL_MAX_TRIS = 30000;

// Snap-tier marker colours (fixed: drawn over the 3D canvas, not themed UI).
const COLOR_EXACT = 0x2b9187;   // vertex / fitted entity
const COLOR_EDGE = 0x3a72d4;
const COLOR_APPROX = 0xc9a227;  // facet-interior pick

export function initMeasure(app) {
  const canvas = $('gl');

  const st = {
    on: false,
    unit: readUnit(),
    xyz: readXyz(),         // show per-axis ΔX/ΔY/ΔZ components
    pending: null,          // first committed entity of the in-progress pair
    hover: null,            // latest snap under the cursor
    measurements: [],
    nextId: 1,
  };

  const invalidate = () => { if (app.viewer) app.viewer.invalidate(); };

  // ---- units ------------------------------------------------------------
  function readUnit() {
    try {
      const u = localStorage.getItem(UNITS_KEY);
      return UNITS[u] ? u : 'mm';
    } catch { return 'mm'; }
  }
  function storeUnit(u) {
    try { localStorage.setItem(UNITS_KEY, u); } catch { /* ignore */ }
  }
  function readXyz() {
    try { return localStorage.getItem(XYZ_KEY) === 'on'; } catch { return false; }
  }
  function storeXyz(on) {
    try { localStorage.setItem(XYZ_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  }

  // Value + error (meters) -> display string. The last displayed digit is
  // never finer than the error estimate.
  function fmt(valM, errM) {
    const u = UNITS[st.unit];
    const v = valM * u.scale;
    const e = Math.abs(errM) * u.scale;
    let dec = u.maxDec;
    if (e > 0) dec = Math.max(0, Math.min(u.maxDec, Math.ceil(-Math.log10(e))));
    return `${v.toFixed(dec)} ${u.suffix}`;
  }
  function fmtErr(errM) {
    const u = UNITS[st.unit];
    return `±${(errM * u.scale).toPrecision(1)} ${u.suffix}`;
  }

  // ---- accuracy ----------------------------------------------------------
  // Per-geometry quantization step from the trusted (recomputed) bounds.
  function quantStep(g) {
    if (g.userData.__qstep === undefined) {
      if (!g.boundingBox) g.computeBoundingBox();
      const s = g.boundingBox.getSize(new THREE.Vector3());
      g.userData.__qstep = Math.max(s.x, s.y, s.z) / QUANT_DIVISOR;
    }
    return g.userData.__qstep;
  }
  const SQRT3 = Math.sqrt(3);
  function entityErr(ent) {
    const step = ent.step || 0;
    // Fits average many exact-on-surface vertices: quantization mostly
    // cancels statistically, but selection systematics show up as rms.
    if (ent.fitRms !== undefined) return 2 * ent.fitRms + step;
    return SQRT3 * step + (ent.approx ? TESS_ALLOWANCE : 0);
  }

  // ---- displaced-part guard ----------------------------------------------
  // World coordinates only equal CAD coordinates while nothing is exploded
  // or drag-moved anywhere on the record's ancestor chain.
  function displaced(rec) {
    const f = app.model ? app.model.explodeF : 0;
    for (let r = rec; r; r = r.parent) {
      if (f > 0 && r.explodeVec.lengthSq() > 0) return true;
      if (r.dragDelta.lengthSq() > 0 || r.flags.moved) return true;
    }
    return false;
  }

  // Entities remember the exact world transform they were captured under;
  // any later movement (explode, drag) makes their stored world coordinates
  // wrong until the part returns to that exact pose (applyPositions restores
  // bit-identical floats at home).
  function snapshotPose(entity) {
    entity.pose = entity.mesh.matrixWorld.toArray();
    return entity;
  }
  function poseMoved(entity) {
    if (!entity.pose) return false;
    const e = entity.mesh.matrixWorld.elements;
    for (let i = 0; i < 16; i++) if (e[i] !== entity.pose[i]) return true;
    return false;
  }

  // Non-identity node scales never appear in BomDom's own exports, but a
  // hand-dropped foreign GLB can carry them — fitted radii/lengths are
  // geometry-local and must be scaled into world units (uniform scale only;
  // anisotropic scale bends circles into ellipses, so fitting bails).
  function worldScaleOf(mesh) {
    let ws = mesh.userData.__wscale;
    if (!ws) {
      const e = mesh.matrixWorld.elements;
      const sx = Math.hypot(e[0], e[1], e[2]);
      const sy = Math.hypot(e[4], e[5], e[6]);
      const sz = Math.hypot(e[8], e[9], e[10]);
      const mean = (sx + sy + sz) / 3;
      ws = { mean, aniso: (Math.max(sx, sy, sz) - Math.min(sx, sy, sz)) / (mean || 1) };
      mesh.userData.__wscale = ws;
    }
    return ws;
  }

  // =========================================================================
  // Geometry access: triangles, adjacency, edge chains
  // =========================================================================

  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

  function triCount(g) {
    return Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
  }
  function cornerIndex(g, t, k) {
    return g.index ? g.index.getX(t * 3 + k) : t * 3 + k;
  }
  function readVert(g, i, out) {
    return out.fromBufferAttribute(g.attributes.position, i);
  }
  function triNormal(g, t, out) {
    readVert(g, cornerIndex(g, t, 0), _a);
    readVert(g, cornerIndex(g, t, 1), _b);
    readVert(g, cornerIndex(g, t, 2), _c);
    return out.copy(_b).sub(_a).cross(_c.sub(_a)).normalize();
  }

  // Triangle adjacency by shared edge. Non-indexed geometries (the injected
  // surface meshes) are unified by exact position bits first — duplicated
  // coordinates come from the same source floats, so string keys match.
  const adjCache = new WeakMap();
  function adjacencyOf(g) {
    let adj = adjCache.get(g);
    if (adj !== undefined) return adj;
    const T = triCount(g);
    let uid; // corner -> unified vertex id
    if (g.index) {
      uid = (t, k) => g.index.getX(t * 3 + k);
    } else {
      const pos = g.attributes.position;
      const map = new Map();
      const ids = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        const key = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
        let id = map.get(key);
        if (id === undefined) { id = map.size; map.set(key, id); }
        ids[i] = id;
      }
      uid = (t, k) => ids[t * 3 + k];
    }
    const neighbors = new Int32Array(T * 3).fill(-1);
    const open = new Map(); // edge key -> encoded (tri*3 + side)
    for (let t = 0; t < T; t++) {
      for (let k = 0; k < 3; k++) {
        const i0 = uid(t, k), i1 = uid(t, (k + 1) % 3);
        const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
        const key = lo * 4294967296 + hi;
        const other = open.get(key);
        if (other === undefined) {
          open.set(key, t * 3 + k);
        } else {
          neighbors[t * 3 + k] = Math.floor(other / 3);
          neighbors[other] = t;
          open.delete(key);
        }
      }
    }
    adj = { neighbors };
    adjCache.set(g, adj);
    return adj;
  }

  // Feature-edge segment index for the shared EdgesGeometry: endpoint
  // connectivity so a snapped segment can be walked into its curve.
  const edgeIdxCache = new WeakMap();
  function edgeIndexOf(eg) {
    let idx = edgeIdxCache.get(eg);
    if (idx !== undefined) return idx;
    const pos = eg.attributes.position;
    const count = pos.count / 2;
    const conn = new Map(); // "x,y,z" -> segment indices
    const keyAt = (i) => `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
    for (let s = 0; s < count; s++) {
      for (const end of [s * 2, s * 2 + 1]) {
        const key = keyAt(end);
        let list = conn.get(key);
        if (!list) { list = []; conn.set(key, list); }
        list.push(s);
      }
    }
    idx = { pos, count, conn, keyAt };
    edgeIdxCache.set(eg, idx);
    return idx;
  }

  // Ordered vertex chain through the feature-edge graph, walked from a seed
  // segment in both directions until a corner/junction or loop closure.
  // seedIndex is where the CLICKED segment's first point landed after the
  // front-extension unshifts — window growth must start there, or a click on
  // an arc that tangentially joins a straight edge could grow from the
  // wrong end of the chain.
  function walkChain(eg, seedSeg) {
    const { pos, conn, keyAt } = edgeIndexOf(eg);
    const p = (i) => new THREE.Vector3().fromBufferAttribute(pos, i);
    const visited = new Set([seedSeg]);
    const pts = [p(seedSeg * 2), p(seedSeg * 2 + 1)];
    let frontAdded = 0;
    let closed = false;

    const extend = (endKeyIdx, pushFront) => {
      let endIdx = endKeyIdx;
      while (pts.length < CHAIN_MAX) {
        const key = keyAt(endIdx);
        const list = conn.get(key) || [];
        const next = list.filter((s) => !visited.has(s));
        if (list.length !== 2 || next.length !== 1) break; // corner / junction / done
        const s = next[0];
        visited.add(s);
        // The far endpoint of segment s (the one not matching `key`).
        const farIdx = keyAt(s * 2) === key ? s * 2 + 1 : s * 2;
        const fp = p(farIdx);
        // Loop closure: far point equals the opposite chain end.
        const opposite = pushFront ? pts[pts.length - 1] : pts[0];
        if (fp.distanceToSquared(opposite) === 0) { closed = true; break; }
        if (pushFront) { pts.unshift(fp); frontAdded++; } else pts.push(fp);
        endIdx = farIdx;
      }
    };
    extend(seedSeg * 2, true);       // walk out of endpoint A
    extend(seedSeg * 2 + 1, false);  // walk out of endpoint B
    return { pts, closed, seedIndex: frontAdded };
  }

  // Grow a window around the chain seed while the model (circle or line)
  // keeps fitting. Returns the best fit or null.
  function growAlongChain(pts, closed, fitFn, tol, seedIndex) {
    if (closed) {
      const fit = fitFn(pts);
      if (fit && fit.rms <= tol) return { fit, n: pts.length };
    }
    let lo = Math.max(0, Math.min(seedIndex || 0, pts.length - 2));
    let hi = Math.min(pts.length - 1, lo + 1);
    let win = pts.slice(lo, hi + 1);
    let best = null;
    let loOpen = true, hiOpen = true;
    while (loOpen || hiOpen) {
      let extended = false;
      if (hiOpen && hi < pts.length - 1) {
        const trial = pts.slice(lo, hi + 2);
        const fit = trial.length >= 3 ? fitFn(trial) : null;
        if (fit && fit.rms <= tol) { hi++; win = trial; best = fit; extended = true; }
        else hiOpen = false;
      } else hiOpen = false;
      if (loOpen && lo > 0) {
        const trial = pts.slice(lo - 1, hi + 1);
        const fit = trial.length >= 3 ? fitFn(trial) : null;
        if (fit && fit.rms <= tol) { lo--; win = trial; best = fit; extended = true; }
        else loOpen = false;
      } else loOpen = false;
      if (!extended && !loOpen && !hiOpen) break;
    }
    if (!best && win.length >= 2) {
      const fit = fitFn(win);
      if (fit && fit.rms <= tol) best = fit;
    }
    return best ? { fit: best, n: win.length } : null;
  }

  // =========================================================================
  // Entity classification
  // =========================================================================

  const _m4 = new THREE.Matrix4();

  function toWorldPoint(mesh, p) { return p.clone().applyMatrix4(mesh.matrixWorld); }
  function toWorldDir(mesh, d) { return d.clone().transformDirection(mesh.matrixWorld).normalize(); }

  // Edge snap -> circle (hole rim / arc), straight line, or exact point.
  function classifyEdge(snap) {
    const g = snap.mesh.geometry;
    const eg = M.edgeGeometryFor(g);
    if (!eg) return pointEntity(snap, false);
    const ws = worldScaleOf(snap.mesh);
    if (ws.aniso > 1e-3) return pointEntity(snap, false); // anisotropic scale bends circles
    const step = quantStep(g);
    const tol = Math.max(4 * step, 1e-6);
    const { pts, closed, seedIndex } = walkChain(eg, snap.edgeSeg);

    const circle = growAlongChain(pts, closed, fitCircle3D, tol, seedIndex);
    // Sanity guard compares in WORLD units: the fitted radius is mesh-local.
    if (circle && circle.n >= 6 && circle.fit.arcSpanRad >= 1.75
        && circle.fit.radius * ws.mean < (app.model ? app.model.diagLen : 1)) {
      const f = circle.fit;
      return snapshotPose({
        kind: 'circle', rec: snap.rec, mesh: snap.mesh, step: step * ws.mean,
        fitRms: f.rms * ws.mean,
        center: toWorldPoint(snap.mesh, f.center),
        normal: toWorldDir(snap.mesh, f.normal),
        radius: f.radius * ws.mean,
        point: toWorldPoint(snap.mesh, f.center),
        dia: { d: f.radius * 2 * ws.mean, err: (2 * f.rms + step) * ws.mean },
      });
    }
    const line = growAlongChain(pts, false, fitLine3D, tol, seedIndex);
    if (line && line.fit) {
      const f = line.fit;
      return snapshotPose({
        kind: 'line', rec: snap.rec, mesh: snap.mesh, step: step * ws.mean,
        fitRms: f.rms * ws.mean,
        linePoint: toWorldPoint(snap.mesh, f.point),
        lineDir: toWorldDir(snap.mesh, f.dir),
        length: f.length * ws.mean,
        lineT: [f.t0 * ws.mean, f.t1 * ws.mean], // world extent about linePoint
        point: snap.worldPoint.clone(),
        label: 'edge',
      });
    }
    return pointEntity(snap, false);
  }

  // Face pick -> plane, cylinder (bore/boss), or approximate point.
  function classifyFace(snap) {
    const g = snap.mesh.geometry;
    const tc = triCount(g);
    if (tc > FIT_MAX_TRIS || (!g.index && tc > SOUP_FIT_MAX_TRIS)
        || snap.faceIndex === undefined || snap.faceIndex === null) {
      return pointEntity(snap, true); // adjacency build would hitch the click
    }
    const ws = worldScaleOf(snap.mesh);
    if (ws.aniso > 1e-3) return pointEntity(snap, true);
    const step = quantStep(g);
    const adj = adjacencyOf(g);
    const seed = snap.faceIndex;
    const seedN = triNormal(g, seed, new THREE.Vector3());

    // 1-ring flatness decides which surface model to try first.
    const n2 = new THREE.Vector3();
    let flat = true;
    for (let k = 0; k < 3; k++) {
      const nb = adj.neighbors[seed * 3 + k];
      if (nb < 0) continue;
      if (triNormal(g, nb, n2).dot(seedN) < 0.99939) { flat = false; break; } // ~2°
    }

    if (flat) {
      const plane = growPlanarRegion(g, adj, seed, seedN, step);
      if (plane) {
        return snapshotPose({
          kind: 'plane', rec: snap.rec, mesh: snap.mesh, step: step * ws.mean,
          fitRms: plane.rms * ws.mean,
          planePoint: toWorldPoint(snap.mesh, plane.point),
          planeNormal: toWorldDir(snap.mesh, plane.normal),
          region: plane.region,
          point: snap.worldPoint.clone(),
          label: 'face',
        });
      }
    } else {
      const cyl = growCylindricalRegion(g, adj, seed, step);
      if (cyl) {
        const axisDir = toWorldDir(snap.mesh, cyl.axisDir);
        const axisPoint = toWorldPoint(snap.mesh, cyl.axisPoint);
        return snapshotPose({
          kind: 'cylinder', rec: snap.rec, mesh: snap.mesh, step: step * ws.mean,
          fitRms: cyl.rms * ws.mean,
          axisPoint, axisDir,
          radius: cyl.radius * ws.mean,
          axisT: [cyl.axisT[0] * ws.mean, cyl.axisT[1] * ws.mean],
          region: cyl.region,
          point: snap.worldPoint.clone(),
          dia: { d: cyl.radius * 2 * ws.mean, err: (2 * cyl.rms + step) * ws.mean },
        });
      }
    }
    return pointEntity(snap, true);
  }

  function pointEntity(snap, approx) {
    const ws = worldScaleOf(snap.mesh);
    return snapshotPose({
      kind: 'point', rec: snap.rec, mesh: snap.mesh,
      step: quantStep(snap.mesh.geometry) * ws.mean,
      approx: approx && snap.tier === 'face',
      point: snap.worldPoint.clone(),
      label: snap.tier === 'vertex' ? 'corner' : snap.tier === 'edge' ? 'edge point' : 'surface (approx)',
    });
  }

  function growPlanarRegion(g, adj, seed, seedN, step) {
    const tol = Math.max(4 * step, 1e-6);
    const seedPoint = readVert(g, cornerIndex(g, seed, 0), new THREE.Vector3()).clone();
    const visited = new Set([seed]);
    const queue = [seed];
    const pts = new Map(); // position index -> Vector3
    const n = new THREE.Vector3(), v = new THREE.Vector3();
    const takeVerts = (t) => {
      for (let k = 0; k < 3; k++) {
        const i = cornerIndex(g, t, k);
        if (!pts.has(i)) pts.set(i, readVert(g, i, new THREE.Vector3()).clone());
      }
    };
    takeVerts(seed);
    while (queue.length && visited.size < PLANE_MAX_TRIS) {
      const t = queue.pop();
      for (let k = 0; k < 3; k++) {
        const nb = adj.neighbors[t * 3 + k];
        if (nb < 0 || visited.has(nb)) continue;
        if (triNormal(g, nb, n).dot(seedN) < 0.9995) continue;
        let ok = true;
        for (let j = 0; j < 3; j++) {
          readVert(g, cornerIndex(g, nb, j), v);
          if (Math.abs(v.sub(seedPoint).dot(seedN)) > tol * 3) { ok = false; break; }
        }
        if (!ok) continue;
        visited.add(nb);
        queue.push(nb);
        takeVerts(nb);
      }
    }
    const fit = fitPlane([...pts.values()]);
    // region: the grown facet set — the hover preview fills it, and lets a
    // later pick anywhere on the same face reuse this classification.
    return fit && fit.rms <= tol ? { ...fit, region: visited } : null;
  }

  function growCylindricalRegion(g, adj, seed, step) {
    // Seed neighbourhood: adjacency rings around the picked facet, until the
    // patch is big enough to pin an axis (long-strip barrel tessellation
    // needs several rings to cover a usable arc).
    const seedSet = new Set([seed]);
    let frontier = [seed];
    for (let depth = 0; depth < 4 && seedSet.size < 48; depth++) {
      const next = [];
      for (const t of frontier) {
        for (let k = 0; k < 3; k++) {
          const nb = adj.neighbors[t * 3 + k];
          if (nb >= 0 && !seedSet.has(nb)) { seedSet.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    const fitOf = (set) => {
      const pts = new Map();
      const normals = [];
      for (const t of set) {
        normals.push(triNormal(g, t, new THREE.Vector3()).clone());
        for (let k = 0; k < 3; k++) {
          const i = cornerIndex(g, t, k);
          if (!pts.has(i)) pts.set(i, readVert(g, i, new THREE.Vector3()).clone());
        }
      }
      return { fit: fitCylinder([...pts.values()], normals), pts, normals };
    };
    let fit = fitOf(seedSet).fit;
    // Loose sanity only: the seed patch covers a small arc, so its radius and
    // axis are rough — the strict gate comes after the full grow.
    if (!fit || !(fit.radius > 0) || fit.rms > fit.radius * 0.08) return null;

    // Grow by surface criteria robust to a tilted seed axis: a facet belongs
    // to the same cylindrical face when its normal is perpendicular to the
    // axis and its vertices sit in a generous radial band. Two passes: the
    // second regrows from scratch with the refined axis.
    const rel = new THREE.Vector3();
    const n = new THREE.Vector3();
    const belongs = (t, f) => {
      if (Math.abs(triNormal(g, t, n).dot(f.axisDir)) > 0.09) return false; // > ~5°
      for (let k = 0; k < 3; k++) {
        readVert(g, cornerIndex(g, t, k), rel).sub(f.axisPoint);
        rel.addScaledVector(f.axisDir, -rel.dot(f.axisDir));
        if (Math.abs(rel.length() - f.radius) > f.radius * 0.25) return false;
      }
      return true;
    };
    let visited;
    for (let pass = 0; pass < 2; pass++) {
      visited = new Set(seedSet);
      frontier = [...seedSet];
      let sinceRefit = 0;
      while (frontier.length && visited.size < CYL_MAX_TRIS) {
        const t = frontier.pop();
        for (let k = 0; k < 3; k++) {
          const nb = adj.neighbors[t * 3 + k];
          if (nb < 0 || visited.has(nb)) continue;
          if (!belongs(nb, fit)) continue;
          visited.add(nb);
          frontier.push(nb);
          if (++sinceRefit >= 48) {
            sinceRefit = 0;
            const r = fitOf(visited).fit;
            if (r) fit = r;
          }
        }
      }
      const refined = fitOf(visited).fit;
      if (!refined) return null;
      fit = refined;
    }
    const tol = Math.max(6 * step, 3e-6, fit.radius * 1e-3);
    const final = fitOf(visited);
    if (!final.fit || final.fit.rms > tol) return null;
    fit = final.fit;

    // Robust trim: the grown region often borders a round-over whose first
    // vertex ring passes the loose gates (radius off by ~0.5%) and drags the
    // diameter low. The residuals are BIMODAL (barrel majority + ring
    // minority), so trim around the median with a MAD-scaled band — an
    // rms-scaled band can't separate the modes.
    let fitPts = [...final.pts.values()];
    const signedRes = (p, f) => {
      rel.copy(p).sub(f.axisPoint);
      rel.addScaledVector(f.axisDir, -rel.dot(f.axisDir));
      return rel.length() - f.radius;
    };
    for (let i = 0; i < 3; i++) {
      const res = fitPts.map((p) => signedRes(p, fit));
      const sorted = [...res].sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      const absDev = res.map((r) => Math.abs(r - med)).sort((x, y) => x - y);
      const mad = absDev[absDev.length >> 1];
      const keep = Math.max(3 * 1.4826 * mad, step, 1e-6);
      const kept = fitPts.filter((p, idx) => Math.abs(res[idx] - med) <= keep);
      if (kept.length === fitPts.length || kept.length < 12) break;
      const refit = fitCylinder(kept, final.normals);
      if (!refit) break;
      fit = refit;
      fitPts = kept;
    }

    // Mode refinement: the axis is pinned by the facet normals, but the
    // radius is still dragged by transition rings bordering the barrel
    // (measured: they can outnumber true barrel vertices). True-surface
    // vertices cluster at exactly ONE radius — they lie on the CAD face —
    // so take the dominant radial mode and average it, axis unchanged.
    {
      const dists = fitPts.map((p) => {
        rel.copy(p).sub(fit.axisPoint);
        rel.addScaledVector(fit.axisDir, -rel.dot(fit.axisDir));
        return rel.length();
      });
      const bin = Math.max(step, 1e-6);
      const counts = new Map();
      for (const d of dists) {
        const k = Math.round(d / bin);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      let peakK = 0, peakN = -1;
      for (const [k, cnt] of counts) if (cnt > peakN) { peakN = cnt; peakK = k; }
      const keepD = dists.filter((d) => Math.abs(d - peakK * bin) <= 1.5 * bin);
      if (keepD.length >= 8) {
        const r = keepD.reduce((acc, d) => acc + d, 0) / keepD.length;
        let s2 = 0;
        for (const d of keepD) s2 += (d - r) * (d - r);
        fit = { ...fit, radius: r, rms: Math.sqrt(s2 / keepD.length) };
      }
    }

    // Angular coverage: a sliver of a fillet can't pin the axis honestly.
    const u = Math.abs(fit.axisDir.x) < 0.9
      ? new THREE.Vector3(1, 0, 0).cross(fit.axisDir).normalize()
      : new THREE.Vector3(0, 1, 0).cross(fit.axisDir).normalize();
    const w = new THREE.Vector3().crossVectors(fit.axisDir, u);
    const angles = [];
    let tMin = Infinity, tMax = -Infinity;
    for (const p of fitPts) {
      rel.copy(p).sub(fit.axisPoint);
      const t = rel.dot(fit.axisDir);
      tMin = Math.min(tMin, t);
      tMax = Math.max(tMax, t);
      rel.addScaledVector(fit.axisDir, -t);
      angles.push(Math.atan2(rel.dot(w), rel.dot(u)));
    }
    angles.sort((x, y) => x - y);
    let maxGap = 2 * Math.PI + angles[0] - angles[angles.length - 1];
    for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
    if (2 * Math.PI - maxGap < 1.0) return null; // < ~60° of arc
    return { ...fit, axisT: [tMin, tMax], region: visited }; // region: see growPlanarRegion
  }

  // =========================================================================
  // Snapping (hover + click)
  // =========================================================================

  const _local = new THREE.Vector3();
  const _sphere = new THREE.Sphere();
  const _sa = new THREE.Vector3(), _sb = new THREE.Vector3();

  function worldPerPixel(dist) {
    const cam = app.viewer.camera;
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / canvas.clientHeight;
  }

  function snapAt(ev) {
    const hit = app.pick(ev);
    if (!hit) return null;
    const mesh = hit.object;
    const g = mesh.geometry;
    // Every candidate distance below is measured in MESH-LOCAL space, so the
    // world-space snap radius must be converted (÷ world scale) like every
    // other local/world crossing in this file.
    const radius = SNAP_PX * worldPerPixel(hit.distance) / (worldScaleOf(mesh).mean || 1);
    _m4.copy(mesh.matrixWorld).invert();
    _local.copy(hit.point).applyMatrix4(_m4);

    // Vertex tier — nearest tessellation vertex, at HALF the snap radius:
    // rim vertices are dense (~9° apart), and a full-radius vertex priority
    // would make the rim's circle entity unreachable.
    let vBest = null, vBestD = radius * 0.5;
    if (g.boundsTree) {
      _sphere.center.copy(_local);
      _sphere.radius = radius;
      const v = new THREE.Vector3();
      g.boundsTree.shapecast({
        intersectsBounds: (box) => box.intersectsSphere(_sphere),
        intersectsTriangle: (tri) => {
          for (const p of [tri.a, tri.b, tri.c]) {
            const d = p.distanceTo(_local);
            if (d < vBestD) { vBestD = d; vBest = v.copy(p).clone(); }
          }
          return false;
        },
      });
    }

    // Edge tier — nearest point on a feature-edge segment.
    let eBest = null, eBestD = radius, eBestSeg = -1;
    const eg = M.edgeGeometryFor(g);
    if (eg) {
      const pos = eg.attributes.position;
      const count = pos.count / 2;
      for (let s = 0; s < count; s++) {
        _sa.fromBufferAttribute(pos, s * 2);
        _sb.fromBufferAttribute(pos, s * 2 + 1);
        // Cheap reject on per-axis distance before the exact test.
        if (Math.min(Math.abs(_sa.x - _local.x), Math.abs(_sb.x - _local.x)) > radius &&
            (_sa.x - _local.x) * (_sb.x - _local.x) > 0) continue;
        const r = distPointSegment(_local, _sa, _sb);
        if (r.d < eBestD) { eBestD = r.d; eBest = r.point; eBestSeg = s; }
      }
    }

    // With a section active, a candidate near the silhouette can lie on
    // clipped-away material — its marker would be invisible. The raw hit
    // point is already plane-filtered by pick(), so fall back to it.
    if (app.section && app.section.enabled) {
      const behind = (lp) => lp &&
        app.section.plane.distanceToPoint(lp.clone().applyMatrix4(mesh.matrixWorld)) < 0;
      if (behind(vBest)) vBest = null;
      if (behind(eBest)) { eBest = null; eBestSeg = -1; }
    }

    let tier = 'face';
    let local = _local.clone();
    if (vBest) { tier = 'vertex'; local = vBest; }
    else if (eBest) { tier = 'edge'; local = eBest; }

    return {
      tier,
      // The nearest feature edge is recorded even under a vertex snap: hole
      // rims are dense with vertices, and the rim's CIRCLE entity must stay
      // reachable (entityFromSnap lets circles override vertex points).
      edgeSeg: eBest ? eBestSeg : -1,
      mesh, rec: hit.rec,
      faceIndex: hit.faceIndex,
      localPoint: local,
      worldPoint: local.clone().applyMatrix4(mesh.matrixWorld),
    };
  }

  function entityFromSnap(snap) {
    if (snap.tier === 'vertex') {
      // A vertex on a hole rim should read as the hole, not one corner of
      // it — but ONLY circles override the vertex, and only when the vertex
      // actually lies ON the fitted circle (a corner where an arc meets a
      // straight edge must stay a point, not adopt the neighbouring arc).
      if (snap.edgeSeg >= 0) {
        const e = classifyEdge(snap);
        if (e.kind === 'circle') {
          const v = snap.worldPoint.clone().sub(e.center);
          const off = v.dot(e.normal);
          const radial = v.addScaledVector(e.normal, -off).length() - e.radius;
          const tol = Math.max(6 * e.step, 2e-6);
          if (Math.abs(off) <= tol && Math.abs(radial) <= tol) return e;
        }
      }
      return pointEntity(snap, false);
    }
    if (snap.tier === 'edge') return classifyEdge(snap);
    return classifyFace(snap);
  }

  // =========================================================================
  // Measurement maths between two entities
  // =========================================================================

  function axisOf(e) {
    if (e.kind === 'circle') return { p: e.center, d: e.normal };
    if (e.kind === 'cylinder') return { p: e.axisPoint, d: e.axisDir };
    if (e.kind === 'line') return { p: e.linePoint, d: e.lineDir };
    return null;
  }
  function radiusOf(e) {
    return (e.kind === 'circle' || e.kind === 'cylinder') ? e.radius : 0;
  }

  // Returns { base, conditions, note, pa, pb } — base in meters, conditions
  // null when center/min/max doesn't apply, pa/pb world endpoints for the
  // leader line.
  function measureBetween(a, b) {
    const axA = axisOf(a), axB = axisOf(b);
    const rA = radiusOf(a), rB = radiusOf(b);
    const out = { note: '', conditions: null };

    const finish = (base, pa, pb) => {
      out.base = base;
      out.pa = pa;
      out.pb = pb;
      return out;
    };

    // plane ↔ plane
    if (a.kind === 'plane' && b.kind === 'plane') {
      const align = Math.abs(a.planeNormal.dot(b.planeNormal));
      if (align > 0.99939) { // within ~2°
        const d = Math.abs(b.planePoint.clone().sub(a.planePoint).dot(a.planeNormal));
        const pb = a.planePoint.clone().addScaledVector(a.planeNormal,
          b.planePoint.clone().sub(a.planePoint).dot(a.planeNormal));
        return finish(d, a.planePoint.clone(), pb);
      }
      // Same mesh: the BVH would measure the body against itself (always 0).
      const mm = a.mesh !== b.mesh ? meshMinDistance(a.mesh, b.mesh) : null;
      if (mm) {
        out.note = 'faces not parallel — minimum distance between the two bodies';
        return finish(mm.dist, mm.pa, mm.pb);
      }
      out.note = 'faces not parallel';
      return finish(a.planePoint.distanceTo(b.planePoint), a.planePoint.clone(), b.planePoint.clone());
    }

    // plane ↔ anything with an axis or point
    const planeSide = a.kind === 'plane' ? a : b.kind === 'plane' ? b : null;
    if (planeSide) {
      const other = planeSide === a ? b : a;
      // Straight edge: exact over the fitted SEGMENT — the nearest endpoint,
      // or 0 where the edge crosses the face plane. The generic branch below
      // would report the plane's distance to the chain centroid, a value
      // that depends on how far the edge chain happened to grow.
      if (other.kind === 'line' && other.lineT) {
        const n = planeSide.planeNormal;
        const e0 = other.linePoint.clone().addScaledVector(other.lineDir, other.lineT[0]);
        const e1 = other.linePoint.clone().addScaledVector(other.lineDir, other.lineT[1]);
        const d0 = e0.clone().sub(planeSide.planePoint).dot(n);
        const d1 = e1.clone().sub(planeSide.planePoint).dot(n);
        if (d0 * d1 <= 0) { // edge crosses the face plane
          const px = e0.clone().lerp(e1, Math.abs(d0) / (Math.abs(d0) + Math.abs(d1) || 1));
          return finish(0, px, px.clone());
        }
        const [de, pe] = Math.abs(d0) <= Math.abs(d1) ? [d0, e0] : [d1, e1];
        return finish(Math.abs(de), pe.clone().addScaledVector(n, -de), pe);
      }
      const oAx = axisOf(other);
      const r = radiusOf(other);
      const ref = oAx ? oAx.p : other.point;
      const d = ref.clone().sub(planeSide.planePoint).dot(planeSide.planeNormal);
      const base = Math.abs(d);
      const foot = ref.clone().addScaledVector(planeSide.planeNormal, -d);
      if (r > 0) {
        const cosAxis = oAx ? Math.abs(oAx.d.dot(planeSide.planeNormal)) : 0;
        if (other.kind === 'cylinder' && cosAxis > 0.05) {
          // A tilted cylinder's wall extremes depend on its length, not its
          // radius — there is no honest min/max, so warn instead. Circles
          // stay exact at any tilt via the amplitude term.
          out.note = 'hole axis is not parallel to the face';
        } else {
          const mm = planeCircleMinMax(base, r, cosAxis);
          out.conditions = { center: base, min: mm.min, max: mm.max };
        }
      }
      return finish(base, foot, ref.clone());
    }

    // two axes (circle/cylinder/line in any combination)
    if (axA && axB) {
      const ll = lineLineClosest(axA.p, axA.d, axB.p, axB.d);
      // edge ↔ edge: both extents are known, so measure the SEGMENTS —
      // collinear edges separated along their axis must not read 0, and a
      // skew pair must not report a crossing outside either edge.
      if (a.kind === 'line' && b.kind === 'line' && a.lineT && b.lineT) {
        const ends = (e) => [
          e.linePoint.clone().addScaledVector(e.lineDir, e.lineT[0]),
          e.linePoint.clone().addScaledVector(e.lineDir, e.lineT[1]),
        ];
        const [a0, a1] = ends(a), [b0, b1] = ends(b);
        const ss = segSegClosest(a0, a1, b0, b1);
        if (!ll.parallel) out.note = 'edges are not parallel — closest approach shown';
        return finish(ss.dist, ss.pa, ss.pb);
      }
      let base = ll.dist;
      let pa = axA.p.clone(), pb = axB.p.clone();
      if (a.kind === 'circle' && b.kind === 'circle') {
        base = a.center.distanceTo(b.center); // SW center-to-center convention
        pa = a.center.clone(); pb = b.center.clone();
      } else if (ll.parallel) {
        // Draw between the closest points: project B's anchor onto A's axis.
        const t = axB.p.clone().sub(axA.p).dot(axA.d);
        pa = axA.p.clone().addScaledVector(axA.d, t);
        pb = axB.p.clone();
      }
      if (!ll.parallel && (a.kind !== 'circle' || b.kind !== 'circle')) {
        out.note = 'axes are not parallel — closest approach shown';
      }
      // Wall-to-wall min/max only means anything when the axes are parallel
      // (the offsets live in the common perpendicular plane). ll.dist is the
      // perpendicular axis separation — NOT `base`, which circle pairs
      // override with the 3D center distance; their fixed axial offset
      // returns via the hypotenuse inside parallelWallMinMax.
      if (rA + rB > 0 && ll.parallel) {
        const h = (a.kind === 'circle' && b.kind === 'circle')
          ? Math.abs(axB.p.clone().sub(axA.p).dot(axA.d)) : 0;
        const mm = parallelWallMinMax(ll.dist, rA, rB, h);
        out.conditions = { center: base, min: mm.min, max: mm.max };
      }
      return finish(base, pa, pb);
    }

    // one axis + a point
    const ax = axA || axB;
    if (ax) {
      const axEnt = axA ? a : b;
      const other = axA ? b : a;
      const r = radiusOf(axEnt);
      let base, pa, pb;
      if (axEnt.kind === 'circle') {
        base = other.point.distanceTo(axEnt.center); // 3D center distance
        pa = axEnt.center.clone(); pb = other.point.clone();
        // No min/max here: the true point-to-arc extremes need the exact
        // 3D point-to-circle solution, and |d ∓ r| is only right in-plane.
      } else if (axEnt.kind === 'line' && axEnt.lineT) {
        // Finite edge: clamp to the fitted extent instead of projecting
        // onto the infinite line's extension past the endpoints.
        const e0 = ax.p.clone().addScaledVector(ax.d, axEnt.lineT[0]);
        const e1 = ax.p.clone().addScaledVector(ax.d, axEnt.lineT[1]);
        const near = distPointSegment(other.point, e0, e1);
        base = near.d;
        pa = near.point; pb = other.point.clone();
      } else {
        const w = other.point.clone().sub(ax.p);
        const t = w.dot(ax.d);
        pa = ax.p.clone().addScaledVector(ax.d, t);
        pb = other.point.clone();
        base = pa.distanceTo(pb);
        // Point-to-cylinder-wall IS exact: the radial offset applies along
        // the same perpendicular the base distance was measured on.
        if (r > 0) out.conditions = { center: base, min: Math.abs(base - r), max: base + r };
      }
      return finish(base, pa, pb);
    }

    // point ↔ point
    return finish(a.point.distanceTo(b.point), a.point.clone(), b.point.clone());
  }

  function meshMinDistance(meshA, meshB) {
    const ga = meshA.geometry, gb = meshB.geometry;
    if (!ga.boundsTree || !gb.boundsTree) return null;
    const bToA = new THREE.Matrix4().copy(meshA.matrixWorld).invert().multiply(meshB.matrixWorld);
    const t1 = {}, t2 = {};
    ga.boundsTree.closestPointToGeometry(gb, bToA, t1, t2);
    if (!t1.point) return null;
    return {
      // closestPointToGeometry works in A's LOCAL frame — scale the distance
      // into world units like every other local/world crossing in this file.
      dist: t1.distance * worldScaleOf(meshA).mean,
      pa: t1.point.clone().applyMatrix4(meshA.matrixWorld),
      // three-mesh-bvh reports target2 in the OTHER geometry's own frame.
      pb: t2.point ? t2.point.clone().applyMatrix4(meshB.matrixWorld)
        : t1.point.clone().applyMatrix4(meshA.matrixWorld),
    };
  }

  // =========================================================================
  // Scene + DOM presentation
  // =========================================================================

  const group = new THREE.Group(); // world-space overlay; added once viewer exists
  group.name = 'bomdom-measure';
  let groupAdded = false;
  function ensureGroup() {
    if (!groupAdded && app.viewer) {
      app.viewer.scene.add(group);
      groupAdded = true;
    }
  }

  const lineMat = new THREE.LineBasicMaterial({
    color: COLOR_EXACT, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9,
  });
  const entityMat = new THREE.LineBasicMaterial({
    color: COLOR_EDGE, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9,
  });
  const markerMatFor = {
    vertex: new THREE.PointsMaterial({ color: COLOR_EXACT, size: 9, sizeAttenuation: false, depthTest: false }),
    edge: new THREE.PointsMaterial({ color: COLOR_EDGE, size: 8, sizeAttenuation: false, depthTest: false }),
    face: new THREE.PointsMaterial({ color: COLOR_APPROX, size: 7, sizeAttenuation: false, depthTest: false }),
  };

  // ΔXYZ leg colours track the axis-gizmo CSS tokens, theme-reactively —
  // same pattern as model.js initEdgeColor.
  const axisMats = {
    x: new THREE.LineBasicMaterial({ color: 0xcf3b40, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }),
    y: new THREE.LineBasicMaterial({ color: 0x2f9e63, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }),
    z: new THREE.LineBasicMaterial({ color: 0x3a72d4, toneMapped: false, depthTest: false, transparent: true, opacity: 0.9 }),
  };
  const applyAxisColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const a of ['x', 'y', 'z']) {
      const c = cs.getPropertyValue('--axis-' + a).trim();
      if (c) axisMats[a].color.set(c);
    }
    invalidate();
  };
  applyAxisColors();
  new MutationObserver(applyAxisColors)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function makePoints(positions, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    const p = new THREE.Points(g, mat);
    p.raycast = () => {};
    p.renderOrder = 1001;
    return p;
  }
  function makeLine(pa, pb, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
    ]), 3));
    const l = new THREE.Line(g, mat);
    l.raycast = () => {};
    l.renderOrder = 1000;
    return l;
  }
  // Fitted-entity glyphs: circle outline, cylinder end rings + axis, so the
  // user sees exactly what got fitted.
  function entityGlyph(e) {
    if (e.kind === 'circle' || e.kind === 'cylinder') {
      const isC = e.kind === 'circle';
      const center = isC ? e.center : e.axisPoint;
      const dir = isC ? e.normal : e.axisDir;
      const u = Math.abs(dir.x) < 0.9
        ? new THREE.Vector3(1, 0, 0).cross(dir).normalize()
        : new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      const w = new THREE.Vector3().crossVectors(dir, u);
      const segs = [];
      const N = 48;
      const ring = (c) => {
        const at = (i) => {
          const ang = (i / N) * 2 * Math.PI;
          return c.clone()
            .addScaledVector(u, Math.cos(ang) * e.radius)
            .addScaledVector(w, Math.sin(ang) * e.radius);
        };
        for (let i = 0; i < N; i++) {
          const p0 = at(i), p1 = at(i + 1);
          segs.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      };
      if (isC || !e.axisT) ring(center);
      else {
        // A ring at each end of the fitted extent reads as "this bore".
        ring(center.clone().addScaledVector(dir, e.axisT[0]));
        ring(center.clone().addScaledVector(dir, e.axisT[1]));
        const a0 = e.axisPoint.clone().addScaledVector(e.axisDir, e.axisT[0]);
        const a1 = e.axisPoint.clone().addScaledVector(e.axisDir, e.axisT[1]);
        segs.push(a0.x, a0.y, a0.z, a1.x, a1.y, a1.z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
      const l = new THREE.LineSegments(g, entityMat);
      l.raycast = () => {};
      l.renderOrder = 1000;
      return l;
    }
    return null;
  }

  function disposeObj(obj) {
    obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    if (obj.parent) obj.parent.remove(obj);
  }

  // ΔXYZ staircase: leader endpoint A to endpoint B, one leg per model axis.
  // World coordinates ARE model coordinates (the camera reorients, the model
  // never moves), so the legs read as the CAD-axis components — SolidWorks'
  // dX/dY/dZ. Always drawn from the center-condition endpoints.
  function xyzLegs(m) {
    const legs = new THREE.Group();
    const from = m.result.pa.clone();
    for (const a of ['x', 'y', 'z']) {
      const to = from.clone();
      to[a] = m.result.pb[a];
      if (Math.abs(to[a] - from[a]) > 1e-9) legs.add(makeLine(from, to, axisMats[a]));
      from.copy(to);
    }
    return legs.children.length > 1 ? legs : null; // one leg = the leader line itself
  }

  function setXyzObj(m, on) {
    if (m.xyzObj) { disposeObj(m.xyzObj); m.xyzObj = null; }
    if (on) {
      const legs = xyzLegs(m);
      if (legs) { m.xyzObj = legs; m.obj.add(legs); } // rides m.obj's stale-hiding
    }
  }

  // ---- labels -------------------------------------------------------------
  const viewport = $('viewport');
  const _proj = new THREE.Vector3();

  function projectToViewport(p) {
    _proj.copy(p).project(app.viewer.camera);
    if (_proj.z > 1 || _proj.z < -1) return null;
    const r = viewport.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    return {
      x: (cr.left - r.left) + ((_proj.x + 1) / 2) * cr.width,
      y: (cr.top - r.top) + ((1 - _proj.y) / 2) * cr.height,
    };
  }

  function makeLabel(m) {
    const el = document.createElement('div');
    el.className = 'measure-label';
    const val = document.createElement('span');
    val.className = 'ml-val mono';
    el.appendChild(val);
    if (m.result.conditions) {
      const cond = document.createElement('button');
      cond.className = 'ml-cond';
      cond.title = 'Cycle center / minimum / maximum (hole walls)';
      cond.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const order = ['center', 'min', 'max'];
        m.condition = order[(order.indexOf(m.condition) + 1) % order.length];
        refreshLabel(m);
        invalidate();
      });
      el.appendChild(cond);
      m.condEl = cond;
    }
    const x = document.createElement('button');
    x.className = 'ml-x';
    x.textContent = '×';
    x.title = 'Remove this measurement';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeMeasurement(m);
    });
    el.appendChild(x);
    viewport.appendChild(el);
    m.labelEl = el;
    m.valEl = val;
    refreshLabel(m);
  }

  function currentValue(m) {
    if (m.result.conditions && m.condition !== 'center') return m.result.conditions[m.condition];
    return m.result.base;
  }

  // Ø labels format lazily so a unit switch re-renders them; other kinds
  // carry fixed strings ('face', 'edge', 'corner', ...).
  function entityLabel(e) {
    return e.dia ? `Ø ${fmt(e.dia.d, e.dia.err)}` : (e.label || 'point');
  }

  function refreshLabel(m) {
    const err = entityErr(m.a) + entityErr(m.b);
    const condTag = { center: 'ctr', min: 'min', max: 'max' }[m.condition] || '';
    m.valEl.textContent = fmt(currentValue(m), err);
    if (m.condEl) m.condEl.textContent = condTag;
    const d = m.result.pb.clone().sub(m.result.pa);
    const bits = [`${fmtErr(err)}`];
    bits.push(`A: ${entityLabel(m.a)}`);
    bits.push(`B: ${entityLabel(m.b)}`);
    if (m.result.note) bits.push(m.result.note);
    if (m.a.approx || m.b.approx) bits.push('approximate: surface pick on a curved face');
    bits.push(`ΔX ${fmt(Math.abs(d.x), err)} · ΔY ${fmt(Math.abs(d.y), err)} · ΔZ ${fmt(Math.abs(d.z), err)}`);
    m.labelEl.title = bits.join('\n');
    m.labelEl.classList.toggle('is-approx', !!(m.a.approx || m.b.approx));
    // ΔXYZ row (matches the staircase legs; always the center endpoints)
    if (st.xyz) {
      if (!m.xyzEl) {
        m.xyzEl = document.createElement('span');
        m.xyzEl.className = 'ml-xyz mono';
        m.labelEl.appendChild(m.xyzEl);
      }
      m.xyzEl.innerHTML = '';
      for (const a of ['x', 'y', 'z']) {
        const s = document.createElement('span');
        s.className = 'ax-' + a;
        s.textContent = `Δ${a.toUpperCase()} ${fmt(Math.abs(d[a]), err)}`;
        m.xyzEl.appendChild(s);
      }
    } else if (m.xyzEl) {
      m.xyzEl.remove();
      m.xyzEl = null;
    }
  }

  function layoutLabels() {
    if (!app.viewer) return;
    for (const m of st.measurements) {
      const mid = m.result.pa.clone().add(m.result.pb).multiplyScalar(0.5);
      const pos = projectToViewport(mid);
      // A section cut hides the measured geometry; its label must not float
      // over the void it used to anchor to.
      const clipped = app.section && app.section.enabled
        && app.section.plane.distanceToPoint(mid) < 0;
      if (!pos || clipped) { m.labelEl.style.display = 'none'; continue; }
      m.labelEl.style.display = '';
      m.labelEl.style.left = `${pos.x}px`;
      m.labelEl.style.top = `${pos.y}px`;
    }
    if (st.pending && pendingLabel) {
      const pos = projectToViewport(st.pending.point);
      if (pos) {
        pendingLabel.style.display = '';
        pendingLabel.style.left = `${pos.x}px`;
        pendingLabel.style.top = `${pos.y}px`;
      } else pendingLabel.style.display = 'none';
    }
  }

  // ---- hover / pending scene objects --------------------------------------
  let hoverMarker = null;
  let pendingMarker = null;
  let pendingGlyph = null;
  let rubberLine = null;
  let pendingLabel = null;

  // ---- hover entity preview ------------------------------------------------
  // The hover highlight runs the SAME classification the click will run
  // (entityFromSnap), so what lights up is exactly what gets measured.
  // Results are cached per mesh keyed by the classification seed; sweeping
  // across one face or bore reuses its region via containment. The cache is
  // swapped out whenever anything moves — entities capture world poses.
  let hoverCache = new WeakMap(); // mesh -> Map(seedKey -> entity)
  const resetHoverCache = () => { hoverCache = new WeakMap(); };

  function hoverKeyOf(snap) {
    if (snap.tier === 'face') return 'f' + snap.faceIndex;
    if (snap.tier === 'edge') return 'e' + snap.edgeSeg;
    // Vertex snaps key by exact position: same rim vertex -> same entity.
    const p = snap.localPoint;
    return `v${snap.edgeSeg}:${p.x},${p.y},${p.z}`;
  }

  function hoverEntityFor(snap) {
    let byKey = hoverCache.get(snap.mesh);
    if (!byKey) { byKey = new Map(); hoverCache.set(snap.mesh, byKey); }
    const key = hoverKeyOf(snap);
    let e = byKey.get(key);
    if (e) return e;
    // A face pick landing inside an already-grown plane/cylinder region is
    // the same entity — no refit while sweeping along a face or bore.
    if (snap.tier === 'face') {
      for (const other of byKey.values()) {
        if (other.region && other.region.has(snap.faceIndex)) {
          byKey.set(key, other);
          return other;
        }
      }
    }
    if (byKey.size > 64) byKey.clear();
    e = entityFromSnap(snap);
    byKey.set(key, e);
    return e;
  }

  // Face-region fill: the grown facets in the mesh's LOCAL space, riding its
  // world matrix. Depth-TESTED (unlike the markers) so only the visible part
  // of the face lights up; the base surfaces sit behind their polygonOffset
  // push-back, so the fill wins depth without z-fighting.
  const planeFillMat = new THREE.MeshBasicMaterial({
    color: COLOR_EDGE, toneMapped: false, transparent: true, opacity: 0.18,
    side: THREE.DoubleSide, depthWrite: false,
  });
  function planeFill(entity) {
    const g = entity.mesh.geometry;
    const arr = new Float32Array(entity.region.size * 9);
    let o = 0;
    const v = new THREE.Vector3();
    for (const t of entity.region) {
      for (let k = 0; k < 3; k++) {
        readVert(g, cornerIndex(g, t, k), v);
        arr[o++] = v.x; arr[o++] = v.y; arr[o++] = v.z;
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const fill = new THREE.Mesh(bg, planeFillMat);
    fill.raycast = () => {};
    fill.matrix.copy(entity.mesh.matrixWorld);
    fill.matrixAutoUpdate = false;
    fill.renderOrder = 999;
    return fill;
  }

  let hoverGlyph = null;
  function setHoverGlyph(entity) {
    if (hoverGlyph) { disposeObj(hoverGlyph); hoverGlyph = null; }
    if (!entity) return;
    if (entity.kind === 'circle' || entity.kind === 'cylinder') {
      hoverGlyph = entityGlyph(entity);
    } else if (entity.kind === 'line' && entity.lineT) {
      hoverGlyph = makeLine(
        entity.linePoint.clone().addScaledVector(entity.lineDir, entity.lineT[0]),
        entity.linePoint.clone().addScaledVector(entity.lineDir, entity.lineT[1]),
        entityMat);
    } else if (entity.kind === 'plane' && entity.region) {
      hoverGlyph = planeFill(entity);
    }
    if (hoverGlyph) group.add(hoverGlyph);
  }

  function setHoverMarker(snap) {
    if (hoverMarker) { disposeObj(hoverMarker); hoverMarker = null; }
    if (snap) {
      hoverMarker = makePoints(
        [snap.worldPoint.x, snap.worldPoint.y, snap.worldPoint.z],
        markerMatFor[snap.tier]);
      group.add(hoverMarker);
    }
    setHoverGlyph(snap ? hoverEntityFor(snap) : null);
    invalidate();
  }

  function setPending(entity) {
    if (pendingMarker) { disposeObj(pendingMarker); pendingMarker = null; }
    if (pendingGlyph) { disposeObj(pendingGlyph); pendingGlyph = null; }
    if (pendingLabel) { pendingLabel.remove(); pendingLabel = null; }
    st.pending = entity;
    if (entity) {
      pendingMarker = makePoints(
        [entity.point.x, entity.point.y, entity.point.z],
        markerMatFor[entity.kind === 'point' ? (entity.approx ? 'face' : 'vertex') : 'edge']);
      group.add(pendingMarker);
      const glyph = entityGlyph(entity);
      if (glyph) { pendingGlyph = glyph; group.add(glyph); }
      pendingLabel = document.createElement('div');
      pendingLabel.className = 'measure-label is-pending mono';
      pendingLabel.textContent = entityLabel(entity);
      viewport.appendChild(pendingLabel);
      layoutLabels();
    }
    updateRubber(null);
    invalidate();
  }

  function updateRubber(snap) {
    if (rubberLine) { disposeObj(rubberLine); rubberLine = null; }
    if (st.pending && snap) {
      rubberLine = makeLine(st.pending.point, snap.worldPoint, lineMat);
      group.add(rubberLine);
    }
  }

  // ---- committed measurements ---------------------------------------------
  function commit(a, b) {
    const result = measureBetween(a, b);
    const m = {
      id: st.nextId++,
      a, b, result,
      condition: 'center',
      obj: new THREE.Group(),
      stale: false,
    };
    m.obj.add(makeLine(result.pa, result.pb, lineMat));
    m.obj.add(makePoints([
      result.pa.x, result.pa.y, result.pa.z,
      result.pb.x, result.pb.y, result.pb.z,
    ], markerMatFor.vertex));
    for (const e of [a, b]) {
      const glyph = entityGlyph(e);
      if (glyph) m.obj.add(glyph);
    }
    setXyzObj(m, st.xyz);
    group.add(m.obj);
    st.measurements.push(m);
    makeLabel(m);
    updateStale(m);
    layoutLabels();
    invalidate();
  }

  function removeMeasurement(m) {
    const i = st.measurements.indexOf(m);
    if (i >= 0) st.measurements.splice(i, 1);
    disposeObj(m.obj);
    m.labelEl.remove();
    invalidate();
  }

  function clearAll() {
    for (const m of [...st.measurements]) removeMeasurement(m);
    setPending(null);
  }

  function updateStale(m) {
    // Stale = either part's world transform differs from the exact pose it
    // was measured under; returning to that pose (applyPositions restores
    // bit-identical floats) revalidates the stored coordinates.
    m.stale = poseMoved(m.a) || poseMoved(m.b);
    m.labelEl.classList.toggle('is-stale', m.stale);
    m.obj.visible = !m.stale;
    if (m.stale) {
      m.labelEl.title = 'Parts have moved since this was measured.\nReset positions to restore it.';
    } else refreshLabel(m);
  }

  // =========================================================================
  // Mode + input wiring
  // =========================================================================

  let moveRaf = 0;
  let lastMove = null;

  function onPointerLeave() {
    // Cancel the throttle rAF too — a pending callback holding the last
    // in-canvas event would resurrect the marker after the cursor left.
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    lastMove = null;
    if (st.hover) {
      st.hover = null;
      setHoverMarker(null);
      updateRubber(null);
      invalidate();
    }
  }

  function onPointerMove(ev) {
    if (!st.on || ev.buttons !== 0) { // orbiting/dragging — drop the preview
      if (st.hover) { st.hover = null; setHoverMarker(null); updateRubber(null); }
      return;
    }
    lastMove = ev;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!st.on || !lastMove) return;
      const snap = snapAt(lastMove);
      st.hover = snap;
      setHoverMarker(snap);
      updateRubber(snap);
      invalidate();
    });
  }

  function handleClick(ev, hit) {
    if (!hit) { setPending(null); return; }
    const snap = snapAt(ev);
    if (!snap) { setPending(null); return; }
    const entity = entityFromSnap(snap);
    if (st.pending) {
      // A double-click lands two identical snaps (framing is suppressed in
      // measure mode but both clicks arrive) — treat the repeat as a no-op
      // instead of committing a zero-length measurement.
      if (st.pending.rec === entity.rec && st.pending.kind === entity.kind
          && st.pending.point.distanceToSquared(entity.point) < 1e-18) return;
      if (st.pending.rec !== entity.rec && (displaced(st.pending.rec) || displaced(entity.rec))) {
        app.ui.toast('Parts are exploded or moved — reset positions to measure between parts');
        return;
      }
      commit(st.pending, entity);
      setPending(null);
    } else {
      if (displaced(entity.rec)) {
        app.ui.toast('This part is exploded or moved — within-part picks only reflect the current view');
      }
      setPending(entity);
    }
  }

  function handleRightClick() {
    if (st.pending) { setPending(null); return true; }
    return false;
  }

  function escape() {
    if (!st.on) return false;
    if (st.pending) { setPending(null); return true; }
    setMode(false);
    return true;
  }

  function setMode(on) {
    if (on === st.on) return;
    if (on && !app.model) { app.ui.toast('No 3D model loaded'); return; }
    st.on = on;
    app.measureMode = on;
    ensureGroup();
    $('btnMeasure').classList.toggle('is-on', on);
    canvas.classList.toggle('is-measure', on);
    $('measureChip').classList.toggle('hidden', !on);
    if (app.triad) app.triad.refresh(); // triad stands down while measure owns the canvas
    if (on) {
      // Assembly mode also owns hover + click on this canvas: exit it, or its
      // last hover highlight would stay frozen for the whole measure session
      // (picking's hover path stands down while measureMode is set).
      if (app.assemblyMode && app.actions) app.actions.setAssemblyMode(false);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerleave', onPointerLeave);
      // Feature edges are the snap targets: make sure they get built even if
      // the user has their display toggled off.
      const model = app.model;
      M.buildEdgesLazily(model, () => app.events.emit('appearance'), () => app.model !== model);
      if (!st.measurements.length) {
        app.ui.toast('Measure: click two points — corners, edges, holes and faces snap (Esc to exit)');
      }
    } else {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      setPending(null);
      setHoverMarker(null);
      st.hover = null;
    }
    invalidate();
  }

  app.measure = {
    toggle: () => setMode(!st.on),
    handleClick,
    handleRightClick,
    escape,
    // Structured readback for E2E checks (and the console-curious).
    list: () => st.measurements.map((m) => ({
      id: m.id,
      kinds: [m.a.kind, m.b.kind],
      valueM: currentValue(m),
      condition: m.condition,
      errM: entityErr(m.a) + entityErr(m.b),
      note: m.result.note,
      stale: m.stale,
      deltasM: ['x', 'y', 'z'].map((a) => Math.abs(m.result.pb[a] - m.result.pa[a])),
      entities: [m.a, m.b].map((e) => ({
        kind: e.kind,
        radiusM: e.radius,
        fitRms: e.fitRms,
        axis: e.axisDir ? e.axisDir.toArray() : (e.normal ? e.normal.toArray() : null),
        axisPoint: e.axisPoint ? e.axisPoint.toArray() : (e.center ? e.center.toArray() : null),
      })),
    })),
  };

  // ---- chrome -------------------------------------------------------------
  $('btnMeasure').addEventListener('click', () => setMode(!st.on));
  $('measureExit').addEventListener('click', () => setMode(false));
  $('measureClear').addEventListener('click', () => clearAll());
  const unitSel = $('measureUnits');
  unitSel.value = st.unit;
  unitSel.addEventListener('change', () => {
    st.unit = UNITS[unitSel.value] ? unitSel.value : 'mm';
    storeUnit(st.unit);
    for (const m of st.measurements) if (!m.stale) refreshLabel(m);
    if (st.pending && pendingLabel) pendingLabel.textContent = entityLabel(st.pending);
  });
  const xyzBox = $('measureXYZ');
  xyzBox.checked = st.xyz;
  xyzBox.addEventListener('change', () => {
    st.xyz = xyzBox.checked;
    storeXyz(st.xyz);
    for (const m of st.measurements) {
      setXyzObj(m, st.xyz);
      if (!m.stale) refreshLabel(m);
      // Stale labels keep their "parts moved" tooltip; just drop the row.
      else if (!st.xyz && m.xyzEl) { m.xyzEl.remove(); m.xyzEl = null; }
    }
    layoutLabels();
    invalidate();
  });

  // ---- app events -----------------------------------------------------------
  if (app.viewer) app.viewer.onCameraChange(() => layoutLabels());
  // Fires on every explode step AND at rest: staleness must track parts in
  // flight, and a pending first point whose part moved is unusable (its
  // committed coordinates are from the old pose).
  const onPositionsChanged = () => {
    resetHoverCache(); // cached hover entities hold pre-move world coords
    for (const m of st.measurements) updateStale(m);
    if (st.pending && poseMoved(st.pending)) {
      setPending(null);
      app.ui.toast('Measurement point dropped — the part moved');
    }
    layoutLabels();
    invalidate();
  };
  app.events.on('positions', onPositionsChanged);
  app.events.on('positions-live', onPositionsChanged);
  app.events.on('model', () => {
    // Sidecar re-drop: the old scene graph (and every fitted entity) is gone.
    resetHoverCache();
    clearAll();
    setMode(false);
  });
}
