// Export menu: Excel (in-cell thumbnails via write-excel-file), CSV
// (RFC 4180, UTF-8 BOM, CRLF) and a printable order sheet. Every export is
// exactly one Blob download per click; thumbnails come from META data URIs
// decoded with atob — never fetched.

import writeXlsxFile from 'write-excel-file';
import * as M from './model.js';
import { decodeDataUri } from './payload.js';

const $ = (id) => document.getElementById(id);
const HEADER_BG = '#1F3864';
const COLUMNS = ['Picture', 'Part Number', 'Description', 'Qty', 'Vendor', 'Vendor Part No'];

export function initExports(app) {
  const btn = $('btnExport');
  const menu = $('exportMenu');

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      return;
    }
    app.ui.closeMenus();
    buildMenu();
    menu.classList.remove('hidden');
  });

  function scopeInfo() {
    const selectedCounts = instanceCounts(app, 'selected');
    const visibleCounts = instanceCounts(app, 'visible');
    const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    const fullCount = (app.meta.parts || []).reduce((a, p) => a + p.instances, 0);
    return {
      selected: sum(selectedCounts),
      visible: sum(visibleCounts),
      full: fullCount,
      anyHidden: !!app.model && app.model.hiddenInstances > 0,
    };
  }

  function buildMenu() {
    const info = scopeInfo();
    const def = info.selected ? 'selected' : (info.anyHidden && info.visible) ? 'visible' : 'full';
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'menu-head';
    head.textContent = 'Scope';
    menu.appendChild(head);
    for (const [value, label, n] of [
      ['selected', 'Selected', info.selected],
      ['visible', 'Visible', info.visible],
      ['full', 'Full', info.full],
    ]) {
      const lab = document.createElement('label');
      lab.className = 'menu-radio';
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'bomdomExportScope';
      r.value = value;
      r.checked = value === def;
      r.disabled = !n;
      lab.appendChild(r);
      lab.appendChild(document.createTextNode(` ${label} (${n})`));
      menu.appendChild(lab);
    }
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    menu.appendChild(sep);
    const chosen = () => {
      const el = menu.querySelector('input[name=bomdomExportScope]:checked');
      return el ? el.value : 'full';
    };
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.textContent = label;
      b.addEventListener('click', () => {
        const scope = chosen();
        menu.classList.add('hidden');
        Promise.resolve(fn(scope)).catch((e) => {
          console.error('[BomDom] export failed', e);
          app.ui.toast('Export failed: ' + e.message);
        });
      });
      menu.appendChild(b);
    };
    mk('Excel (.xlsx)', (s) => exportExcel(app, s));
    mk('CSV', (s) => exportCsv(app, s));
    mk('Print order sheet', (s) => exportPrint(app, s));
  }
}

// ---------------------------------------------------------------------------
// Scope -> rows
// ---------------------------------------------------------------------------

function instanceCounts(app, mode) {
  const counts = new Map();
  const model = app.model;
  if (!model) return counts;
  if (mode === 'selected') {
    const seen = new Set();
    for (const id of app.sel.selected) {
      const rec = model.records[id];
      if (!rec) continue;
      for (const s of M.subtree(rec)) {
        if (s.partId === null || !s.meshes.length || seen.has(s.id)) continue;
        seen.add(s.id);
        counts.set(s.partId, (counts.get(s.partId) || 0) + 1);
      }
    }
  } else {
    for (const [partId, recs] of model.byPartId) {
      let n = 0;
      for (const r of recs) if (!M.isEffectivelyHidden(r, app.sel.scope)) n += 1;
      if (n) counts.set(partId, n);
    }
  }
  return counts;
}

function rowsForScope(app, scope) {
  const rows = [];
  const push = (entry, qty) => {
    const r = entry.row || {};
    rows.push({
      name: entry.name,
      description: r.description || '',
      qty,
      vendor: r.vendor || '',
      vendorPartNo: r.vendor_part_no || '',
      vendorUrl: r.vendor_url || null,
      thumbnail: entry.part ? entry.part.thumbnail : null,
    });
  };
  if (scope === 'full' || !app.model) {
    for (const e of app.bom.entries) {
      push(e, e.kind === 'part' ? e.part.instances : (e.row && e.row.quantity != null ? e.row.quantity : 0));
    }
  } else {
    // Scoped quantities are live INSTANCE counts, not file quantities.
    const counts = instanceCounts(app, scope);
    for (const e of app.bom.entries) {
      if (e.kind !== 'part') continue;
      const n = counts.get(e.part.id);
      if (n) push(e, n);
    }
  }
  return rows;
}

const SCOPE_LABELS = {
  selected: 'Selected parts (quantities are selected instance counts)',
  visible: 'Visible parts (quantities are visible instance counts)',
  full: 'Full assembly',
};

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

