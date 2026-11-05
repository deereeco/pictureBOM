// Review notes: anyone can pin a note to a spot on a part, to a whole part,
// or to the design overall — there is no separate mode. The Notes tab is
// always there; pins show on the model whenever notes exist. Notes take
// replies, can be edited, moved, resolved, and carry sketches drawn on the
// view they were written in. Everything stays offline. Notes travel two ways
// from one "Share notes…" button — a small .json of the notes, or a full
// copy of this BomDom with the notes baked in (selfcopy.js) — and dropping
// either kind on a BomDom merges its notes. Notes belong to ONE build: a file
// from another export of the assembly is refused.
//
// Ways in: right-click a part ("Add note here" / "Note on whole part"),
// right-click a list row, or the Notes tab's "+ Pin note" (the next click on
// a part places it) and "+ Overall note".
//
// Each note's first entry (and any reply carrying a sketch) saves the full
// view setup it was written in (viewstate.js serialize: camera, explode,
// section, hidden/moved parts, scope). Opening a note restores that setup,
// so a reader sees exactly what the writer saw. Sketches are strokes stored
// flat on that view in height-normalised screen units; they line up at any
// window size, and fade (with a "Back to …'s view" chip) once the camera
// leaves the view they were drawn on.

import * as THREE from 'three';
import * as M from './model.js';
import { readNotesSlot } from './payload.js';
import { canCopy, buildCopy, copySize } from './selfcopy.js';
import { download, sanitizeFile } from './exports.js';
import { copyText } from './clipboard.js';
import { exportNotesExcel, exportNotesPdf, notesAsText } from './notesexport.js';

const $ = (id) => document.getElementById(id);
const FORMAT = 'bomdom-notes';
const VERSION = 1;
const NAME_KEY = 'bomdom-reviewer';
const CUSTOM_KEY = 'bomdom-pen-custom';
// One color per reviewer, picked from their name, so Sam is the same color
// in every copy of the file.
const AUTHOR_COLORS = ['#e08a1e', '#7a5bd6', '#2f9e63', '#d64545', '#3a72d4', '#c2417a', '#8a6d1a'];
// Fixed pen colors after "your color"; any that look like your own color are
// skipped so the strip never shows the same swatch twice.
const PEN_PRESETS = [['#e5484d', 'Red'], ['#3a72d4', 'Blue'], ['#f2b705', 'Yellow'], ['#1c1f24', 'Black']];
const STROKE_W = 0.0045; // stroke width as a share of the view height
const ERASE_PX = 9;      // eraser reach around the pointer, in CSS pixels
const NOTE_PIN_LIFT = 22;
const OTHER_ALPHA = 0.35; // sketches you can't change while drawing

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s);

