#!/usr/bin/env node
// Offline verifier for the measurement-tool fitting math (web/bomdom/fitmath.js).
//
// Two BomDom exports are measured through the fitmath API, each against
// dimensions known from part names / vendor catalogues:
//
//  1. scripts/fixtures/Cage2-sjm_BomDom.html — SolidWorks-origin (COM glTF
//     export), Draco-compressed and quantized to 14 bits. 16 Thorlabs ER rods
//     (Ø6.000 mm x 81.280 mm, axes on a 30.000 mm cage grid). This is the
//     noisy, real-world case the tool was built for.
//  2. docs/index.html — the demo-site Domitron 3D printer, FreeCAD/STEP-origin,
//     plain float32 geometry whose tessellation vertices lie ON the B-rep
//     surfaces (fits come back with ~0 rms). Clean metric AND inch nominals.
//
// Everything runs offline with plain Node — no npm install at the repo root,
// no SolidWorks, no FreeCAD (Draco decoder from web/node_modules/three).
//
// Run:  node scripts/verify_measure_math.mjs           (both assets, PASS/FAIL)
//       node scripts/verify_measure_math.mjs --dump    (mesh census only; works
//                                                       before fitmath.js exists)
//       node scripts/verify_measure_math.mjs --html <bomdom.html>
//                                                      (one export; the asset
//                                                       profile is auto-detected)
//       node scripts/verify_measure_math.mjs --fitmath <path.mjs>
//                                                      (verify an alternative
//                                                       fitmath implementation)
// Exits 0 on all-pass, 1 on any failed check, 2 when fitmath.js is missing.
//
// Cage2 selection notes (measured on this asset, see issue #3 measurement work):
//  - Four rods sit in a tilted cage segment, so rods are identified by their
//    LOCAL mesh AABB (6 x 6 x 81.28 mm) + unit world scale, not the world AABB.
//  - The ER3 mesh is ~90% end detail (internal threads/sockets, median vertex
//    radius 1.13 mm) and its barrel end ring dips one facet into a round-over
//    (r = 2.981 mm). fitCylinder is therefore fed only barrel-facet corners
//    within (2.99, 3.01) mm of the AABB-axis — the harness equivalent of the
//    user picking the barrel surface — which spans two axial vertex rings.
//  - Draco quantization step = maxExtent/16383 (~5 µm on the rod), hence the
//    10–20 µm tolerances.
// Domitron notes (2026-09-04):
//  - "Smooth Rod 8mmD 400mmL" is 500.000 mm long in the model despite its
//    name; the 6 rods form 3 parallel pairs at 150.000 / 412.500 / 59.600 mm.
//  - Cylinders are coarse 26-gons; barrel picks take facet corners within
//    ±0.02 mm of the nominal radius (no round-overs to dodge here).
//  - Inch-nominal parts prove the unit switcher's raw values: "025 inner 075
//    outer" = Ø0.250"/Ø0.750", "01875 inner 05 outer" = Ø0.1875"/Ø0.500",
//    1515 extrusions 1.500" across the flats x 16.000" long, acrylic 1/8".

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
// Repo root has no node_modules; three lives under web/ (the same file that
// fitmath's bare 'three' specifier resolves to, so Vector3 classes are shared).
import * as THREE from '../web/node_modules/three/build/three.module.js';
import { extractGlbFromHtml, parseGlb, loadDraco, usesDraco, collectInstances, triangleData, applyMat, applyMatDir }
  from './lib/glb_mesh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const DEFAULT_ASSETS = [
  path.join(repo, 'scripts', 'fixtures', 'Cage2-sjm_BomDom.html'),
  path.join(repo, 'docs', 'index.html'),
];
const DRACO_DIR = path.join(repo, 'web', 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const FITMATH = argAfter('--fitmath') ? path.resolve(argAfter('--fitmath')) : path.join(repo, 'web', 'bomdom', 'fitmath.js');

const MM = 1000; // glTF units are meters
const IN = 25.4;
const fmt = (v, d = 4) => v.toFixed(d);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const unitScale = (inst) => inst.worldScale.every((s) => Math.abs(s - 1) < 1e-3);

// ---------------------------------------------------------------------------
// Geometry helpers shared by both asset profiles
// ---------------------------------------------------------------------------
// Frame along one local AABB axis, carried into world space — works for tilted
// parts too, unlike the world AABB. 'long' / 'short' pick by extent; 'odd'
// picks the extent unlike the other two (a spacer's axis, thick or thin).
function frameAlong(inst, which) {
  const e = inst.localAabb.extent;
  let k;
  if (which === 'long') k = e.indexOf(Math.max(...e));
  else if (which === 'short') k = e.indexOf(Math.min(...e));
  else {
    const s = e.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    k = Math.abs(s[0][0] - s[1][0]) < Math.abs(s[1][0] - s[2][0]) ? s[2][1] : s[0][1];
  }
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

// Barrel pick: facets parallel to the axis whose corners lie on the nominal
// cylinder (radius rMm ± band). One point (+ its facet normal) per corner.
function barrelPoints(inst, axis, rMm, band) {
  const sinTol = Math.sin(3 * Math.PI / 180);
  const pts = [], nrm = [];
  for (const t of triangleData(inst)) {
    if (Math.abs(dot3(t.n, axis.dir)) >= sinTol) continue;
    for (const i of t.i) {
      if (Math.abs(radialMm(inst, axis, i) - rMm) > band) continue;
      pts.push(vAt(inst, i));
      nrm.push(new THREE.Vector3(t.n[0], t.n[1], t.n[2]));
    }
  }
  return { pts, nrm };
}

// Fit a cylinder at a nominal radius; cyl is null when the pick is too thin.
function fitAt(fm, inst, axis, rMm, band, minPts = 24) {
  const { pts, nrm } = barrelPoints(inst, axis, rMm, band);
  if (pts.length < minPts) return { pts: pts.length, cyl: null };
  const cyl = fm.fitCylinder(pts, nrm);
  return { pts: pts.length, cyl: cyl && isFinite(cyl.radius) ? cyl : null };
}

// Extent of every vertex along a direction (THREE.Vector3), in mm.
function extentAlong(inst, d) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < inst.worldPos.length / 3; i++) {
    const p = inst.worldPos[i * 3] * d.x + inst.worldPos[i * 3 + 1] * d.y + inst.worldPos[i * 3 + 2] * d.z;
    if (p < lo) lo = p; if (p > hi) hi = p;
  }
  return (hi - lo) * MM;
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

// Fit both end planes; separation along the axis + worst rms, or null.
function planeSeparation(fm, inst, axis) {
  const [capA, capB] = capVerts(inst, axis);
  const plA = capA.length >= 3 ? fm.fitPlane(capA) : null;
  const plB = capB.length >= 3 ? fm.fitPlane(capB) : null;
  if (!plA || !plB) return null;
  const n = plA.normal.clone();
  if (dot3([n.x, n.y, n.z], axis.dir) < 0) n.negate();
  return {
    sep: Math.abs(plB.point.clone().sub(plA.point).dot(n)) * MM,
    rmsUm: Math.max(plA.rms, plB.rms) * MM * 1000,
    verts: [capA.length, capB.length],
  };
}

// Track the largest deviation and who produced it.
const worst = () => ({ dev: 0, who: '-', note(d, who) { if (Math.abs(d) > Math.abs(this.dev)) { this.dev = d; this.who = who; } } });
const shortName = (inst) => `${inst.name.slice(0, 18)} (${inst.nodeIndex})`;

// Rod suite shared by both assets: cylinder fit + length per rod, parallel-pair
// spacings through lineLineClosest, end-face planes on the first rod.
// rods = instances, spec = { dia, len, band, spacing: (spacings[]) => {ok, text} }.
function rodChecks(fm, check, rods, spec) {
  console.log('per-rod measurements:');
  console.log('  rod (node)                  barrel pts   dia mm    dev um   len mm     dev um   fit rms um');
  const wDia = worst(), wLen = worst();
  let diaOk = rods.length > 0, lenOk = rods.length > 0;
  for (const rod of rods) {
    const axis = frameAlong(rod, 'long');
    rod.axisGuess = axis;
    const label = shortName(rod).padEnd(26);
    const { pts, cyl } = fitAt(fm, rod, axis, spec.dia / 2, spec.band, 50);
    if (!cyl) {
      diaOk = lenOk = false;
      console.log(`  ${label}  ${String(pts).padStart(10)}   fitCylinder ${pts >= 50 ? 'returned null' : 'skipped: too few points'}`);
      continue;
    }
    rod.cyl = cyl;
    const dia = cyl.radius * 2 * MM;
    wDia.note(dia - spec.dia, rod.name);
    if (Math.abs(dia - spec.dia) > 0.010) diaOk = false;
    const len = extentAlong(rod, cyl.axisDir);
    wLen.note(len - spec.len, rod.name);
    if (Math.abs(len - spec.len) > 0.020) lenOk = false;
    console.log(`  ${label}  ${String(pts).padStart(10)}   ${fmt(dia)}  ${fmt((dia - spec.dia) * 1000, 1).padStart(7)}   ${fmt(len)}  ${fmt((len - spec.len) * 1000, 1).padStart(7)}   ${fmt(cyl.rms * MM * 1000, 2).padStart(10)}`);
  }
  console.log('');
  check('B', `fitted rod diameter ${fmt(spec.dia, 3)} +/- 0.010 mm (all rods)`, diaOk,
    `worst ${fmt(spec.dia + wDia.dev)} mm (dev ${fmt(wDia.dev * 1000, 1)} um) on ${wDia.who}`);
  check('C', `rod length along fitted axis ${fmt(spec.len, 3)} +/- 0.020 mm`, lenOk,
    lenOk ? `all rods in tolerance (worst dev ${fmt(wLen.dev * 1000, 1)} um)` : 'see per-rod table');

  // D. pairwise axis-to-axis distances via lineLineClosest (parallel case).
  // Fitted axes of physically parallel rods differ by ~1e-4 rad (Cage2) and
  // for such near-parallel skew lines the infinite-line closest approach is
  // meaningless (they "cross" far outside the assembly). So the parallel
  // branch is exercised deterministically with identical direction vectors —
  // the angular difference changes the true spacing by well under a nanometer
  // — and the behavior on raw near-parallel input is reported as a diagnostic.
  const fitted = rods.filter((r) => r.cyl);
  const spacings = [];
  let branchMisses = 0, rawDivergent = 0;
  for (let i = 0; i < fitted.length; i++) {
    for (let j = i + 1; j < fitted.length; j++) {
      const a = fitted[i].cyl, b = fitted[j].cyl;
      if (Math.abs(a.axisDir.dot(b.axisDir)) < Math.cos(0.5 * Math.PI / 180)) continue; // not a parallel pair
      const r = fm.lineLineClosest(a.axisPoint.clone(), a.axisDir.clone(), b.axisPoint.clone(), a.axisDir.clone());
      if (!r.parallel) branchMisses++;
      const raw = fm.lineLineClosest(a.axisPoint.clone(), a.axisDir.clone(), b.axisPoint.clone(), b.axisDir.clone());
      if (Math.abs(raw.dist - r.dist) * MM > 0.001) rawDivergent++;
      spacings.push(r.dist * MM);
    }
  }
  check('D0', 'lineLineClosest flags identical dirs as parallel', branchMisses === 0,
    branchMisses ? `parallel=false on ${branchMisses} pair(s) despite d1 === d2` : 'ok');
  spec.spacing(check, spacings);
  if (rawDivergent) {
    console.log(`note: on raw fitted axes (near-parallel skew input) lineLineClosest diverged >1 um from the ` +
      `parallel-case spacing for ${rawDivergent} pair(s); the measure tool should snap near-parallel dirs before calling it`);
  }

  // E. fitPlane on the first rod's end faces + separation of the two planes
  const rod = fitted[0];
  const ps = rod ? planeSeparation(fm, rod, rod.axisGuess) : null;
  if (ps) {
    check('E1', 'rod end-face plane fit rms < 0.002 mm (both faces)', ps.rmsUm < 2,
      `worst rms ${fmt(ps.rmsUm, 3)} um (${ps.verts.join('/')} verts)`);
    check('E2', `rod end-plane separation ${fmt(spec.len, 3)} +/- 0.02 mm`, Math.abs(ps.sep - spec.len) <= 0.02,
      `${fmt(ps.sep)} mm (dev ${fmt((ps.sep - spec.len) * 1000, 1)} um)`);
  } else {
    const why = rod ? 'fitPlane returned null' : 'no fitted rod available';
    check('E1', 'rod end-face plane fit rms < 0.002 mm (both faces)', false, why);
    check('E2', `rod end-plane separation ${fmt(spec.len, 3)} +/- 0.02 mm`, false, why);
  }
}

// ---------------------------------------------------------------------------
// Asset profile: Cage2 (SolidWorks, Draco, 16 Thorlabs ER rods)
// ---------------------------------------------------------------------------
const CAGE = { len: 81.280, dia: 6.000, grid: 30.000, diag: 30 * Math.SQRT2, count: 16, band: 0.01 };
function isRodLike(inst) {
  const e = [...inst.localAabb.extent].map((v) => v * MM).sort((a, b) => a - b);
  return Math.abs(e[0] - CAGE.dia) <= 0.2 && Math.abs(e[1] - CAGE.dia) <= 0.2
    && Math.abs(e[2] - CAGE.len) <= 0.5 && unitScale(inst);
}
const cage2 = {
  label: 'Cage2 (SolidWorks COM export, Draco 14-bit)',
  detect: (instances) => instances.filter(isRodLike).length >= 8,
  census(instances) {
    const rods = instances.filter(isRodLike);
    console.log(`\nrod-like instances (6 x 6 x 81.28 mm local AABB): ${rods.length} (expect ${CAGE.count})`);
    if (!rods.length) return;
    // Composition diagnostic for the fitmath author: the rod mesh is mostly end
    // detail; only the (2.99, 3.01) mm radial band is true barrel surface.
    const rod = rods[0];
    const axis = frameAlong(rod, 'long');
    const bands = [[0, 2.5], [2.5, 2.99], [2.99, 3.01], [3.01, 99]];
    const hist = bands.map(() => 0);
    for (let i = 0; i < rod.worldPos.length / 3; i++) {
      const r = radialMm(rod, axis, i);
      for (let b = 0; b < bands.length; b++) if (r >= bands[b][0] && r < bands[b][1]) { hist[b]++; break; }
    }
    console.log(`radial profile of first rod (${rod.name}, ${rod.worldPos.length / 3} verts): ` +
      bands.map((b, k) => `[${b[0]},${b[1]}) ${hist[k]}`).join('  '));
    const { pts } = barrelPoints(rod, axis, CAGE.dia / 2, CAGE.band);
    const caps = capVerts(rod, axis);
    console.log(`barrel pick: ${pts.length} corner points; end-face picks: ${caps[0].length} + ${caps[1].length} verts`);
  },
  run(fm, check, instances) {
    const rods = instances.filter(isRodLike);
    check('A', 'rod instances found (6 x 6 x 81.28 mm local AABB)', rods.length === CAGE.count, `${rods.length} (expect ${CAGE.count})`);
    rodChecks(fm, check, rods, {
      dia: CAGE.dia, len: CAGE.len, band: CAGE.band,
      spacing(chk, spacings) {
        const near30 = spacings.filter((d) => d > 29 && d < 31);
        const diag = spacings.filter((d) => d > 41.5 && d < 43.5);
        const good30 = near30.filter((d) => Math.abs(d - CAGE.grid) <= 0.015);
        chk('D1', `parallel rod pairs at ${fmt(CAGE.grid, 3)} +/- 0.015 mm (need >= 12)`, good30.length >= 12,
          `${good30.length} of ${near30.length} pairs in (29,31) mm` +
          (near30.length ? `; worst dev ${fmt(Math.max(...near30.map((d) => Math.abs(d - CAGE.grid))) * 1000, 1)} um` : ''));
        const diagOk = diag.length >= 1 && diag.every((d) => Math.abs(d - CAGE.diag) <= 0.02);
        chk('D2', `diagonal pairs at ${fmt(CAGE.diag)} +/- 0.02 mm`, diagOk,
          diag.length ? `${diag.length} pairs; worst dev ${fmt(Math.max(...diag.map((d) => Math.abs(d - CAGE.diag))) * 1000, 1)} um`
                      : 'no distances found in (41.5,43.5) mm');
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Asset profile: Domitron (FreeCAD/STEP, plain float32, named parts)
// ---------------------------------------------------------------------------
const ROD = { name: 'Smooth Rod 8mmD 400mmL', count: 6, dia: 8.000, len: 500.000, spacings: [150.000, 412.500, 59.600], band: 0.02 };
const SPACER = { name: '025 inner 075 outer', count: 11, bore: 0.250 * IN, od: 0.750 * IN };
const WASHER = { name: '01875 inner 05 outer', count: 148, bore: 0.1875 * IN, od: 0.500 * IN };
const EXTRUSION = { name: 'Aluminum Extrusions', count: 7, flats: 1.500 * IN, len: 16.000 * IN };
const ACRYLIC = { name: '4x4 1-8 Thick Acryllic Sheet', count: 7, thick: 0.125 * IN };
const MOTOR = { name: 'Nema 17 Stepper Motor', count: 5, shaft: 5.000, boss: 22.000, len: 63.000 };
const DOMITRON_GROUPS = [ROD, SPACER, WASHER, EXTRUSION, ACRYLIC, MOTOR];
// STEP node names carry a trailing instance index ("Smooth Rod 8mmD 400mmL 3").
const baseName = (n) => (n || '').replace(/[\s_-]*\d+$/, '');
const byName = (instances, name) => instances.filter((i) => baseName(i.name) === name && unitScale(i));
const domitron = {
  label: 'Domitron 3D printer (FreeCAD/STEP export, plain float32)',
  detect: (instances) => byName(instances, ROD.name).length > 0,
  census(instances) {
    console.log('\nfeature groups used by the assertions:');
    for (const g of DOMITRON_GROUPS) {
      const n = byName(instances, g.name).length;
      console.log(`  ${g.name.padEnd(32)} ${String(n).padStart(4)} found (expect ${g.count})`);
    }
  },
  run(fm, check, instances) {
    const rods = byName(instances, ROD.name);
    check('A', `rod instances found ("${ROD.name}")`, rods.length === ROD.count, `${rods.length} (expect ${ROD.count})`);
    rodChecks(fm, check, rods, {
      dia: ROD.dia, len: ROD.len, band: ROD.band,
      spacing(chk, spacings) {
        // Each nominal spacing must be hit by exactly one pair, within 15 µm.
        const unmatched = [...spacings];
        const hits = ROD.spacings.map((want) => {
          const k = unmatched.findIndex((d) => Math.abs(d - want) <= 0.015);
          return k < 0 ? null : unmatched.splice(k, 1)[0] - want;
        });
        chk('D1', `parallel rod pairs at ${ROD.spacings.map((s) => fmt(s, 1)).join(' / ')} mm +/- 0.015`,
          hits.every((h) => h !== null) && unmatched.length === 0,
          `${spacings.length} parallel pairs: ${spacings.map((d) => fmt(d, 3)).join(', ')} mm` +
          (hits.every((h) => h !== null) ? `; worst dev ${fmt(Math.max(...hits.map(Math.abs)) * 1000, 1)} um` : ''));
      },
    });

    // J. Inch-nominal turned parts: bore + OD cylinder fits on every instance.
    // These are the raw values the unit switcher converts (Ø6.350 mm = 0.250").
    for (const [id, part] of [['J1', SPACER], ['J2', WASHER]]) {
      const insts = byName(instances, part.name);
      const wBore = worst(), wOd = worst();
      let ok = insts.length === part.count;
      for (const inst of insts) {
        const axis = frameAlong(inst, 'odd');
        const b = fitAt(fm, inst, axis, part.bore / 2, ROD.band), o = fitAt(fm, inst, axis, part.od / 2, ROD.band);
        if (!b.cyl || !o.cyl) { ok = false; continue; }
        const bd = b.cyl.radius * 2 * MM - part.bore, od = o.cyl.radius * 2 * MM - part.od;
        wBore.note(bd, shortName(inst)); wOd.note(od, shortName(inst));
        if (Math.abs(bd) > 0.010 || Math.abs(od) > 0.010) ok = false;
      }
      check(id, `${part.name}: bore Ø${fmt(part.bore, 4)} / OD Ø${fmt(part.od, 3)} mm +/- 0.010 (x${part.count})`, ok,
        `${insts.length} found; worst bore dev ${fmt(wBore.dev * 1000, 1)} um, OD dev ${fmt(wOd.dev * 1000, 1)} um`);
    }

    // K. 1515 extrusion: fitPlane on the two outer flats (1.500" apart) and on
    // the cut ends (16.000" apart) — plane<->plane distance in both directions.
    {
      const insts = byName(instances, EXTRUSION.name);
      const wF = worst(), wL = worst();
      let ok = insts.length === EXTRUSION.count, rmsMax = 0;
      for (const inst of insts) {
        const f = planeSeparation(fm, inst, frameAlong(inst, 'short'));
        const l = planeSeparation(fm, inst, frameAlong(inst, 'long'));
        if (!f || !l) { ok = false; continue; }
        rmsMax = Math.max(rmsMax, f.rmsUm, l.rmsUm);
        wF.note(f.sep - EXTRUSION.flats, shortName(inst)); wL.note(l.sep - EXTRUSION.len, shortName(inst));
        if (Math.abs(f.sep - EXTRUSION.flats) > 0.010 || Math.abs(l.sep - EXTRUSION.len) > 0.020) ok = false;
      }
      check('K', `1515 extrusion flats ${fmt(EXTRUSION.flats, 3)} mm & length ${fmt(EXTRUSION.len, 3)} mm (x${EXTRUSION.count})`, ok,
        `${insts.length} found; worst flats dev ${fmt(wF.dev * 1000, 1)} um, length dev ${fmt(wL.dev * 1000, 1)} um, plane rms ${fmt(rmsMax, 3)} um`);
    }

    // L. 1/8" acrylic sheets: thickness as plane<->plane (4 verts per face — the
    // smallest pick fitPlane must handle).
    {
      const insts = byName(instances, ACRYLIC.name);
      const w = worst();
      let ok = insts.length === ACRYLIC.count;
      for (const inst of insts) {
        const t = planeSeparation(fm, inst, frameAlong(inst, 'short'));
        if (!t) { ok = false; continue; }
        w.note(t.sep - ACRYLIC.thick, shortName(inst));
        if (Math.abs(t.sep - ACRYLIC.thick) > 0.010) ok = false;
      }
      check('L', `acrylic sheet thickness ${fmt(ACRYLIC.thick, 3)} mm (1/8", x${ACRYLIC.count})`, ok,
        `${insts.length} found; worst dev ${fmt(w.dev * 1000, 1)} um`);
    }

    // M. Nema 17: shaft Ø5 and pilot boss Ø22 are coaxial cylinders of very
    // different radius on one mesh — the pick-by-radius must separate them.
    {
      const insts = byName(instances, MOTOR.name);
      const wS = worst(), wB = worst(), wL = worst();
      let ok = insts.length === MOTOR.count;
      for (const inst of insts) {
        const axis = frameAlong(inst, 'long');
        const s = fitAt(fm, inst, axis, MOTOR.shaft / 2, ROD.band), b = fitAt(fm, inst, axis, MOTOR.boss / 2, ROD.band);
        if (!s.cyl || !b.cyl) { ok = false; continue; }
        const sd = s.cyl.radius * 2 * MM - MOTOR.shaft, bd = b.cyl.radius * 2 * MM - MOTOR.boss;
        const ld = extentAlong(inst, b.cyl.axisDir) - MOTOR.len;
        wS.note(sd, shortName(inst)); wB.note(bd, shortName(inst)); wL.note(ld, shortName(inst));
        if (Math.abs(sd) > 0.010 || Math.abs(bd) > 0.010 || Math.abs(ld) > 0.020) ok = false;
        const coax = fm.lineLineClosest(s.cyl.axisPoint.clone(), b.cyl.axisDir.clone(), b.cyl.axisPoint.clone(), b.cyl.axisDir.clone());
        if (coax.dist * MM > 0.010) ok = false; // shaft and boss share an axis
      }
      check('M', `Nema 17 shaft Ø${fmt(MOTOR.shaft, 3)} / boss Ø${fmt(MOTOR.boss, 3)} / length ${fmt(MOTOR.len, 3)} mm (x${MOTOR.count})`, ok,
        `${insts.length} found; worst shaft dev ${fmt(wS.dev * 1000, 1)} um, boss dev ${fmt(wB.dev * 1000, 1)} um, length dev ${fmt(wL.dev * 1000, 1)} um`);
    }
  },
};

const PROFILES = [cage2, domitron];

// ---------------------------------------------------------------------------
// Pure-math regressions (asset independent, run once)
// ---------------------------------------------------------------------------
function mathChecks(fm, check) {
  const near = (v, want, tol = 1e-12) => Math.abs(v - want) <= tol;

  // F. plane <-> circle rim distance extremes (regression: the old formula
  // used base +/- r unconditionally, which measures a distance to nothing
  // whenever the rim's axis isn't lying IN the plane).
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

  // H. segment-segment closest distance (regression: straight edges were
  // measured as infinite lines — collinear edges apart along the axis read 0)
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const h1 = fm.segSegClosest(V(0, 0, 0), V(0.010, 0, 0), V(0.030, 0, 0), V(0.040, 0, 0));
  check('H1', 'seg<->seg: collinear edges read the axial gap', near(h1.dist, 0.020),
    `${fmt(h1.dist * MM)} mm (want 20)`);
  const h2 = fm.segSegClosest(V(0, 0, 0), V(0.010, 0, 0), V(0, 0.003, 0.004), V(0.010, 0.003, 0.004));
  check('H2', 'seg<->seg: parallel offset reads the perpendicular', near(h2.dist, 0.005),
    `${fmt(h2.dist * MM)} mm (want 5)`);
  const h3 = fm.segSegClosest(V(-0.005, 0, 0), V(0.005, 0, 0), V(0, -0.005, 0.002), V(0, 0.005, 0.002));
  check('H3', 'seg<->seg: crossing skew pair reads the crossing gap', near(h3.dist, 0.002),
    `${fmt(h3.dist * MM)} mm (want 2)`);
}

// ---------------------------------------------------------------------------
// Census (--dump)
// ---------------------------------------------------------------------------
function printCensus(instances, profile) {
  console.log(`mesh census — ${instances.length} mesh instances in the default scene\n`);
  console.log('  node  name                                      mesh  tris    local extent mm (x, y, z)');
  for (const inst of instances) {
    const e = inst.localAabb.extent.map((v) => fmt(v * MM, 3).padStart(9)).join(' ');
    console.log(`  ${String(inst.nodeIndex).padStart(4)}  ${(inst.name || '').slice(0, 40).padEnd(41)} ` +
      `${String(inst.mesh).padStart(4)}  ${String(inst.indices.length / 3).padStart(6)}  ${e}`);
  }
  if (profile) profile.census(instances);
}

// ---------------------------------------------------------------------------
async function loadFitmath() {
  if (!existsSync(FITMATH)) {
    console.error(`fitmath.js not present yet (looked for ${FITMATH}).`);
    console.error('Run with --dump to exercise the GLB extraction/decode pipeline on its own.');
    process.exit(2);
  }
  const fm = await import(pathToFileURL(FITMATH).href);
  for (const name of ['fitPlane', 'fitCircle3D', 'fitLine3D', 'fitCylinder', 'lineLineClosest',
                      'planeCircleMinMax', 'parallelWallMinMax', 'segSegClosest']) {
    if (typeof fm[name] !== 'function') {
      console.error(`fitmath.js does not export ${name}()`);
      process.exit(1);
    }
  }
  return fm;
}

function printResults(checks) {
  console.log('result  id  check                                                            measured');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}    ${c.id.padEnd(3)} ${c.label.padEnd(64)} ${c.measured}`);
  }
  return checks.filter((c) => !c.ok).length;
}

async function decodeAsset(file, dracoCache) {
  const glb = extractGlbFromHtml(file);
  const { gltf, bin } = parseGlb(glb);
  let draco = null;
  if (usesDraco(gltf)) draco = dracoCache.mod || (dracoCache.mod = await loadDraco(DRACO_DIR));
  const instances = collectInstances(draco, gltf, bin);
  console.log(`decoded ${path.basename(file)}: GLB ${(glb.length / 1024).toFixed(0)} KB (${draco ? 'Draco' : 'plain float32'}), ` +
    `${gltf.meshes.length} meshes, ${instances.length} instances, ` +
    `${instances.reduce((s, i) => s + i.indices.length / 3, 0)} world-space triangles`);
  return instances;
}

async function main() {
  const dump = process.argv.includes('--dump');
  const assets = argAfter('--html') ? [path.resolve(argAfter('--html'))] : DEFAULT_ASSETS;
  const dracoCache = {};
  let failed = 0;
  const fm = dump ? null : await loadFitmath();

  for (const file of assets) {
    console.log(`\n=== ${path.relative(repo, file) || file} ===`);
    if (!existsSync(file)) {
      console.log(`FAIL    --  asset missing: ${file}`);
      failed++;
      continue;
    }
    const instances = await decodeAsset(file, dracoCache);
    const profile = PROFILES.find((p) => p.detect(instances));
    if (!profile) {
      console.log('FAIL    --  no asset profile matched (expected Cage2 ER rods or Domitron part names)');
      failed++;
      continue;
    }
    console.log(`profile: ${profile.label}\n`);
    if (dump) { printCensus(instances, profile); continue; }
    const checks = [];
    profile.run(fm, (id, label, ok, measured) => checks.push({ id, label, ok: !!ok, measured }), instances);
    failed += printResults(checks);
  }

  if (!dump) {
    console.log('\n=== fitmath pure-math regressions ===');
    const checks = [];
    mathChecks(fm, (id, label, ok, measured) => checks.push({ id, label, ok: !!ok, measured }));
    failed += printResults(checks);
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
    if (failed) process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
