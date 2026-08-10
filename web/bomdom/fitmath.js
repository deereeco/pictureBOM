// Pure geometry fitting for the measure tool. No DOM, no renderer state —
// this module is also imported by scripts/verify_measure_math.mjs, which
// asserts these fits against known Thorlabs catalog dimensions offline.
//
// Everything works in meters (glTF units). The key property these fits rely
// on: SolidWorks tessellation vertices lie exactly ON the CAD surface (only
// Draco quantization noise, ~µm), so least-squares through vertices recovers
// true dimensions — unlike naive picks on facet interiors, which carry chord
// error.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Small linear algebra
// ---------------------------------------------------------------------------

// Eigen-decomposition of a symmetric 3x3 by cyclic Jacobi rotations.
// m is row-major [xx, xy, xz, yy, yz, zz]. Returns { values: [3], vectors:
// [Vector3 x3] } sorted ascending by eigenvalue.
function eigenSym3(m) {
  let a = [
    [m[0], m[1], m[2]],
    [m[1], m[3], m[4]],
    [m[2], m[4], m[5]],
  ];
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      // theta === 0 (equal diagonal entries) must rotate by 45°, not 0° —
      // Math.sign(0) would freeze the sweep and never converge.
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const out = [0, 1, 2].map((i) => ({
    value: a[i][i],
    vector: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize(),
  }));
  out.sort((x, y) => x.value - y.value);
  return { values: out.map((o) => o.value), vectors: out.map((o) => o.vector) };
}

// Covariance second moments of points about their centroid.
function momentsAboutCentroid(points) {
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  const d = new THREE.Vector3();
  for (const p of points) {
    d.copy(p).sub(c);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  return { centroid: c, m: [xx, xy, xz, yy, yz, zz] };
}

// Cramer solve of a 3x3 system. Returns null when singular.
function solve3(A, b) {
  const det = (M) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
    - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-30) return null;
  const col = (M, i, v) => M.map((row, r) => row.map((x, ci) => (ci === i ? v[r] : x)));
  return [det(col(A, 0, b)) / d, det(col(A, 1, b)) / d, det(col(A, 2, b)) / d];
}

// ---------------------------------------------------------------------------
// Fits
// ---------------------------------------------------------------------------

export function fitPlane(points) {
  if (!points || points.length < 3) return null;
  const { centroid, m } = momentsAboutCentroid(points);
  const eig = eigenSym3(m);
  const normal = eig.vectors[0]; // least-variance direction
  let sum2 = 0, max = 0;
  const d = new THREE.Vector3();
  for (const p of points) {
    const e = Math.abs(d.copy(p).sub(centroid).dot(normal));
    sum2 += e * e;
    if (e > max) max = e;
  }
  return { point: centroid, normal, rms: Math.sqrt(sum2 / points.length), max };
}

export function fitLine3D(points) {
  if (!points || points.length < 2) return null;
  const { centroid, m } = momentsAboutCentroid(points);
  const dir = eigenSym3(m).vectors[2]; // most-variance direction
  let sum2 = 0, max = 0, tMin = Infinity, tMax = -Infinity;
  const d = new THREE.Vector3();
  for (const p of points) {
    d.copy(p).sub(centroid);
    const t = d.dot(dir);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
    const e = d.addScaledVector(dir, -t).length();
    sum2 += e * e;
    if (e > max) max = e;
  }
  return {
    point: centroid, dir,
    rms: Math.sqrt(sum2 / points.length), max,
    length: tMax - tMin,
  };
}

// Kasa algebraic circle fit on 2D coordinates already centered near origin.
// Returns { cx, cy, r } or null.
function fitCircle2D(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    sxz += x * z; syz += y * z; sz += z;
  }
  const sol = solve3(
    [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]],
    [-sxz, -syz, -sz],
  );
  if (!sol) return null;
  const [D, E, F] = sol;
  const r2 = D * D / 4 + E * E / 4 - F;
  if (!(r2 > 0)) return null;
  return { cx: -D / 2, cy: -E / 2, r: Math.sqrt(r2) };
}

