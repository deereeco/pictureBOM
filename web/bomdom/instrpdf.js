// Lays the instruction sheet out as a PDF file (issue #23): the same content
// as the printable sheet — title line, ballooned view with the optional
// "Finished assembly" inset, numbered checklist — written directly with
// pdf.js so "save" is one click instead of a trip through the browser's
// print dialog. The page rules mirror the print CSS: a landscape one-page
// sheet seats the view beside the list; otherwise the view owns page 1 and
// the list follows on its own pages, repeating its header row as it flows.

import { PdfDoc, wrapText, jpegInfo } from './pdf.js';
import { decodeDataUri } from './payload.js';

export const PAPER = {
  a4: { w: 595.28, h: 841.89, label: 'A4' },
  letter: { w: 612, h: 792, label: 'Letter' },
};

const MARGIN = 34;          // ~12 mm
const GAP = 14;             // view <-> list gap on a one-page sheet
const BODY_PT = 9;
const LINE_H = 11;
const HEAD_H = 16;
const PAD_X = 5, PAD_Y = 3.5;
const THUMB_PT = 26;        // picture cell image box (matches the print CSS)
const MAX_IMAGE_PX = 2000;  // view captures downscale to this long edge
const INSET_FRAC = 0.27;    // inset width as a share of the view width
const RULE = '#444444';

// items: instruction items (n, name, kind, recs, row, part); settings: the
// page-setup object; onePage: the caller's one-page verdict (row/column
// limits); view/assembled: composited canvases (assembled may be null).
export async function buildInstructionsPdf({ items, settings, onePage, view, assembled, asmName, version }) {
  const paper = PAPER[settings.paper] || PAPER.a4;
  const landscape = settings.orient !== 'portrait';
  const W = landscape ? paper.h : paper.w;
  const H = landscape ? paper.w : paper.h;
  const title = `${asmName} — assembly instructions`;
  const stamp = `pictureBOM BomDom${version ? ' v' + version : ''}`;
  const doc = new PdfDoc({ title, producer: stamp });

  const viewImg = canvasImage(doc, view);
  const insetImg = assembled ? canvasImage(doc, assembled) : null;
  const thumbs = new Map();
  if (settings.cols.thumb) {
    for (const item of items) {
      const uri = item.part && item.part.thumbnail;
      if (uri && !thumbs.has(uri)) thumbs.set(uri, await thumbImage(doc, uri));
    }
  }

  const contentW = W - 2 * MARGIN;
  const bottom = H - MARGIN;
  const pages = [];
  const newPage = (running) => {
    const p = doc.addPage(W, H);
    pages.push(p);
    let y = MARGIN;
    if (running) {
      p.text(title, MARGIN, y + 7, { size: 8.5, color: '#444444' });
      y += 16;
    }
    return { p, y };
  };

  let { p, y } = newPage(false);
  p.text(title, MARGIN, y + 13, { font: 'HB', size: 15 });
  y += 19;
  p.text(`${items.length} items · ${new Date().toLocaleDateString()} · ${stamp}`, MARGIN, y + 8,
    { size: 9, color: '#333333' });
  y += 18;

  // One-page sheet: view left, list right — but only if the list really
  // fits beside it (wrapped names can outgrow the row limit's estimate);
  // otherwise fall back to the split layout instead of spilling a narrow
  // table onto page 2.
  if (onePage) {
    // A tall viewport (portrait tablet) yields a figure narrower than its
    // column once fitted by height — the list takes the width it frees.
    const viewW = (contentW - GAP) * (1.25 / 2.25);
    const fig = fitSize(viewImg, viewW, bottom - y);
    const listX = MARGIN + fig.w + GAP;
    const listW = contentW - fig.w - GAP;
    const cols = columnsFor(settings, listW);
    const rows = items.map((it) => rowFor(it, cols, thumbs));
    const tableH = HEAD_H + rows.reduce((a, r) => a + r.h, 0);
    if (y + tableH <= bottom) {
      drawFigure(p, MARGIN, y, viewW, bottom - y, viewImg, insetImg);
      let ty = drawHeader(p, cols, listX, y);
      for (const row of rows) {
        drawRow(p, cols, row, listX, ty);
        ty += row.h;
      }
      finish(pages, W, H);
      return doc.toBlob();
    }
  }

  drawFigure(p, MARGIN, y, contentW, bottom - y, viewImg, insetImg);
  ({ p, y } = newPage(true));
  const cols = columnsFor(settings, contentW);
  const rows = items.map((it) => rowFor(it, cols, thumbs));
  y = drawHeader(p, cols, MARGIN, y);
  for (const row of rows) {
    if (y + row.h > bottom) {
      ({ p, y } = newPage(true));
      y = drawHeader(p, cols, MARGIN, y);
    }
    drawRow(p, cols, row, MARGIN, y);
    y += row.h;
  }
  finish(pages, W, H);
  return doc.toBlob();
}

