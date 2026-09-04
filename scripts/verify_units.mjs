#!/usr/bin/env node
// Offline verifier for the BomDom display-unit table + formatters
// (web/bomdom/units.js), shared by the measure tool and the move triad.
// Pure module, plain Node, no fixtures needed.
//
// Run:  node scripts/verify_units.mjs        exits 0 on all-pass, 1 otherwise.

import {
  UNITS, DEFAULT_UNIT, decimalsFor, formatLength, formatFeetInches, formatError, trimNum,
} from '../web/bomdom/units.js';

let fails = 0;
let count = 0;
function check(name, ok, detail = '') {
  count++;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------------------
// Table contract: the chip's unit list, and honest resolution in every unit.
// ---------------------------------------------------------------------------
eq('chip offers um mm cm m in ft ftin (in that order)',
  Object.keys(UNITS).join(' '), 'um mm cm m in ft ftin');
check('default unit exists', !!UNITS[DEFAULT_UNIT]);
for (const [k, u] of Object.entries(UNITS)) {
  check(`${k}: scale finite > 0`, Number.isFinite(u.scale) && u.scale > 0);
  check(`${k}: integer maxDec >= freeDec`,
    Number.isInteger(u.maxDec) && Number.isInteger(u.freeDec) && u.maxDec >= u.freeDec);
  const q = Math.pow(10, -u.maxDec) / u.scale; // one display quantum, meters
  check(`${k}: finest measure digit is 0.3–3 µm (${(q * 1e6).toFixed(2)} µm)`,
    q >= 0.3e-6 && q <= 3.1e-6);
  const f = Math.pow(10, -u.freeDec) / u.scale;
  check(`${k}: free-drag digit is 1 µm–0.4 mm (${(f * 1e3).toFixed(3)} mm)`,
    f >= 0.5e-6 && f <= 0.4e-3);
  check(`${k}: short suffix`, typeof u.suffix === 'string' && u.suffix.length <= 2);
}
check('ftin scale/suffix are inches (typed moves, ticks, ± bounds)',
  UNITS.ftin.scale === UNITS.in.scale && UNITS.ftin.suffix === 'in' && UNITS.ftin.feetInches === true);
check('ft = in / 12', Math.abs(UNITS.ft.scale * 12 - UNITS.in.scale) < 1e-12);
check('in = 25.4 mm exactly', Math.abs(UNITS.in.scale - 1000 / 25.4) < 1e-12);

// ---------------------------------------------------------------------------
// formatLength at the unit's full precision (Thorlabs ER rod, 81.280 mm).
// ---------------------------------------------------------------------------
const ROD = 0.08128;
eq('um rod', formatLength(ROD, 'um', UNITS.um.maxDec), '81280 µm');
eq('mm rod', formatLength(ROD, 'mm', UNITS.mm.maxDec), '81.280 mm');
eq('cm rod', formatLength(ROD, 'cm', UNITS.cm.maxDec), '8.1280 cm');
eq('m rod', formatLength(ROD, 'm', UNITS.m.maxDec), '0.081280 m');
eq('in rod', formatLength(ROD, 'in', UNITS.in.maxDec), '3.2000 in');
eq('ft rod', formatLength(ROD, 'ft', UNITS.ft.maxDec), '0.26667 ft');
eq('ftin rod (under a foot: inches only)', formatLength(ROD, 'ftin', UNITS.ftin.maxDec), '3.2000"');
eq('ftin 15 in', formatLength(15 * 0.0254, 'ftin', 4), `1' 3.0000"`);
eq('ftin 24 in exact', formatLength(24 * 0.0254, 'ftin', 4), `2' 0.0000"`);
eq('ftin 100 ft', formatLength(1200 * 0.0254, 'ftin', 4), `100' 0.0000"`);
eq('unknown unit falls back to mm', formatLength(0.001, 'furlong', 3), '1.000 mm');

// ---------------------------------------------------------------------------
// Feet + inches edge cases.
// ---------------------------------------------------------------------------
eq('inch part rounding up to 12 carries into feet', formatFeetInches(11.99996, 4), `1' 0.0000"`);
eq('11.9999 stays inches', formatFeetInches(11.9999, 4), `11.9999"`);
eq('negative (triad move) signs the whole value', formatFeetInches(-15.5, 2), `-1' 3.50"`);
eq('negative under a foot', formatFeetInches(-0.5, 2), `-0.50"`);
eq('zero', formatFeetInches(0, 4), `0.0000"`);
eq('trim: snapped 18 in with float junk', formatFeetInches(18.000000000002, 2, true), `1' 6"`);
eq('trim: snapped 12 in just under', formatFeetInches(11.999999999999, 2, true), `1' 0"`);
eq('trim: snapped 2.5 in', formatFeetInches(2.5, 2, true), `2.5"`);

// ---------------------------------------------------------------------------
// Triad helpers: trimmed exact values in every unit.
// ---------------------------------------------------------------------------
eq('trimNum drops float junk', trimNum(15.000000000002), '15');
eq('trimNum keeps real decimals', trimNum(2.5), '2.5');
eq('mm trim', formatLength(0.025000000000001, 'mm', UNITS.mm.freeDec, true), '25 mm');
eq('um trim', formatLength(0.000005, 'um', UNITS.um.freeDec, true), '5 µm');
eq('ft trim', formatLength(0.3048, 'ft', UNITS.ft.freeDec, true), '1 ft');
eq('mm free drag', formatLength(0.0123456, 'mm', UNITS.mm.freeDec), '12.3 mm');
eq('ft free drag', formatLength(0.0123456, 'ft', UNITS.ft.freeDec), '0.041 ft');
eq('negative free drag mm', formatLength(-0.0123456, 'mm', UNITS.mm.freeDec), '-12.3 mm');

// ---------------------------------------------------------------------------
// Measure rule: last digit never finer than the ± bound, capped at maxDec.
// A typical ER-rod pair bound is ~10 µm.
// ---------------------------------------------------------------------------
const ERR = 1.04e-5; // meters
eq('decimals mm @10 µm', decimalsFor(ERR, 'mm'), 2);
eq('decimals cm @10 µm', decimalsFor(ERR, 'cm'), 3);
eq('decimals m @10 µm', decimalsFor(ERR, 'm'), 5);
eq('decimals in @10 µm', decimalsFor(ERR, 'in'), 4);
eq('decimals ft @10 µm', decimalsFor(ERR, 'ft'), 5);
eq('decimals ftin @10 µm', decimalsFor(ERR, 'ftin'), 4);
eq('decimals um @10 µm', decimalsFor(ERR, 'um'), 0);
eq('decimals: zero error = full precision', decimalsFor(0, 'mm'), UNITS.mm.maxDec);
eq('decimals: huge error clamps at 0', decimalsFor(1, 'mm'), 0);
eq('decimals: tiny error clamps at maxDec', decimalsFor(1e-12, 'in'), UNITS.in.maxDec);
eq('measure readout mm', formatLength(ROD, 'mm', decimalsFor(ERR, 'mm')), '81.28 mm');
eq('measure readout um', formatLength(ROD, 'um', decimalsFor(ERR, 'um')), '81280 µm');
eq('measure readout ftin', formatLength(15 * 0.0254, 'ftin', decimalsFor(ERR, 'ftin')), `1' 3.0000"`);

// ---------------------------------------------------------------------------
// ± bound: one significant figure, plain notation, in the unit's scalar.
// ---------------------------------------------------------------------------
eq('err mm', formatError(ERR, 'mm'), '±0.01 mm');
eq('err cm', formatError(ERR, 'cm'), '±0.001 cm');
eq('err m', formatError(ERR, 'm'), '±0.00001 m');
eq('err in', formatError(ERR, 'in'), '±0.0004 in');
eq('err ft', formatError(ERR, 'ft'), '±0.00003 ft');
eq('err ftin speaks inches', formatError(ERR, 'ftin'), '±0.0004 in');
eq('err um is plain, not 1e+1', formatError(ERR, 'um'), '±10 µm');
eq('err um sub-micron', formatError(0.4e-6, 'um'), '±0.4 µm');
eq('err rounds to one figure', formatError(0.00096, 'mm'), '±1 mm');
eq('err zero', formatError(0, 'mm'), '±0 mm');
eq('err 0.3 mm', formatError(0.00026, 'mm'), '±0.3 mm');

console.log(`\n${count - fails}/${count} checks passed`);
process.exit(fails ? 1 : 0);
