#!/usr/bin/env node
// Offline verifier for the measurement-tool fitting math (web/bomdom/fitmath.js).
//
// Extracts the GLB embedded in docs/samples/Cage2-sjm_BomDom.html, decodes the
// Draco primitives with the decoder shipped inside web/node_modules/three
// (see scripts/lib/glb_mesh.mjs), and measures the 16 Thorlabs ER rods
// (Ø6.000 mm x 81.280 mm, axes on a 30.000 mm cage grid) through the fitmath
// API. Everything runs offline with plain Node — no npm install at the repo
// root, no SolidWorks.
//
// Run:  node scripts/verify_measure_math.mjs           (full PASS/FAIL suite)
//       node scripts/verify_measure_math.mjs --dump    (mesh census only; works
//                                                       before fitmath.js exists)
//       node scripts/verify_measure_math.mjs --fitmath <path.mjs>
//                                                      (verify an alternative
//                                                       fitmath implementation)
// Exits 0 on all-pass, 1 on any failed check, 2 when fitmath.js is missing.
//
// Selection notes (measured on this asset, see issue #3 measurement work):
//  - Four rods sit in a tilted cage segment, so rods are identified by their
//    LOCAL mesh AABB (6 x 6 x 81.28 mm) + unit world scale, not the world AABB.
//  - The ER3 mesh is ~90% end detail (internal threads/sockets, median vertex
//    radius 1.13 mm) and its barrel end ring dips one facet into a round-over
//    (r = 2.981 mm). fitCylinder is therefore fed only barrel-facet corners
//    within (2.99, 3.01) mm of the AABB-axis — the harness equivalent of the
//    user picking the barrel surface — which spans two axial vertex rings.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
// Repo root has no node_modules; three lives under web/ (the same file that
// fitmath's bare 'three' specifier resolves to, so Vector3 classes are shared).
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { extractGlbFromHtml, parseGlb, loadDraco, collectInstances, triangleData, applyMat, applyMatDir }
  from './lib/glb_mesh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const SAMPLE_HTML = path.join(repo, 'docs', 'samples', 'Cage2-sjm_BomDom.html');
