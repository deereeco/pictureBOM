// Corner axis triad — an SVG mirror of the camera's orientation, so "which
// way is X/Y/Z" is never a guess. Same letters and colours as the X/Y/Z
// choices in the View and Explode popovers.
//
// SVG rather than a second WebGL view: the viewer renders on demand, and a
// projection of three unit vectors is a few lines of maths that cost nothing
// per frame and stay crisp at any DPI.

import * as THREE from 'three';
import { upVector } from './scene.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZE = 88;
const C = SIZE / 2;      // centre
const R = 31;            // axis length in px
const BALL_POS = 9;      // filled ball on +axis
const BALL_NEG = 6.5;    // hollow ball on -axis

const AXIS_VECS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const el = (name, attrs) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
};

export function initAxisGizmo(app) {
  const holder = document.getElementById('axisGizmo');
  if (!holder || !app.viewer) return;

  const svg = el('svg', {
    width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`,
    class: 'axis-svg', role: 'group', 'aria-label': 'Model axes',
  });

  // Ring marking the axis currently used as up — drawn under the balls.
  const upRing = el('circle', { class: 'axis-upring', r: BALL_POS + 3.5, cx: C, cy: C });
  svg.appendChild(upRing);

  const arms = [];
  for (const key of ['x', 'y', 'z']) {
    for (const sign of [1, -1]) {
      const g = el('g', {
        class: `axis-arm ax-${key}`,
        role: 'button',
        tabindex: '0',
        'aria-label': `Look from ${sign > 0 ? '+' : '-'}${key.toUpperCase()}`,
      });
      const line = sign > 0 ? el('line', { class: 'axis-line' }) : null;
      const ball = el('circle', {
        class: sign > 0 ? 'axis-ball' : 'axis-ball is-neg',
        r: sign > 0 ? BALL_POS : BALL_NEG,
      });
      const label = sign > 0
        ? el('text', { class: 'axis-label', 'text-anchor': 'middle', dy: '0.35em' })
        : null;
      if (label) label.textContent = key.toUpperCase();
      const title = el('title');
      title.textContent = `Look from ${sign > 0 ? '+' : '−'}${key.toUpperCase()}`;
      g.appendChild(title);
      if (line) g.appendChild(line);
      g.appendChild(ball);
      if (label) g.appendChild(label);

      const dir = new THREE.Vector3(...AXIS_VECS[key]).multiplyScalar(sign);
      const arm = { key, sign, dir, g, line, ball, label, depth: 0 };
      const look = () => app.actions.setView(dir.clone());
      g.addEventListener('click', look);
      g.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); look(); }
      });
      arms.push(arm);
      svg.appendChild(g);
    }
  }

  holder.appendChild(svg);

  // Caption doubles as the way in: it says which axis is up and opens the
  // View popover, so the fix is one click from the thing that looks wrong.
  const caption = document.createElement('button');
  caption.type = 'button';
  caption.className = 'axis-caption';
  caption.title = 'Change which way is up (View menu)';
  holder.appendChild(caption);
  caption.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (app.ui.openViewMenu) app.ui.openViewMenu();
  });

  function syncUp() {
    const up = app.viewer.upAxis;              // e.g. '+z'
    const letter = up[1].toUpperCase();
    caption.innerHTML = '';
    const strong = document.createElement('span');
    strong.className = `ax-text ax-${up[1]}`;
    strong.textContent = (up[0] === '-' ? '−' : '') + letter;
    caption.appendChild(strong);
    caption.appendChild(document.createTextNode(' up'));
    caption.setAttribute('aria-label',
      `${up[0] === '-' ? 'Negative ' : ''}${letter} is up — change`);
    upRing.setAttribute('class', `axis-upring ax-${up[1]}`);
    upDir.copy(upVector(up));
  }
  const upDir = new THREE.Vector3();
  app.ui.syncAxisGizmo = syncUp;
  syncUp();

  const v = new THREE.Vector3();
  const inv = new THREE.Quaternion();

  app.viewer.onCameraChange((camera) => {
    inv.copy(camera.quaternion).invert();
    for (const arm of arms) {
      // World axis -> camera space. +z points out of the screen, so it doubles
      // as the paint-order depth.
      v.copy(arm.dir).applyQuaternion(inv);
      const x = C + v.x * R;
      const y = C - v.y * R;
      arm.depth = v.z;
      arm.ball.setAttribute('cx', x.toFixed(2));
      arm.ball.setAttribute('cy', y.toFixed(2));
      if (arm.line) {
        arm.line.setAttribute('x1', C);
        arm.line.setAttribute('y1', C);
        arm.line.setAttribute('x2', x.toFixed(2));
        arm.line.setAttribute('y2', y.toFixed(2));
      }
      if (arm.label) {
        arm.label.setAttribute('x', x.toFixed(2));
        arm.label.setAttribute('y', y.toFixed(2));
      }
      // Balls pointing away sit behind the model visually: fade them out.
      arm.g.style.opacity = v.z < -0.25 ? '0.45' : '1';
      if (arm.dir.equals(upDir)) {
        upRing.setAttribute('cx', x.toFixed(2));
        upRing.setAttribute('cy', y.toFixed(2));
      }
    }
    // SVG paints in document order — back to front.
    arms.sort((a, b) => a.depth - b.depth);
    for (const arm of arms) svg.appendChild(arm.g);
  });
}
