// Renderer / camera / controls with ON-DEMAND rendering: nothing renders
// unless invalidate() is called or a tween is active. No continuous rAF.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// ---- up axis ---------------------------------------------------------------
// Which model axis points up on screen. glTF says +Y, CAD usually means +Z, and
// an assembly modelled sideways can need any of the six. Only the CAMERA is
// re-oriented — model coordinates never move, so the explode axes, drag deltas
// and every X/Y/Z label in the UI keep meaning the CAD axes.

const UP_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];
export const DEFAULT_UP = '+y';

const AXIS_VEC = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function normalizeUp(up) {
  if (typeof up !== 'string') return null;
  let s = up.trim().toLowerCase();
  if (!s) return null;
  if (s[0] !== '+' && s[0] !== '-') s = '+' + s;
  return UP_AXES.includes(s) ? s : null;
}

export function upVector(up) {
  const axis = normalizeUp(up) || DEFAULT_UP;
  return new THREE.Vector3(...AXIS_VEC[axis[1]]).multiplyScalar(axis[0] === '-' ? -1 : 1);
}

// Where the camera sits for the "Front" view of each up axis. +Y keeps glTF's
// own convention (front = +Z); +Z uses the CAD one (front = -Y, i.e. looking at
// the XZ plane). The remaining views are derived from up x front.
const FRONT_FOR_UP = {
  '+y': [0, 0, 1], '-y': [0, 0, -1],
  '+z': [0, -1, 0], '-z': [0, 1, 0],
  '+x': [0, 0, 1], '-x': [0, 0, 1],
};

