// Join the payload's 3D part list with its BOM rows. Shared by the parts
// panel, the exports and the context menus.

export function buildBomJoin(meta) {
  const rowByName = new Map(); // casefolded row name -> merged row data

  const put = (name, data) => {
    const key = (name || '').toLowerCase();
    if (!key) return;
    const cur = rowByName.get(key) || {};
    for (const [k, v] of Object.entries(data)) {
      if (cur[k] === undefined || cur[k] === null || cur[k] === '') cur[k] = v;
    }
    rowByName.set(key, cur);
  };

  for (const r of meta.bom.hierarchical_rows || []) {
    put(r.name, {
      name: r.name,
      description: r.description,
      vendor: r.vendor,
      vendor_part_no: r.vendor_part_no,
      vendor_url: r.vendor_url,
      quantity: r.quantity,
      type: r.type,
    });
  }
  for (const r of meta.bom.flat_parts || []) {
    put(r.name, {
      name: r.name,
      description: r.description,
      vendor: r.vendor,
      vendor_part_no: r.vendor_part_no,
      vendor_url: r.vendor_url,
      quantity: r.total_quantity,
      where_used: r.where_used,
    });
  }

  const rowFor = (part) =>
    rowByName.get(((part.bom_name || part.name) || '').toLowerCase()) || null;

  // Panel entries: every 3D part, then BOM rows with no geometry at all.
  const entries = (meta.parts || []).map((part) => ({
    kind: 'part',
    part,
    row: rowFor(part),
    name: part.bom_name || part.name,
  }));
  const recon = meta.reconciliation || {};
  for (const name of recon.hidden_rows || []) {
    entries.push({ kind: 'row', name, row: rowByName.get(name.toLowerCase()) || null, reason: 'hidden' });
  }
  for (const name of recon.unmatched_rows || []) {
    entries.push({ kind: 'row', name, row: rowByName.get(name.toLowerCase()) || null, reason: 'unmatched' });
  }

  return { rowByName, rowFor, entries };
}

// hierarchical_rows level strings ("1.0", "1.2", "1.2.3") -> tree.
// A trailing ".0" marks the item itself; parent = longest existing prefix.
export function buildBomTree(meta) {
  const rows = meta.bom.hierarchical_rows || [];
  const canon = (level) => {
    const segs = String(level || '').split('.');
    if (segs.length > 1 && segs[segs.length - 1] === '0') segs.pop();
    return segs;
  };
  const byKey = new Map();
  const roots = [];
  for (const row of rows) {
    const segs = canon(row.level);
    const node = { row, key: segs.join('.'), children: [], parent: null };
    let parent = null;
    for (let i = segs.length - 1; i >= 1 && !parent; i--) {
      parent = byKey.get(segs.slice(0, i).join('.')) || null;
    }
    node.parent = parent;
    (parent ? parent.children : roots).push(node);
    if (!byKey.has(node.key)) byKey.set(node.key, node);
  }
  return { roots, byKey };
}
