// Review notes: engineers pin notes to a spot on a part, to a whole part, or
// to the design overall; reply, resolve, and sketch on the view they wrote
// in. Everything stays offline. Notes travel two ways from one "Share
// notes…" button — a small .json of the notes, or a full copy of this
// BomDom with the notes baked in (selfcopy.js) — and dropping either kind on
// a BomDom merges its notes. Notes belong to ONE build: a file from another
// export of the assembly is refused.
//
// Each note's first entry (and any reply carrying a doodle) saves the full
// view setup it was written in (viewstate.js serialize: camera, explode,
// section, hidden/moved parts, scope). Opening a note restores that setup,
// so a reader sees exactly what the writer saw. Doodles are strokes stored
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
// One color per reviewer, picked from their name, so Sam is the same color
// in every copy of the file.
const AUTHOR_COLORS = ['#e08a1e', '#7a5bd6', '#2f9e63', '#d64545', '#3a72d4', '#c2417a', '#8a6d1a'];
const PEN_COLORS = [null, '#e5484d', '#3a72d4', '#2f9e63']; // null = your own color
const STROKE_W = 0.0045; // stroke width as a share of the view height
const NOTE_PIN_LIFT = 22;

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

export function initReview(app) {
  const viewer = app.viewer;
  const sel = app.sel;
  const viewport = $('viewport');
  const canvas = viewer.renderer.domElement;
  const pinsEl = $('notePins');
  const card = $('noteCard');
  const chip = $('reviewChip');
  const strip = $('penStrip');
  const doodleChip = $('doodleChip');
  const layer = $('doodleLayer');
  const pane = $('notesPane');
  const tab = $('tabNotes');
  const btn = $('btnReview');
  const countEl = $('reviewCount');
  const ctx = layer.getContext('2d');

  const st = {
    on: false,
    doc: null,           // { format, version, build, notes }
    openId: null,        // note shown in the card
    draft: null,         // { kind, recId, p, noteId (reply), text, strokes, view }
    drawing: null,       // { tool, color, live } while the pen strip is up
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
    renderChip();
  };

  // ---- the notes document -------------------------------------------------
  const emptyDoc = () => ({ format: FORMAT, version: VERSION, build: buildInfo(), notes: [] });
  const live = () => (st.doc ? st.doc.notes.filter((n) => !n.deleted) : []);
  const byId = (id) => (st.doc ? st.doc.notes.find((n) => n.id === id) : null);
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
  // by id; the newest status change wins; a deletion wins outright.
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
        const have = new Set(cur.entries.map((e) => e.id));
        for (const e of inc.entries || []) {
          if (e && typeof e.id === 'string' && !have.has(e.id)) {
            cur.entries.push(sanitizeEntry(e));
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

  // ---- views ---------------------------------------------------------------
  const snapView = () => (app.viewstate ? app.viewstate.serialize() : null);
  function showView(view) {
    if (!view || !app.viewstate) return;
    app.viewstate.apply(view, { quiet: true });
  }
  // Does the camera still show the view a doodle was drawn on?
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

  // ---- mode ------------------------------------------------------------------
  function set(on) {
    on = !!on;
    if (on === st.on) return;
    if (on && !app.model) { app.ui.toast('No 3D model loaded'); return; }
    st.on = on;
    app.reviewMode = on;
    btn.classList.toggle('is-on', on);
    chip.classList.toggle('hidden', !on);
    pinsEl.classList.toggle('hidden', !on);
    tab.classList.toggle('hidden', !on);
    canvas.classList.toggle('is-review', on);
    if (on) {
      // One owner for canvas clicks at a time.
      if (app.measureMode && app.measure) app.measure.toggle();
      if (app.instructions && app.instructions.on) app.instructions.set(false);
      if (app.actions) { app.actions.setMoveMode(false); app.actions.setAssemblyMode(false); }
      if (app.ui.setPanelHidden) app.ui.setPanelHidden(false);
      tab.click();
      if (!live().length) app.ui.toast('Review: click a part to pin a note — right-click for the whole part (N to exit)');
    } else {
      stopDrawing();
      st.draft = null;
      closeNote();
      if (tab.classList.contains('is-active')) $('tabParts').click();
    }
    renderChip();
    renderPane();
    renderPins();
    drawDoodles();
  }

  // Esc: drawing → done; open card → close; else leave the mode.
  function escape() {
    if (!st.on) return false;
    if (st.drawing) { stopDrawing(); return true; }
    if (st.openId || st.draft) { st.draft = null; closeNote(); return true; }
    set(false);
    return true;
  }

  // ---- canvas clicks (picking.js hands them over in review mode) -----------
  function handleClick(ev, hit) {
    if (st.drawing) return;
    if (st.draft && (st.draft.text.trim() || st.draft.strokes.length)) {
      app.ui.toast('Post or close the note you are writing first (Esc closes it)');
      return; // never throw away unsent work on a stray click
    }
    if (!hit) {
      st.draft = null;
      closeNote();
      return;
    }
    startDraft({ kind: 'point', rec: hit.rec, world: hit.point });
  }

  function startDraft({ kind, rec = null, world = null }) {
    if (!st.on) set(true);
    stopDrawing();
    closeNote(true);
    let p = null;
    if (rec) {
      rec.object.updateWorldMatrix(true, false);
      let w = world;
      if (!w) { // whole part: anchor at the middle of its visible geometry
        const box = M.boxOfRecs([rec]);
        w = box.isEmpty() ? new THREE.Vector3().setFromMatrixPosition(rec.object.matrixWorld) : box.getCenter(new THREE.Vector3());
      }
      p = w.clone().applyMatrix4(rec.object.matrixWorld.clone().invert()).toArray();
    }
    st.draft = { kind, recId: rec ? rec.id : null, p, noteId: null, text: '', strokes: [], view: null };
    renderPins();
    renderCard();
    drawDoodles();
    if (kind === 'part' && rec) sel.setHover({ ids: M.subtree(rec).map((r) => r.id), src: 'note' });
    focusComposer();
  }

  function startReply(note) {
    st.draft = { kind: note.kind, recId: note.rec, p: note.p, noteId: note.id, text: '', strokes: [], view: null };
  }

  function post() {
    const d = st.draft;
    if (!d) return;
    const text = d.text.trim();
    if (!text && !d.strokes.length) { app.ui.toast('Write a note or draw on the view first'); return; }
    if (!myName) { app.ui.toast('Add your name first'); focusComposer(); return; }
    const now = new Date().toISOString();
    const entry = { id: uid(), author: myName, at: now, text };
    if (d.strokes.length) entry.doodle = d.strokes;
    if (d.noteId) {
      const note = byId(d.noteId);
      if (!note) return;
      if (d.strokes.length) entry.view = d.view || snapView();
      note.entries.push(entry);
      st.draft = null;
      st.openId = note.id;
    } else {
      entry.view = d.view || snapView();
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
  function openNote(id, { restore = true } = {}) {
    const note = byId(id);
    if (!note || note.deleted) return;
    if (!st.on) set(true);
    stopDrawing();
    st.draft = null;
    st.openId = id;
    if (restore && note.entries[0] && note.entries[0].view) showView(note.entries[0].view);
    const rec = recOf(note);
    if (note.kind === 'part' && rec) sel.setHover({ ids: M.subtree(rec).map((r) => r.id), src: 'note' });
    else if (sel.hover && sel.hover.src === 'note') sel.setHover(null);
    renderPane();
    renderPins();
    renderCard();
    drawDoodles();
  }

  function closeNote(keepDraft) {
    st.openId = null;
    if (!keepDraft) st.draft = null;
    if (sel.hover && sel.hover.src === 'note') sel.setHover(null);
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
    card.classList.add('hidden');
    changed();
  }

  // ---- toolbar count + chip -------------------------------------------------
  function renderCount() {
    const open = live().filter((n) => n.status !== 'resolved').length;
    countEl.textContent = open ? String(open) : '';
    countEl.classList.toggle('hidden', !open);
    btn.title = open
      ? `Review notes — ${open} open (N)`
      : 'Review notes — click a part to pin a note (N)';
  }

  function renderChip() {
    chip.replaceChildren();
    chip.appendChild(el('span', null, 'Review'));
    chip.appendChild(el('span', 'mc-hint', 'click a part to pin a note · right-click for the whole part'));
    const who = el('button', 'rc-name', myName ? `as ${myName}` : 'add your name');
    who.type = 'button';
    who.title = 'The name your notes are signed with';
    who.addEventListener('click', () => {
      const input = el('input', 'rc-name-input');
      input.value = myName;
      input.placeholder = 'Your name';
      input.maxLength = 60;
      const done = () => { if (input.value.trim()) setMyName(input.value); else renderChip(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderChip(); });
      input.addEventListener('blur', done);
      who.replaceWith(input);
      input.focus();
    });
    chip.appendChild(who);
    const x = el('button', null, '✕');
    x.type = 'button';
    x.title = 'Leave review mode (N)';
    x.addEventListener('click', () => set(false));
    chip.appendChild(x);
  }

  // ---- pins --------------------------------------------------------------------
  const pinEls = new Map(); // note id (or 'draft') -> element
  function renderPins() {
    const want = new Map();
    if (st.on) {
      for (const n of live()) {
        if (n.kind === 'overall' || !n.p) continue;
        if (st.filter === 'open' && n.status === 'resolved' && st.openId !== n.id) continue;
        want.set(n.id, n);
      }
      if (st.draft && !st.draft.noteId && st.draft.p) want.set('draft', null);
    }
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
      const color = note ? authorColor(note.entries[0] && note.entries[0].author) : authorColor(myName);
      const done = note && note.status === 'resolved';
      e.style.setProperty('--pin', done ? 'var(--success)' : color);
      e.textContent = id === 'draft' ? '+' : done ? '✓' : String(numberOf(note));
      e.classList.toggle('is-open', id === st.openId || id === 'draft');
      e.title = note ? `#${numberOf(note)} ${note.part}${note.label ? ' — ' + note.label : ''}` : 'New note';
    }
    layoutPins();
  }

  function layoutPins() {
    if (!st.on) return;
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
    const pin = pinEls.get(st.draft && !st.draft.noteId ? 'draft' : st.openId);
    let x = 12, y = 12;
    if (pin && !pin.classList.contains('hidden')) {
      x = parseFloat(pin.style.left) + 18;
      y = parseFloat(pin.style.top) - NOTE_PIN_LIFT - 20;
      if (x + card.offsetWidth > vr.width - 10) x = parseFloat(pin.style.left) - card.offsetWidth - 18;
    }
    x = Math.max(8, Math.min(x, vr.width - card.offsetWidth - 8));
    y = Math.max(8, Math.min(y, vr.height - card.offsetHeight - 8));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  function renderCard() {
    const note = st.openId ? byId(st.openId) : null;
    const d = st.draft;
    // While sketching, the card steps aside so it never covers the view.
    if ((!note && !d) || st.drawing) { card.classList.add('hidden'); return; }
    card.replaceChildren();
    card.classList.remove('hidden');

    const head = el('div', 'nc-head');
    const kind = note ? note.kind : d.kind;
    const dot = el('span', 'note-dot');
    if (note) {
      dot.textContent = note.status === 'resolved' ? '✓' : String(numberOf(note));
      dot.style.setProperty('--pin', note.status === 'resolved' ? 'var(--success)' : authorColor(note.entries[0] && note.entries[0].author));
    } else {
      dot.textContent = '+';
      dot.style.setProperty('--pin', authorColor(myName));
    }
    head.appendChild(dot);
    const rec = note ? recOf(note) : (d.recId != null ? app.model.records[d.recId] : null);
    const title = note
      ? (note.kind === 'overall' ? 'Overall' : `${note.part}${note.label ? ' — ' + note.label : ''}`)
      : (kind === 'overall' ? 'New overall note' : (() => { const i = partInfo(rec); return `${i.number}${i.label ? ' — ' + i.label : ''}`; })());
    const t = el('span', 'nc-title', title);
    t.title = title + (kind === 'part' ? ' (whole part)' : '');
    head.appendChild(t);
    if (kind === 'part') head.appendChild(el('span', 'nc-kind', 'whole part'));
    const x = el('button', 'nc-x', '✕');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.addEventListener('click', () => closeNote());
    head.appendChild(x);
    card.appendChild(head);

    if (note) {
      const thread = el('div', 'nc-thread');
      note.entries.forEach((e, i) => {
        const m = el('div', 'nc-entry');
        const meta = el('div', 'nc-meta');
        const a = el('span', 'nc-author', e.author || 'someone');
        a.style.color = authorColor(e.author);
        meta.appendChild(a);
        meta.appendChild(el('span', 'nc-date', fmtDate(e.at)));
        if (e.doodle && e.doodle.length) {
          const v = el('button', 'nc-sketch', '✎ sketch');
          v.type = 'button';
          v.title = i === 0 ? 'Show the view this was drawn on' : `Show ${e.author}'s view`;
          v.addEventListener('click', () => { showView(e.view || note.entries[0].view); drawDoodles(); });
          meta.appendChild(v);
        }
        m.appendChild(meta);
        if (e.text) m.appendChild(el('div', 'nc-text', e.text));
        thread.appendChild(m);
      });
      card.appendChild(thread);
      if (note.status === 'resolved' && note.statusBy) {
        card.appendChild(el('div', 'nc-resolved', `Resolved by ${note.statusBy} · ${fmtDate(note.statusAt)}`));
      }
    }

    // Composer: a new note, or a reply to the open one.
    const composing = d && (!note || d.noteId === note.id);
    if (!composing && note && !st.drawing) startReply(note);
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
    ta.rows = note ? 2 : 3;
    ta.placeholder = note ? 'Reply…' : 'Write a note…';
    ta.value = dd.text;
    ta.addEventListener('input', () => { dd.text = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); }
    });
    comp.appendChild(ta);
    const row = el('div', 'nc-actions');
    const pen = el('button', 'nc-btn nc-icon' + (st.drawing ? ' is-on' : ''));
    pen.type = 'button';
    pen.innerHTML = ICON.pen;
    pen.title = dd.strokes.length ? `Draw on the view (${dd.strokes.length} stroke${dd.strokes.length > 1 ? 's' : ''})` : 'Draw on the view';
    pen.addEventListener('click', () => (st.drawing ? stopDrawing() : startDrawing()));
    row.appendChild(pen);
    if (dd.strokes.length) row.appendChild(el('span', 'nc-hint', `✎ ${dd.strokes.length}`));
    row.appendChild(el('span', 'nc-spacer'));
    if (note) {
      const res = el('button', 'nc-btn', note.status === 'resolved' ? 'Reopen' : 'Resolve');
      res.type = 'button';
      res.addEventListener('click', () => setStatus(note, note.status === 'resolved' ? 'open' : 'resolved'));
      row.appendChild(res);
      if (note.entries[0] && note.entries[0].author === myName) {
        const del = el('button', 'nc-btn nc-danger', 'Delete');
        del.type = 'button';
        del.title = 'Delete this note for everyone who merges your notes';
        del.addEventListener('click', () => {
          if (del.dataset.armed) { removeNote(note); return; }
          del.dataset.armed = '1';
          del.textContent = 'Delete?';
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Delete'; } }, 2500);
        });
        row.appendChild(del);
      }
    }
    const go = el('button', 'nc-btn nc-primary', note ? 'Reply' : 'Post');
    go.type = 'button';
    go.title = 'Ctrl+Enter';
    go.addEventListener('click', post);
    row.appendChild(go);
    comp.appendChild(row);
    card.appendChild(comp);
    placeCard(); // now, so the card never flashes in the corner first
  }

  function focusComposer() {
    requestAnimationFrame(() => { const ta = $('noteInput'); if (ta) ta.focus(); });
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
    const add = el('button', 'np-add', '+ Overall note');
    add.type = 'button';
    add.title = 'A note about the whole design, not one spot';
    add.addEventListener('click', () => startDraft({ kind: 'overall' }));
    head.appendChild(add);
    pane.appendChild(head);

    const shown = notes.filter((n) => st.filter === 'all' || n.status !== 'resolved');
    if (!shown.length) {
      pane.appendChild(el('div', 'parts-empty', notes.length
        ? 'Every note is resolved.'
        : 'No notes yet. Click a part to pin one, or add an overall note.'));
    }
    // Overall notes first, then one group per reviewer (who started the note).
    const groups = new Map();
    const overall = shown.filter((n) => n.kind === 'overall');
    for (const n of shown) {
      if (n.kind === 'overall') continue;
      const who = (n.entries[0] && n.entries[0].author) || 'someone';
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

  function itemFor(n) {
    const it = el('button', 'np-item' + (st.openId === n.id ? ' is-open' : ''));
    it.type = 'button';
    const dot = el('span', 'note-dot');
    dot.textContent = n.status === 'resolved' ? '✓' : String(numberOf(n));
    dot.style.setProperty('--pin', n.status === 'resolved' ? 'var(--success)' : authorColor(n.entries[0] && n.entries[0].author));
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
      const s = el('span', 'np-sketch', '✎');
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
      if (!st.on) set(true);
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

  // ---- doodles -----------------------------------------------------------------
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

  function drawDoodles() {
    const { w, h, dpr } = sizeLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let away = null;
    if (st.on) {
      const note = st.openId ? byId(st.openId) : null;
      if (note) {
        for (const e of note.entries) {
          if (!e.doodle || !e.doodle.length) continue;
          const view = e.view || note.entries[0].view;
          const on = viewMatches(view);
          drawStrokes(ctx, e.doodle, w, h, authorColor(e.author), on ? 1 : 0.12);
          if (!on) away = { e, view };
        }
      }
      const d = st.draft;
      if (d && d.strokes.length) {
        const on = st.drawing || !d.view || viewMatches(d.view);
        drawStrokes(ctx, d.strokes, w, h, authorColor(myName), on ? 1 : 0.12);
        if (!on) away = { e: { author: myName }, view: d.view };
      }
      if (st.drawing && st.drawing.live) {
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
    // The doodle is pinned to the view it is drawn on: freeze the camera.
    if (!st.draft.view || !st.draft.strokes.length) st.draft.view = snapView();
    else if (!viewMatches(st.draft.view)) showView(st.draft.view);
    st.drawing = { tool: 'pen', color: null, live: null, more: false };
    viewer.controls.enabled = false;
    layer.classList.add('is-drawing');
    renderStrip();
    renderCard();
    drawDoodles();
  }

  function stopDrawing() {
    if (!st.drawing) return;
    st.drawing = null;
    viewer.controls.enabled = true;
    layer.classList.remove('is-drawing');
    strip.classList.add('hidden');
    if (st.draft && !st.draft.strokes.length) st.draft.view = null;
    renderCard();
    drawDoodles();
    focusComposer();
  }

  const ICON = {
    pen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 14l1-4 8-8 3 3-8 8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13L13 3M7 3h6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    circle: '<svg viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="8" rx="6" ry="5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    box: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    undo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 4L2 7l3 3M2.5 7H10a4 4 0 010 8H8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function renderStrip() {
    const dr = st.drawing;
    strip.replaceChildren();
    if (!dr) { strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    const tool = (name, label) => {
      const b = el('button', 'ps-btn' + (dr.tool === name ? ' is-on' : ''));
      b.type = 'button';
      b.innerHTML = ICON[name];
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', () => { dr.tool = name; renderStrip(); });
      return b;
    };
    if (dr.more) {
      const more = el('div', 'ps-more');
      more.appendChild(tool('circle', 'Circle'));
      more.appendChild(tool('box', 'Box'));
      more.appendChild(el('span', 'ps-sep'));
      for (const c of PEN_COLORS) {
        const sw = el('button', 'ps-sw' + (dr.color === c ? ' is-on' : ''));
        sw.type = 'button';
        sw.style.background = c || authorColor(myName);
        const label = c ? { '#e5484d': 'Red', '#3a72d4': 'Blue', '#2f9e63': 'Green' }[c] : 'Your color';
        sw.title = label;
        sw.setAttribute('aria-label', label);
        sw.addEventListener('click', () => { dr.color = c; renderStrip(); });
        more.appendChild(sw);
      }
      more.appendChild(el('span', 'ps-sep'));
      const clear = el('button', 'ps-btn ps-text', 'Clear');
      clear.type = 'button';
      clear.title = 'Remove every stroke in this sketch';
      clear.addEventListener('click', () => { st.draft.strokes = []; drawDoodles(); renderCard(); });
      more.appendChild(clear);
      strip.appendChild(more);
    }
    const row = el('div', 'ps-row');
    row.appendChild(tool('pen', 'Pen'));
    row.appendChild(tool('arrow', 'Arrow'));
    row.appendChild(el('span', 'ps-sep'));
    const undo = el('button', 'ps-btn');
    undo.type = 'button';
    undo.innerHTML = ICON.undo;
    undo.title = 'Undo';
    undo.setAttribute('aria-label', 'Undo');
    undo.addEventListener('click', () => { st.draft.strokes.pop(); drawDoodles(); renderCard(); });
    row.appendChild(undo);
    const more = el('button', 'ps-btn ps-text' + (dr.more ? ' is-on' : ''), '⋯');
    more.type = 'button';
    more.title = 'More: circle, box, colors, clear';
    more.setAttribute('aria-label', 'More tools');
    more.addEventListener('click', () => { dr.more = !dr.more; renderStrip(); });
    row.appendChild(more);
    const done = el('button', 'ps-btn ps-text ps-done', 'Done');
    done.type = 'button';
    done.title = 'Finish drawing (Esc)';
    done.addEventListener('click', stopDrawing);
    row.appendChild(done);
    strip.appendChild(row);
  }

  // Pointer input on the doodle layer (only live while drawing).
  let drawPid = null;
  layer.addEventListener('pointerdown', (ev) => {
    if (!st.drawing || ev.button !== 0) return;
    ev.preventDefault();
    layer.setPointerCapture(ev.pointerId);
    drawPid = ev.pointerId;
    const r = layer.getBoundingClientRect();
    const uv = toUV(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
    st.drawing.live = { t: st.drawing.tool, c: st.drawing.color || authorColor(myName), w: STROKE_W, pts: [uv] };
    drawDoodles();
  });
  layer.addEventListener('pointermove', (ev) => {
    if (!st.drawing || !st.drawing.live || ev.pointerId !== drawPid) return;
    const r = layer.getBoundingClientRect();
    const uv = toUV(ev.clientX - r.left, ev.clientY - r.top, r.width, r.height);
    const s = st.drawing.live;
    if (s.t === 'pen') {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(uv[0] - last[0], uv[1] - last[1]) * r.height < 2) return;
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
    const r = layer.getBoundingClientRect();
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]) * r.height;
    if (s.t === 'pen' || span > 4) {
      s.pts = s.pts.map(([u, v]) => [Math.round(u * 1e4) / 1e4, Math.round(v * 1e4) / 1e4]);
      st.draft.strokes.push(s);
    }
    drawDoodles();
    renderCard();
  };
  layer.addEventListener('pointerup', endStroke);
  layer.addEventListener('pointercancel', endStroke);

  // ---- follow the app -----------------------------------------------------------
  viewer.onCameraChange(() => { if (st.on) { layoutPins(); drawDoodles(); } });
  new ResizeObserver(() => { if (st.on) { layoutPins(); drawDoodles(); } }).observe(viewport);
  for (const evName of ['positions', 'appearance', 'scope', 'filter']) {
    app.events.on(evName, () => { if (st.on) layoutPins(); });
  }
  btn.addEventListener('click', () => set(!st.on));

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
    renderCount();
    renderChip();
    renderPane();
    const open = live().filter((n) => n.status !== 'resolved').length;
    if (st.fromFile && live().length) {
      app.ui.toast(`This file has ${live().length} review note(s)${open ? ` (${open} open)` : ''} — press N or Review to see them`);
    }
  }
  if (app.model) load();
  else app.events.on('model', () => { if (!st.doc) load(); });

  app.review = {
    get on() { return st.on; },
    set,
    escape,
    handleClick,
    startPartNote: (rec) => startDraft({ kind: 'part', rec }),
    mergeFiles,
    // Structured readback for E2E checks.
    state: () => ({
      on: st.on, openId: st.openId, drawing: !!st.drawing, draft: st.draft && { ...st.draft },
      notes: live().map((n) => ({ id: n.id, n: numberOf(n), kind: n.kind, part: n.part, status: n.status,
        entries: n.entries.map((e) => ({ author: e.author, text: e.text, strokes: (e.doodle || []).length, view: !!e.view })) })),
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
