// Shared length units for the BomDom viewer — the measure tool and the move
// triad read ONE reader preference (per browser, like the edges toggle), so
// both must understand every unit the chip offers. World units are meters
// (glTF); `scale` is display units per meter.
//
//  maxDec  finest decimals the measure tool prints (its ± bound trims from
//          there); every unit bottoms out near 1 µm so precision is honest in
//          any of them.
//  freeDec decimals for unsnapped triad drags (~0.1–0.3 mm, coarser on purpose).
//
// 'ftin' prints feet + inches (1' 3.2500") but its scale and suffix are INCHES:
// typed moves, ruler ticks and ± bounds all speak inches; only the composite
// readout differs. Pinned by scripts/verify_units.mjs.

export const UNITS_KEY = 'picturebom-bomdom-units';
export const DEFAULT_UNIT = 'mm';

const IN_PER_M = 1000 / 25.4;

export const UNITS = {
  um:   { scale: 1e6,           suffix: 'µm', maxDec: 0, freeDec: 0 },
  mm:   { scale: 1000,          suffix: 'mm', maxDec: 3, freeDec: 1 },
  cm:   { scale: 100,           suffix: 'cm', maxDec: 4, freeDec: 2 },
  m:    { scale: 1,             suffix: 'm',  maxDec: 6, freeDec: 4 },
  in:   { scale: IN_PER_M,      suffix: 'in', maxDec: 4, freeDec: 2 },
  ft:   { scale: IN_PER_M / 12, suffix: 'ft', maxDec: 5, freeDec: 3 },
  ftin: { scale: IN_PER_M,      suffix: 'in', maxDec: 4, freeDec: 2, feetInches: true },
};

const unitOf = (unit) => UNITS[unit] || UNITS[DEFAULT_UNIT];

export function readUnit() {
  try {
    const u = localStorage.getItem(UNITS_KEY);
    return UNITS[u] ? u : DEFAULT_UNIT;
  } catch { return DEFAULT_UNIT; }
}

export function storeUnit(u) {
  try { localStorage.setItem(UNITS_KEY, u); } catch { /* ignore */ }
}

// Drop float junk from exact values: 15.000000000002 -> "15".
export const trimNum = (n) => String(parseFloat(n.toFixed(6)));

const numStr = (x, dec, trim) => (trim ? trimNum(x) : x.toFixed(dec));

// Decimals to print for a value known to ±errM (meters): the last digit is
// never finer than the error bound, capped at the unit's maxDec.
export function decimalsFor(errM, unit) {
  const u = unitOf(unit);
  const e = Math.abs(errM) * u.scale;
  if (!(e > 0)) return u.maxDec;
  return Math.max(0, Math.min(u.maxDec, Math.ceil(-Math.log10(e))));
}

// Meters -> "381.000 mm" / "1' 3.0000\"". `dec` = decimals to print;
// `trim` prints exact values without trailing zeros (snapped triad ticks).
export function formatLength(valM, unit, dec, trim = false) {
  const u = unitOf(unit);
  const disp = valM * u.scale;
  if (u.feetInches) return formatFeetInches(disp, dec, trim);
  return `${numStr(disp, dec, trim)} ${u.suffix}`;
}

// Inches -> `1' 3.25"`; under a foot just `3.25"`; a sign leads the whole
// value (triad moves can run negative). The inch part rounding up to 12
// carries into the feet so 11.99996" never prints as `12.0000"`.
export function formatFeetInches(inches, dec, trim = false) {
  const neg = inches < 0;
  const abs = Math.abs(inches);
  let ft = Math.floor(abs / 12);
  let inStr = numStr(abs - ft * 12, dec, trim);
  if (parseFloat(inStr) >= 12) { ft += 1; inStr = numStr(0, dec, trim); }
  const body = ft > 0 ? `${ft}' ${inStr}"` : `${inStr}"`;
  return (neg ? '-' : '') + body;
}

// ± bound at one significant figure in the unit's scalar (inches for ft+in),
// printed plainly: "±10 µm", never "±1e+1 µm".
export function formatError(errM, unit) {
  const u = unitOf(unit);
  const e = Math.abs(errM) * u.scale;
  if (!(e > 0)) return `±0 ${u.suffix}`;
  const r = Number(e.toPrecision(1));
  const dec = Math.max(0, -Math.floor(Math.log10(r)));
  return `±${r.toFixed(dec)} ${u.suffix}`;
}