// Circle through 3D points that are expected to be roughly coplanar (a hole
// rim, a tessellated arc). arcSpanRad tells callers how much of the circle
// the points actually cover — a 90° sliver pins the radius far less well
// than a closed rim, so callers gate acceptance on it.
export function fitCircle3D(points) {
  if (!points || points.length < 3) return null;
  const plane = fitPlane(points);
  if (!plane) return null;
  const { normal, point: centroid } = plane;
  // In-plane basis.
  const u = Math.abs(normal.x) < 0.9
    ? new THREE.Vector3(1, 0, 0).cross(normal).normalize()
    : new THREE.Vector3(0, 1, 0).cross(normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const xs = [], ys = [];
  const d = new THREE.Vector3();
  for (const p of points) {
    d.copy(p).sub(centroid);
    xs.push(d.dot(u));
    ys.push(d.dot(v));
  }
  const c2 = fitCircle2D(xs, ys);
  if (!c2) return null;
  const center = centroid.clone().addScaledVector(u, c2.cx).addScaledVector(v, c2.cy);
  // Residuals combine in-plane radius error and out-of-plane deviation.
  let sum2 = 0, max = 0;
  const angles = [];
  for (let i = 0; i < points.length; i++) {
    const dx = xs[i] - c2.cx, dy = ys[i] - c2.cy;
    const inPlane = Math.sqrt(dx * dx + dy * dy) - c2.r;
    const offPlane = d.copy(points[i]).sub(centroid).dot(normal);
    const e = Math.hypot(inPlane, offPlane);
    sum2 += e * e;
    if (e > max) max = e;
    angles.push(Math.atan2(dy, dx));
  }
  angles.sort((a, b) => a - b);
  let maxGap = 2 * Math.PI + angles[0] - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  return {
    center, radius: c2.r, normal,
    rms: Math.sqrt(sum2 / points.length), max,
    arcSpanRad: 2 * Math.PI - maxGap,
  };
}

// Cylinder from surface points + their triangles' normals. Every barrel
// normal is perpendicular to the axis, so the axis is the least-variance
// direction of the normal cloud taken about the ORIGIN (not the mean —
// a full bore's normals cancel to a zero mean).
export function fitCylinder(points, triNormals) {
  if (!points || points.length < 6 || !triNormals || triNormals.length < 2) return null;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const n of triNormals) {
    xx += n.x * n.x; xy += n.x * n.y; xz += n.x * n.z;
    yy += n.y * n.y; yz += n.y * n.z; zz += n.z * n.z;
  }
  const axisDir = eigenSym3([xx, xy, xz, yy, yz, zz]).vectors[0];
  // Project points onto the plane through the centroid perpendicular to the
  // axis, then circle-fit in 2D.
  const { centroid } = momentsAboutCentroid(points);
  const u = Math.abs(axisDir.x) < 0.9
    ? new THREE.Vector3(1, 0, 0).cross(axisDir).normalize()
    : new THREE.Vector3(0, 1, 0).cross(axisDir).normalize();
  const v = new THREE.Vector3().crossVectors(axisDir, u);
  const xs = [], ys = [];
  const d = new THREE.Vector3();
  for (const p of points) {
    d.copy(p).sub(centroid);
    xs.push(d.dot(u));
    ys.push(d.dot(v));
  }
  const c2 = fitCircle2D(xs, ys);
  if (!c2) return null;
  const axisPoint = centroid.clone().addScaledVector(u, c2.cx).addScaledVector(v, c2.cy);
  let sum2 = 0, max = 0;
  const rel = new THREE.Vector3();
  for (const p of points) {
    rel.copy(p).sub(axisPoint);
    rel.addScaledVector(axisDir, -rel.dot(axisDir));
    const e = Math.abs(rel.length() - c2.r);
    sum2 += e * e;
    if (e > max) max = e;
  }
  return {
    axisPoint, axisDir, radius: c2.r,
    rms: Math.sqrt(sum2 / points.length), max,
  };
}

// ---------------------------------------------------------------------------
// Distances
// ---------------------------------------------------------------------------

