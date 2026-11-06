// Review notes as plain text, for pasting into Jira, Teams or a change order
// (each note's ⋯ menu → Copy as text).

const statusText = (n) => (n.status === 'resolved' ? 'Resolved' : 'Open');
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

function threadLines(n) {
  return n.entries.map((e) => `${e.author || 'someone'} (${day(e.at)}): ${e.text || (e.doodle ? '(sketch)' : '')}`);
}

// c: { asm, notes, numberOf }
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
