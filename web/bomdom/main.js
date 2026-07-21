// BomDom viewer entry point. Boot order (each stage degrades independently):
// theme (inline head script) -> META decode -> panel/chrome (interactive
// fast) -> WebGL2 probe -> GLB decode or sidecar drop-zone -> parse ->
// instance graph -> fit camera -> lazy BVH.

import { diag, diagText, stage, timed } from './diag.js';
import { readMode, readConfig, decodeMeta, decodeGlb, dropRemainingSlots } from './payload.js';
import { createEmitter, SelectionModel } from './state.js';
import { createViewer } from './scene.js';
import * as M from './model.js';
import { buildBomJoin } from './bom.js';
import { initPicking } from './picking.js';
import { initInteractions } from './interactions.js';
import { initPanel } from './panel.js';
import { initExports } from './exports.js';

const $ = (id) => document.getElementById(id);

const app = {
  meta: null,
  mode: null,
  viewer: null,
  model: null,
  events: null,
  sel: null,
  bom: null,
  ui: {},
  actions: null,
  pick: () => null,
  moveMode: false,
  dragging: false,
};
window.__bomdom = app; // console access for the manual browser checklist

boot();

async function boot() {
  stage('boot (BomDom viewer)');
  app.events = createEmitter();
  app.sel = new SelectionModel(app.events);
  installToast();

  try {
    app.mode = readMode();
    stage('mode: ' + app.mode);
  } catch (e) {
    fatal('payload mode', e);
    return;
  }
  app.config = readConfig();

  try {
    app.meta = await decodeMeta();
  } catch (e) {
    fatal('META decode', e);
    return;
  }
  if (app.mode === 'sidecar') dropRemainingSlots(); // glb slot is empty in sidecar mode

  app.bom = buildBomJoin(app.meta);
  buildChrome();
  initPanel(app);
  initExports(app);
  initInteractions(app);
  if (!app.config.allow_exports) {
    // The file owner disabled in-viewer exports (hand-editable via the
    // bomdom-config block near the top of this file).
    document.getElementById('btnExport').classList.add('hidden');
    stage('exports disabled by file config');
  }
  wireStateToVisuals();
  updateFooter();
  updateDiagLine();
  stage('panel ready (interactive)');

  // WebGL2 probe — on failure the table and exports keep working.
  let gl2 = null;
  try { gl2 = document.createElement('canvas').getContext('webgl2'); } catch (e) { /* probe */ }
  if (!gl2) {
    dropRemainingSlots(); // free the multi-MB GLB base64 held in the DOM
    showViewportCard('3D view unavailable',
      'This browser or machine does not provide WebGL2. The parts table, search and exports still work.');
    stage('WebGL2 unavailable — degraded mode');
    return;
  }

  try {
    app.viewer = createViewer($('gl'));
  } catch (e) {
    dropRemainingSlots();
    showViewportCard('3D view unavailable', 'WebGL renderer failed to start: ' + e.message);
    console.error('[BomDom] renderer init failed', e);
    return;
  }
  initPicking(app);

  if (app.mode === 'embedded') {
    let buf;
    try {
      buf = await decodeGlb();
    } catch (e) {
      stageError('GLB decode', e);
      return;
    }
    await loadModel(buf, 'embedded GLB');
  } else {
    setupDropZone();
  }
}

// ---------------------------------------------------------------------------
// Model load
// ---------------------------------------------------------------------------

function glbMagicOk(buf) {
  if (!buf || buf.byteLength < 12) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x67 && b[1] === 0x6C && b[2] === 0x54 && b[3] === 0x46; // 'glTF'
}