// Closest approach of two infinite lines. Directions within ~0.3° are
// treated as parallel (perpendicular distance) — the skew closest-approach
// formula is numerically meaningless between two independently FITTED axes
// that differ only by fit noise, scattering hundreds of µm on real data.
export function lineLineClosest(p1, d1, p2, d2) {
  const w = new THREE.Vector3().subVectors(p2, p1);
  const cross = new THREE.Vector3().crossVectors(d1, d2);
  const denom = cross.lengthSq(); // sin²(angle) for unit directions
  if (denom < 2.5e-5) { // parallel to within ~5 mrad
    const along = w.dot(d1);
    const perp = w.clone().addScaledVector(d1, -along);
    return { dist: perp.length(), parallel: true };
  }
  return { dist: Math.abs(w.dot(cross)) / Math.sqrt(denom), parallel: false };
}

// Distance extremes from a plane to a circle rim of radius r whose axis
// makes |cos α| = cosAxis with the plane normal. Rim points oscillate about
// the center distance `base` with amplitude r·sin α = r·√(1−cos²α): a rim
// parallel to the face (cosAxis 1) is all at `base`, an edge-on rim sweeps
// base ± r, and a rim crossing the plane bottoms out at 0 — never |base−r|,
// which is a distance to nothing. Also serves the cylinder-wall-to-plane
// case with the axis parallel to the plane (cosAxis ≈ 0); a TILTED
// cylinder's extremes depend on its length, not r, so callers warn instead.
export function planeCircleMinMax(base, r, cosAxis) {
  const amp = r * Math.sqrt(Math.max(0, 1 - cosAxis * cosAxis));
  return { min: Math.max(0, base - amp), max: base + amp };
}

// Wall-to-wall distance extremes between two parallel-axis round entities:
// rho is the perpendicular separation of the axes, h a fixed offset ALONG
// them (nonzero only for circle rims — a rim is one station on its axis,
// so the axial gap rides every wall-point pair; cylinders extend, h = 0).
// In the cross-section plane the walls close side-by-side by rho−(rA+rB),
// nested (shaft in bore) by |rA−rB|−rho, and touching/overlapping walls
// meet at 0; the outer extreme is always rho+rA+rB.
export function parallelWallMinMax(rho, rA, rB, h = 0) {
  const inMin = Math.max(0, rho - (rA + rB), Math.abs(rA - rB) - rho);
  return { min: Math.hypot(h, inMin), max: Math.hypot(h, rho + rA + rB) };
}

// Closest point on segment ab to p. Returns { d, point, t }.
export function distPointSegment(p, a, b) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, a).dot(ab) / (ab.lengthSq() || 1)));
  const point = a.clone().addScaledVector(ab, t);
  return { d: p.distanceTo(point), point, t };
}

// Plane/triangle intersection segment. Writes the two endpoints into outA /
// outB and returns true, or returns false when the triangle doesn't cross
// the plane (coplanar triangles are treated as not crossing — their edges
// belong to neighbouring triangles' segments). Vertices lying exactly on
// the plane count as segment endpoints, so a cut through a vertex ring
// still produces its outline.
export function triPlaneSegment(pa, pb, pc, plane, outA, outB) {
  const da = plane.distanceToPoint(pa);
  const db = plane.distanceToPoint(pb);
  const dc = plane.distanceToPoint(pc);
  const zeros = (da === 0 ? 1 : 0) + (db === 0 ? 1 : 0) + (dc === 0 ? 1 : 0);
  if (zeros === 3) return false; // fully coplanar — neighbours own these edges
  let n = 0;
  const put = (v) => {
    (n === 0 ? outA : outB).copy(v);
    n++;
  };
  const verts = [[pa, da], [pb, db], [pc, dc]];
  for (const [p, d] of verts) if (d === 0 && n < 2) put(p);
  const lerped = new THREE.Vector3();
  const pairs = [[pa, pb, da, db], [pb, pc, db, dc], [pc, pa, dc, da]];
  for (const [p, q, dp, dq] of pairs) {
    if (n === 2) break;
    if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
      put(lerped.copy(p).lerp(q, dp / (dp - dq)));
    }
  }
  // Two distinct endpoints only: a lone on-plane vertex (n===1) is a touch,
  // not a crossing.
  return n === 2 && outA.distanceToSquared(outB) > 0;
}
