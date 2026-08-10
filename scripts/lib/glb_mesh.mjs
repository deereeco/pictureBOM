// Shared pipeline: BomDom HTML -> embedded GLB -> Draco-decoded, world-space
// mesh instances. Used by scripts/verify_measure_math.mjs (and ad-hoc analysis
// scripts). Plain Node, no npm deps at the repo root — the Draco decoder is
// loaded from web/node_modules/three.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// GLB extraction + container parse
// ---------------------------------------------------------------------------
export function extractGlbFromHtml(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  // Single-quoted attributes are a contract with build_viewer.mjs / smoke_bomdom.py.
  const m = html.match(/<script type='text\/plain' id='bomdom-glb'>([^<]*)<\/script>/);
  if (!m) throw new Error(`bomdom-glb payload slot not found in ${htmlPath}`);
  return gunzipSync(Buffer.from(m[1].trim(), 'base64'));
}

export function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('bad GLB magic');
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB missing JSON or BIN chunk');
  return { gltf: json, bin };
}

// ---------------------------------------------------------------------------
// Draco decode (Emscripten JS decoder, loaded without any fetch/wasm plumbing)
// ---------------------------------------------------------------------------
export async function loadDraco(dracoDir) {
  const file = path.join(dracoDir, 'draco_decoder.js');
  const src = readFileSync(file, 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename',
    src + '\nif (typeof DracoDecoderModule !== "undefined") module.exports = DracoDecoderModule;')(
    mod, mod.exports, createRequire(import.meta.url), dracoDir, file);
  if (typeof mod.exports !== 'function') throw new Error(`DracoDecoderModule not found in ${file}`);
  return new Promise((resolve) => mod.exports({ onModuleLoaded: resolve }));
}

function readPositions(draco, decoder, dmesh, attr) {
  const n = dmesh.num_points();
  // Fast path: bulk copy through the Emscripten heap (same trick as DRACOLoader).
  if (typeof decoder.GetAttributeDataArrayForAllPoints === 'function' && draco._malloc) {
    const byteLen = n * 3 * 4;
    const ptr = draco._malloc(byteLen);
    try {
      if (decoder.GetAttributeDataArrayForAllPoints(dmesh, attr, draco.DT_FLOAT32, byteLen, ptr)) {
        return new Float32Array(draco.HEAPF32.buffer, ptr, n * 3).slice();
      }
    } finally { draco._free(ptr); }
  }
  const fa = new draco.DracoFloat32Array();
  decoder.GetAttributeFloatForAllPoints(dmesh, attr, fa);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < out.length; i++) out[i] = fa.GetValue(i);
  draco.destroy(fa);
  return out;
}

function readIndices(draco, decoder, dmesh) {
  const numFaces = dmesh.num_faces();
  const numIdx = numFaces * 3;
  if (typeof decoder.GetTrianglesUInt32Array === 'function' && draco._malloc) {
    const byteLen = numIdx * 4;
    const ptr = draco._malloc(byteLen);
    try {
      decoder.GetTrianglesUInt32Array(dmesh, byteLen, ptr);
      return new Uint32Array(draco.HEAPF32.buffer, ptr, numIdx).slice();
    } finally { draco._free(ptr); }
  }
  const out = new Uint32Array(numIdx);
  const ia = new draco.DracoInt32Array();
  for (let f = 0; f < numFaces; f++) {
    decoder.GetFaceFromMesh(dmesh, f, ia);
    out[f * 3] = ia.GetValue(0);
    out[f * 3 + 1] = ia.GetValue(1);
    out[f * 3 + 2] = ia.GetValue(2);
  }
  draco.destroy(ia);
  return out;
}

function decodePrimitive(draco, gltf, bin, prim) {
  const ext = prim.extensions && prim.extensions.KHR_draco_mesh_compression;
  if (!ext) throw new Error('non-Draco primitive found; this pipeline only handles KHR_draco_mesh_compression');
  const bv = gltf.bufferViews[ext.bufferView];
  const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const dbuf = new draco.DecoderBuffer();
  dbuf.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
  const decoder = new draco.Decoder();
  const dmesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(dbuf, dmesh);
  if (!status.ok()) throw new Error(`Draco decode failed: ${status.error_msg()}`);
  const attr = decoder.GetAttributeByUniqueId(dmesh, ext.attributes.POSITION);
  const positions = readPositions(draco, decoder, dmesh, attr);
  const indices = readIndices(draco, decoder, dmesh);
  draco.destroy(dmesh); draco.destroy(dbuf); draco.destroy(decoder);
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Scene graph -> per-mesh-instance world geometry (column-major 4x4, glTF)
// ---------------------------------------------------------------------------
function trsToMat(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (yy + xx)) * s[2], 0,
    t[0], t[1], t[2], 1];
}

function matMul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

function det3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6])
       - m[4] * (m[1] * m[10] - m[9] * m[2])
       + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

export function applyMat(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
}

export function applyMatDir(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}

function aabbOf(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  return { lo, hi, extent: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

// Decode each mesh once (primitives merged), then instance it per node of the
// default scene. Every instance gets baked world-space Float64 vertices.
export function collectInstances(draco, gltf, bin) {
  const meshGeom = (gltf.meshes || []).map((mesh) => {
    let nVerts = 0, nIdx = 0;
    const parts = mesh.primitives.map((p) => {
      const g = decodePrimitive(draco, gltf, bin, p);
      nVerts += g.positions.length / 3;
      nIdx += g.indices.length;
      return g;
    });
    const positions = new Float32Array(nVerts * 3);
    const indices = new Uint32Array(nIdx);
    let vOff = 0, iOff = 0;
    for (const g of parts) {
      positions.set(g.positions, vOff * 3);
      for (let i = 0; i < g.indices.length; i++) indices[iOff + i] = g.indices[i] + vOff;
      vOff += g.positions.length / 3;
      iOff += g.indices.length;
    }
    return { name: mesh.name || null, positions, indices, localAabb: aabbOf(positions) };
  });

  const nodes = gltf.nodes || [];
  const instances = [];
  const walk = (nodeIndex, parentMat) => {
    const n = nodes[nodeIndex];
    const world = matMul(parentMat, trsToMat(n));
    if (n.mesh !== undefined) instances.push({ nodeIndex, name: n.name || `node${nodeIndex}`, mesh: n.mesh, world });
    for (const c of (n.children || [])) walk(c, world);
  };
  const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = gltf.scenes[gltf.scene || 0];
  for (const r of scene.nodes) walk(r, ident);

  for (const inst of instances) {
    const g = meshGeom[inst.mesh];
    const m = inst.world;
    const src = g.positions, n = src.length / 3;
    const w = new Float64Array(n * 3); // Float64 so transforms add no float32 noise
    for (let i = 0; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      w[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      w[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      w[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    inst.meshName = g.name;
    inst.indices = g.indices;
    inst.worldPos = w;
    inst.aabb = aabbOf(w);
    inst.localAabb = g.localAabb;
    inst.worldScale = [0, 1, 2].map((c) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]));
    inst.flipWinding = det3(m) < 0;
  }
  return instances;
}

// World-space triangle list for one instance: unit normal + corner vertex
// indices; degenerate triangles skipped, winding-flip (negative determinant
// transforms) corrected so normals stay outward.
export function triangleData(inst) {
  const { worldPos: p, indices: ix } = inst;
  const flip = inst.flipWinding ? -1 : 1;
  const tris = [];
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) continue;
    tris.push({ i: [ix[t], ix[t + 1], ix[t + 2]], n: [flip * nx / len, flip * ny / len, flip * nz / len] });
  }
  return tris;
}