// Unit vector from the orbit target towards the camera for a named view
// ('iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right').
function viewDirection(name, up) {
  const axis = normalizeUp(up) || DEFAULT_UP;
  const u = upVector(axis);
  const front = new THREE.Vector3(...FRONT_FOR_UP[axis]);
  const right = new THREE.Vector3().crossVectors(u, front);
  switch (name) {
    case 'top': return u.clone();
    case 'bottom': return u.clone().negate();
    case 'front': return front.clone();
    case 'back': return front.clone().negate();
    case 'right': return right.clone();
    case 'left': return right.clone().negate();
    default: return front.clone().add(right).add(u).normalize(); // iso
  }
}

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  let upAxis = DEFAULT_UP;
  camera.up.copy(upVector(upAxis));
  camera.position.copy(viewDirection('iso', upAxis)).multiplyScalar(1.8);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  // Form definition over showroom flatness: dial the environment down and let
  // the key/fill pair carve shading gradients into gray parts. Keep enough
  // environment for metals — polished/black metallic parts are lit almost
  // entirely by reflections and would crush to black without it.
  scene.environmentIntensity = 0.65;

  // The rig holds the tuned key/fill geometry in +Y-up space and is rotated
  // as a whole when the up axis changes, so light keeps coming from "above"
  // the model instead of raking it from the side.
  const lightRig = new THREE.Group();
  scene.add(lightRig);
  lightRig.add(new THREE.HemisphereLight(0xffffff, 0x60666e, 0.3));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(3, 6, 4);
  lightRig.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-4, 2.5, -3);
  lightRig.add(fill);

  // ---- on-demand render loop + tweens --------------------------------
  let pending = false;
  const tweens = [];
  const cameraListeners = [];
  let controls = makeControls();

  function makeControls() {
    const c = new OrbitControls(camera, canvas);
    c.enableDamping = false; // damping needs a continuous loop
    c.addEventListener('change', invalidate);
    return c;
  }

  // OrbitControls derives its pole quaternion from camera.up ONCE, in the
  // constructor — mutating camera.up afterwards leaves orbiting spinning
  // around the old axis. Rebuilding the instance is the only public way to
  // re-derive it; every consumer reads viewer.controls through a getter, so
  // swapping the object is safe (nothing caches it across a gesture).
  function rebuildControls() {
    const target = controls.target.clone();
    const enabled = controls.enabled;
    controls.dispose();
    controls = makeControls();
    controls.target.copy(target);
    controls.update();
    controls.enabled = enabled;
  }

  function invalidate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    pending = false;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      const k = Math.max(0, Math.min(1, (now - tw.start) / tw.duration));
      tw.update(tw.ease(k));
      if (k >= 1) {
        tweens.splice(i, 1);
        if (tw.done) tw.done();
      }
    }
    renderer.render(scene, camera);
    for (const cb of cameraListeners) cb(camera);
    if (tweens.length) invalidate();
  }

  // Anything that mirrors the camera (the axis gizmo) redraws right after a
  // render, so it can never disagree with what is on screen.
  function onCameraChange(cb) {
    cameraListeners.push(cb);
    cb(camera);
  }

  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  // ---- up axis + standard views ---------------------------------------
  function setUpAxis(axis, { snapView = false } = {}) {
    const next = normalizeUp(axis);
    if (!next) return upAxis;
    upAxis = next;
    const up = upVector(upAxis);
    camera.up.copy(up);
    lightRig.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    // Keep the current eye position (zoom and framing survive the switch) —
    // only the roll changes, which is what rights a sideways model. The
    // exception is a view straight down the new pole: lookAt has no roll
    // reference there, so drop into the isometric for this up instead.
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length() || 1;
    if (snapView || Math.abs(offset.normalize().dot(up)) > 0.999) {
      camera.position.copy(controls.target).addScaledVector(viewDirection('iso', upAxis), dist);
    }
    rebuildControls();
    invalidate();
    return upAxis;
  }

  // name: 'iso' | 'top' | ... , or a world-space direction (the axis gizmo
  // hands one straight over).
  function setView(nameOrDir) {
    const dir = nameOrDir && nameOrDir.isVector3
      ? nameOrDir.clone().normalize()
      : viewDirection(nameOrDir, upAxis);
    const dist = camera.position.distanceTo(controls.target) || 1;
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    controls.update(); // nudges off an exactly-along-the-pole singularity
    invalidate();
  }

  function addTween({ duration = 300, delay = 0, update, done, ease = easeInOut }) {
    tweens.push({ start: performance.now() + delay, duration, update, done, ease });
    invalidate();
  }

  // ---- theme-reactive background --------------------------------------
  function applyThemeBackground() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    scene.background = new THREE.Color(bg || '#eef1f5');
    invalidate();
  }
  applyThemeBackground();
  new MutationObserver(applyThemeBackground)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---- resize ----------------------------------------------------------
  const holder = canvas.parentElement;
  function resize() {
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }
  new ResizeObserver(resize).observe(holder);
  resize();

  // ---- framing ---------------------------------------------------------
  // Exact fit: project points into the camera frustum and solve the nearest
  // distance where every point is inside. Called with per-mesh bounding-box
  // corners this fits the actual silhouette — aggregate-box or sphere fits
  // leave elongated assemblies tiny.
  function framePoints(points, pad = 1.08) {
    if (!points || !points.length) return;
    const box = new THREE.Box3().setFromPoints(points);
    const center = box.getCenter(new THREE.Vector3());
    const viewDir = camera.position.clone().sub(controls.target);
    if (viewDir.lengthSq() < 1e-12) viewDir.copy(viewDirection('iso', upAxis));
    viewDir.normalize();
    // Screen basis from the live camera up, so framing stays exact whichever
    // axis is up. Looking straight down the pole leaves the roll undefined —
    // any perpendicular reference fits the same silhouette there.
    let up = camera.up.clone().normalize();
    if (Math.abs(viewDir.dot(up)) > 0.95) {
      up = Math.abs(viewDir.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    }
    const right = new THREE.Vector3().crossVectors(up, viewDir).normalize();
    const camUp = new THREE.Vector3().crossVectors(viewDir, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    let dist = 0, maxSize = 1e-4;
    const rel = new THREE.Vector3();
    for (const p of points) {
      rel.copy(p).sub(center);
      const x = rel.dot(right), y = rel.dot(camUp), z = rel.dot(viewDir);
      dist = Math.max(dist, Math.abs(x) / tanH + z, Math.abs(y) / tanV + z);
      maxSize = Math.max(maxSize, rel.length() * 2);
    }
    dist *= pad;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(viewDir, dist);
    camera.near = Math.max(dist / 1000, maxSize / 1000);
    camera.far = dist * 100;
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  }

  function frameBox(box, pad) {
    if (!box || box.isEmpty()) return;
    const pts = [];
    for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) for (let iz = 0; iz < 2; iz++) {
      pts.push(new THREE.Vector3(ix ? box.max.x : box.min.x,
                                 iy ? box.max.y : box.min.y,
                                 iz ? box.max.z : box.min.z));
    }
    framePoints(pts, pad);
  }

  return {
    renderer, scene, camera, invalidate, addTween, frameBox, framePoints,
    onCameraChange, setUpAxis, setView,
    get controls() { return controls; }, // rebuilt whenever the up axis changes
    get upAxis() { return upAxis; },
  };
}