export function authorColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) | 0;
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hexRgb(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function nearColor(a, b) {
  const x = hexRgb(a), y = hexRgb(b);
  if (!x || !y) return false;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 90;
}

export function initReview(app) {
  const viewer = app.viewer;
  const sel = app.sel;
  const viewport = $('viewport');
  const canvas = viewer.renderer.domElement;
  const pinsEl = $('notePins');
  const card = $('noteCard');
  const placeChip = $('notePlaceChip');
  const strip = $('penStrip');
  const doodleChip = $('doodleChip');
  const layer = $('doodleLayer');
  const pane = $('notesPane');
  const tab = $('tabNotes');
  const ctx = layer.getContext('2d');

  const st = {
    doc: null,           // { format, version, build, notes }
    openId: null,        // note shown in the card
    // draft: a new note, a reply (noteId) or an edit of one entry (noteId +
    // editId). { kind, recId, p, spotP, noteId, editId, text, strokes, view, undo }
    draft: null,
    drawing: null,       // { tool, color, live, erased } while the pen strip is up
    placing: null,       // { mode: 'new' | 'move' | 'spot', noteId } — next part click
    cardPos: null,       // where the user dragged the card ({ x, y } in the viewport)
    filter: 'open',
    fromFile: 0,         // notes that arrived baked into this file
  };

  // ---- identity ---------------------------------------------------------
  const buildInfo = () => ({
    assembly: (app.meta.assembly && app.meta.assembly.name) || 'assembly',
    generated: app.meta.generated || '',
    records: app.model ? app.model.records.length : 0,
  });
  const sameBuild = (b) => {
    const mine = buildInfo();
    return !!b && b.assembly === mine.assembly && b.generated === mine.generated
      && (!b.records || !mine.records || b.records === mine.records);
  };
  const storeKey = () => `bomdom-notes|${buildInfo().assembly}|${buildInfo().generated}`;

  let myName = '';
  try { myName = localStorage.getItem(NAME_KEY) || ''; } catch { /* private mode */ }
  const setMyName = (n) => {
    myName = String(n || '').trim().slice(0, 60);
    try { localStorage.setItem(NAME_KEY, myName); } catch { /* ignore */ }
    renderPane();
    renderCard();
  };
  let customColor = '';
  try { customColor = localStorage.getItem(CUSTOM_KEY) || ''; } catch { /* ignore */ }

  // ---- the notes document -------------------------------------------------
  const emptyDoc = () => ({ format: FORMAT, version: VERSION, build: buildInfo(), notes: [] });
  const live = () => (st.doc ? st.doc.notes.filter((n) => !n.deleted) : []);
  const byId = (id) => (st.doc ? st.doc.notes.find((n) => n.id === id) : null);
  const starter = (note) => (note && note.entries[0] ? note.entries[0].author : '');
  const isMine = (author) => !!myName && author === myName;
  // Pin numbers follow creation order across everyone's notes, so a merged
  // file numbers the same way in every copy.
  const numberOf = (note) => {
    const all = live().slice().sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
    return all.indexOf(note) + 1;
  };

  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(storeKey(), JSON.stringify(st.doc));
      } catch {
        app.ui.toast('Notes are too big to keep in this browser — use Share notes to save them');
      }
    }, 250);
  }

  function changed() {
    persist();
    renderCount();
    renderPane();
    renderPins();
    renderCard();
    drawDoodles();
  }

  // Merge another notes document into ours. Notes and entries are matched
  // by id; the newest status change, edit or pin move wins; a deletion wins
  // outright.
  function merge(doc, { from = 'file' } = {}) {
    if (!doc || doc.format !== FORMAT || !Array.isArray(doc.notes)) return { error: 'not a notes file' };
    if (doc.version > VERSION) return { error: 'from a newer pictureBOM — update to open it' };
    if (!sameBuild(doc.build)) {
      const b = doc.build || {};
      return { error: `for a different build of ${b.assembly || 'this assembly'}` +
        (b.generated ? ` (generated ${String(b.generated).slice(0, 10)})` : '') };
    }
    let added = 0, updated = 0;
    const authors = new Set();
    for (const inc of doc.notes) {
      if (!inc || typeof inc.id !== 'string') continue;
      const cur = byId(inc.id);
      if (!cur) {
        st.doc.notes.push(sanitizeNote(inc));
        if (!inc.deleted) { added += 1; (inc.entries || []).forEach((e) => authors.add(e.author)); }
        continue;
      }
      let touched = false;
      if (inc.deleted && !cur.deleted) {
        Object.assign(cur, { deleted: true, deletedAt: inc.deletedAt, deletedBy: inc.deletedBy, entries: [] });
        touched = true;
      }
      if (!cur.deleted) {
        const have = new Map(cur.entries.map((e) => [e.id, e]));
        for (const e of inc.entries || []) {
          if (!e || typeof e.id !== 'string') continue;
          const mine = have.get(e.id);
          if (!mine) {
            cur.entries.push(sanitizeEntry(e));
            authors.add(e.author);
            touched = true;
          } else if ((e.editedAt || '') > (mine.editedAt || '')) {
            Object.assign(mine, sanitizeEntry(e));
            authors.add(e.author);
            touched = true;
          }
        }
        cur.entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        if ((inc.statusAt || '') > (cur.statusAt || '')) {
          cur.status = inc.status === 'resolved' ? 'resolved' : 'open';
          cur.statusAt = inc.statusAt;
          cur.statusBy = inc.statusBy;
          touched = true;
        }
        if ((inc.anchorAt || '') > (cur.anchorAt || '')) {
          const s = sanitizeNote(inc);
          Object.assign(cur, { kind: s.kind, rec: s.rec, p: s.p, part: s.part, label: s.label, anchorAt: s.anchorAt });
          touched = true;
        }
      }
      if (touched) updated += 1;
    }
    if (from !== 'boot') changed();
    return { added, updated, authors: [...authors].filter(Boolean) };
  }

  function sanitizeEntry(e) {
    return {
      id: String(e.id),
      author: esc(e.author).slice(0, 60),
      at: esc(e.at),
      editedAt: e.editedAt ? esc(e.editedAt) : undefined,
      text: esc(e.text).slice(0, 8000),
      view: e.view && typeof e.view === 'object' ? e.view : undefined,
      doodle: Array.isArray(e.doodle) ? e.doodle.filter((s) => s && Array.isArray(s.pts)).slice(0, 400) : undefined,
    };
  }
  function sanitizeNote(n) {
    return {
      id: String(n.id),
      kind: ['point', 'part', 'overall'].includes(n.kind) ? n.kind : 'overall',
      rec: Number.isInteger(n.rec) ? n.rec : null,
      p: Array.isArray(n.p) && n.p.length === 3 && n.p.every(Number.isFinite) ? n.p : null,
      part: esc(n.part),
      label: esc(n.label),
      created: esc(n.created),
      anchorAt: n.anchorAt ? esc(n.anchorAt) : undefined,
      status: n.status === 'resolved' ? 'resolved' : 'open',
      statusAt: esc(n.statusAt),
      statusBy: esc(n.statusBy),
      deleted: !!n.deleted,
      deletedAt: n.deleted ? esc(n.deletedAt) : undefined,
      deletedBy: n.deleted ? esc(n.deletedBy) : undefined,
      entries: n.deleted ? [] : (n.entries || []).filter((e) => e && typeof e.id === 'string').map(sanitizeEntry),
    };
  }

  // ---- anchors -------------------------------------------------------------
  const recOf = (note) => (note && Number.isInteger(note.rec) && app.model ? app.model.records[note.rec] || null : null);
  const tmpV = new THREE.Vector3();
  function anchorWorld(note) {
    const rec = recOf(note);
    if (!rec || !note.p) return null;
    rec.object.updateWorldMatrix(true, false);
    return tmpV.fromArray(note.p).applyMatrix4(rec.object.matrixWorld).clone();
  }
  function toScreen(world) {
    const v = world.clone().project(viewer.camera);
    if (v.z > 1 || v.z < -1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height };
  }
  function partInfo(rec) {
    const part = rec && rec.partId !== null ? app.model.partById.get(rec.partId) : null;
    const number = part ? (part.bom_name || part.name) : (M.cleanName(rec && rec.name) || 'part');
    const row = part ? app.bom.rowFor(part) : null;
    return { number, label: (row && row.description) || '' };
  }
  // A point in the part's own frame: world → local.
  function localOf(rec, world) {
    rec.object.updateWorldMatrix(true, false);
    return world.clone().applyMatrix4(rec.object.matrixWorld.clone().invert()).toArray();
  }
  // Whole-part notes anchor at the middle of the part's visible geometry.
  function centreOf(rec) {
    rec.object.updateWorldMatrix(true, false);
    const box = M.boxOfRecs([rec]);
    const w = box.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(rec.object.matrixWorld) : box.getCenter(new THREE.Vector3());
    return localOf(rec, w);
  }

  // ---- views ---------------------------------------------------------------
  const snapView = () => (app.viewstate ? app.viewstate.serialize() : null);
  function showView(view) {
    if (!view || !app.viewstate) return;
    app.viewstate.apply(view, { quiet: true });
  }
  // Does the camera still show the view a sketch was drawn on?
  function viewMatches(view) {
    if (!view || !view.camera) return false;
    const cam = viewer.camera, tgt = viewer.controls.target;
    const p = view.camera.position, t = view.camera.target;
    if (!Array.isArray(p) || !Array.isArray(t)) return false;
    const dist = cam.position.distanceTo(tgt) || 1;
    const tol = dist * 0.004;
    if (Math.hypot(cam.position.x - p[0], cam.position.y - p[1], cam.position.z - p[2]) > tol) return false;
    if (Math.hypot(tgt.x - t[0], tgt.y - t[1], tgt.z - t[2]) > tol) return false;
    const f = view.explode && typeof view.explode.f === 'number' ? view.explode.f : 0;
    return Math.abs((app.model ? app.model.explodeF : 0) - f) < 0.01;
  }

  // ---- the Notes tab is the home --------------------------------------------
  function showNotesTab() {
    if (app.ui.setPanelHidden) app.ui.setPanelHidden(false);
    if (!tab.classList.contains('is-active')) tab.click();
  }
  function toggleNotesTab() {
    if (!app.model) { app.ui.toast('No 3D model loaded'); return; }
    if (tab.classList.contains('is-active') && !$('panel').classList.contains('hidden')) $('tabParts').click();
    else showNotesTab();
  }
  // Instruction mode owns the view with its balloons: pins and the card
  // step aside until it ends.
  const pinsShown = () => !!app.model && !(app.instructions && app.instructions.on);

  const hasUnsent = () => {
    const d = st.draft;
    if (!d) return false;
    if (d.editId) {
      const note = byId(d.noteId);
      const e = note && note.entries.find((x) => x.id === d.editId);
      return !!e && (d.text !== (e.text || '') || strokesDiffer(d.strokes, e.doodle || []));
    }
    return !!(d.text.trim() || d.strokes.length);
  };
  const strokesDiffer = (a, b) => a.length !== b.length || a.some((s, i) => s !== b[i]);
  function guardUnsent() {
    if (!hasUnsent()) return false;
    app.ui.toast('Post or close the note you are writing first (Esc closes it)');
    return true;
  }

  // Leave every in-flight gesture (other tools call this as they take the canvas).
  function cancel() {
    stopPlacing();
    stopDrawing();
  }

  // Esc: placing → cancel; drawing → finish; editing → back; open card → close.
  function escape() {
    if (st.placing) { stopPlacing(); return true; }
    if (st.drawing) { stopDrawing(); return true; }
    if (st.draft && st.draft.editId) { st.draft = null; renderCard(); drawDoodles(); return true; }
    if (st.openId || st.draft) { closeNote(); return true; }
    return false;
  }

  // ---- click-to-place: "+ Pin note", "Move pin…", "Spot" on a draft --------
  function startPlacing(mode, noteId = null) {
    if (!app.model) { app.ui.toast('No 3D model loaded'); return; }
    stopDrawing();
    // One owner for canvas clicks at a time.
    if (app.measureMode && app.measure) app.measure.toggle();
    if (app.instructions && app.instructions.on) app.instructions.set(false);
    if (app.actions) app.actions.setMoveMode(false);
    st.placing = { mode, noteId };
    app.notePlacing = true;
    canvas.classList.add('is-placing');
    pinsEl.classList.add('is-placing'); // a click on a pin's spot must reach the part
    placeChip.replaceChildren(
      el('span', null, mode === 'new' ? 'New note' : mode === 'move' ? 'Move pin' : 'Pin to a spot'),
      el('span', 'mc-hint', 'click a spot on a part'),
    );
    const x = el('button', null, 'Cancel');
    x.type = 'button';
    x.title = 'Cancel (Esc)';
    x.addEventListener('click', stopPlacing);
    placeChip.appendChild(x);
    placeChip.classList.remove('hidden');
  }
  function stopPlacing() {
    if (!st.placing) return;
    st.placing = null;
    app.notePlacing = false;
    canvas.classList.remove('is-placing');
    pinsEl.classList.remove('is-placing');
    placeChip.classList.add('hidden');
  }

  // picking.js hands canvas clicks over while placing.
  function handleClick(ev, hit) {
    const pl = st.placing;
    if (!pl) return;
    if (!hit) { app.ui.toast('Click on a part — Esc cancels'); return; }
    stopPlacing();
    const p = localOf(hit.rec, hit.point);
    if (pl.mode === 'new') {
      startDraft({ kind: 'point', rec: hit.rec, world: hit.point });
    } else if (pl.mode === 'spot' && st.draft && !st.draft.noteId) {
      Object.assign(st.draft, { kind: 'point', recId: hit.rec.id, p, spotP: p });
      clearNoteHover();
      renderPins();
      renderCard();
      focusComposer();
    } else if (pl.mode === 'move') {
      const note = byId(pl.noteId);
      if (!note) return;
      setAnchor(note, { kind: 'point', rec: hit.rec, p });
      openNote(note.id, { restore: false });
      app.ui.toast(`Note #${numberOf(note)} moved`);
    }
  }

  function setAnchor(note, { kind, rec, p }) {
    const info = rec ? partInfo(rec) : { number: '', label: '' };
    Object.assign(note, {
      kind, rec: rec ? rec.id : null, p, part: info.number, label: info.label,
      anchorAt: new Date().toISOString(),
    });
    changed();
  }

  // ---- drafts --------------------------------------------------------------
  function startDraft({ kind, rec = null, world = null }) {
    if (!app.model) { app.ui.toast('No 3D model loaded'); return; }
    if (guardUnsent()) return;
    stopPlacing();
    stopDrawing();
    closeNote(true);
    st.cardPos = null;
    let p = null, spotP = null;
    if (rec) {
      if (world) spotP = localOf(rec, world);
      p = kind === 'point' && spotP ? spotP : centreOf(rec);
    }
    st.draft = { kind, recId: rec ? rec.id : null, p, spotP, noteId: null, editId: null, text: '', strokes: [], view: null, undo: [] };
    renderPins();
    renderCard();
    drawDoodles();
    noteHover(kind, rec);
    focusComposer();
  }

  function startReply(note) {
    st.draft = { kind: note.kind, recId: note.rec, p: note.p, noteId: note.id, editId: null, text: '', strokes: [], view: null, undo: [] };
  }

  function startEdit(note, entry) {
    if (st.draft && !st.draft.editId && hasUnsent() && st.draft.noteId !== note.id) { guardUnsent(); return; }
    stopDrawing();
    st.draft = {
      kind: note.kind, recId: note.rec, p: note.p, noteId: note.id, editId: entry.id,
      text: entry.text || '', strokes: (entry.doodle || []).slice(),
      view: entry.view || (note.entries[0] && note.entries[0].view) || null, undo: [],
    };
    renderCard();
    drawDoodles();
    focusComposer(true);
  }

  // The kind switch on a new note: a spot on the part, or the whole part.
  function setDraftKind(kind) {
    const d = st.draft;
    if (!d || d.noteId || d.kind === kind) return;
    const rec = d.recId != null ? app.model.records[d.recId] : null;
    if (!rec) return;
    if (kind === 'part') {
      Object.assign(d, { kind: 'part', p: centreOf(rec) });
      noteHover('part', rec);
    } else if (d.spotP) {
      Object.assign(d, { kind: 'point', p: d.spotP });
      clearNoteHover();
    } else {
      startPlacing('spot'); // came from a list row: no spot clicked yet
      return;
    }
    renderPins();
    renderCard();
  }

  function post() {
    const d = st.draft;
    if (!d) return;
    const text = d.text.trim();
    if (!text && !d.strokes.length) { app.ui.toast('Write a note or sketch on the view first'); return; }
    if (!myName) { app.ui.toast('Add your name first'); focusComposer(); return; }
    const now = new Date().toISOString();
    if (d.editId) {
      const note = byId(d.noteId);
      const e = note && note.entries.find((x) => x.id === d.editId);
      if (!e) { st.draft = null; renderCard(); return; }
      e.text = text;
      if (d.strokes.length) {
        e.doodle = d.strokes.slice();
        e.view = d.view || e.view || snapView();
      } else {
        delete e.doodle;
        if (e !== note.entries[0]) delete e.view; // the first entry's view is the note's own
      }
      e.editedAt = now;
      st.draft = null;
      st.openId = note.id;
    } else if (d.noteId) {
      const note = byId(d.noteId);
      if (!note) return;
      const entry = { id: uid(), author: myName, at: now, text };
      if (d.strokes.length) { entry.doodle = d.strokes.slice(); entry.view = d.view || snapView(); }
      note.entries.push(entry);
      st.draft = null;
      st.openId = note.id;
    } else {
      const entry = { id: uid(), author: myName, at: now, text, view: d.view || snapView() };
      if (d.strokes.length) entry.doodle = d.strokes.slice();
      const rec = d.recId != null ? app.model.records[d.recId] : null;
      const info = rec ? partInfo(rec) : { number: '', label: '' };
      const note = {
        id: uid(), kind: d.kind, rec: d.recId, p: d.p, part: info.number, label: info.label,
        created: now, status: 'open', statusAt: now, statusBy: myName, entries: [entry],
      };
      st.doc.notes.push(note);
      st.draft = null;
      st.openId = note.id;
    }
    stopDrawing();
    changed();
  }

  // ---- opening notes -------------------------------------------------------
  function noteHover(kind, rec) {
    if (kind === 'part' && rec) sel.setHover({ ids: M.subtree(rec).map((r) => r.id), src: 'note' });
    else clearNoteHover();
  }
  function clearNoteHover() { if (sel.hover && sel.hover.src === 'note') sel.setHover(null); }

  function openNote(id, { restore = true } = {}) {
    const note = byId(id);
    if (!note || note.deleted) return;
    if (st.draft && st.draft.noteId !== id && guardUnsent()) return;
    stopPlacing();
    stopDrawing();
    if (st.openId !== id) st.cardPos = null;
    if (!st.draft || st.draft.noteId !== id) st.draft = null;
    st.openId = id;
    if (restore && note.entries[0] && note.entries[0].view) showView(note.entries[0].view);
    noteHover(note.kind, recOf(note));
    renderPane();
    renderPins();
    renderCard();
    drawDoodles();
  }

  function closeNote(keepDraft) {
    st.openId = null;
    if (!keepDraft) { st.draft = null; st.cardPos = null; }
    stopDrawing();
    clearNoteHover();
    card.classList.add('hidden');
    doodleChip.classList.add('hidden');
    renderPins();
    renderPane();
    drawDoodles();
  }

  function setStatus(note, status) {
    note.status = status;
    note.statusAt = new Date().toISOString();
    note.statusBy = myName || 'someone';
    changed();
  }

  function removeNote(note) {
    Object.assign(note, {
      deleted: true, deletedAt: new Date().toISOString(), deletedBy: myName, entries: [],
    });
    st.openId = null;
    st.draft = null;
    stopDrawing();
    card.classList.add('hidden');
    clearNoteHover();
    changed();
  }

  // ---- count on the tab -----------------------------------------------------
  function renderCount() {
    const open = live().filter((n) => n.status !== 'resolved').length;
    tab.replaceChildren(document.createTextNode('Notes'));
    if (open) tab.appendChild(el('span', 'tb-count', String(open)));
    tab.title = open ? `Review notes — ${open} open (N)` : 'Review notes — right-click a part to add one (N)';
  }

  // ---- pins --------------------------------------------------------------------
  const pinEls = new Map(); // note id (or 'draft') -> element
  function renderPins() {
    const want = new Map();
    if (pinsShown()) {
      for (const n of live()) {
        if (n.kind === 'overall' || !n.p) continue;
        if (st.filter === 'open' && n.status === 'resolved' && st.openId !== n.id) continue;
        want.set(n.id, n);
      }
      if (st.draft && !st.draft.noteId && st.draft.p) want.set('draft', null);
    }
    pinsEl.classList.toggle('hidden', !want.size);
    for (const [id, e] of pinEls) if (!want.has(id)) { e.remove(); pinEls.delete(id); }
    for (const [id, note] of want) {
      let e = pinEls.get(id);
      if (!e) {
        e = el('button', 'note-pin');
        e.type = 'button';
        e.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (id === 'draft') return;
          if (st.openId === id) closeNote(); else openNote(id);
        });
        pinsEl.appendChild(e);
        pinEls.set(id, e);
      }
      const color = note ? authorColor(starter(note)) : authorColor(myName);
      const done = note && note.status === 'resolved';
      e.style.setProperty('--pin', done ? 'var(--success)' : color);
      e.textContent = id === 'draft' ? '+' : done ? '✓' : String(numberOf(note));
      e.classList.toggle('is-open', id === st.openId || id === 'draft');
      e.classList.toggle('is-whole', note ? note.kind === 'part' : !!(st.draft && st.draft.kind === 'part'));
      e.title = note ? `#${numberOf(note)} ${note.part}${note.label ? ' — ' + note.label : ''}${note.kind === 'part' ? ' (whole part)' : ''}` : 'New note';
    }
    layoutPins();
  }

  function layoutPins() {
    for (const [id, e] of pinEls) {
      const note = id === 'draft' ? { rec: st.draft && st.draft.recId, p: st.draft && st.draft.p } : byId(id);
      const rec = recOf(note);
      const w = note && anchorWorld(note);
      const hidden = !rec || M.isEffectivelyHidden(rec, sel.scope, sel.filter);
      const s = w && !hidden ? toScreen(w) : null;
      e.classList.toggle('hidden', !s);
      if (s) { e.style.left = s.x + 'px'; e.style.top = s.y + 'px'; }
    }
    placeCard();
  }

  // ---- the note card -------------------------------------------------------
  function placeCard() {
    if (card.classList.contains('hidden')) return;
    const vr = viewport.getBoundingClientRect();
    let x = 12, y = 12;
    if (st.cardPos) {
      ({ x, y } = st.cardPos);
    } else {
      const pin = pinEls.get(st.draft && !st.draft.noteId ? 'draft' : st.openId);
      if (pin && !pin.classList.contains('hidden')) {
        x = parseFloat(pin.style.left) + 18;
        y = parseFloat(pin.style.top) - NOTE_PIN_LIFT - 20;
        if (x + card.offsetWidth > vr.width - 10) x = parseFloat(pin.style.left) - card.offsetWidth - 18;
      }
    }
    // While sketching, stay above the tool strip so Post/Reply stay reachable.
    const floor = st.drawing && !strip.classList.contains('hidden') ? strip.offsetTop : vr.height;
    x = Math.max(8, Math.min(x, vr.width - card.offsetWidth - 8));
    y = Math.max(8, Math.min(y, floor - card.offsetHeight - 8));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  // Drag the card by its header to get it out of the way; it stays put
  // until the note closes or another one opens.
  function dragHandle(head) {
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('button, input, textarea')) return;
      ev.preventDefault();
      const start = { x: ev.clientX, y: ev.clientY, l: parseFloat(card.style.left) || 0, t: parseFloat(card.style.top) || 0 };
      head.setPointerCapture(ev.pointerId);
      card.classList.add('is-dragging');
      const move = (e) => {
        st.cardPos = { x: start.l + e.clientX - start.x, y: start.t + e.clientY - start.y };
        placeCard();
      };
      const up = () => {
        card.classList.remove('is-dragging');
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
        if (st.cardPos) st.cardPos = { x: parseFloat(card.style.left), y: parseFloat(card.style.top) };
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  function noteMenu(note, x, y) {
    const mine = isMine(starter(note));
    const items = [{ head: `Note #${numberOf(note)}` }];
    if (mine) {
      items.push({ label: 'Edit note', onClick: () => startEdit(note, note.entries[0]) });
      if (note.kind === 'point') {
        items.push({ label: 'Move pin…', onClick: () => startPlacing('move', note.id) });
        items.push({ label: 'Change to whole part', onClick: () => { const r = recOf(note); if (r) setAnchor(note, { kind: 'part', rec: r, p: centreOf(r) }); openNote(note.id, { restore: false }); } });
      } else {
        items.push({ label: 'Pin to a spot…', onClick: () => startPlacing('move', note.id) });
      }
    }
    items.push({ label: 'Show its view', onClick: () => { if (note.entries[0]) showView(note.entries[0].view); drawDoodles(); } });
    items.push({ label: 'Copy as text', onClick: async () => {
      const ok = await copyText(notesAsText({ ...exportCtx(), notes: [note] }));
      app.ui.toast(ok ? 'Note copied' : 'Could not reach the clipboard');
    } });
    if (mine) {
      items.push({ sep: true });
      items.push({ label: 'Delete note', onClick: () => removeNote(note) });
    }
    app.ui.showMenu(x, y, items);
  }

  function renderCard() {
    const note = st.openId ? byId(st.openId) : null;
    const d = st.draft;
    if ((!note && !d) || !pinsShown()) { card.classList.add('hidden'); return; }
    // Keep the textarea's focus and caret across a re-render.
    const had = document.activeElement && document.activeElement.id === 'noteInput'
      ? { s: document.activeElement.selectionStart, e: document.activeElement.selectionEnd } : null;
    card.replaceChildren();
    card.classList.remove('hidden');

    const head = el('div', 'nc-head');
    head.title = 'Drag to move this note out of the way';
    const kind = note ? note.kind : d.kind;
    const dot = el('span', 'note-dot');
    if (note) {
      dot.textContent = note.status === 'resolved' ? '✓' : String(numberOf(note));
      dot.style.setProperty('--pin', note.status === 'resolved' ? 'var(--success)' : authorColor(starter(note)));
    } else {
      dot.textContent = '+';
      dot.style.setProperty('--pin', authorColor(myName));
    }
    head.appendChild(dot);
    const rec = note ? recOf(note) : (d.recId != null ? app.model.records[d.recId] : null);
    const title = note
      ? (note.kind === 'overall' ? 'Overall' : `${note.part}${note.label ? ' — ' + note.label : ''}`)
      : (kind === 'overall' ? 'New overall note' : (() => { const i = partInfo(rec); return `${i.number}${i.label ? ' — ' + i.label : ''}`; })());
    head.appendChild(el('span', 'nc-title', title));
    if (note && kind === 'part') head.appendChild(el('span', 'nc-kind', 'whole part'));
    if (note) {
      const more = el('button', 'nc-x nc-more', '⋯');
      more.type = 'button';
      more.title = 'More: edit, move pin, delete…';
      more.setAttribute('aria-label', 'More actions');
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const r = more.getBoundingClientRect();
        noteMenu(note, r.left, r.bottom + 4);
      });
      head.appendChild(more);
    }
    const x = el('button', 'nc-x', '✕');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.addEventListener('click', () => closeNote());
    head.appendChild(x);
    dragHandle(head);
    card.appendChild(head);

    // New note on a part: pick a spot on it or the whole part.
    if (!note && d && d.recId != null) {
      const seg = el('div', 'seg seg-mini nc-kindseg');
      const spotTip = d.spotP ? 'Pin the note to the spot you clicked' : 'Then click a spot on the part to pin the note';
      for (const [k, label, tip] of [['point', 'Spot', spotTip], ['part', 'Whole part', 'The note is about the whole part']]) {
        const b = el('button', 'seg-btn' + (d.kind === k ? ' is-active' : ''), label);
        b.type = 'button';
        b.title = tip;
        b.addEventListener('click', () => setDraftKind(k));
        seg.appendChild(b);
      }
      card.appendChild(seg);
    }

    const editing = d && d.editId && note && d.noteId === note.id ? d.editId : null;
    if (note) {
      const thread = el('div', 'nc-thread');
      note.entries.forEach((e, i) => {
        const m = el('div', 'nc-entry' + (e.id === editing ? ' is-editing' : ''));
        const meta = el('div', 'nc-meta');
        const a = el('span', 'nc-author', e.author || 'someone');
        a.style.color = authorColor(e.author);
        meta.appendChild(a);
        meta.appendChild(el('span', 'nc-date', fmtDate(e.at) + (e.editedAt ? ' · edited' : '')));
        meta.appendChild(el('span', 'nc-spacer'));
        if (e.doodle && e.doodle.length && e.id !== editing) {
          const v = el('button', 'nc-link', 'Show sketch');
          v.type = 'button';
          v.title = i === 0 ? 'Go back to the view this was drawn on' : `Go back to ${e.author}'s view`;
          v.addEventListener('click', () => { showView(e.view || note.entries[0].view); drawDoodles(); });
          meta.appendChild(v);
        }
        if (isMine(e.author) && e.id !== editing) {
          const ed = el('button', 'nc-link', 'Edit');
          ed.type = 'button';
          ed.title = 'Change what you wrote or sketched';
          ed.addEventListener('click', () => startEdit(note, e));
          meta.appendChild(ed);
        }
        m.appendChild(meta);
        if (e.id === editing) m.appendChild(el('div', 'nc-hint', 'Editing below…'));
        else if (e.text) m.appendChild(el('div', 'nc-text', e.text));
        thread.appendChild(m);
      });
      card.appendChild(thread);
      if (note.status === 'resolved' && note.statusBy) {
        card.appendChild(el('div', 'nc-resolved', `Resolved by ${note.statusBy} · ${fmtDate(note.statusAt)}`));
      }
    }

    // Composer: a new note, a reply to the open one, or an edit.
    if (note && (!d || d.noteId !== note.id)) startReply(note);
    const dd = st.draft;
    const comp = el('div', 'nc-compose');
    if (!myName) {
      const name = el('input', 'nc-name');
      name.placeholder = 'Your name (signs your notes)';
      name.maxLength = 60;
      name.addEventListener('change', () => setMyName(name.value));
      comp.appendChild(name);
    }
    const ta = el('textarea', 'nc-input');
    ta.id = 'noteInput';
    ta.rows = note && !editing ? 2 : 3;
    ta.placeholder = editing ? 'Edit your note…' : note ? 'Reply…' : 'Write a note…';
    ta.value = dd.text;
    ta.addEventListener('input', () => { dd.text = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); }
    });
    comp.appendChild(ta);
    const row = el('div', 'nc-actions');
    const n = dd.strokes.length;
    const sk = el('button', 'nc-btn nc-sketch' + (st.drawing ? ' is-on' : ''));
    sk.type = 'button';
    sk.innerHTML = ICON.sketch;
    sk.appendChild(el('span', null, st.drawing ? 'Sketching' : n ? `Sketch · ${n}` : 'Sketch'));
    sk.title = st.drawing ? 'Finish sketching (Esc)' : 'Draw on the 3D view — arrows, circles, freehand';
    sk.addEventListener('click', () => (st.drawing ? stopDrawing() : startDrawing()));
    row.appendChild(sk);
    row.appendChild(el('span', 'nc-spacer'));
    if (editing) {
      const cancelB = el('button', 'nc-btn', 'Cancel');
      cancelB.type = 'button';
      cancelB.addEventListener('click', () => { stopDrawing(); st.draft = null; renderCard(); drawDoodles(); });
      row.appendChild(cancelB);
    } else if (note) {
      const res = el('button', 'nc-btn', note.status === 'resolved' ? 'Reopen' : 'Resolve');
      res.type = 'button';
      res.addEventListener('click', () => setStatus(note, note.status === 'resolved' ? 'open' : 'resolved'));
      row.appendChild(res);
    }
    const go = el('button', 'nc-btn nc-primary', editing ? 'Save' : note ? 'Reply' : 'Post');
    go.type = 'button';
    go.title = 'Ctrl+Enter';
    go.addEventListener('click', post);
    row.appendChild(go);
    comp.appendChild(row);
    card.appendChild(comp);
    placeCard(); // now, so the card never flashes in the corner first
    if (had) { ta.focus(); try { ta.setSelectionRange(had.s, had.e); } catch { /* ignore */ } }
  }

  function focusComposer(toEnd) {
    requestAnimationFrame(() => {
      const ta = $('noteInput');
      if (!ta) return;
      ta.focus();
      if (toEnd) { const n = ta.value.length; ta.setSelectionRange(n, n); }
    });
  }

  // ---- the Notes tab -------------------------------------------------------
  function renderPane() {
    pane.replaceChildren();
    const notes = live();
    const open = notes.filter((n) => n.status !== 'resolved');
    const head = el('div', 'np-head');
    const seg = el('div', 'seg seg-mini');
    for (const [v, label] of [['open', `Open ${open.length}`], ['all', `All ${notes.length}`]]) {
      const b = el('button', 'seg-btn' + (st.filter === v ? ' is-active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { st.filter = v; renderPane(); renderPins(); });
      seg.appendChild(b);
    }
    head.appendChild(seg);
    const pin = el('button', 'np-add' + (st.placing && st.placing.mode === 'new' ? ' is-on' : ''), '+ Pin note');
    pin.type = 'button';
    pin.title = 'Then click a spot on a part (or right-click a part → Add note here)';
    pin.addEventListener('click', () => {
      if (st.placing && st.placing.mode === 'new') { stopPlacing(); renderPane(); return; }
      if (guardUnsent()) return;
      closeNote();
      startPlacing('new');
      renderPane();
    });
    head.appendChild(pin);
    const add = el('button', 'np-add', '+ Overall');
    add.type = 'button';
    add.title = 'A note about the whole design, not one spot';
    add.addEventListener('click', () => startDraft({ kind: 'overall' }));
    head.appendChild(add);
    pane.appendChild(head);

    const shown = notes.filter((n) => st.filter === 'all' || n.status !== 'resolved');
    if (!shown.length) {
      pane.appendChild(el('div', 'parts-empty', notes.length
        ? 'Every note is resolved.'
        : 'No notes yet. Right-click a part to add one, or use + Pin note. Anyone you send this BomDom to can add notes too.'));
    }
    // Overall notes first, then one group per reviewer (who started the note).
    const groups = new Map();
    const overall = shown.filter((n) => n.kind === 'overall');
    for (const n of shown) {
      if (n.kind === 'overall') continue;
      const who = starter(n) || 'someone';
      if (!groups.has(who)) groups.set(who, []);
      groups.get(who).push(n);
    }
    const sortN = (a, b) => numberOf(a) - numberOf(b);
    if (overall.length) {
      pane.appendChild(el('div', 'np-group', 'Overall'));
      overall.sort(sortN).forEach((n) => pane.appendChild(itemFor(n)));
    }
    for (const [who, list] of groups) {
      const g = el('div', 'np-group');
      const sw = el('span', 'np-sw');
      sw.style.background = authorColor(who);
      g.appendChild(sw);
      g.appendChild(document.createTextNode(who + (who === myName ? ' · you' : '')));
      pane.appendChild(g);
      list.sort(sortN).forEach((n) => pane.appendChild(itemFor(n)));
    }

    const foot = el('div', 'np-foot');
    const sign = el('div', 'np-sign');
    if (myName) {
      sign.appendChild(document.createTextNode('Signing as '));
      const b = el('button', 'nc-link', myName);
      b.type = 'button';
      b.title = 'Change the name your notes are signed with';
      b.addEventListener('click', () => editName(sign));
      sign.appendChild(b);
    } else {
      const b = el('button', 'nc-link', 'Add your name');
      b.type = 'button';
      b.title = 'The name your notes are signed with';
      b.addEventListener('click', () => editName(sign));
      sign.appendChild(b);
    }
    foot.appendChild(sign);
    const share = el('button', 'btn btn-primary np-share', 'Share notes…');
    share.type = 'button';
    share.disabled = !notes.length;
    share.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const r = share.getBoundingClientRect();
      showShareMenu(r.left, r.top);
    });
    foot.appendChild(share);
    const load = el('button', 'btn btn-secondary', 'Load…');
    load.type = 'button';
    load.title = 'Merge notes from a notes file or a BomDom copy (you can also drop them on the 3D view)';
    load.addEventListener('click', pickFiles);
    foot.appendChild(load);
    const exp = el('button', 'btn btn-secondary', 'Export…');
    exp.type = 'button';
    exp.disabled = !notes.length;
    exp.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const r = exp.getBoundingClientRect();
      showExportMenu(r.left, r.top);
    });
    foot.appendChild(exp);
    pane.appendChild(foot);
  }

  function editName(holder) {
    const input = el('input', 'nc-name np-name');
    input.value = myName;
    input.placeholder = 'Your name';
    input.maxLength = 60;
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) setMyName(input.value); else renderPane();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    holder.replaceChildren(input);
    input.focus();
    input.select();
  }

  function itemFor(n) {
    const it = el('button', 'np-item' + (st.openId === n.id ? ' is-open' : ''));
    it.type = 'button';
    const dot = el('span', 'note-dot');
    dot.textContent = n.status === 'resolved' ? '✓' : String(numberOf(n));
    dot.style.setProperty('--pin', n.status === 'resolved' ? 'var(--success)' : authorColor(starter(n)));
    it.appendChild(dot);
    const body = el('span', 'np-body');
    if (n.kind !== 'overall') {
      body.appendChild(el('span', 'np-part', `${n.part}${n.label ? ' · ' + n.label : ''}${n.kind === 'part' ? ' · whole part' : ''}`));
    }
    const first = n.entries[0] || {};
    body.appendChild(el('span', 'np-text', first.text || (first.doodle ? '(sketch)' : '')));
    const replies = n.entries.length - 1;
    body.appendChild(el('span', 'np-meta', [first.author, fmtDate(first.at),
      replies ? `${replies} repl${replies > 1 ? 'ies' : 'y'}` : ''].filter(Boolean).join(' · ')));
    it.appendChild(body);
    if (n.entries.some((e) => e.doodle && e.doodle.length)) {
      const s = el('span', 'np-sketch');
      s.innerHTML = ICON.sketch;
      s.title = 'Has a sketch';
      it.appendChild(s);
    }
    it.addEventListener('click', () => (st.openId === n.id ? closeNote() : openNote(n.id)));
    return it;
  }

  // ---- sharing -------------------------------------------------------------
  const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function myDoc() {
    // The notes I started, replied to, resolved or deleted (all of each).
    if (!myName) return st.doc;
    const mine = st.doc.notes.filter((n) => n.statusBy === myName || n.deletedBy === myName
      || n.entries.some((e) => e.author === myName));
    // Nothing of mine (only reading someone else's copy): pass everything on.
    return { ...st.doc, build: buildInfo(), notes: mine.length ? mine : st.doc.notes };
  }
  function showShareMenu(x, y) {
    const mine = JSON.stringify(myDoc());
    const all = JSON.stringify(st.doc);
    const items = [
      { head: 'Share notes' },
      { label: `${myName ? 'My notes only' : 'Notes only'} (.json · ${kb(mine.length)})`, onClick: saveJson },
      canCopy()
        ? { label: `BomDom with all notes (.html · ${kb(copySize() + all.length)})`, onClick: saveCopy }
        : { label: 'BomDom with all notes (not available in this file)', disabled: true },
    ];
    app.ui.showMenu(x, y, items);
  }
  function saveJson() {
    const doc = myDoc();
    const asm = sanitizeFile(buildInfo().assembly);
    const who = myName ? '_' + sanitizeFile(myName).replace(/\s+/g, '-').replace(/[.-]+$/, '') : '';
    download(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), `${asm}_notes${who}.json`);
    app.ui.toast(`Saved ${doc.notes.filter((n) => !n.deleted).length} note(s) — send the file back; dropping it on the BomDom merges it`);
  }
  function saveCopy() {
    let html;
    try { html = buildCopy({ ...st.doc, build: buildInfo() }); } catch (e) { app.ui.toast(e.message); return; }
    let base = decodeURIComponent((location.pathname.split('/').pop() || '').replace(/\.html?$/i, ''));
    if (!base) base = sanitizeFile(buildInfo().assembly) + '_BomDom';
    base = base.replace(/_notes$/i, '');
    download(new Blob([html], { type: 'text/html' }), `${sanitizeFile(base)}_notes.html`);
    app.ui.toast('Saved a copy of this BomDom with every note inside');
  }

  // Files in: notes .json or a BomDom .html copy (only its notes are read).
  function mergeFiles(files) {
    const list = [...files].filter((f) => /\.(json|html?)$/i.test(f.name));
    if (!list.length) return;
    let pending = list.length;
    const results = [];
    for (const f of list) {
      const r = new FileReader();
      r.onload = () => {
        let doc = null;
        if (/\.html?$/i.test(f.name)) doc = notesFromHtml(String(r.result));
        else { try { doc = JSON.parse(String(r.result)); } catch { doc = null; } }
        results.push({ name: f.name, doc });
        if (--pending === 0) finishMerge(results);
      };
      r.onerror = () => { results.push({ name: f.name, doc: null }); if (--pending === 0) finishMerge(results); };
      r.readAsText(f);
    }
  }
  function notesFromHtml(html) {
    const m = /id=['"]bomdom-notes['"]>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return { error: 'has no notes slot' };
    if (!m[1].trim()) return { format: FORMAT, version: VERSION, build: buildInfo(), notes: [] };
    try { return JSON.parse(m[1]); } catch { return null; }
  }
  function finishMerge(results) {
    let added = 0, updated = 0;
    const authors = new Set();
    const errors = [];
    for (const { name, doc } of results) {
      if (doc && doc.format === 'bomdom-view' && app.viewstate) { app.viewstate.apply(doc); continue; }
      const res = doc && !doc.error ? merge(doc) : { error: (doc && doc.error) || 'not a notes file' };
      if (res.error) { errors.push(`"${name}" is ${res.error}`); continue; }
      added += res.added; updated += res.updated;
      res.authors.forEach((a) => authors.add(a));
    }
    if (errors.length) app.ui.toast(errors.join(' · '));
    else if (added || updated) {
      showNotesTab();
      const who = [...authors].join(', ');
      const bits = [added ? `${added} new note${added > 1 ? 's' : ''}` : '',
        updated ? `${updated} updated` : ''].filter(Boolean).join(', ');
      app.ui.toast(`Merged ${bits}${who ? ' from ' + who : ''}`);
    } else app.ui.toast('Nothing new in those notes');
  }
  function pickFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.json,.html,.htm,application/json,text/html';
    input.addEventListener('change', () => { if (input.files) mergeFiles(input.files); });
    input.click();
  }

  // ---- exports ---------------------------------------------------------------
  function exportCtx() {
    const notes = live().slice().sort((a, b) => numberOf(a) - numberOf(b));
    return {
      app, notes, numberOf, authorColor, anchorWorld, toScreen, recOf,
      asm: buildInfo().assembly, version: app.meta.app_version || '',
      showView, snapView, drawStrokes, viewMatches,
    };
  }
  function showExportMenu(x, y) {
    const run = (fn) => () => {
      closeNote();
      Promise.resolve(fn(exportCtx())).catch((e) => {
        console.error('[BomDom] notes export failed', e);
        app.ui.toast('Export failed: ' + e.message);
      });
    };
    app.ui.showMenu(x, y, [
      { head: 'Export notes' },
      { label: 'Excel (.xlsx) — Review sheet', onClick: run(exportNotesExcel) },
      { label: 'PDF — notes pages', onClick: run(exportNotesPdf) },
      { label: 'Copy as text', onClick: async () => {
        const ok = await copyText(notesAsText(exportCtx()));
        app.ui.toast(ok ? 'Notes copied — paste into Jira, Teams or a change order' : 'Could not reach the clipboard');
      } },
    ]);
  }

  // ---- sketches ----------------------------------------------------------------
  function sizeLayer() {
    const r = viewport.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (layer.width !== w || layer.height !== h) { layer.width = w; layer.height = h; }
    return { w: r.width, h: r.height, dpr };
  }

  // u,v: height-normalised offsets from the view centre (same camera → same
  // spot at any window width, since the vertical field of view is fixed).
  const toUV = (x, y, w, h) => [(x - w / 2) / h, (y - h / 2) / h];

  // Shared with the exports: draws strokes onto any 2D context of size w×h.
  function drawStrokes(g, strokes, w, h, fallbackColor, alpha = 1) {
    const X = (u) => w / 2 + u * h, Y = (v) => h / 2 + v * h;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of strokes) {
      const pts = s.pts || [];
      if (!pts.length) continue;
      g.strokeStyle = s.c || fallbackColor;
      g.lineWidth = Math.max(1.5, (s.w || STROKE_W) * h);
      g.beginPath();
      if (s.t === 'pen') {
        g.moveTo(X(pts[0][0]), Y(pts[0][1]));
        for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i][0]), Y(pts[i][1]));
        if (pts.length === 1) g.lineTo(X(pts[0][0]) + 0.1, Y(pts[0][1]));
        g.stroke();
      } else if (pts.length >= 2) {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        const x1 = X(a[0]), y1 = Y(a[1]), x2 = X(b[0]), y2 = Y(b[1]);
        if (s.t === 'box') {
          g.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          g.stroke();
        } else if (s.t === 'circle') {
          g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2 || 0.5, Math.abs(y2 - y1) / 2 || 0.5, 0, 0, Math.PI * 2);
          g.stroke();
        } else { // arrow: shaft + head at the end point
          g.moveTo(x1, y1);
          g.lineTo(x2, y2);
          g.stroke();
          const ang = Math.atan2(y2 - y1, x2 - x1);
          const hl = Math.max(9, g.lineWidth * 4);
          g.beginPath();
          g.moveTo(x2, y2);
          g.lineTo(x2 - hl * Math.cos(ang - 0.45), y2 - hl * Math.sin(ang - 0.45));
          g.moveTo(x2, y2);
          g.lineTo(x2 - hl * Math.cos(ang + 0.45), y2 - hl * Math.sin(ang + 0.45));
          g.stroke();
        }
      }
    }
    g.restore();
  }

  // A stroke as a polyline in uv, for the eraser's hit test.
  function strokePath(s) {
    const pts = s.pts || [];
    if (s.t === 'pen' || pts.length < 2) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    if (s.t === 'box') return [a, [b[0], a[1]], b, [a[0], b[1]], a];
    if (s.t === 'circle') {
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      const out = [];
      for (let i = 0; i <= 32; i++) { const t = i / 32 * Math.PI * 2; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
      return out;
    }
    return [a, b];
  }
  function strokeHit(s, uv, tolUV) {
    const path = strokePath(s);
    const reach = tolUV + (s.w || STROKE_W) / 2;
    if (path.length === 1) return Math.hypot(uv[0] - path[0][0], uv[1] - path[0][1]) <= reach;
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i];
      const dx = bx - ax, dy = by - ay;
      const L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((uv[0] - ax) * dx + (uv[1] - ay) * dy) / L)) : 0;
      if (Math.hypot(uv[0] - (ax + t * dx), uv[1] - (ay + t * dy)) <= reach) return true;
    }
    return false;
  }

  function drawDoodles() {
    const { w, h, dpr } = sizeLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let away = null;
    if (pinsShown()) {
      const d = st.draft;
      const note = st.openId ? byId(st.openId) : null;
      if (note) {
        for (const e of note.entries) {
          if (!e.doodle || !e.doodle.length) continue;
          if (d && d.editId === e.id) continue; // its strokes are in the draft
          const view = e.view || note.entries[0].view;
          const on = viewMatches(view);
          // While you sketch, strokes you can't change stay faint.
          drawStrokes(ctx, e.doodle, w, h, authorColor(e.author), !on ? 0.12 : st.drawing ? OTHER_ALPHA : 1);
          if (!on) away = { e, view };
        }
      }
      if (d && d.strokes.length) {
        const on = st.drawing || !d.view || viewMatches(d.view);
        drawStrokes(ctx, d.strokes, w, h, authorColor(myName), on ? 1 : 0.12);
        if (!on) away = { e: { author: myName }, view: d.view };
      }
      if (st.drawing && st.drawing.live && st.drawing.live.t !== 'eraser') {
        drawStrokes(ctx, [st.drawing.live], w, h, authorColor(myName));
      }
    }
    if (away && !st.drawing) {
      doodleChip.replaceChildren(el('span', null, 'Sketch hidden'));
      const back = el('button', null, `Back to ${away.e.author === myName ? 'your' : away.e.author + '’s'} view`);
      back.type = 'button';
      back.addEventListener('click', () => { showView(away.view); drawDoodles(); });
      doodleChip.appendChild(back);
      doodleChip.classList.remove('hidden');
    } else {
      doodleChip.classList.add('hidden');
    }
  }

  function startDrawing() {
    if (!st.draft) {
      const note = st.openId ? byId(st.openId) : null;
      if (!note) return;
      startReply(note);
    }
    stopPlacing();
    const d = st.draft;
    // The sketch is pinned to the view it is drawn on: freeze the camera.
    if (!d.view || !d.strokes.length) d.view = snapView();
    else if (!viewMatches(d.view)) showView(d.view);
    st.drawing = { tool: 'pen', color: null, live: null };
    viewer.controls.enabled = false;
    layer.classList.add('is-drawing');
    layer.classList.remove('is-erasing');
    renderStrip();
    renderCard();
    drawDoodles();
  }

  function stopDrawing() {
    if (!st.drawing) return;
    st.drawing = null;
    viewer.controls.enabled = true;
    layer.classList.remove('is-drawing', 'is-erasing');
    strip.classList.add('hidden');
    if (st.draft && !st.draft.strokes.length && !st.draft.editId) st.draft.view = null;
    renderCard();
    drawDoodles();
  }

  // Every change to the sketch is one undo step (erasing and Clear included).
  function sketchEdit(next) {
    const d = st.draft;
    if (!d) return;
    d.undo.push(d.strokes);
    d.strokes = next;
    drawDoodles();
    renderCard();
    renderStrip();
  }
  function undo() {
    const d = st.draft;
    if (!d || !d.undo.length) return;
    d.strokes = d.undo.pop();
    drawDoodles();
    renderCard();
    renderStrip();
  }

  const ICON = {
    sketch: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 11.5c1.6-3 3-4.4 4-3.4s-1 3.3.3 3.9c1.4.6 2.5-3.3 4.2-3.6 1.2-.2 1.1 1.8 2 2.2.7.3 1.6-.6 2.5-1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14l1-4 8-8 3 3-8 8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    eraser: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 14h8M2.6 9.6l6-6a1.5 1.5 0 012.1 0l2.7 2.7a1.5 1.5 0 010 2.1L8 13.8H5.2L2.6 11.7a1.5 1.5 0 010-2.1zM5.5 6.7l4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13L13 3M7 3h6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    circle: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="6" ry="5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    box: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    undo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4L2 7l3 3M2.5 7H10a4 4 0 010 8H8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // The colors after your own: two presets that don't look like it, then
  // a custom one from the system color picker.
  function penColors() {
    const mine = authorColor(myName);
    return PEN_PRESETS.filter(([c]) => !nearColor(c, mine)).slice(0, 2);
  }

  // The system color picker opens next to its <input>: keep that input
  // (invisible) on top of the rainbow swatch.
  const colorInput = el('input', 'ps-color-input');
  colorInput.type = 'color';
  colorInput.tabIndex = -1;
  colorInput.setAttribute('aria-hidden', 'true');
  strip.after(colorInput);
  const takeCustom = () => {
    customColor = colorInput.value;
    try { localStorage.setItem(CUSTOM_KEY, customColor); } catch { /* ignore */ }
    if (st.drawing) { st.drawing.color = customColor; if (st.drawing.tool === 'eraser') setTool('pen'); else renderStrip(); }
  };
  colorInput.addEventListener('input', takeCustom);
  colorInput.addEventListener('change', takeCustom);

  function setTool(name) {
    if (!st.drawing) return;
    st.drawing.tool = name;
    layer.classList.toggle('is-erasing', name === 'eraser');
    renderStrip();
  }

  function renderStrip() {
    const dr = st.drawing;
    strip.replaceChildren();
    if (!dr) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    const d = st.draft;
    const btn = (cls, html, label, onClick, { on = false, disabled = false } = {}) => {
      const b = el('button', 'ps-btn' + (cls ? ' ' + cls : '') + (on ? ' is-on' : ''));
      b.type = 'button';
      b.innerHTML = html;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      return b;
    };
    const tool = (name, label) => btn('', ICON[name], label, () => setTool(name), { on: dr.tool === name });
    const sep = () => el('span', 'ps-sep');

    strip.appendChild(el('span', 'ps-label', d && d.editId ? 'Editing sketch' : 'Sketch'));
    strip.appendChild(tool('pen', 'Pen'));
    strip.appendChild(tool('eraser', 'Eraser — drag over strokes to remove them'));
    strip.appendChild(sep());
    strip.appendChild(tool('arrow', 'Arrow'));
    strip.appendChild(tool('circle', 'Circle'));
    strip.appendChild(tool('box', 'Box'));
    strip.appendChild(sep());
    const swatch = (c, label) => {
      const sw = el('button', 'ps-sw' + (dr.color === c && dr.tool !== 'eraser' ? ' is-on' : ''));
      sw.type = 'button';
      sw.style.background = c || authorColor(myName);
      sw.title = label;
      sw.setAttribute('aria-label', label);
      sw.addEventListener('click', () => { dr.color = c; if (dr.tool === 'eraser') setTool('pen'); else renderStrip(); });
      return sw;
    };
    strip.appendChild(swatch(null, 'Your color'));
    for (const [c, label] of penColors()) strip.appendChild(swatch(c, label));
    const custom = el('button', 'ps-sw ps-custom' + (customColor && dr.color === customColor && dr.tool !== 'eraser' ? ' is-on' : ''));
    custom.type = 'button';
    if (customColor) custom.style.setProperty('--custom', customColor);
    custom.title = 'Pick any color';
    custom.setAttribute('aria-label', 'Pick any color');
    custom.addEventListener('click', () => {
      if (customColor) { dr.color = customColor; if (dr.tool === 'eraser') setTool('pen'); else renderStrip(); }
      const r = custom.getBoundingClientRect();
      colorInput.style.left = r.left + 'px';
      colorInput.style.top = r.top + 'px';
      colorInput.value = customColor || '#ff7a00';
      colorInput.click();
    });
    strip.appendChild(custom);
    strip.appendChild(sep());
    const n = d ? d.strokes.length : 0;
    strip.appendChild(btn('', ICON.undo, 'Undo (Ctrl+Z)', undo, { disabled: !(d && d.undo.length) }));
    const clear = btn('ps-text', 'Clear', d && d.editId ? 'Remove every stroke in this sketch' : 'Remove every stroke you drew here', () => sketchEdit([]), { disabled: !n });
    strip.appendChild(clear);
    strip.appendChild(sep());
    const done = btn('ps-text ps-done', ICON.check + '<span>Finish sketch</span>', 'Finish sketching and go back to the note (Esc)', stopDrawing);
    strip.appendChild(done);
  }

  // Pointer input on the sketch layer (only live while drawing).
  let drawPid = null;
  const uvAt = (ev) => {
    const r = layer.getBoundingClientRect();
    return { uv: toUV(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height), h: r.height };
  };
  function eraseAt(uv, h) {
    const d = st.draft;
    const dr = st.drawing;
    const keep = d.strokes.filter((s) => !strokeHit(s, uv, ERASE_PX / h));
    if (keep.length === d.strokes.length) return;
    if (!dr.erased) { dr.erased = true; d.undo.push(d.strokes); } // one undo step per drag
    d.strokes = keep;
    drawDoodles();
  }
  layer.addEventListener('pointerdown', (ev) => {
    if (!st.drawing || ev.button !== 0 || !st.draft) return;
    ev.preventDefault();
    layer.setPointerCapture(ev.pointerId);
    drawPid = ev.pointerId;
    const { uv, h } = uvAt(ev);
    if (st.drawing.tool === 'eraser') {
      st.drawing.live = { t: 'eraser' };
      st.drawing.erased = false;
      eraseAt(uv, h);
      return;
    }
    st.drawing.live = { t: st.drawing.tool, c: st.drawing.color || authorColor(myName), w: STROKE_W, pts: [uv] };
    drawDoodles();
  });
  layer.addEventListener('pointermove', (ev) => {
    if (!st.drawing || !st.drawing.live || ev.pointerId !== drawPid) return;
    const { uv, h } = uvAt(ev);
    const s = st.drawing.live;
    if (s.t === 'eraser') { eraseAt(uv, h); return; }
    if (s.t === 'pen') {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(uv[0] - last[0], uv[1] - last[1]) * h < 2) return;
      s.pts.push(uv);
    } else {
      s.pts[1] = uv;
    }
    drawDoodles();
  });
  const endStroke = (ev) => {
    if (!st.drawing || !st.drawing.live || ev.pointerId !== drawPid) return;
    drawPid = null;
    const s = st.drawing.live;
    st.drawing.live = null;
    if (s.t === 'eraser') {
      if (st.drawing.erased) { renderCard(); renderStrip(); }
      st.drawing.erased = false;
      return;
    }
    const r = layer.getBoundingClientRect();
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]) * r.height;
    if (s.t === 'pen' || span > 4) {
      s.pts = s.pts.map(([u, v]) => [Math.round(u * 1e4) / 1e4, Math.round(v * 1e4) / 1e4]);
      sketchEdit([...st.draft.strokes, s]);
    } else {
      drawDoodles();
    }
  };
  layer.addEventListener('pointerup', endStroke);
  layer.addEventListener('pointercancel', endStroke);
  // Ctrl+Z while sketching (and not typing in the note) undoes a stroke.
  document.addEventListener('keydown', (ev) => {
    if (!st.drawing || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z') return;
    const t = ev.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
    ev.preventDefault();
    undo();
  });

  // ---- follow the app -----------------------------------------------------------
  viewer.onCameraChange(() => { layoutPins(); drawDoodles(); });
  new ResizeObserver(() => { layoutPins(); drawDoodles(); }).observe(viewport);
  for (const evName of ['positions', 'appearance', 'scope', 'filter']) {
    app.events.on(evName, () => layoutPins());
  }
  // Instruction mode hides pins and the card; bring them back afterwards.
  app.events.on('instructions', () => refresh());
  function refresh() {
    if (!pinsShown()) cancel();
    renderPins();
    renderCard();
    drawDoodles();
  }

  // Notes live in this browser per build (so closing the tab loses nothing),
  // merged with any baked into the file.
  function load() {
    st.doc = emptyDoc();
    let local = null;
    try { local = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch { local = null; }
    if (local) merge(local, { from: 'boot' });
    const baked = readNotesSlot();
    if (baked && baked.notes) {
      const before = live().length;
      const res = merge(baked, { from: 'boot' });
      if (!res.error) st.fromFile = baked.notes.filter((n) => !n.deleted).length;
      if (res.error) console.warn('[BomDom] notes in this file are', res.error);
      if (live().length !== before) persist();
    }
    tab.classList.remove('hidden');
    renderCount();
    renderPane();
    renderPins();
    const open = live().filter((n) => n.status !== 'resolved').length;
    if (st.fromFile && live().length) {
      app.ui.toast(`This file has ${live().length} review note(s)${open ? ` (${open} open)` : ''} — see the Notes tab`);
    }
  }
  if (app.model) load();
  else app.events.on('model', () => { if (!st.doc) load(); });

  app.review = {
    get placing() { return !!st.placing; },
    cancel,
    refresh,
    escape,
    handleClick,
    toggleTab: toggleNotesTab,
    startPartNote: (rec) => startDraft({ kind: 'part', rec }),
    startSpotNote: (rec, world) => startDraft({ kind: 'point', rec, world }),
    startPlacing: () => startPlacing('new'),
    mergeFiles,
    // Structured readback for E2E checks.
    state: () => ({
      openId: st.openId, drawing: st.drawing && { tool: st.drawing.tool, color: st.drawing.color },
      placing: st.placing && { ...st.placing }, cardPos: st.cardPos,
      draft: st.draft && { ...st.draft, strokes: st.draft.strokes.length, undo: st.draft.undo.length },
      notes: live().map((n) => ({ id: n.id, n: numberOf(n), kind: n.kind, part: n.part, rec: n.rec, p: n.p, status: n.status,
        entries: n.entries.map((e) => ({ id: e.id, author: e.author, text: e.text, edited: !!e.editedAt, strokes: (e.doodle || []).length, view: !!e.view })) })),
    }),
    doc: () => st.doc,
  };
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
