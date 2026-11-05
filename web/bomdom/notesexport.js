// Review-note exports: an Excel Review sheet and PDF notes pages, each with
// a picture of the view the note was written in (pin and sketch drawn on),
// plus a plain-text list for pasting into Jira, Teams or a change order.
//
// Pictures are rendered at export time rather than stored with the notes —
// that keeps a notes file small. Each note's saved view is put back, the
// scene rendered on white, and the reader's own view restored at the end.

import * as THREE from 'three';
import writeXlsxFile from 'write-excel-file';
import { PdfDoc, wrapText, jpegInfo } from './pdf.js';
import { decodeDataUri } from './payload.js';
import { download, sanitizeFile, fileStamp } from './exports.js';

const HEADER_BG = '#1F3864';
const PIC_MAX_W = 1400;   // picture long edge cap (px)
const STROKE_FALLBACK = '#e08a1e';

const statusText = (n) => (n.status === 'resolved' ? 'Resolved' : 'Open');
const where = (n) => (n.kind === 'overall' ? 'Overall' : n.kind === 'part' ? 'Whole part' : 'Point');
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

// One picture per note: { note -> { bytes, width, height, components } }.
async function renderPictures(c, onProgress) {
  const { app } = c;
  const viewer = app.viewer;
  const out = new Map();
  if (!viewer || !app.model) return out;
  const saved = c.snapView();
  const prevBg = viewer.scene.background;
  try {
    for (let i = 0; i < c.notes.length; i++) {
      const note = c.notes[i];
      const root = note.entries[0];
      if (root && root.view) c.showView(root.view);
      app.model.root.updateWorldMatrix(true, true);
      viewer.scene.background = new THREE.Color('#ffffff');
      viewer.renderer.render(viewer.scene, viewer.camera);
      const gl = viewer.renderer.domElement;
      const k = Math.min(1, PIC_MAX_W / gl.width);
      const pic = document.createElement('canvas');
      pic.width = Math.max(1, Math.round(gl.width * k));
      pic.height = Math.max(1, Math.round(gl.height * k));
      const g = pic.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, pic.width, pic.height);
      g.drawImage(gl, 0, 0, pic.width, pic.height);
      viewer.scene.background = prevBg;

      // Sketches drawn on this same view (the note's, and any reply's).
      for (const e of note.entries) {
        if (!e.doodle || !e.doodle.length) continue;
        if (e.view && e !== root && !c.viewMatches(e.view)) continue;
        c.drawStrokes(g, e.doodle, pic.width, pic.height, c.authorColor(e.author) || STROKE_FALLBACK);
      }
      // The pin itself.
      const w = c.anchorWorld(note);
      const s = w ? c.toScreen(w) : null;
      if (s) {
        const rect = gl.getBoundingClientRect();
        const sx = pic.width / rect.width;
        const x = s.x * sx, y = s.y * sx;
        const color = c.authorColor(root && root.author);
        g.strokeStyle = color;
        g.fillStyle = color;
        g.lineWidth = 2 * sx;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y - 18 * sx);
        g.stroke();
        g.beginPath();
        g.arc(x, y, 3 * sx, 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(x, y - 28 * sx, 11 * sx, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#ffffff';
        g.font = `700 ${12 * sx}px Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(note.status === 'resolved' ? '✓' : String(c.numberOf(note)), x, y - 28 * sx + 0.5);
      }
      const dec = decodeDataUri(pic.toDataURL('image/jpeg', 0.86));
      const info = dec && jpegInfo(dec.bytes);
      if (info) out.set(note, { bytes: dec.bytes, ...info });
      if (onProgress) onProgress(i + 1, c.notes.length);
      // Let the toast paint between pictures on a long list.
      if (i % 4 === 3) await new Promise((r) => setTimeout(r));
    }
  } finally {
    viewer.scene.background = prevBg;
    if (saved) c.showView(saved);
    viewer.invalidate();
  }
  return out;
}

function threadLines(n) {
  return n.entries.map((e) => `${e.author || 'someone'} (${day(e.at)}): ${e.text || (e.doodle ? '(sketch)' : '')}`);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function notesAsText(c) {
  const open = c.notes.filter((n) => n.status !== 'resolved').length;
  const lines = [`${c.asm} — review notes (${open} open, ${c.notes.length - open} resolved)`, ''];
  for (const n of c.notes) {
    const head = n.kind === 'overall' ? 'Overall' : `${n.part}${n.label ? ' — ' + n.label : ''}${n.kind === 'part' ? ' (whole part)' : ''}`;
    lines.push(`#${c.numberOf(n)} [${statusText(n).toLowerCase()}] ${head}`);
    for (const t of threadLines(n)) lines.push('  ' + t);
    if (n.status === 'resolved' && n.statusBy) lines.push(`  Resolved by ${n.statusBy} (${day(n.statusAt)})`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export async function exportNotesExcel(c) {
  c.app.ui.toast(`Preparing ${c.notes.length} picture(s)…`);
  const pics = await renderPictures(c);
  const columns = ['#', 'Picture', 'Part number', 'Part', 'Where', 'Status', 'Started by', 'Date', 'Note', 'Replies'];
  const data = [];
  data.push([{ value: `${c.asm} — review notes — ${new Date().toLocaleDateString()}`, fontWeight: 'bold', span: columns.length },
    ...Array(columns.length - 1).fill(null)]);
  data.push(columns.map((h) => ({ value: h, fontWeight: 'bold', color: '#FFFFFF', backgroundColor: HEADER_BG, height: 20, alignVertical: 'center' })));
  const images = [];
  const PIC_W = 200, PIC_H = 130;
  c.notes.forEach((n, i) => {
    const root = n.entries[0] || {};
    const replies = n.entries.slice(1).map((e) => `${e.author} (${day(e.at)}): ${e.text || '(sketch)'}`).join('\n');
    const cell = (value, extra) => ({ value, alignVertical: 'top', wrap: true, ...extra });
    data.push([
      cell(c.numberOf(n), { align: 'center', height: 104 }),
      null,
      cell(n.kind === 'overall' ? '' : n.part),
      cell(n.kind === 'overall' ? '' : n.label),
      cell(where(n)),
      cell(statusText(n), n.status === 'resolved' ? { color: '#2F9E63' } : { color: '#C0392B' }),
      cell(root.author || ''),
      cell(day(root.at)),
      cell(root.text || (root.doodle ? '(sketch)' : '')),
      cell(replies),
    ]);
    const p = pics.get(n);
    if (!p) return;
    const s = Math.min(PIC_W / p.width, PIC_H / p.height);
    images.push({
      content: new Blob([p.bytes], { type: 'image/jpeg' }),
      contentType: 'image/jpeg',
      width: Math.max(1, Math.round(p.width * s)),
      height: Math.max(1, Math.round(p.height * s)),
      dpi: 96,
      anchor: { row: i + 3, column: 2 },
      offsetX: 3,
      offsetY: 3,
    });
  });
  const blob = await writeXlsxFile(data, {
    columns: [{ width: 5 }, { width: 30 }, { width: 18 }, { width: 24 }, { width: 11 }, { width: 10 },
      { width: 14 }, { width: 11 }, { width: 46 }, { width: 46 }],
    images: images.length ? images : undefined,
    sheet: 'Review',
    fontFamily: 'Calibri',
    fontSize: 11,
  });
  download(blob, `${sanitizeFile(c.asm)}_review_${fileStamp()}.xlsx`);
  c.app.ui.toast('Saved the Review sheet');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAGE_W = 612, PAGE_H = 792; // Letter, portrait
const MARGIN = 40;
const PIC_COL = 250;
const GAP = 14;

export async function exportNotesPdf(c) {
  c.app.ui.toast(`Preparing ${c.notes.length} picture(s)…`);
  const pics = await renderPictures(c);
  const stamp = `pictureBOM BomDom${c.version ? ' v' + c.version : ''}`;
  const title = `${c.asm} — review notes`;
  const doc = new PdfDoc({ title, producer: stamp });
  const pages = [];
  const bottom = PAGE_H - MARGIN;
  const newPage = (running) => {
    const p = doc.addPage(PAGE_W, PAGE_H);
    pages.push(p);
    let y = MARGIN;
    if (running) { p.text(title, MARGIN, y + 7, { size: 8.5, color: '#444444' }); y += 18; }
    return { p, y };
  };
  let { p, y } = newPage(false);
  const open = c.notes.filter((n) => n.status !== 'resolved').length;
  p.text(title, MARGIN, y + 14, { font: 'HB', size: 16 });
  y += 21;
  p.text(`${c.notes.length} notes · ${open} open · ${new Date().toLocaleDateString()} · ${stamp}`,
    MARGIN, y + 8, { size: 9, color: '#333333' });
  y += 22;

  const textX = MARGIN + PIC_COL + GAP;
  const textW = PAGE_W - MARGIN - textX;
  for (const n of c.notes) {
    const pic = pics.get(n);
    const img = pic ? doc.addImage({ kind: 'jpeg', ...pic }) : null;
    const picH = img ? PIC_COL * (img.height / img.width) : 0;
    const head = n.kind === 'overall' ? 'Overall' : `${n.part}${n.label ? ' — ' + n.label : ''}`;
    const headLines = wrapText(`#${c.numberOf(n)}  ${head}`, 'HB', 10.5, textW, 2);
    const body = [];
    for (const e of n.entries) {
      body.push({ font: 'HB', size: 8.5, color: '#444444', text: `${e.author || 'someone'} · ${day(e.at)}${e.doodle && e.doodle.length ? ' · sketch' : ''}` });
      for (const l of wrapText(e.text || '(sketch)', 'H', 9.5, textW, 30)) body.push({ font: 'H', size: 9.5, color: '#000000', text: l, tight: true });
    }
    const status = `${statusText(n)}${n.status === 'resolved' && n.statusBy ? ` · ${n.statusBy}, ${day(n.statusAt)}` : ''} · ${where(n)}`;
    const textH = headLines.length * 13 + 14 + body.reduce((a, b) => a + (b.tight ? 12 : 15), 0);
    const blockH = Math.max(picH, textH) + 18;
    if (y + blockH > bottom && y > MARGIN + 40) ({ p, y } = newPage(true));
    p.line(MARGIN, y, PAGE_W - MARGIN, y, { color: '#bbbbbb', width: 0.6 });
    y += 9;
    if (img) {
      p.image(img, MARGIN, y, PIC_COL, picH);
      p.rect(MARGIN, y, PIC_COL, picH, { stroke: '#cccccc', lineWidth: 0.5 });
    }
    let ty = y + 10;
    for (const l of headLines) { p.text(l, textX, ty, { font: 'HB', size: 10.5 }); ty += 13; }
    p.text(status, textX, ty, { size: 8.5, color: n.status === 'resolved' ? '#2F7D4F' : '#B03A2E' });
    ty += 14;
    for (const b of body) {
      if (!b.tight) ty += 3;
      p.text(b.text, textX, ty, { font: b.font, size: b.size, color: b.color });
      ty += 12;
    }
    y += Math.max(picH, ty - y) + 9;
  }
  if (pages.length > 1) {
    pages.forEach((pg, i) => pg.text(`Page ${i + 1} of ${pages.length}`, PAGE_W - MARGIN, PAGE_H - 20,
      { size: 8, color: '#555555', align: 'right' }));
  }
  download(doc.toBlob(), `${sanitizeFile(c.asm)}_review_${fileStamp()}.pdf`);
  c.app.ui.toast('Saved the notes PDF');
}
