// Settings gear (issue #31): the one place for reader preferences — things
// that are about the person reading, not about the model in front of them.
// Theme, units, animations and the diagnostics line are remembered per
// browser (localStorage), exactly like the toggles they replace; model-side
// choices (up axis, part colors, edges, shading) stay in the View menu.
//
// The popover is rebuilt on every open, so it always mirrors state that
// other controls may have changed (the measure chip's unit select shares the
// same stored preference).

import { UNITS, readUnit, storeUnit } from './units.js';

const $ = (id) => document.getElementById(id);

export const THEME_KEY = 'picturebom-theme'; // must match the inline boot script (and the launcher)
export const ANIM_KEY = 'picturebom-bomdom-anim';
export const REPO_URL = 'https://github.com/deereeco/pictureBOM';

const UNIT_LABELS = { um: 'µm', mm: 'mm', cm: 'cm', m: 'm', in: 'in', ft: 'ft', ftin: 'ft + in' };

// ---- theme -----------------------------------------------------------------
// All three modes are stored explicitly. NO stored value means the viewer's
// own default — dark, which frames the spotlight backdrop (see the head
// script in shell.html) — while a stored 'system' follows the operating
// system. The launcher shares the key and reads the same three values.
export const THEME_MODES = ['light', 'dark', 'system'];
export const DEFAULT_THEME_MODE = 'dark';

export function readThemeMode() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(t) ? t : DEFAULT_THEME_MODE;
  } catch { return DEFAULT_THEME_MODE; }
}

const osDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

let themeTransitionTimer = null;
function paintTheme(theme) {
  const root = document.documentElement;
  if (root.getAttribute('data-theme') === theme) return;
  root.classList.add('theme-transition');
  root.setAttribute('data-theme', theme);
  clearTimeout(themeTransitionTimer);
  themeTransitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 300);
}

export function applyThemeMode(mode) {
  if (!THEME_MODES.includes(mode)) mode = DEFAULT_THEME_MODE;
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode: applies this session */ }
  paintTheme(mode === 'system' ? (osDark() ? 'dark' : 'light') : mode);
}