async function loadModel(buf, sourceLabel) {
  if (!glbMagicOk(buf)) {
    stageError('GLB validation', new Error(`${sourceLabel} is not a GLB (bad magic bytes)`));
    return false;
  }
  stage(`parsing ${sourceLabel} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
  const t0 = performance.now();
  let gltf;
  try {
    gltf = await M.parseGlbBuffer(buf);
  } catch (e) {
    stageError('GLB parse', e);
    return false;
  }
  timed('gltf parse', performance.now() - t0);

  try {
    app.model = M.buildGraph(gltf, app.meta);
  } catch (e) {
    stageError('instance graph', e);
    return false;
  }
  app.viewer.scene.add(app.model.root);
  M.applyPositions(app.model, 0);
  M.updateVisuals(app.model, app.sel);
  app.model.root.updateWorldMatrix(true, true);
  const framePts = M.pointsOfRecs(app.model.rootRecs);
  if (framePts.length) app.viewer.framePoints(framePts);
  else app.viewer.frameBox(app.model.bounds);
  M.buildBVHLazily(app.model);

  diag.counts = {
    parts: app.meta.parts.length,
    // Component instances (what users count), not internal render meshes
    instances: (app.meta.parts || []).reduce((a, p) => a + p.instances, 0),
    triangles: app.model.triangles,
  };
  hideViewportCard();
  $('dropZone').classList.add('hidden');
  updateFooter();
  updateDiagLine();
  app.events.emit('model');
  stage('model ready');
  return true;
}

// ---------------------------------------------------------------------------
// Sidecar drop-zone
// ---------------------------------------------------------------------------

function setupDropZone() {
  const zone = $('dropZone');
  const nameEl = $('dropFileName');
  nameEl.textContent = app.meta.geometry.sidecar_filename || 'the exported .glb';
  zone.classList.remove('hidden');
  stage('sidecar mode — waiting for GLB drop');

  const takeFile = (file) => {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      app.ui.toast(`"${file.name}" is not a .glb file`);
      return;
    }
    hideViewportCard(); // clear any error card from an earlier attempt
    const reader = new FileReader();
    reader.onerror = () => app.ui.toast('Could not read the dropped file');
    reader.onload = async () => {
      const ok = await loadModel(reader.result, file.name);
      if (!ok) app.ui.toast(`"${file.name}" could not be loaded as a model`);
    };
    reader.readAsArrayBuffer(file);
  };

  $('btnBrowseGlb').addEventListener('click', () => $('glbFileInput').click());
  $('glbFileInput').addEventListener('change', (ev) => takeFile(ev.target.files[0]));

  const viewport = $('viewport');
  for (const evName of ['dragover', 'dragenter']) {
    viewport.addEventListener(evName, (ev) => {
      ev.preventDefault();
      zone.classList.add('is-over');
    });
  }
  viewport.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  viewport.addEventListener('drop', (ev) => {
    ev.preventDefault();
    zone.classList.remove('is-over');
    takeFile(ev.dataTransfer.files && ev.dataTransfer.files[0]);
  });
  // A stray drop anywhere else must not navigate away from the page.
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());
}

// ---------------------------------------------------------------------------
// Chrome (appbar text, warnings banner, footer, diagnostics)
// ---------------------------------------------------------------------------

function buildChrome() {
  const meta = app.meta;
  const name = (meta.assembly && meta.assembly.name) || 'assembly';
  document.title = 'BomDom — ' + name;
  $('asmName').textContent = name;
  $('asmName').title = [meta.assembly.file, meta.assembly.config && ('config ' + meta.assembly.config)]
    .filter(Boolean).join(' · ');
  const genDate = (meta.generated || '').slice(0, 10);
  $('genChip').textContent =
    `generated ${genDate || '?'} · pictureBOM${meta.app_version ? ' v' + meta.app_version : ''}`;

  // Warnings banner: payload warnings + reconciliation counts, dismissible.
  const recon = meta.reconciliation || {};
  const counts = [];
  if ((recon.unmatched_nodes || []).length) counts.push(`${recon.unmatched_nodes.length} 3D part(s) not in BOM`);
  if ((recon.hidden_rows || []).length) counts.push(`${recon.hidden_rows.length} BOM row(s) hidden in model`);
  if ((recon.unmatched_rows || []).length) counts.push(`${recon.unmatched_rows.length} BOM row(s) without 3D`);
  const warnings = meta.warnings || [];
  if (counts.length || warnings.length) {
    const summary = counts.length ? counts.join(' · ') : `${warnings.length} warning(s)`;
    $('warnText').textContent = summary;
    $('warnBanner').classList.remove('hidden');
    const detailLines = [...warnings];
    for (const u of recon.unmatched_nodes || []) {
      detailLines.push(`Not in BOM: ${u.raw_name} (${u.instances} instance(s))`);
    }
    $('warnDetail').textContent = detailLines.join('\n') || summary;
    $('warnDetailBtn').addEventListener('click', () => $('warnDetail').classList.toggle('hidden'));
    $('warnClose').addEventListener('click', () => {
      $('warnBanner').classList.add('hidden');
      $('warnDetail').classList.add('hidden');
    });
  }

  $('btnDiag').addEventListener('click', () => {
    const line = $('diagLine');
    line.classList.toggle('hidden');
    $('btnDiag').classList.toggle('is-on', !line.classList.contains('hidden'));
    updateDiagLine();
  });
}

function updateFooter() {
  const meta = app.meta;
  if (!meta) return;
  const parts = (meta.parts || []).length;
  const instances = (meta.parts || []).reduce((a, p) => a + p.instances, 0);
  const bits = [`${parts} parts`, `${instances} instances`];
  if (app.model) {
    if (app.model.hiddenInstances) bits.push(`${app.model.hiddenInstances} hidden`);
    const moved = M.movedRecs(app.model).length;
    if (moved) bits.push(`${moved} moved`);
  } else {
    bits.push('no 3D model loaded');
  }
  $('statusStats').textContent = bits.join(' · ');
}
app.ui.updateFooter = updateFooter;

function updateDiagLine() {
  $('diagLine').textContent = diagText();
}

// ---------------------------------------------------------------------------
// State -> visuals wiring
// ---------------------------------------------------------------------------

function wireStateToVisuals() {
  const refresh = () => {
    if (app.model) {
      M.updateVisuals(app.model, app.sel);
      if (app.viewer) app.viewer.invalidate();
    }
    updateFooter();
    updateDiagLine();
  };
  app.events.on('hover', refresh);
  app.events.on('selection', refresh);
  app.events.on('scope', refresh);
  app.events.on('appearance', refresh);
  app.events.on('positions', () => { updateFooter(); });
}

// ---------------------------------------------------------------------------
// Degraded states
// ---------------------------------------------------------------------------

function showViewportCard(title, msg, isError) {
  const card = $('viewportCard');
  card.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'card-msg' + (isError ? ' is-error' : '');
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = msg;
  box.appendChild(h);
  box.appendChild(p);
  card.appendChild(box);
  card.classList.remove('hidden');
}

function hideViewportCard() {
  $('viewportCard').classList.add('hidden');
}

function stageError(stageName, err) {
  console.error(`[BomDom] stage "${stageName}" failed`, err);
  diag.notes.push(`FAILED at ${stageName}: ${err.message}`);
  showViewportCard(`3D load failed at: ${stageName}`,
    `${err.message} — the parts table, search and exports still work.`, true);
  updateDiagLine();
}

function fatal(stageName, err) {
  console.error(`[BomDom] fatal at "${stageName}"`, err);
  showViewportCard(`Failed at: ${stageName}`, String(err && err.message || err), true);
  const list = $('partsList');
  if (list) {
    list.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'parts-empty';
    d.textContent = `Payload decode failed (${stageName}): ${err.message}`;
    list.appendChild(d);
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function installToast() {
  let timer = null;
  app.ui.toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.add('hidden'), 3200);
  };
}