const DRACO_DIR = path.join(repo, 'web', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const fmArg = process.argv.indexOf('--fitmath');
const FITMATH = fmArg > -1 && process.argv[fmArg + 1]
  ? path.resolve(process.argv[fmArg + 1])
  : path.join(repo, 'web', 'bomdom', 'fitmath.js');

const MM = 1000; // glTF units are meters
const ROD_LEN = 81.280, ROD_DIA = 6.000, GRID = 30.000, DIAG = 30 * Math.SQRT2;
const fmt = (v, d = 4) => v.toFixed(d);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

// ---------------------------------------------------------------------------
// Rod identification + per-rod frames
// ---------------------------------------------------------------------------
function isRodLike(inst) {
  const e = [...inst.localAabb.extent].map((v) => v * MM).sort((a, b) => a - b);
  return Math.abs(e[0] - ROD_DIA) <= 0.2 && Math.abs(e[1] - ROD_DIA) <= 0.2
    && Math.abs(e[2] - ROD_LEN) <= 0.5
    && inst.worldScale.every((s) => Math.abs(s - 1) < 1e-3);
}

// Long-axis frame estimated from the local AABB, carried into world space
// (works for the tilted cage segment too, unlike the world AABB).
function rodAxis(inst) {
  const e = inst.localAabb.extent;
  const k = e.indexOf(Math.max(...e));
  const d = [0, 0, 0]; d[k] = 1;
  const c = inst.localAabb.lo.map((v, i) => (v + inst.localAabb.hi[i]) / 2);
  return { dir: norm3(applyMatDir(inst.world, d)), point: applyMat(inst.world, c) };
}

const projOf = (inst, axis, i) =>
  inst.worldPos[i * 3] * axis.dir[0] + inst.worldPos[i * 3 + 1] * axis.dir[1] + inst.worldPos[i * 3 + 2] * axis.dir[2];

function radialMm(inst, axis, i) {
  const d = [inst.worldPos[i * 3] - axis.point[0],
             inst.worldPos[i * 3 + 1] - axis.point[1],
             inst.worldPos[i * 3 + 2] - axis.point[2]];
  const along = dot3(d, axis.dir);
  return Math.sqrt(Math.max(0, dot3(d, d) - along * along)) * MM;
}

const vAt = (inst, i) => new THREE.Vector3(inst.worldPos[i * 3], inst.worldPos[i * 3 + 1], inst.worldPos[i * 3 + 2]);

// Barrel pick: facets perpendicular to the axis whose corners lie on the
// nominal cylinder. One point (+ its facet normal, index-aligned) per corner.
function barrelPoints(inst, axis) {
  const sinTol = Math.sin(3 * Math.PI / 180);
  const pts = [], nrm = [];
  for (const t of triangleData(inst)) {
    if (Math.abs(dot3(t.n, axis.dir)) >= sinTol) continue;
    for (const i of t.i) {
      const r = radialMm(inst, axis, i);
      if (r <= 2.99 || r >= 3.01) continue;
      pts.push(vAt(inst, i));
      nrm.push(new THREE.Vector3(t.n[0], t.n[1], t.n[2]));
    }
  }
  return { pts, nrm };
}

// End-face pick: cap-normal facets (within 5 deg of the axis) whose corners all
// sit within 0.05 mm of the projection extreme — excludes socket bottoms etc.
function capVerts(inst, axis) {
  const cosCap = Math.cos(5 * Math.PI / 180);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < inst.worldPos.length / 3; i++) {
    const p = projOf(inst, axis, i);
    if (p < lo) lo = p; if (p > hi) hi = p;
  }
  const win = 0.05 / MM;
  const sides = [new Set(), new Set()];
  for (const t of triangleData(inst)) {
    if (Math.abs(dot3(t.n, axis.dir)) <= cosCap) continue;
    const ps = t.i.map((i) => projOf(inst, axis, i));
    if (ps.every((p) => p - lo < win)) for (const i of t.i) sides[0].add(i);
    else if (ps.every((p) => hi - p < win)) for (const i of t.i) sides[1].add(i);
  }
  return sides.map((s) => [...s].map((i) => vAt(inst, i)));
}

// ---------------------------------------------------------------------------
// Census (--dump)
// ---------------------------------------------------------------------------
function printCensus(instances) {
  console.log(`mesh census — ${instances.length} mesh instances in the default scene\n`);
  console.log('  node  name                                      mesh  tris    world extent mm (x, y, z)        rod?');
  for (const inst of instances) {
    const e = inst.aabb.extent.map((v) => fmt(v * MM, 3).padStart(9)).join(' ');
    console.log(`  ${String(inst.nodeIndex).padStart(4)}  ${(inst.name || '').slice(0, 40).padEnd(41)} ` +
      `${String(inst.mesh).padStart(4)}  ${String(inst.indices.length / 3).padStart(6)}  ${e}  ${isRodLike(inst) ? 'yes' : ''}`);
  }
  const rods = instances.filter(isRodLike);
  console.log(`\nrod-like instances (by local AABB): ${rods.length} (expect 16)`);

  if (!rods.length) return;
  // Composition diagnostic for the fitmath author: the rod mesh is mostly end
  // detail; only the (2.99, 3.01) mm radial band is true barrel surface.
  const rod = rods[0];
  const axis = rodAxis(rod);
  const bands = [[0, 2.5], [2.5, 2.99], [2.99, 3.01], [3.01, 99]];
  const hist = bands.map(() => 0);
  for (let i = 0; i < rod.worldPos.length / 3; i++) {
    const r = radialMm(rod, axis, i);
    for (let b = 0; b < bands.length; b++) if (r >= bands[b][0] && r < bands[b][1]) { hist[b]++; break; }
  }
  console.log(`radial profile of first rod (${rod.name}, ${rod.worldPos.length / 3} verts): ` +
    bands.map((b, k) => `[${b[0]},${b[1]}) ${hist[k]}`).join('  '));
  const { pts } = barrelPoints(rod, axis);
  const caps = capVerts(rod, axis);
  console.log(`barrel pick: ${pts.length} corner points; end-face picks: ${caps[0].length} + ${caps[1].length} verts`);
}

