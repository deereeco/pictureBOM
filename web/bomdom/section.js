// Section view: one axis-aligned cutting plane driven by a slider, applied
// as a global renderer clipping plane. Global (not per-material) clipping is
// deliberate: it clips every derived material clone, the shared edge lines
// and the selection veils in one assignment, so the never-invalidated
// material cache needs no surgery. The cut is uncapped — closed solids
// render their back faces while the section is on (forceDoubleSide), and a
// bright outline drawn exactly at the cut makes the open section read as
// intentional.

import * as THREE from 'three';
import * as M from './model.js';
import { triPlaneSegment } from './fitmath.js';

const $ = (id) => document.getElementById(id);

const AXIS_UNIT = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Above this, an un-BVH'd geometry skips brute-force outline extraction and
// waits for its bounds tree ('bvh-ready' recomputes everything).
const BRUTE_MAX_TRIS = 80000;

export function initSection(app) {
  const state = {
    enabled: false,
    axis: null,      // chosen on first enable from the model's smallest extent
    frac: 0.5,
    flipped: false,
    plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
    box: new THREE.Box3(),
  };
  app.section = state;

  const invalidate = () => { if (app.viewer) app.viewer.invalidate(); };
  const refresh = () => app.events.emit('appearance');

  // Cut outline colour follows the accent token, like initEdgeColor does for
  // part edges. toneMapped false so the CSS-picked colour survives ACES.
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x2b9187, toneMapped: false });
  const applyOutlineColor = () => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (c) outlineMat.color.set(c);
    invalidate();
  };
  applyOutlineColor();
  new MutationObserver(applyOutlineColor)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- plane maths ------------------------------------------------------
  function defaultAxis() {
    if (!app.model || app.model.bounds.isEmpty()) return 'y';
    const s = app.model.bounds.getSize(new THREE.Vector3());
    // Cut across the assembly's thinnest direction by default — on a plate
    // assembly that's the plane of the plate, which is the informative cut.
    return [['x', s.x], ['y', s.y], ['z', s.z]].sort((a, b) => a[1] - b[1])[0][0];
  }

  function computeRange() {
    if (!app.model) return;
    state.box.copy(M.boxOfRecs(app.model.rootRecs));
  }

  function updatePlane() {
    if (state.box.isEmpty()) return;
    const a = state.axis;
    const min = state.box.min[a];
    const max = state.box.max[a];
    // Pad both ends so frac 0/1 cleanly shows nothing/everything even with
    // facets lying exactly on the box faces.
    const pad = Math.max((max - min) * 0.002, 1e-6);
    const w = (min - pad) + state.frac * ((max + pad) - (min - pad));
    const n = AXIS_UNIT[a].clone();
    if (state.flipped) {
      state.plane.normal.copy(n);          // keep points with coord > w
      state.plane.constant = -w;
    } else {
      state.plane.normal.copy(n).negate(); // keep points with coord < w
      state.plane.constant = w;
    }
  }

  function apply() {
    if (!app.viewer) return;
    app.viewer.renderer.clippingPlanes = state.enabled ? [state.plane] : [];
    if (app.model) app.model.forceDoubleSide = state.enabled;
    $('btnSection').classList.toggle('is-on', state.enabled);
    refresh(); // re-derives materials (DoubleSide while clipping)
    scheduleOutlines(true);
    invalidate();
  }

  // ---- cut outlines -----------------------------------------------------
  // One LineSegments child per mesh instance, in LOCAL coordinates: the
  // world plane is transformed into each instance's space, so shared
  // geometries still get per-instance cuts. Rebuilt (not transformed) when
  // anything moves — the world plane is fixed while parts travel through it.
  const outlineLines = new Map(); // mesh -> LineSegments
  let outlineTimer = 0;
  let outlineLast = 0;

  const _va = new THREE.Vector3();
  const _vb = new THREE.Vector3();
  const _inv = new THREE.Matrix4();
  const _localPlane = new THREE.Plane();
  const _triA = new THREE.Vector3();
  const _triB = new THREE.Vector3();
  const _triC = new THREE.Vector3();

  function segmentsForMesh(mesh) {
    const g = mesh.geometry;
    if (!g || !g.attributes.position) return null;
    _inv.copy(mesh.matrixWorld).invert();
    _localPlane.copy(state.plane).applyMatrix4(_inv);
    if (!g.boundingBox) g.computeBoundingBox();
    if (!_localPlane.intersectsBox(g.boundingBox)) return null;

    const out = [];
    // Nudge the line to the kept side so the global clip plane never eats
    // its own outline to float precision. The nudge is a WORLD length but is
    // applied along the local plane normal in local coordinates, so divide
    // by the mesh's world scale (foreign GLBs can carry non-identity scales;
    // BomDom's own exports are always 1).
    const me = mesh.matrixWorld.elements;
    const wscale = (Math.hypot(me[0], me[1], me[2]) + Math.hypot(me[4], me[5], me[6])
      + Math.hypot(me[8], me[9], me[10])) / 3 || 1;
    const eps = (app.model ? app.model.diagLen : 1) * 1e-4 / wscale;
    const push = () => {
      out.push(
        _va.x + _localPlane.normal.x * eps, _va.y + _localPlane.normal.y * eps, _va.z + _localPlane.normal.z * eps,
        _vb.x + _localPlane.normal.x * eps, _vb.y + _localPlane.normal.y * eps, _vb.z + _localPlane.normal.z * eps,
      );
    };

    if (g.boundsTree) {
      g.boundsTree.shapecast({
        intersectsBounds: (box) => _localPlane.intersectsBox(box),
        intersectsTriangle: (tri) => {
          if (triPlaneSegment(tri.a, tri.b, tri.c, _localPlane, _va, _vb)) push();
          return false;
        },
      });
    } else {
      const pos = g.attributes.position;
      const idx = g.index;
      const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
      if (triCount > BRUTE_MAX_TRIS) return null; // wait for the BVH
      for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        _triA.fromBufferAttribute(pos, i0);
        _triB.fromBufferAttribute(pos, i1);
        _triC.fromBufferAttribute(pos, i2);
        if (triPlaneSegment(_triA, _triB, _triC, _localPlane, _va, _vb)) push();
      }
    }
    return out.length ? out : null;
  }

  function clearOutlines() {
    for (const [, lines] of outlineLines) lines.visible = false;
  }

  function rebuildOutlines() {
    if (!app.model || !state.enabled) { clearOutlines(); return; }
    const seen = new Set();
    for (const mesh of app.model.pickables) {
      seen.add(mesh);
      const segs = segmentsForMesh(mesh);
      let lines = outlineLines.get(mesh);
      if (!segs) {
        if (lines) lines.visible = false;
        continue;
      }
      if (!lines) {
        lines = new THREE.LineSegments(new THREE.BufferGeometry(), outlineMat);
        lines.raycast = () => {}; // picking must ignore the cut outline
        lines.matrixAutoUpdate = false; // identity local transform — rides the mesh
        lines.renderOrder = 2; // after the surface, so polygonOffset keeps it crisp
        mesh.add(lines);
        outlineLines.set(mesh, lines);
      }
      lines.geometry.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(segs), 3));
      lines.geometry.computeBoundingSphere();
      lines.visible = true;
    }
    for (const [mesh, lines] of outlineLines) {
      if (!seen.has(mesh)) lines.visible = false;
    }
    invalidate();
  }

  // Throttled during slider drags; immediate on discrete changes.
  function scheduleOutlines(immediate) {
    if (immediate) {
      clearTimeout(outlineTimer);
      outlineTimer = 0;
      outlineLast = performance.now();
      rebuildOutlines();
      return;
    }
    if (outlineTimer) return;
    const wait = Math.max(0, 30 - (performance.now() - outlineLast));
    outlineTimer = setTimeout(() => {
      outlineTimer = 0;
      outlineLast = performance.now();
      rebuildOutlines();
    }, wait);
  }

  // ---- events -----------------------------------------------------------
  // Parts moving through the fixed plane (drag-move end, snap-back, explode)
  // change every cut. 'positions-live' fires per explode step — outlines
  // can't keep up with a scrub, so they hide and rebuild at rest.
  app.events.on('positions', () => { if (state.enabled) { computeRange(); scheduleOutlines(true); } });
  app.events.on('positions-live', () => { if (state.enabled) clearOutlines(); });
  app.events.on('bvh-ready', () => { if (state.enabled) scheduleOutlines(true); });
  app.events.on('model', () => {
    // Sidecar re-drop: main.js removed and disposed the old scene graph.
    outlineLines.clear();
    state.axis = null;
    if (state.enabled) { computeRange(); if (!state.axis) state.axis = defaultAxis(); updatePlane(); apply(); }
  });
  // Appearance events fire for visibility changes (rebuild needed) but also
  // for every lazy edge-build slice (nothing changed) — gate on a cheap
  // visibility signature so the build doesn't trigger dozens of rebuilds.
  // Order-DEPENDENT rolling hash, not a sum: pickables comes from a
  // deterministic DFS, and two different visible sets with equal count and
  // equal id sum must not collide (they'd skip the rebuild and leave newly
  // visible parts cut open with no outlines).
  let lastSig = '';
  app.events.on('appearance', () => {
    if (!state.enabled || !app.model) return;
    let idHash = 0;
    for (const mesh of app.model.pickables) {
      const rec = app.model.meshRecords.get(mesh);
      if (rec) idHash = (idHash * 31 + rec.id + 1) | 0;
    }
    const sig = `${app.model.pickables.length}|${app.model.hiddenInstances}|${idHash}`;
    if (sig === lastSig) return;
    lastSig = sig;
    scheduleOutlines(false);
  });

  // ---- UI ---------------------------------------------------------------
  const menu = $('sectionMenu');

  function head(text) {
    const h = document.createElement('div');
    h.className = 'menu-head';
    h.textContent = text;
    menu.appendChild(h);
  }

  function check(text, checked, onChange) {
    const lab = document.createElement('label');
    lab.className = 'pop-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    lab.appendChild(box);
    lab.appendChild(document.createTextNode(' ' + text));
    menu.appendChild(lab);
    return box;
  }

  function axisRadio(letter) {
    const lab = document.createElement('label');
    lab.className = 'menu-radio';
    const r = document.createElement('input');
    r.type = 'radio';
    r.name = 'bdSectionAxis';
    r.checked = state.axis === letter;
    r.addEventListener('change', () => {
      state.axis = letter;
      updatePlane();
      apply();
    });
    lab.appendChild(r);
    const s = document.createElement('span');
    s.className = 'ax-text ax-' + letter;
    s.textContent = ' ' + letter.toUpperCase();
    lab.appendChild(s);
    return lab;
  }

  function buildPopover() {
    menu.innerHTML = '';
    head('Section view');
    check('Cut the model open (X)', state.enabled, (on) => setEnabled(on));

    head('Cut axis (model axes)');
    const row = document.createElement('div');
    row.className = 'pop-inline';
    for (const letter of ['x', 'y', 'z']) row.appendChild(axisRadio(letter));
    menu.appendChild(row);

    check('Flip side', state.flipped, (on) => {
      state.flipped = on;
      updatePlane();
      apply();
    });

    head('Cut position');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.001';
    slider.value = String(state.frac);
    slider.className = 'explode-slider section-slider';
    slider.title = 'Cut position along the axis';
    slider.addEventListener('input', () => {
      state.frac = parseFloat(slider.value);
      updatePlane();
      if (app.viewer) app.viewer.renderer.clippingPlanes = state.enabled ? [state.plane] : [];
      scheduleOutlines(false);
      invalidate();
    });
    slider.addEventListener('change', () => scheduleOutlines(true));
    const wrap = document.createElement('div');
    wrap.className = 'section-slider-row';
    wrap.appendChild(slider);
    menu.appendChild(wrap);
  }

  function setEnabled(on) {
    if (on && !app.model) { app.ui.toast('No 3D model loaded'); return; }
    state.enabled = on;
    if (on) {
      computeRange();
      if (!state.axis) state.axis = defaultAxis();
      updatePlane();
    }
    apply();
    // Keep an open popover's checkbox in step with the X key.
    if (!menu.classList.contains('hidden')) buildPopover();
  }

  app.sectionApi = {
    toggle: () => setEnabled(!state.enabled),
    isOn: () => state.enabled,
  };

  $('btnSection').addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      return;
    }
    app.ui.closeMenus();
    buildPopover();
    menu.classList.remove('hidden');
  });
}