async function exportExcel(app, scope) {
  const rows = rowsForScope(app, scope);
  const asm = app.meta.assembly.name || 'assembly';
  const data = [];
  data.push([{ value: `${asm} — BomDom — ${SCOPE_LABELS[scope]}`, fontWeight: 'bold', span: 6 },
    null, null, null, null, null]);
  data.push(COLUMNS.map((h) => ({
    value: h, fontWeight: 'bold', color: '#FFFFFF', backgroundColor: HEADER_BG,
    height: 20, alignVertical: 'center',
  })));

  const images = [];
  rows.forEach((r, i) => {
    data.push([
      null,
      { value: r.name, alignVertical: 'center', height: 34 }, // ~45 px row for the picture
      { value: r.description, alignVertical: 'center', wrap: true },
      { value: r.qty, alignVertical: 'center', align: 'center' },
      { value: r.vendor, alignVertical: 'center' },
      { value: r.vendorPartNo, alignVertical: 'center' },
    ]);
    if (!r.thumbnail) return;
    const dec = decodeDataUri(r.thumbnail);
    const size = dec && imageSize(dec.bytes, dec.mime);
    if (!size) return;
    const s = Math.min(40 / size.width, 40 / size.height, 1);
    images.push({
      content: new Blob([dec.bytes], { type: dec.mime }),
      contentType: dec.mime,
      width: Math.max(1, Math.round(size.width * s)),
      height: Math.max(1, Math.round(size.height * s)),
      dpi: 96,
      anchor: { row: i + 3, column: 1 }, // 1-based; title + header rows above
      offsetX: 3,
      offsetY: 3,
    });
  });

  const blob = await writeXlsxFile(data, {
    columns: [{ width: 8 }, { width: 24 }, { width: 42 }, { width: 7 }, { width: 18 }, { width: 18 }],
    images: images.length ? images : undefined, // no thumbnails -> data-only
    sheet: 'BOM',
    fontFamily: 'Calibri',
    fontSize: 11,
  });
  download(blob, `${sanitizeFile(asm)}_BomDom_${fileStamp()}.xlsx`);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function exportCsv(app, scope) {
  const rows = rowsForScope(app, scope);
  const asm = app.meta.assembly.name || 'assembly';
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [
    q(`${asm} — BomDom export — ${SCOPE_LABELS[scope]} — ${new Date().toLocaleString()}`),
    COLUMNS.slice(1).map(q).join(','),
  ];
  for (const r of rows) {
    lines.push([r.name, r.description, r.qty, r.vendor, r.vendorPartNo].map(q).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  download(blob, `${sanitizeFile(asm)}_BomDom_${fileStamp()}.csv`);
}

// ---------------------------------------------------------------------------
// Print order sheet
// ---------------------------------------------------------------------------

function exportPrint(app, scope) {
  const rows = rowsForScope(app, scope);
  const asm = app.meta.assembly.name || 'assembly';
  const sheet = $('printSheet');
  sheet.innerHTML = '';

  const h1 = document.createElement('h1');
  h1.textContent = asm + ' — order sheet';
  sheet.appendChild(h1);
  const sub = document.createElement('div');
  sub.className = 'print-sub';
  sub.textContent = `${SCOPE_LABELS[scope]} · ${rows.length} line items · ${new Date().toLocaleString()}` +
    ` · pictureBOM BomDom${app.meta.app_version ? ' v' + app.meta.app_version : ''}`;
  sheet.appendChild(sub);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['Picture', 'Part Number', 'Description', 'Qty', 'Vendor', 'Ordered']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const tdImg = document.createElement('td');
    if (r.thumbnail) {
      const img = document.createElement('img');
      img.src = r.thumbnail;
      img.alt = '';
      tdImg.appendChild(img);
    }
    tr.appendChild(tdImg);
    for (const [cls, text] of [
      ['part mono', r.name], ['', r.description], ['num', String(r.qty)],
      ['', r.vendor + (r.vendorPartNo ? ' ' + r.vendorPartNo : '')],
    ]) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    const tdBox = document.createElement('td');
    tdBox.className = 'ordered-box';
    tdBox.textContent = '☐';
    tr.appendChild(tdBox);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sheet.appendChild(table);
  window.print();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function sanitizeFile(name) {
  return (name || 'assembly').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'assembly';
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Minimal JPEG (SOF scan) / PNG (IHDR) dimension readers — enough for our
// own thumbnails, and a graceful null for anything else.
function imageSize(bytes, mime) {
  try {
    if (mime === 'image/png') {
      if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
      const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xFF) { i += 1; continue; }
        const m = bytes[i + 1];
        if (m === 0xFF) { i += 1; continue; }
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          return {
            height: (bytes[i + 5] << 8) | bytes[i + 6],
            width: (bytes[i + 7] << 8) | bytes[i + 8],
          };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}
