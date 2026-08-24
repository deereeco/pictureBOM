// BomDom viewer entry point. Boot order (each stage degrades independently):
// theme (inline head script) -> loading card (static, unhidden while the
// parser still streams the payload slots at the end of the file) -> META
// decode -> panel/chrome (interactive fast) -> WebGL2 probe -> GLB decode
// or sidecar drop-zone -> parse -> instance graph -> fit camera -> lazy BVH.
// The loading bar (loading.js) spans decode through instance graph.

import { diag, diagText, stage, timed } from './diag.js';
import { readMode, readConfig, decodeMeta, decodeGlb, dropRemainingSlots } from './payload.js';
import { RATES, beginLoading, stageProgress, stageStart, stageDone, finishLoading, hideLoading } from './loading.js';
import { createEmitter, SelectionModel } from './state.js';
import { createViewer, normalizeUp, DEFAULT_UP } from './scene.js';
import * as M from './model.js';
import { buildBomJoin } from './bom.js';
import { initPicking } from './picking.js';
import { initSection } from './section.js';
import { initMeasure } from './measure.js';
import { initTriad } from './triad.js';
import { initTrails } from './trails.js';
import { initInstructions } from './instructions.js';
import { initViewState } from './viewstate.js';
import { initInteractions, readStoredUpAxis } from './interactions.js';
import { initAxisGizmo } from './axes.js';
import { initPanel } from './panel.js';
import { initFilters } from './filter.js';
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
  renderStyle: 'shaded', // reader preference; initInteractions reads the stored one
};
window.__bomdom = app; // console access for the manual browser checklist

boot().catch((e) => { stage('boot failed'); reportUncaught(e); });