// ---- animations --------------------------------------------------------------
// Missing -> on, unless the OS asks for reduced motion; an explicit choice wins.
export function readAnimations() {
  try {
    const v = localStorage.getItem(ANIM_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* fall through */ }
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function storeAnimations(on) {
  try { localStorage.setItem(ANIM_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
}

// ---- forget ------------------------------------------------------------------
// Everything this viewer (and the pictureBOM launcher, which shares the theme
// key) ever remembered in this browser lives under one prefix.
export function forgetStoredSettings() {
  const gone = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('picturebom-')) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch { /* storage blocked: nothing was remembered anyway */ }
  return gone.length;
}

// ---- popover -----------------------------------------------------------------
export function initSettings(app) {
  const btn = $('btnSettings');
  const menu = $('settingsMenu');
  app.animations = readAnimations();

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const head = (text) => menu.appendChild(el('div', 'menu-head', text));
  const sep = () => menu.appendChild(el('div', 'menu-sep'));

  function segRow(options, current, onPick, ariaLabel) {
    const row = el('div', 'pop-seg-row');
    const seg = el('div', 'seg seg-mini');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', ariaLabel);
    for (const [value, label] of options) {
      const b = el('button', 'seg-btn' + (value === current ? ' is-active' : ''), label);
      b.type = 'button';
      b.dataset.value = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', value === current ? 'true' : 'false');
      b.addEventListener('click', () => {
        onPick(value);
        for (const o of seg.children) {
          const on = o.dataset.value === value;
          o.classList.toggle('is-active', on);
          o.setAttribute('aria-checked', on ? 'true' : 'false');
        }
      });
      seg.appendChild(b);
    }
    row.appendChild(seg);
    menu.appendChild(row);
  }

  function check(label, checked, onChange, title) {
    const lab = el('label', 'pop-check');
    if (title) lab.title = title;
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    lab.appendChild(box);
    lab.appendChild(document.createTextNode(' ' + label));
    menu.appendChild(lab);
    return box;
  }

  function item(label, onClick, { key = null, title = null } = {}) {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.appendChild(el('span', 'item-label', label));
    if (key) b.appendChild(el('span', 'item-key', key));
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    menu.appendChild(b);
    return b;
  }

  function build() {
    menu.innerHTML = '';

    head('Theme');
    segRow([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], readThemeMode(),
      applyThemeMode, 'Theme');

    head('Units');
    const unitRow = el('div', 'pop-seg-row');
    const unitSel = el('select', 'pop-select');
    unitSel.title = 'Measurement units — measure readouts and the move triad';
    unitSel.setAttribute('aria-label', 'Measurement units');
    for (const u of Object.keys(UNITS)) {
      const o = el('option', null, UNIT_LABELS[u] || u);
      o.value = u;
      unitSel.appendChild(o);
    }
    unitSel.value = readUnit();
    unitSel.addEventListener('change', () => {
      const u = UNITS[unitSel.value] ? unitSel.value : readUnit();
      storeUnit(u);
      // The measure chip keeps its own select as a shortcut to the same
      // preference; routing through it lets measure.js refresh live labels.
      const chip = $('measureUnits');
      if (chip && chip.value !== u) {
        chip.value = u;
        chip.dispatchEvent(new Event('change'));
      }
    });
    unitRow.appendChild(unitSel);
    menu.appendChild(unitRow);

    head('Viewer');
    check('Animations', app.animations, (on) => {
      app.animations = on;
      storeAnimations(on);
      if (app.viewer) app.viewer.setAnimations(on);
    }, 'Camera glides, explode play-out and snap-back — off means instant');
    check('Diagnostics line', app.ui.diagOn ? app.ui.diagOn() : false, (on) => {
      if (app.ui.setDiag) app.ui.setDiag(on);
    }, 'Decode path, timings and counts in the footer (same as the ⓘ button)');

    sep();
    item('Mouse & keyboard', () => {
      close();
      $('helpOverlay').classList.remove('hidden');
    }, { key: '?' });

    // Two-step: the first click arms the item, the second (within 4 s) acts.
    // No browser dialog, no extra row.
    let armed = null;
    const forget = item('Forget my settings on this device', () => {
      if (!armed) {
        forget.classList.add('is-armed');
        forget.querySelector('.item-label').textContent = 'Click again to forget everything and reload';
        armed = setTimeout(() => {
          armed = null;
          forget.classList.remove('is-armed');
          forget.querySelector('.item-label').textContent = 'Forget my settings on this device';
        }, 4000);
        return;
      }
      clearTimeout(armed);
      forgetStoredSettings();
      location.reload();
    }, { title: 'Clears the theme, units, edges, shading, colors & lighting, panel and up-axis choices saved in this browser, then reloads' });

    sep();
    const meta = app.meta || {};
    const about = el('div', 'pop-about');
    const genDate = (meta.generated || '').slice(0, 10);
    const text = el('span', 'about-text',
      `pictureBOM${meta.app_version ? ' v' + meta.app_version : ''}${genDate ? ' · generated ' + genDate : ''}`);
    const asm = meta.assembly || {};
    text.title = [asm.file, asm.config && ('config ' + asm.config)].filter(Boolean).join(' · ') || 'BomDom';
    about.appendChild(text);
    const gh = el('a', 'gh-link');
    gh.href = REPO_URL;
    gh.target = '_blank';
    gh.rel = 'noopener';
    gh.title = 'pictureBOM on GitHub';
    gh.setAttribute('aria-label', 'pictureBOM on GitHub');
    gh.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
    gh.addEventListener('click', close);
    about.appendChild(gh);
    menu.appendChild(about);
  }

  function isOpen() { return !menu.classList.contains('hidden'); }

  function open() {
    app.ui.closeMenus();
    build();
    menu.classList.remove('hidden');
    btn.classList.add('is-on');
    btn.setAttribute('aria-expanded', 'true');
    app.ui.clampMenu(menu);
  }

  // interactions.js's closeMenus hides this popover and resets the gear's
  // open state along with every other menu (Esc, click-away, another menu).
  const close = () => app.ui.closeMenus();

  function toggle() { if (isOpen()) close(); else open(); }

  btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });
  app.ui.toggleSettings = toggle;

  // Only a stored 'system' follows OS theme changes mid-session.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (readThemeMode() === 'system') paintTheme(e.matches ? 'dark' : 'light');
  });
}
