// Minimal PDF writer for the instruction sheet (issue #23): pages, the
// standard Helvetica/Courier faces in WinAnsi, filled and stroked rectangles,
// lines, and images — JPEG bytes pass straight through (DCTDecode), canvases
// go in as Flate-compressed RGB with PNG "Up" predictors. The only dependency
// is pako's deflate, which jszip already bundles for the Excel export, so the
// viewer stays one self-contained file that makes no requests.
//
// Coordinates are top-left origin in points, like a canvas — the writer
// flips them to PDF's bottom-left page space when it emits operators.

// Default import: pako is CommonJS, and this form loads both through esbuild
// and straight into Node for the offline smoke test.
import pako from 'pako';

const { deflate } = pako;

export const FONTS = {
  H: 'Helvetica', HB: 'Helvetica-Bold', C: 'Courier', CB: 'Courier-Bold',
};
const FONT_KEYS = Object.keys(FONTS); // resource names /F1../F4 in this order
const fontRef = (key) => '/F' + (FONT_KEYS.indexOf(key) + 1);

// Code points WinAnsi keeps in its 0x80–0x9F block (Latin-1 has none there).
const WINANSI_HIGH = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F],
]);

// A string as WinAnsi bytes; anything the encoding lacks prints as '?'.
export function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) out.push(cp);
    else out.push(WINANSI_HIGH.has(cp) ? WINANSI_HIGH.get(cp) : 0x3F);
  }
  return out;
}

// PDF literal string: printable ASCII stays readable, everything else is
// octal-escaped so the content stream is pure ASCII.
function pdfLiteral(str) {
  let s = '(';
  for (const b of toWinAnsi(str)) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) s += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b < 0x7F) s += String.fromCharCode(b);
    else s += '\\' + b.toString(8).padStart(3, '0');
  }
  return s + ')';
}

// Document-info strings take UTF-16BE with a BOM — exact for any title.
function pdfTextString(str) {
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0');
  return '<' + hex + '>';
}

function pdfDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`;
}

const fmt = (n) => {
  const s = (Math.round(n * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};

function rgbOps(hex, op) {
  const n = parseInt(String(hex).slice(1), 16);
  const c = (v) => fmt(v / 255);
  return `${c((n >> 16) & 255)} ${c((n >> 8) & 255)} ${c(n & 255)} ${op}`;
}

function latin1(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xFF;
  return b;
}

// Courier is fixed-pitch (600/1000 em). Helvetica widths come from a canvas
// measuring Arial / Liberation Sans, which are metric-compatible with
// Helvetica — layout-only, so a missing font costs alignment, never validity.
let measureCtx;
export function textWidth(str, font, size) {
  const s = String(str);
  const n = [...s].length;
  if (font === 'C' || font === 'CB') return n * 0.6 * size;
  if (measureCtx === undefined) {
    try { measureCtx = document.createElement('canvas').getContext('2d'); } catch (e) { measureCtx = null; }
  }
  if (!measureCtx) return n * 0.52 * size;
  measureCtx.font = `${font === 'HB' ? '700' : '400'} 100px Arial, Helvetica, "Liberation Sans", sans-serif`;
  return measureCtx.measureText(s).width * size / 100;
}

function wrapAll(str, font, size, maxWidth) {
  const fits = (s) => textWidth(s, font, size) <= maxWidth;
  const lines = [];
  let cur = '';
  for (const word of String(str).replace(/\s+/g, ' ').trim().split(' ')) {
    if (!word) continue;
    const trial = cur ? cur + ' ' + word : word;
    if (fits(trial)) { cur = trial; continue; }
    if (cur) lines.push(cur);
    let w = word;
    while (!fits(w) && w.length > 1) {
      // A lone word wider than the column: break after the last hyphen,
      // underscore or slash that still fits (part numbers read naturally
      // that way), else by character.
      let k = w.length - 1;
      while (k > 1 && !fits(w.slice(0, k))) k--;
      let soft = -1;
      for (let i = k - 1; i > 0; i--) if ('-_/'.includes(w[i])) { soft = i + 1; break; }
      if (soft > 0) k = soft;
      lines.push(w.slice(0, k));
      w = w.slice(k);
    }
    cur = w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// Greedy word wrap to maxWidth, at most maxLines lines; when text is left
// over, the last line ends in an ellipsis.
export function wrapText(str, font, size, maxWidth, maxLines) {
  const lines = wrapAll(str, font, size, maxWidth);
  const max = Math.max(1, maxLines || 1);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && textWidth(last + '…', font, size) > maxWidth) last = last.slice(0, -1).trimEnd();
  kept[max - 1] = last + '…';
  return kept;
}

// JPEG SOF scan: dimensions + component count (1 gray, 3 YCbCr/RGB, 4 CMYK).
export function jpegInfo(bytes) {
  try {
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
          components: bytes[i + 9],
        };
      }
      i += 2 + len;
    }
  } catch (e) { /* fall through */ }
  return null;
}

class Page {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ops = [];
    this.images = new Map(); // XObject name -> object number
  }

  // y is the BASELINE (top-left page coordinates).
  text(str, x, y, o = {}) {
    const font = o.font || 'H', size = o.size || 10;
    let tx = x;
    if (o.align === 'center') tx -= textWidth(str, font, size) / 2;
    else if (o.align === 'right') tx -= textWidth(str, font, size);
    this.ops.push(`BT ${rgbOps(o.color || '#000000', 'rg')} ${fontRef(font)} ${fmt(size)} Tf ` +
      `${fmt(tx)} ${fmt(this.h - y)} Td ${pdfLiteral(str)} Tj ET`);
  }

  rect(x, y, w, h, o = {}) {
    const parts = [];
    if (o.fill) parts.push(rgbOps(o.fill, 'rg'));
    if (o.stroke) parts.push(rgbOps(o.stroke, 'RG'), `${fmt(o.lineWidth == null ? 0.5 : o.lineWidth)} w`);
    const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n';
    this.ops.push(`q ${parts.join(' ')} ${fmt(x)} ${fmt(this.h - y - h)} ${fmt(w)} ${fmt(h)} re ${paint} Q`);
  }

  line(x1, y1, x2, y2, o = {}) {
    this.ops.push(`q ${rgbOps(o.color || '#000000', 'RG')} ${fmt(o.width == null ? 0.5 : o.width)} w ` +
      `${fmt(x1)} ${fmt(this.h - y1)} m ${fmt(x2)} ${fmt(this.h - y2)} l S Q`);
  }

  image(img, x, y, w, h) {
    this.images.set(img.name, img.obj);
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(this.h - y - h)} cm /${img.name} Do Q`);
  }
}