// Silent init deaths look exactly like the JS-disabled dead page — the worst
// failure mode on an iPad, where there are no devtools. Surface the first
// uncaught error on the page; once a model is up, note it in diagnostics only.
let uncaughtShown = false;
function reportUncaught(err) {
  console.error('[BomDom] uncaught', err);
  const msg = String((err && err.message) || err || 'unknown error');
  // A repeating per-event error (pointermove, resize) must not grow the diag
  // line without bound — record each distinct message once per streak.
  if (diag.notes[diag.notes.length - 1] !== 'UNCAUGHT: ' + msg) {
    diag.notes.push('UNCAUGHT: ' + msg);
  }
  // Card only while nothing else claimed the viewport: stageError/fatal and
  // the WebGL2-degraded path write better, purpose-specific cards.
  if (!uncaughtShown && !app.model && $('viewportCard').classList.contains('hidden')) {
    uncaughtShown = true;
    hideLoading(); // a stuck "Loading…" card must not cover the error
    showViewportCard('Viewer hit an unexpected error', msg, true);
  }
  updateDiagLine();
}
window.addEventListener('error', (ev) => { if (ev.error) reportUncaught(ev.error); });
window.addEventListener('unhandledrejection', (ev) => reportUncaught(ev.reason));

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
  initFilters(app);
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
    hideLoading();
    showViewportCard('3D view unavailable',
      'This browser or machine does not provide WebGL2. The parts table, search and exports still work.');
    stage('WebGL2 unavailable — degraded mode');
    return;
  }

  try {
    app.viewer = createViewer($('gl'));
  } catch (e) {
    dropRemainingSlots();
    hideLoading();
    showViewportCard('3D view unavailable', 'WebGL renderer failed to start: ' + e.message);
    console.error('[BomDom] renderer init failed', e);
    return;
  }
  app.viewer.setRenderStyle(app.renderStyle);
  initPicking(app);
  M.initEdgeColor(app.viewer.invalidate);
  initSection(app);
  initMeasure(app);
  initTriad(app);
  initTrails(app);
  initInstructions(app);
  initViewState(app);

  // Which way is up: this reader's remembered choice for this assembly wins,
  // then the exported default (hand-editable "up_axis" in bomdom-config),
  // then glTF's own +Y. Set before the first framing so the model comes up
  // the right way round rather than being righted after the fact.
  const upAxis = readStoredUpAxis(app.meta) || normalizeUp(app.config.up_axis) || DEFAULT_UP;
  // snapView: nothing is framed yet, so start from the canonical isometric
  // for this up axis rather than re-rolling the +Y one.
  app.viewer.setUpAxis(upAxis, { snapView: true });
  initAxisGizmo(app);
  stage('up axis: ' + upAxis);

  if (app.mode === 'embedded') {
    // Weight the loading bar's stages by rough expected duration. The raw
    // GLB size is known from META before the blob is touched; base64 is
    // 4/3 of the (barely) gzipped bytes.
    const raw = (app.meta.geometry && app.meta.geometry.glb_bytes) || 10e6;
    const tok = beginLoading([
      { key: 'unpack', label: 'Unpacking 3D data', ms: (raw * 1.3) / RATES.unpack },
      { key: 'inflate', label: 'Decompressing', ms: raw / RATES.inflate },
      { key: 'parse', label: 'Building 3D geometry', ms: raw / RATES.parse },
    ]);
    let buf;
    try {
      buf = await decodeGlb((key, done, total) => stageProgress(tok, key, done, total));
    } catch (e) {
      stageError('GLB decode', e);
      return;
    }
    await loadModel(buf, 'embedded GLB', tok);
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

async function loadModel(buf, sourceLabel, loadTok) {
  if (!glbMagicOk(buf)) {
    stageError('GLB validation', new Error(`${sourceLabel} is not a GLB (bad magic bytes)`));
    return false;
  }
  stage(`parsing ${sourceLabel} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
  // No progress callback exists for glTF/Draco parsing — this stage of the
  // loading bar advances on a time estimate and snaps to done afterwards.
  stageStart(loadTok, 'parse');
  const t0 = performance.now();
  let gltf;
  try {
    gltf = await M.parseGlbBuffer(buf);
  } catch (e) {
    stageError('GLB parse', e);
    return false;
  }
  timed('gltf parse', performance.now() - t0);

  const oldModel = app.model; // sidecar re-drop replaces a live model
  try {
    app.model = M.buildGraph(gltf, app.meta);
  } catch (e) {
    stageError('instance graph', e);
    return false;
  }
  // Everything from here to 'model ready' runs with app.model already set,
  // which disarms reportUncaught's loading-card cleanup — so a throw in this
  // stretch would otherwise strand the bar at ~98% forever. Catch it here.
  try {
    if (oldModel) {
      // Remove AND free the previous scene graph — leaving it would render two
      // superimposed models and strand every child overlay (edges, veils,
      // section outlines) with no owner able to hide them. disposeModel also
      // frees materials, shaded twins, their matCache clones and textures.
      app.viewer.scene.remove(oldModel.root);
      M.disposeModel(oldModel);
      // Record ids are per-model: a stale scope/filter/selection/hover would
      // hide or tint an arbitrary subset of the NEW records during the
      // updateVisuals + framing below. The 'model' emit clears these too, but
      // that runs after framing — clear silently first, then the emit's
      // handlers re-sync the widgets (scope chip, filter block, rows).
      app.sel.selected.clear();
      app.sel.scope = null;
      app.sel.filter = null;
      app.sel.hover = null;
    }
    app.viewer.scene.add(app.model.root);
    app.model.edgesOn = app.edgesOn;
    M.setMaterialStyle(app.model, app.renderStyle);
    M.applyPositions(app.model, 0);
    M.updateVisuals(app.model, app.sel);
    app.model.root.updateWorldMatrix(true, true);
    const framePts = M.pointsOfRecs(app.model.rootRecs);
    if (framePts.length) app.viewer.framePoints(framePts);
    else app.viewer.frameBox(app.model.bounds);
    // Edges chain after the BVH: both are cosmetic-vs-latency slicers, and
    // picking speed (gated on the BVH) should win. The staleness check stops
    // the chain if a sidecar re-drop replaces the model mid-build.
    const model = app.model;
    M.buildBVHLazily(model, () => {
      if (app.model !== model) return; // replaced by a sidecar re-drop mid-build
      app.events.emit('bvh-ready'); // section outlines + measure snapping wake up
      if (app.edgesOn) {
        M.buildEdgesLazily(model, () => app.events.emit('appearance'), () => app.model !== model);
      }
    }, () => app.model !== model);
  } catch (e) {
    stageError('model display', e);
    return false;
  }

  diag.counts = {
    parts: app.meta.parts.length,
    // Component instances (what users count), not internal render meshes
    instances: (app.meta.parts || []).reduce((a, p) => a + p.instances, 0),
    triangles: app.model.triangles,
  };
  stageDone(loadTok, 'parse');
  finishLoading(loadTok);
  hideViewportCard();
  $('dropZone').classList.add('hidden');
  $('axisGizmo').classList.remove('hidden');
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
  hideLoading(); // the static "Loading…" card yields to the drop zone
  const zone = $('dropZone');
  const nameEl = $('dropFileName');
  nameEl.textContent = app.meta.geometry.sidecar_filename || 'the exported .glb';
  zone.classList.remove('hidden');
  stage('sidecar mode — waiting for GLB drop');

  let activeReader = null; // a newer drop supersedes an in-flight read
  const takeFile = (file) => {
    if (!file) return;
    if (/\.json$/i.test(file.name)) return; // saved-view drops belong to viewstate.js
    if (!/\.glb$/i.test(file.name)) {
      app.ui.toast(`"${file.name}" is not a .glb file`);
      return;
    }
    hideViewportCard(); // clear any error card from an earlier attempt
    if (activeReader) activeReader.abort(); // fires onabort only, never onerror
    // The drop zone would otherwise paint over the loading card (later
    // sibling wins the overlay stack) — swap them for the duration.
    zone.classList.add('hidden');
    const tok = beginLoading([
      { key: 'read', label: 'Reading ' + file.name, ms: file.size / RATES.read },
      { key: 'parse', label: 'Building 3D geometry', ms: file.size / RATES.parse },
    ]);
    const reader = new FileReader();
    activeReader = reader;
    const superseded = () => activeReader !== reader;
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) stageProgress(tok, 'read', ev.loaded, ev.total);
    };
    reader.onerror = () => {
      if (superseded()) return;
      hideLoading(tok);
      zone.classList.remove('hidden'); // let the user try again
      app.ui.toast('Could not read the dropped file');
    };
    reader.onload = async () => {
      if (superseded()) return;
      stageDone(tok, 'read');
      const ok = await loadModel(reader.result, file.name, tok);
      if (superseded()) return; // a newer drop owns the zone/card now
      if (!ok) {
        zone.classList.remove('hidden');
        app.ui.toast(`"${file.name}" could not be loaded as a model`);
      }
    };
    reader.readAsArrayBuffer(file);
  };

  $('btnBrowseGlb').addEventListener('click', () => $('glbFileInput').click());
  $('glbFileInput').addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    // The Browse flow has no drop event for viewstate to catch — route saved
    // views from here, or picking one would be silently swallowed.
    if (f && /\.json$/i.test(f.name) && app.viewstate) {
      app.viewstate.restoreFile(f);
      return;
    }
    takeFile(f);
  });

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
  app.events.on('filter', refresh);
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
  hideLoading();
  showViewportCard(`3D load failed at: ${stageName}`,
    `${err.message} — the parts table, search and exports still work.`, true);
  updateDiagLine();
}

function fatal(stageName, err) {
  console.error(`[BomDom] fatal at "${stageName}"`, err);
  hideLoading();
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
