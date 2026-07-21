// Renderer / camera / controls with ON-DEMAND rendering: nothing renders
// unless invalidate() is called or a tween is active. No continuous rAF.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
  camera.position.set(1, 0.8, 1.2);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  // Form definition over showroom flatness: dial the environment down and let
  // the key/fill pair carve shading gradients into gray parts. Keep enough
  // environment for metals — polished/black metallic parts are lit almost
  // entirely by reflections and would crush to black without it.
  scene.environmentIntensity = 0.65;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x60666e, 0.3));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(3, 6, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-4, 2.5, -3);
  scene.add(fill);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false; // damping needs a continuous loop

  // ---- on-demand render loop + tweens --------------------------------
  let pending = false;
  const tweens = [];

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
    if (tweens.length) invalidate();
  }

  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  function addTween({ duration = 300, delay = 0, update, done, ease = easeInOut }) {
    tweens.push({ start: performance.now() + delay, duration, update, done, ease });
    invalidate();
  }

  controls.addEventListener('change', invalidate);

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
    if (viewDir.lengthSq() < 1e-12) viewDir.set(1, 0.8, 1.2);
    viewDir.normalize();
    const up = Math.abs(viewDir.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
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

  return { renderer, scene, camera, controls, invalidate, addTween, frameBox, framePoints };
}
