// Facet filters + color-by-property. Facets are built from META alone
// (bom.property_names + the joined BOM rows), so filtering the parts list
// works with no 3D at all; the record sets that drive the 3D ghost/hide are
// recomputed when a model loads (sidecar GLBs arrive after the panel).

import * as M from './model.js';

const $ = (id) => document.getElementById(id);

// Validated categorical order (adjacent-pair CVD-safe); values wrap past the
// end. "(none)" always gets the neutral gray so absence never reads as a
// category of its own.
const PALETTE = [0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4,
  0x008300, 0x4a3aa7, 0xe34948];
const NONE_COLOR = 0x9aa0a6;
const NONE_KEY = '';

const ICON_PAINT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11L12 4 3 13l6 6 8-8h6z"/><path d="M21.5 15.5s-1.5 2.2-1.5 3.3a1.5 1.5 0 0 0 3 0c0-1.1-1.5-3.3-1.5-3.3z" fill="currentColor" stroke="none"/></svg>';
const ICON_FUNNEL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3H2l8 9.5V21l4-2v-6.5z"/></svg>';

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export function initFilters(app) {
  const names = (app.meta.bom && app.meta.bom.property_names) || [];
  const block = $('filterBlock');
  const legend = $('colorLegend');
  if (!names.length || !block) return; // no configured properties — feature off

  const sel = app.sel;

  // ---- facet data (META only) -------------------------------------------
  const valueKeyOf = (row, prop) => {
    const v = row && row.properties ? row.properties[prop] : '';
    return String(v == null ? '' : v).trim().toLowerCase();
  };

  // prop -> ordered Map(valueKey -> {display, count}); "(none)" sorts last.
  const facets = new Map();
  for (const prop of names) {
    const values = new Map();
    for (const e of app.bom.entries) {
      const key = valueKeyOf(e.row, prop);
      let v = values.get(key);
      if (!v) {
        const display = key === NONE_KEY ? '(none)'
          : String(e.row.properties[prop]).trim();
        v = { display, count: 0 };
        values.set(key, v);
      }
      v.count += 1;
    }
    if (values.has(NONE_KEY)) {
      const none = values.get(NONE_KEY);
      values.delete(NONE_KEY);
      values.set(NONE_KEY, none);
    }
    facets.set(prop, values);
  }

  // ---- state --------------------------------------------------------------
  const chosen = new Map(names.map((p) => [p, new Set()])); // prop -> value keys
  let hideOthers = false; // false = ghost non-matching parts (default)
  let colorProp = null;   // property currently painting the model, or null

  const anyChosen = () => [...chosen.values()].some((s) => s.size);
  const chosenCount = () => [...chosen.values()].reduce((a, s) => a + s.size, 0);

  // AND across properties, OR within one property's values.
  function matchesFacets(row) {
    for (const [prop, set] of chosen) {
      if (set.size && !set.has(valueKeyOf(row, prop))) return false;
    }
    return true;
  }
  app.ui.matchesFacets = (entry) => matchesFacets(entry.row);
  app.ui.rowMatchesFacets = matchesFacets;

  // ---- state -> SelectionModel --------------------------------------------
  function applyFilter() {
    if (!anyChosen()) {
      sel.setFilter(null);
      return;
    }
    let recIds = null;
    if (app.model) {
      const matching = [];
      for (const e of app.bom.entries) {
        if (e.kind !== 'part' || !matchesFacets(e.row)) continue;
        const recs = app.model.byPartId.get(e.part.id);
        if (recs) matching.push(...recs);
      }
      // Subtrees + ancestors: assemblies containing a match stay solid.
      recIds = M.scopeSetFor(matching);
    }
    sel.setFilter({ recIds, hide: hideOthers });
  }

  function computeColorBy() {
    if (!colorProp) {
      sel.setColorBy(null);
      return;
    }
    const values = facets.get(colorProp);
    const valueColor = new Map();
    let i = 0;
    for (const key of values.keys()) {
      valueColor.set(key, key === NONE_KEY ? NONE_COLOR : PALETTE[i++ % PALETTE.length]);
    }
    const recColor = new Map();
    if (app.model) {
      for (const e of app.bom.entries) {
        if (e.kind !== 'part') continue;
        const color = valueColor.get(valueKeyOf(e.row, colorProp));
        if (color === undefined) continue;
        for (const r of app.model.byPartId.get(e.part.id) || []) {
          recColor.set(r.id, color);
        }
      }
    }
    sel.setColorBy({ prop: colorProp, valueColor, recColor });
  }

  // ---- user events ---------------------------------------------------------
  function toggleValue(prop, key) {
    const set = chosen.get(prop);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    applyFilter();
    render();
  }

  function toggleColorProp(prop) {
    colorProp = colorProp === prop ? null : prop;
    computeColorBy();
    render();
  }

  function setHideOthers(hide) {
    if (hideOthers === hide) return;
    hideOthers = hide;
    applyFilter();
    render();
  }

  app.ui.clearFilters = () => {
    for (const s of chosen.values()) s.clear();
    hideOthers = false;
    colorProp = null;
    sel.colorBy = null;   // silent — the setFilter below emits one 'filter'
    sel.setFilter(null);
    render();
  };

  // Record sets depend on the model; sidecar GLBs load after the panel.
  app.events.on('model', () => {
    if (anyChosen()) applyFilter();
    if (colorProp) computeColorBy();
  });

  // ---- DOM ------------------------------------------------------------------
  block.classList.remove('hidden');
  block.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'filter-head';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'filter-title';
  title.innerHTML = ICON_FUNNEL + '<span>Filters</span><span class="filter-badge hidden"></span>';
  title.title = 'Show or collapse the part-property filters';
  head.appendChild(title);
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'linklike filter-clear hidden';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => app.ui.clearFilters());
  head.appendChild(clearBtn);
  block.appendChild(head);

  const body = document.createElement('div');
  body.className = 'filter-body';
  block.appendChild(body);
  title.addEventListener('click', () => {
    body.classList.toggle('hidden');
    block.classList.toggle('is-collapsed', body.classList.contains('hidden'));
  });

  function render() {
    // header chrome
    const badge = title.querySelector('.filter-badge');
    const n = chosenCount();
    badge.textContent = n ? String(n) : '';
    badge.classList.toggle('hidden', !n);
    clearBtn.classList.toggle('hidden', !n && !colorProp);

    // facets
    body.innerHTML = '';
    for (const [prop, values] of facets) {
      const set = chosen.get(prop);
      const facetEl = document.createElement('div');
      facetEl.className = 'facet';

      const headEl = document.createElement('div');
      headEl.className = 'facet-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'facet-name';
      nameEl.textContent = prop;
      headEl.appendChild(nameEl);
      const paint = document.createElement('button');
      paint.type = 'button';
      paint.className = 'fbtn' + (colorProp === prop ? ' is-on' : '');
      paint.innerHTML = ICON_PAINT;
      paint.title = colorProp === prop
        ? 'Stop coloring parts by ' + prop
        : 'Color parts by ' + prop;
      paint.addEventListener('click', () => toggleColorProp(prop));
      headEl.appendChild(paint);
      facetEl.appendChild(headEl);

      const chips = document.createElement('div');
      chips.className = 'facet-chips';
      for (const [key, v] of values) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'facet-chip' + (set.has(key) ? ' is-on' : '');
        chip.textContent = `${v.display} (${v.count})`;
        chip.title = set.has(key)
          ? `Stop filtering to ${prop}: ${v.display}`
          : `Show only parts with ${prop}: ${v.display}`;
        chip.addEventListener('click', () => toggleValue(prop, key));
        chips.appendChild(chip);
      }
      facetEl.appendChild(chips);
      body.appendChild(facetEl);
    }

    // footer: what happens to non-matching parts
    const foot = document.createElement('div');
    foot.className = 'filter-foot';
    const lab = document.createElement('span');
    lab.textContent = 'Others:';
    foot.appendChild(lab);
    const seg = document.createElement('div');
    seg.className = 'seg seg-mini';
    for (const [label, hide, tip] of [
      ['Ghost', false, 'Non-matching parts stay faintly visible for context'],
      ['Hide', true, 'Non-matching parts disappear (cleanest for screenshots; exports then skip them)'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + ((hideOthers === hide) ? ' is-active' : '');
      b.textContent = label;
      b.title = tip;
      b.addEventListener('click', () => setHideOthers(hide));
      seg.appendChild(b);
    }
    foot.appendChild(seg);
    body.appendChild(foot);

    renderLegend();
  }

  function renderLegend() {
    if (!legend) return;
    legend.innerHTML = '';
    if (!colorProp) {
      legend.classList.add('hidden');
      return;
    }
    const values = facets.get(colorProp);
    const colors = sel.colorBy ? sel.colorBy.valueColor : new Map();

    const headEl = document.createElement('div');
    headEl.className = 'legend-head';
    const t = document.createElement('span');
    t.textContent = 'Color by ' + colorProp;
    headEl.appendChild(t);
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Stop coloring by ' + colorProp);
    close.title = 'Back to real part colors';
    close.innerHTML = '&#10005;';
    close.addEventListener('click', () => toggleColorProp(colorProp));
    headEl.appendChild(close);
    legend.appendChild(headEl);

    const set = chosen.get(colorProp);
    for (const [key, v] of values) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'legend-row' + (set.has(key) ? ' is-on' : '');
      row.title = 'Click to filter to ' + colorProp + ': ' + v.display;
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      const c = colors.get(key);
      if (c !== undefined) sw.style.background = hex(c);
      row.appendChild(sw);
      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = v.display;
      row.appendChild(label);
      const count = document.createElement('span');
      count.className = 'legend-count';
      count.textContent = String(v.count);
      row.appendChild(count);
      row.addEventListener('click', () => toggleValue(colorProp, key));
      legend.appendChild(row);
    }
    legend.classList.remove('hidden');
  }

  render();
}