// ---------------------------------------------------------------------------
// Assertions (need fitmath)
// ---------------------------------------------------------------------------
async function loadFitmath() {
  if (!existsSync(FITMATH)) {
    console.error(`fitmath.js not present yet (looked for ${FITMATH}).`);
    console.error('Run with --dump to exercise the GLB extraction/decode pipeline on its own.');
    process.exit(2);
  }
  const fm = await import(pathToFileURL(FITMATH).href);
  for (const name of ['fitPlane', 'fitCircle3D', 'fitLine3D', 'fitCylinder', 'lineLineClosest',
                      'planeCircleMinMax', 'parallelWallMinMax']) {
    if (typeof fm[name] !== 'function') {
      console.error(`fitmath.js does not export ${name}()`);
      process.exit(1);
    }
  }
  return fm;
}

function runAssertions(fm, instances) {
  const checks = [];
  const check = (id, label, ok, measured) => checks.push({ id, label, ok: !!ok, measured });

  // A. rod identification
  const rods = instances.filter(isRodLike);
  check('A', 'rod instances found (6 x 6 x 81.28 mm local AABB)', rods.length === 16, `${rods.length} (expect 16)`);

  // B + C. per-rod cylinder fit and length along the fitted axis
  console.log('per-rod measurements:');
  console.log('  rod (node)                  barrel pts   dia mm    dev um   len mm     dev um   fit rms um');
  let worstDia = 0, worstRod = '-', diaOk = rods.length > 0, lenOk = rods.length > 0;
  for (const rod of rods) {
    const axis = rodAxis(rod);
    rod.axisGuess = axis;
    const label = `${rod.name.slice(0, 18)} (${rod.nodeIndex})`.padEnd(26);
    const { pts, nrm } = barrelPoints(rod, axis);
    const cyl = pts.length >= 50 ? fm.fitCylinder(pts, nrm) : null;
    if (!cyl || !isFinite(cyl.radius)) {
      diaOk = lenOk = false;
      console.log(`  ${label}  ${String(pts.length).padStart(10)}   fitCylinder ${pts.length >= 50 ? 'returned null' : 'skipped: too few points'}`);
      continue;
    }
    rod.cyl = cyl;
    const dia = cyl.radius * 2 * MM;
    if (Math.abs(dia - ROD_DIA) > Math.abs(worstDia)) { worstDia = dia - ROD_DIA; worstRod = rod.name; }
    if (Math.abs(dia - ROD_DIA) > 0.010) diaOk = false;
    // length = extent of ALL rod vertices projected onto the fitted axis
    const d = cyl.axisDir;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < rod.worldPos.length / 3; i++) {
      const p = rod.worldPos[i * 3] * d.x + rod.worldPos[i * 3 + 1] * d.y + rod.worldPos[i * 3 + 2] * d.z;
      if (p < lo) lo = p; if (p > hi) hi = p;
    }
    const len = (hi - lo) * MM;
    if (Math.abs(len - ROD_LEN) > 0.020) lenOk = false;
    console.log(`  ${label}  ${String(pts.length).padStart(10)}   ${fmt(dia)}  ${fmt((dia - ROD_DIA) * 1000, 1).padStart(7)}   ${fmt(len)}  ${fmt((len - ROD_LEN) * 1000, 1).padStart(7)}   ${fmt(cyl.rms * MM * 1000, 2).padStart(10)}`);
  }
  console.log('');
  check('B', `fitted rod diameter ${fmt(ROD_DIA, 3)} +/- 0.010 mm (all rods)`, diaOk,
    `worst ${fmt(ROD_DIA + worstDia)} mm (dev ${fmt(worstDia * 1000, 1)} um) on ${worstRod}`);
  check('C', `rod length along fitted axis ${fmt(ROD_LEN, 3)} +/- 0.020 mm`, lenOk,
    lenOk ? 'all rods in tolerance' : 'see per-rod table');

  // D. pairwise axis-to-axis distances via lineLineClosest (parallel case).
  // Fitted axes of physically parallel rods differ by ~1e-4 rad, and for such
  // near-parallel skew lines the infinite-line closest approach is meaningless
  // (they "cross" far outside the assembly). So the parallel branch is
  // exercised deterministically with identical direction vectors — the angular
  // difference changes the true spacing by well under a nanometer — and the
  // behavior on raw near-parallel input is reported as a diagnostic only.
  const fitted = rods.filter((r) => r.cyl);
  const near30 = [], diag = [];
  let branchMisses = 0, rawDivergent = 0;
  for (let i = 0; i < fitted.length; i++) {
    for (let j = i + 1; j < fitted.length; j++) {
      const a = fitted[i].cyl, b = fitted[j].cyl;
      if (Math.abs(a.axisDir.dot(b.axisDir)) < Math.cos(0.5 * Math.PI / 180)) continue; // not a parallel pair
      const r = fm.lineLineClosest(a.axisPoint.clone(), a.axisDir.clone(), b.axisPoint.clone(), a.axisDir.clone());
      if (!r.parallel) branchMisses++;
      const raw = fm.lineLineClosest(a.axisPoint.clone(), a.axisDir.clone(), b.axisPoint.clone(), b.axisDir.clone());
      if (Math.abs(raw.dist - r.dist) * MM > 0.001) rawDivergent++;
      const mm = r.dist * MM;
      if (mm > 29 && mm < 31) near30.push(mm);
      else if (mm > 41.5 && mm < 43.5) diag.push(mm);
    }
  }
  check('D0', 'lineLineClosest flags identical dirs as parallel', branchMisses === 0,
    branchMisses ? `parallel=false on ${branchMisses} pair(s) despite d1 === d2` : 'ok');
  const good30 = near30.filter((d) => Math.abs(d - GRID) <= 0.015);
  check('D1', `parallel rod pairs at ${fmt(GRID, 3)} +/- 0.015 mm (need >= 12)`, good30.length >= 12,
    `${good30.length} of ${near30.length} pairs in (29,31) mm` +
    (near30.length ? `; worst dev ${fmt(Math.max(...near30.map((d) => Math.abs(d - GRID))) * 1000, 1)} um` : ''));
  const diagOk = diag.length >= 1 && diag.every((d) => Math.abs(d - DIAG) <= 0.02);
  check('D2', `diagonal pairs at ${fmt(DIAG)} +/- 0.02 mm`, diagOk,
    diag.length ? `${diag.length} pairs; worst dev ${fmt(Math.max(...diag.map((d) => Math.abs(d - DIAG))) * 1000, 1)} um`
                : 'no distances found in (41.5,43.5) mm');
  if (rawDivergent) {
    console.log(`note: on raw fitted axes (near-parallel skew input) lineLineClosest diverged >1 um from the ` +
      `parallel-case spacing for ${rawDivergent} pair(s); the measure tool should snap near-parallel dirs before calling it`);
  }

  // E. fitPlane on the first rod's end faces + separation of the two planes
  const rod = fitted[0];
  const [capA, capB] = rod ? capVerts(rod, rod.axisGuess) : [[], []];
  const plA = capA.length >= 3 ? fm.fitPlane(capA) : null;
  const plB = capB.length >= 3 ? fm.fitPlane(capB) : null;
  if (plA && plB) {
    const rmsUm = Math.max(plA.rms, plB.rms) * MM * 1000;
    check('E1', 'end-face plane fit rms < 0.002 mm (both faces)', rmsUm < 2,
      `worst rms ${fmt(rmsUm, 3)} um (${capA.length}/${capB.length} verts)`);
    const n = plA.normal.clone();
    if (dot3([n.x, n.y, n.z], rod.axisGuess.dir) < 0) n.negate();
    const sep = Math.abs(plB.point.clone().sub(plA.point).dot(n)) * MM; // (p2 - p1) . n
    check('E2', `end-plane separation ${fmt(ROD_LEN, 3)} +/- 0.02 mm`, Math.abs(sep - ROD_LEN) <= 0.02,
      `${fmt(sep)} mm (dev ${fmt((sep - ROD_LEN) * 1000, 1)} um)`);
  } else {
    const why = rod ? 'fitPlane returned null' : 'no fitted rod available';
    check('E1', 'end-face plane fit rms < 0.002 mm (both faces)', false, why);
    check('E2', `end-plane separation ${fmt(ROD_LEN, 3)} +/- 0.02 mm`, false, why);
  }

  // F. plane <-> circle rim distance extremes (regression: the old formula
  // used base +/- r unconditionally, which measures a distance to nothing
  // whenever the rim's axis isn't lying IN the plane).
  const near = (v, want, tol = 1e-12) => Math.abs(v - want) <= tol;
  const f1 = fm.planeCircleMinMax(0.010, 0.003, 1); // rim parallel to face, 10 mm off
  check('F1', 'plane<->circle: parallel rim reads min=max=base', near(f1.min, 0.010) && near(f1.max, 0.010),
    `min ${fmt(f1.min * MM)} max ${fmt(f1.max * MM)} mm (want 10/10)`);
  const f2 = fm.planeCircleMinMax(0, 0.003, 1); // rim lying ON the face
  check('F2', 'plane<->circle: rim on the face reads 0..0', near(f2.min, 0) && near(f2.max, 0),
    `min ${fmt(f2.min * MM)} max ${fmt(f2.max * MM)} mm (want 0/0)`);
  const f3 = fm.planeCircleMinMax(0.001, 0.003, 0); // edge-on rim crossing the plane
  check('F3', 'plane<->circle: crossing rim clamps min to 0', near(f3.min, 0) && near(f3.max, 0.004),
    `min ${fmt(f3.min * MM)} max ${fmt(f3.max * MM)} mm (want 0/4)`);

  // G. parallel wall-to-wall extremes (regression: |base - (rA+rB)| reported
  // ~the sum of radii for a shaft nested in a bore instead of the wall gap).
  const g1 = fm.parallelWallMinMax(0, 0.0015, 0.002); // coaxial shaft in bore
  check('G1', 'cyl<->cyl: coaxial shaft-in-bore reads the wall gap', near(g1.min, 0.0005) && near(g1.max, 0.0035),
    `min ${fmt(g1.min * MM)} max ${fmt(g1.max * MM)} mm (want 0.5/3.5)`);
  const g2 = fm.parallelWallMinMax(0.010, 0.0015, 0.002); // side by side
  check('G2', 'cyl<->cyl: side-by-side walls', near(g2.min, 0.0065) && near(g2.max, 0.0135),
    `min ${fmt(g2.min * MM)} max ${fmt(g2.max * MM)} mm (want 6.5/13.5)`);
  const g3 = fm.parallelWallMinMax(0.002, 0.0015, 0.002); // overlapping walls
  check('G3', 'cyl<->cyl: overlapping walls meet at 0', near(g3.min, 0) && near(g3.max, 0.0055),
    `min ${fmt(g3.min * MM)} max ${fmt(g3.max * MM)} mm (want 0/5.5)`);
  const g4 = fm.parallelWallMinMax(0, 0.003, 0.003, 0.005); // coaxial stacked rims
  check('G4', 'circle<->circle: coaxial rims carry the axial gap', near(g4.min, 0.005) && near(g4.max, Math.hypot(0.005, 0.006)),
    `min ${fmt(g4.min * MM)} max ${fmt(g4.max * MM)} mm (want 5/${fmt(Math.hypot(5, 6))})`);

  // H. summary table
  console.log('result  id  check                                                measured');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}    ${c.id.padEnd(3)} ${c.label.padEnd(52)} ${c.measured}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  return failed === 0;
}

// ---------------------------------------------------------------------------
async function main() {
  const dump = process.argv.includes('--dump');
  const glb = extractGlbFromHtml(SAMPLE_HTML);
  const { gltf, bin } = parseGlb(glb);
  const draco = await loadDraco(DRACO_DIR);
  const instances = collectInstances(draco, gltf, bin);
  console.log(`decoded ${path.basename(SAMPLE_HTML)}: GLB ${(glb.length / 1024).toFixed(0)} KB, ` +
    `${gltf.meshes.length} meshes, ${instances.length} instances, ` +
    `${instances.reduce((s, i) => s + i.indices.length / 3, 0)} world-space triangles\n`);

  if (dump) { printCensus(instances); return; }

  const fm = await loadFitmath();
  if (!runAssertions(fm, instances)) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
