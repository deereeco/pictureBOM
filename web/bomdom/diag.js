// Stage markers + the on-page diagnostics line (footer "i" toggle).
// Everything logged here is also what a human runs through during the
// manual browser checklist, so keep entries short and factual.

export const diag = {
  decodePath: '-',
  dracoUsed: false,
  timings: {},   // name -> ms
  counts: {},    // instances, parts, triangles
  notes: [],
};

export function stage(name) {
  console.info('[BomDom] ' + name);
}

export function timed(name, ms) {
  diag.timings[name] = Math.round(ms);
  stage(`${name}: ${Math.round(ms)} ms`);
}

export function note(text) {
  diag.notes.push(text);
  stage(text);
}

export function diagText() {
  const t = Object.entries(diag.timings).map(([k, v]) => `${k} ${v}ms`).join(' · ');
  const c = Object.entries(diag.counts).map(([k, v]) => `${k} ${v}`).join(' · ');
  const parts = [
    `decode: ${diag.decodePath}`,
    `draco: ${diag.dracoUsed ? 'yes' : 'no'}`,
    t || null,
    c || null,
    diag.notes.length ? diag.notes.join(' · ') : null,
  ];
  return parts.filter(Boolean).join('  |  ');
}