export class PdfDoc {
  constructor(info = {}) {
    this.info = info;
    // Object numbers are index + 1: 1 catalog, 2 page tree (both written at
    // the end), 3–6 the fonts, then images and pages as they come.
    this.objs = [null, null];
    for (const key of FONT_KEYS) {
      this.objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[key]} /Encoding /WinAnsiEncoding >>`);
    }
    this.pages = [];
    this.imageCount = 0;
  }

  addPage(w, h) {
    const p = new Page(w, h);
    this.pages.push(p);
    return p;
  }

  // spec: { kind: 'jpeg', bytes, width, height, components }
  //    or { kind: 'rgb', width, height, data: Uint8Array of packed RGB }
  addImage(spec) {
    const name = 'Im' + (++this.imageCount);
    let dict, data;
    if (spec.kind === 'jpeg') {
      const cs = spec.components === 1 ? '/DeviceGray' : spec.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      dict = `/Type /XObject /Subtype /Image /Width ${spec.width} /Height ${spec.height} ` +
        `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode` +
        (spec.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '');
      data = spec.bytes;
    } else {
      // PNG "Up" predictor per row, then zlib — the trick PNG itself uses;
      // shaded renders on white compress several times better than raw.
      const { width: w, height: h, data: rgb } = spec;
      const stride = w * 3;
      const rows = new Uint8Array((stride + 1) * h);
      for (let y = 0; y < h; y++) {
        const o = y * (stride + 1), src = y * stride, prev = src - stride;
        rows[o] = 2;
        if (y === 0) rows.set(rgb.subarray(0, stride), o + 1);
        else for (let i = 0; i < stride; i++) rows[o + 1 + i] = rgb[src + i] - rgb[prev + i];
      }
      data = deflate(rows);
      dict = `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
        '/BitsPerComponent 8 /Filter /FlateDecode ' +
        `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${w} >>`;
    }
    this.objs.push({ dict, stream: data });
    return { name, obj: this.objs.length, width: spec.width, height: spec.height };
  }

  toBytes() {
    const objs = this.objs.slice();
    const fontRes = FONT_KEYS.map((k, i) => `/F${i + 1} ${3 + i} 0 R`).join(' ');
    const pageNums = [];
    for (const p of this.pages) {
      objs.push({ dict: '', stream: latin1(p.ops.join('\n')) });
      const contentNum = objs.length;
      const xo = [...p.images].map(([n, o]) => `/${n} ${o} 0 R`).join(' ');
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(p.w)} ${fmt(p.h)}] ` +
        `/Resources << /Font << ${fontRes} >>${xo ? ` /XObject << ${xo} >>` : ''} >> ` +
        `/Contents ${contentNum} 0 R >>`);
      pageNums.push(objs.length);
    }
    objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`;
    const info = [];
    if (this.info.title) info.push(`/Title ${pdfTextString(this.info.title)}`);
    if (this.info.producer) info.push(`/Producer ${pdfTextString(this.info.producer)}`);
    info.push(`/CreationDate (${pdfDate(new Date())})`);
    objs.push(`<< ${info.join(' ')} >>`);
    const infoNum = objs.length;

    const chunks = [];
    let offset = 0;
    const put = (bytes) => { chunks.push(bytes); offset += bytes.length; };
    put(latin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      put(latin1(`${i + 1} 0 obj\n`));
      if (typeof o === 'string') {
        put(latin1(o + '\n'));
      } else {
        put(latin1(`<< ${o.dict}${o.dict ? ' ' : ''}/Length ${o.stream.length} >>\nstream\n`));
        put(o.stream);
        put(latin1('\nendstream\n'));
      }
      put(latin1('endobj\n'));
    });
    const xref = offset;
    let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`;
    tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`;
    put(latin1(tail));

    const out = new Uint8Array(offset);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  toBlob() {
    return new Blob([this.toBytes()], { type: 'application/pdf' });
  }
}