function finish(pages, W, H) {
  if (pages.length < 2) return;
  pages.forEach((p, i) => {
    p.text(`Page ${i + 1} of ${pages.length}`, W - MARGIN, H - 18, { size: 8, color: '#555555', align: 'right' });
  });
}

function fitSize(img, maxW, maxH) {
  const aspect = img.height / img.width;
  let w = maxW, h = w * aspect;
  if (h > maxH) { h = maxH; w = h / aspect; }
  return { w, h };
}

// The ballooned view, fitted into maxW x maxH (aspect kept, top-left
// anchored), with the finished-assembly inset in its top-right corner.
function drawFigure(p, x, y, maxW, maxH, viewImg, insetImg) {
  const { w, h } = fitSize(viewImg, maxW, maxH);
  p.rect(x, y, w, h, { fill: '#ffffff', stroke: '#999999', lineWidth: 0.5 });
  p.image(viewImg, x, y, w, h);
  if (insetImg) {
    const pad = 2;
    const iw = w * INSET_FRAC;
    const imgW = iw - 2 * pad;
    const imgH = imgW * (insetImg.height / insetImg.width);
    const capH = 9;
    const ih = pad + imgH + 1 + capH + 1;
    const ix = x + w - 6 - iw, iy = y + 6;
    p.rect(ix, iy, iw, ih, { fill: '#ffffff', stroke: '#666666', lineWidth: 0.5 });
    p.image(insetImg, ix + pad, iy + pad, imgW, imgH);
    p.text('Finished assembly', ix + iw / 2, iy + pad + imgH + 1 + 7,
      { size: 7.5, color: '#333333', align: 'center' });
  }
  return { w, h };
}

function columnsFor(settings, width) {
  const cols = [
    { key: 'box', w: 18, head: '' },
    { key: 'num', w: 22, head: '#', align: 'center', font: 'HB' },
  ];
  if (settings.cols.thumb) cols.push({ key: 'thumb', w: 42, head: 'Picture' }); // header word needs the width
  // The part number is what the reader matches against the balloon — it gets
  // the wider share; descriptions wrap and ellipsize.
  cols.push({ key: 'part', flex: 1.4, head: 'Part', font: 'C', maxLines: 4 });
  if (settings.cols.desc) cols.push({ key: 'desc', flex: 1, head: 'Description', maxLines: 2 });
  cols.push({ key: 'qty', w: 28, head: 'Qty', align: 'right' });
  if (settings.cols.vendor) cols.push({ key: 'vendor', flex: 0.9, head: 'Vendor', maxLines: 2 });
  const fixed = cols.reduce((a, c) => a + (c.w || 0), 0);
  const flexSum = cols.reduce((a, c) => a + (c.flex || 0), 0);
  const free = Math.max(0, width - fixed);
  for (const c of cols) if (c.flex) c.w = Math.max(40, (free * c.flex) / flexSum);
  return cols;
}

function cellText(item, key) {
  switch (key) {
    case 'part': return item.name + (item.kind === 'asm' ? ' (subassembly)' : '');
    case 'desc': return (item.row && item.row.description) || '';
    case 'vendor': return item.row ? [item.row.vendor, item.row.vendor_part_no].filter(Boolean).join(' ') : '';
    case 'qty': return String(item.recs.length);
    case 'num': return String(item.n);
    default: return null;
  }
}

