// Single source of interaction truth. Canvas, parts list and structure tree
// all subscribe here; none of them talk to each other directly.

export function createEmitter() {
  const subs = new Map();
  return {
    on(event, fn) {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    emit(event, ...args) {
      const set = subs.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(...args); } catch (e) { console.error('[BomDom] listener error', e); }
      }
    },
  };
}

export class SelectionModel {
  constructor(events) {
    this.events = events;
    this.hover = null;           // {kind:'rec',id} | {kind:'part',partId} | null
    this.selected = new Set();   // record ids
    this.scope = null;           // {label, recIds:Set} — "Open" viewing scope
  }

  setHover(h) {
    const same = JSON.stringify(h) === JSON.stringify(this.hover);
    if (same) return;
    this.hover = h;
    this.events.emit('hover', h);
  }

  select(ids, { additive = false } = {}) {
    if (!additive) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.events.emit('selection', this.selected);
  }

  toggle(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.events.emit('selection', this.selected);
  }

  clearSelection() {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.events.emit('selection', this.selected);
    return true;
  }

  setScope(scope) {
    this.scope = scope;
    this.events.emit('scope', scope);
  }
}