function rowFor(item, cols, thumbs) {
  const cells = {};
  let lines = 1;
  for (const c of cols) {
    const text = cellText(item, c.key);
    if (text === null) continue;
    const wrapped = wrapText(text, c.font || 'H', BODY_PT, c.w - 2 * PAD_X, c.maxLines || 1);
    cells[c.key] = wrapped;
    lines = Math.max(lines, wrapped.length);
  }
  const uri = item.part && item.part.thumbnail;
  const thumb = (uri && thumbs.get(uri)) || null;
  const h = Math.max(thumb ? THUMB_PT + 6 : 15, lines * LINE_H + 2 * PAD_Y);
  return { item, cells, thumb, h };
}

const textX = (c, cx) => (c.align === 'center' ? cx + c.w / 2 : c.align === 'right' ? cx + c.w - PAD_X : cx + PAD_X);

function drawHeader(p, cols, x, y) {
  let cx = x;
  for (const c of cols) {
    p.rect(cx, y, c.w, HEAD_H, { fill: '#eeeeee', stroke: RULE, lineWidth: 0.5 });
    if (c.head) p.text(c.head, textX(c, cx), y + HEAD_H / 2 + 3.2, { font: 'HB', size: 9, align: c.align || 'left' });
    cx += c.w;
  }
  return y + HEAD_H;
}

function drawRow(p, cols, row, x, y) {
  let cx = x;
  for (const c of cols) {
    p.rect(cx, y, c.w, row.h, { stroke: RULE, lineWidth: 0.5 });
    if (c.key === 'box') {
      const s = 8; // the tick box, drawn (WinAnsi has no ballot-box glyph)
      p.rect(cx + (c.w - s) / 2, y + (row.h - s) / 2, s, s, { stroke: '#000000', lineWidth: 0.7 });
    } else if (c.key === 'thumb') {
      if (row.thumb) {
        const a = row.thumb.width / row.thumb.height;
        let tw = THUMB_PT, th = THUMB_PT;
        if (a > 1) th = tw / a; else tw = th * a;
        p.image(row.thumb, cx + (c.w - tw) / 2, y + (row.h - th) / 2, tw, th);
      }
    } else {
      const lines = row.cells[c.key] || [];
      let ty = y + (row.h - lines.length * LINE_H) / 2 + BODY_PT * 0.8;
      for (const ln of lines) {
        p.text(ln, textX(c, cx), ty, { font: c.font || 'H', size: BODY_PT, align: c.align || 'left' });
        ty += LINE_H;
      }
    }
    cx += c.w;
  }
}

// A canvas as a lossless RGB image object (downscaled to MAX_IMAGE_PX on the
// long edge — plenty for print — and composited on white).
function canvasImage(doc, canvas) {
  let src = canvas;
  const long = Math.max(canvas.width, canvas.height);
  if (long > MAX_IMAGE_PX) {
    const k = MAX_IMAGE_PX / long;
    src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(canvas.width * k));
    src.height = Math.max(1, Math.round(canvas.height * k));
    const c = src.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvas, 0, 0, src.width, src.height);
  }
  const { width: w, height: h } = src;
  const { data } = src.getContext('2d').getImageData(0, 0, w, h);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    const a = data[i + 3];
    if (a === 255) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    } else {
      const k = a / 255, bg = 255 * (1 - k);
      rgb[j] = data[i] * k + bg; rgb[j + 1] = data[i + 1] * k + bg; rgb[j + 2] = data[i + 2] * k + bg;
    }
  }
  return doc.addImage({ kind: 'rgb', width: w, height: h, data: rgb });
}

// Part thumbnails: the exporter's JPEG data URIs embed as-is; anything else
// decodes through an <img> onto a white canvas. A broken thumbnail costs its
// picture, never the export.
async function thumbImage(doc, uri) {
  try {
    const dec = decodeDataUri(uri);
    if (dec && /^image\/jpe?g$/i.test(dec.mime)) {
      const info = jpegInfo(dec.bytes);
      if (info && info.width > 0 && info.height > 0 && (info.components === 3 || info.components === 1)) {
        return doc.addImage({ kind: 'jpeg', bytes: dec.bytes, ...info });
      }
    }
    const im = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('thumbnail failed to decode'));
      i.src = uri;
    });
    const c = document.createElement('canvas');
    c.width = Math.max(1, im.naturalWidth);
    c.height = Math.max(1, im.naturalHeight);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(im, 0, 0);
    return canvasImage(doc, c);
  } catch (e) {
    console.warn('[BomDom] instructions PDF: thumbnail skipped', e);
    return null;
  }
}
