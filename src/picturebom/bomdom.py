"""BomDom: build a self-contained interactive 3D BOM HTML from a SolidWorks GLB.

Pure Python, no COM. The pipeline:

    parse_glb -> validate_glb -> select_scene -> repack_glb (single scene,
    content-hash dedup) -> match_parts_to_bom -> thumbnails -> payload JSON
    -> HTML via sentinel substitution into the committed viewer template.

Design notes grounded in real SOLIDWORKSGLTF exports:

- A file may contain multiple scenes (one per configuration x display state),
  each with its OWN private copies of every node, mesh and material. Only the
  scene matching the configuration the BOM traversal saw is kept — this is a
  correctness requirement, not an optimization.
- The exporter never shares data between component instances; repeated parts
  are byte-identical blobs. Dedup is therefore pure content hashing: only
  identical bytes/descriptors merge, so differing configurations or
  assembly-context color overrides can never be corrupted by it.
- With Draco compression on, geometry accessors carry no bufferView (the
  geometry lives only in Draco blobs), and the Draco extension's `attributes`
  values are Draco-internal ids, NOT accessor indices — they are never
  remapped.
- Hidden components appear as nodes with no mesh and no children; they are
  kept (the viewer uses them for hierarchy and "not in 3D view" badges).
"""

import base64
import gzip
import hashlib
import json
import logging
import math
import os
import re
import struct
import subprocess
import tempfile
from importlib import resources

from .core import PictureBOMError, sanitize_filename, _vendor_url

log = logging.getLogger(__name__)

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

PAYLOAD_SCHEMA = "picturebom.bomdom/1"

# Required extensions we know how to pass through untouched.
KNOWN_REQUIRED_EXTENSIONS = {"KHR_draco_mesh_compression"}
# Extensions stripped from the output wherever they appear.
STRIPPED_EXTENSIONS = {"KHR_lights_punctual", "Solidworks_custom_properties"}

SENTINEL_META = "__BOMDOM_PAYLOAD_JSON__"
SENTINEL_GLB = "__BOMDOM_GLB_GZ_B64__"
SENTINEL_MODE = "__BOMDOM_MODE__"
SENTINEL_CONFIG = "__BOMDOM_CONFIG__"

_INSTANCE_SUFFIX_RE = re.compile(r"-\d+$")

THUMBNAIL_MAX_PX = 256
THUMBNAIL_JPEG_QUALITY = 70


class Glb:
    """A parsed GLB: the glTF JSON dict plus the binary chunk."""

    def __init__(self, gltf, bin_chunk, source=""):
        self.gltf = gltf
        self.bin = bin_chunk
        self.source = source

    @property
    def draco(self):
        return "KHR_draco_mesh_compression" in self.gltf.get("extensionsRequired", [])


# ---------------------------------------------------------------------------
# Parse / validate
# ---------------------------------------------------------------------------

def parse_glb(path_or_bytes):
    """Parse a .glb file (or raw bytes) into a Glb, checking container structure."""
    if isinstance(path_or_bytes, (bytes, bytearray)):
        data, source = bytes(path_or_bytes), "<bytes>"
    else:
        source = path_or_bytes
        with open(path_or_bytes, "rb") as f:
            data = f.read()

    if len(data) < 20:
        raise PictureBOMError(f"GLB too small ({len(data)} bytes): {source}")
    magic, version, declared = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise PictureBOMError(f"Not a GLB file (bad magic): {source}")
    if version != 2:
        raise PictureBOMError(f"Unsupported GLB version {version}: {source}")
    if declared != len(data):
        raise PictureBOMError(
            f"GLB length mismatch (header {declared}, file {len(data)}): {source}")

    offset, gltf, bin_chunk = 12, None, b""
    while offset < len(data):
        if offset + 8 > len(data):
            raise PictureBOMError(f"Truncated GLB chunk header: {source}")
        clen, ctype = struct.unpack_from("<II", data, offset)
        offset += 8
        if offset + clen > len(data):
            raise PictureBOMError(f"GLB chunk overruns file: {source}")
        chunk = data[offset:offset + clen]
        offset += clen
        if ctype == CHUNK_JSON and gltf is None:
            try:
                gltf = json.loads(chunk)
            except ValueError as e:
                raise PictureBOMError(f"GLB JSON chunk unparseable: {e}") from e
        elif ctype == CHUNK_BIN and not bin_chunk:
            bin_chunk = chunk

    if gltf is None:
        raise PictureBOMError(f"GLB has no JSON chunk: {source}")
    return Glb(gltf, bin_chunk, source)


def _iter_matrix_values(node):
    for key in ("matrix", "translation", "rotation", "scale"):
        for v in node.get(key, []):
            yield v


def validate_glb(glb):
    """Semantic validation. Raises PictureBOMError on hard failures; returns warnings.

    Runs on every SolidWorks export before post-processing, and on our own
    repacked output in tests. Hard failure means: keep the raw .glb on disk,
    skip 3D output, never block the Excel path (callers enforce that).
    """
    g = glb.gltf
    warnings = []

    if g.get("asset", {}).get("version") != "2.0":
        raise PictureBOMError(f"Unsupported glTF version: {g.get('asset', {}).get('version')!r}")

    unknown_required = set(g.get("extensionsRequired", [])) - KNOWN_REQUIRED_EXTENSIONS
    if unknown_required:
        raise PictureBOMError(f"GLB requires unsupported extensions: {sorted(unknown_required)}")

    buffers = g.get("buffers", [])
    if len(buffers) > 1:
        raise PictureBOMError(f"GLB has {len(buffers)} buffers; expected at most 1")
    if buffers:
        if "uri" in buffers[0]:
            raise PictureBOMError("GLB buffer references an external URI; must be self-contained")
        blen = buffers[0].get("byteLength", 0)
        if not (len(glb.bin) - 3 <= blen <= len(glb.bin)):
            raise PictureBOMError(
                f"Buffer byteLength {blen} inconsistent with BIN chunk {len(glb.bin)}")

    def _check_index(value, array_name, context):
        arr = g.get(array_name, [])
        if not isinstance(value, int) or not (0 <= value < len(arr)):
            raise PictureBOMError(f"Dangling {array_name} index {value!r} in {context}")

    for i, bv in enumerate(g.get("bufferViews", [])):
        _check_index(bv.get("buffer"), "buffers", f"bufferViews[{i}]")
        start = bv.get("byteOffset", 0)
        if start + bv.get("byteLength", 0) > len(glb.bin):
            raise PictureBOMError(f"bufferViews[{i}] overruns binary chunk")

    for i, acc in enumerate(g.get("accessors", [])):
        if "bufferView" in acc:
            _check_index(acc["bufferView"], "bufferViews", f"accessors[{i}]")
        sparse = acc.get("sparse")
        if sparse:
            _check_index(sparse["indices"]["bufferView"], "bufferViews", f"accessors[{i}].sparse")
            _check_index(sparse["values"]["bufferView"], "bufferViews", f"accessors[{i}].sparse")

    for i, mesh in enumerate(g.get("meshes", [])):
        prims = mesh.get("primitives", [])
        if not prims:
            raise PictureBOMError(f"meshes[{i}] has no primitives")
        for prim in prims:
            for acc_idx in prim.get("attributes", {}).values():
                _check_index(acc_idx, "accessors", f"meshes[{i}] attributes")
            if "indices" in prim:
                _check_index(prim["indices"], "accessors", f"meshes[{i}] indices")
            if "material" in prim:
                _check_index(prim["material"], "materials", f"meshes[{i}]")
            draco = prim.get("extensions", {}).get("KHR_draco_mesh_compression")
            if draco:
                _check_index(draco.get("bufferView"), "bufferViews", f"meshes[{i}] draco")

    for i, img in enumerate(g.get("images", [])):
        if "bufferView" in img:
            _check_index(img["bufferView"], "bufferViews", f"images[{i}]")
        elif not str(img.get("uri", "")).startswith("data:"):
            raise PictureBOMError(f"images[{i}] references an external URI")
    for i, tex in enumerate(g.get("textures", [])):
        if "source" in tex:
            _check_index(tex["source"], "images", f"textures[{i}]")

    nodes = g.get("nodes", [])
    parent_of = {}
    for i, node in enumerate(nodes):
        if "mesh" in node:
            _check_index(node["mesh"], "meshes", f"nodes[{i}]")
        if "matrix" in node and any(k in node for k in ("translation", "rotation", "scale")):
            raise PictureBOMError(f"nodes[{i}] has both matrix and TRS properties")
        for v in _iter_matrix_values(node):
            if not (isinstance(v, (int, float)) and math.isfinite(v)):
                raise PictureBOMError(f"nodes[{i}] has a non-finite transform value")
        for child in node.get("children", []):
            _check_index(child, "nodes", f"nodes[{i}].children")
            if child in parent_of:
                raise PictureBOMError(f"nodes[{child}] has multiple parents")
            parent_of[child] = i

    scenes = g.get("scenes", [])
    if not scenes:
        raise PictureBOMError("GLB contains no scenes")
    for i, scene in enumerate(scenes):
        for root in scene.get("nodes", []):
            _check_index(root, "nodes", f"scenes[{i}]")
    # Cycle check: DFS from every scene root with an explicit stack.
    for i, scene in enumerate(scenes):
        seen = set()
        stack = list(scene.get("nodes", []))
        path_guard = 0
        while stack:
            n = stack.pop()
            path_guard += 1
            if path_guard > len(nodes) * 2 + 10:
                raise PictureBOMError(f"Node cycle detected in scenes[{i}]")
            if n in seen:
                continue
            seen.add(n)
            stack.extend(nodes[n].get("children", []))

    if len(scenes) > 8:
        warnings.append(f"GLB has {len(scenes)} scenes (unusually many)")
    if not any("mesh" in n for n in nodes):
        warnings.append("GLB contains no mesh nodes (nothing visible to render)")
    img_bytes = sum(g["bufferViews"][img["bufferView"]].get("byteLength", 0)
                    for img in g.get("images", []) if "bufferView" in img)
    if img_bytes > 10 * 1024 * 1024:
        warnings.append(f"Embedded textures total {img_bytes / 1e6:.1f} MB")
    return warnings


# ---------------------------------------------------------------------------
# Scene selection / indexing
# ---------------------------------------------------------------------------

def select_scene(gltf, active_config=None):
    """Pick the scene matching the active configuration the BOM traversal saw.

    SOLIDWORKSGLTF names scenes '<Configuration> - <Display State>'. Falls back
    to the file's default scene.
    """
    scenes = gltf.get("scenes", [])
    default = gltf.get("scene", 0)
    if not (0 <= default < len(scenes)):
        default = 0
    if active_config:
        prefix = active_config + " - "
        matches = [i for i, s in enumerate(scenes)
                   if (s.get("name") or "").startswith(prefix) or s.get("name") == active_config]
        if matches:
            return default if default in matches else matches[0]
    return default


def _is_camera_only(node):
    return "camera" in node and "mesh" not in node and not node.get("children")


def index_scene(glb, scene_index):
    """Walk one scene's subtree. Returns dict with kept/mesh/empty node ids."""
    g = glb.gltf
    nodes = g.get("nodes", [])
    scene = g["scenes"][scene_index]

    kept, parents = [], {}
    order_seen = set()
    stack = [(r, None) for r in reversed(scene.get("nodes", []))]
    while stack:
        idx, parent = stack.pop()
        if idx in order_seen:
            continue
        order_seen.add(idx)
        node = nodes[idx]
        if _is_camera_only(node):
            continue
        kept.append(idx)
        parents[idx] = parent
        for child in reversed(node.get("children", [])):
            stack.append((child, idx))

    mesh_nodes = [i for i in kept if "mesh" in nodes[i]]
    empty_nodes = [i for i in kept
                   if "mesh" not in nodes[i]
                   and not any(c in order_seen and not _is_camera_only(nodes[c])
                               for c in nodes[i].get("children", []))]
    return {
        "scene_index": scene_index,
        "scene_name": scene.get("name", ""),
        "kept": kept,              # pre-order, camera-only nodes removed
        "parents": parents,        # old idx -> old parent idx (None for roots)
        "mesh_nodes": mesh_nodes,
        "empty_nodes": empty_nodes,
    }


# ---------------------------------------------------------------------------
# Name cleaning
# ---------------------------------------------------------------------------

def clean_node_name(name):
    """Strip ONE trailing '-<n>' instance suffix from a component node name.

    '^' (virtual components) and 'Copy of' prefixes are deliberately treated
    as opaque content: the BOM side derives names from GetPathName basenames,
    which carry the same decorations for virtual components.
    """
    return _INSTANCE_SUFFIX_RE.sub("", name or "", count=1)


# ---------------------------------------------------------------------------
# Repack: single scene, content-hash dedup
# ---------------------------------------------------------------------------

def _bv_bytes(glb, bv_index):
    bv = glb.gltf["bufferViews"][bv_index]
    start = bv.get("byteOffset", 0)
    return glb.bin[start:start + bv.get("byteLength", 0)]


def _content_key(obj, drop=("name",)):
    slim = {k: v for k, v in obj.items() if k not in drop}
    return json.dumps(slim, sort_keys=True, separators=(",", ":"))


def _node_determinant(node):
    """Determinant sign of a node's rotation/scale — negative means mirrored."""
    m = node.get("matrix")
    if m:
        a, b, c = m[0], m[1], m[2]
        d, e, f = m[4], m[5], m[6]
        g_, h, i = m[8], m[9], m[10]
        return (a * (e * i - f * h) - b * (d * i - f * g_) + c * (d * h - e * g_))
    sx, sy, sz = (node.get("scale") or [1, 1, 1])[:3]
    return sx * sy * sz


class _Remapper:
    """Deduplicating index allocator: content key -> new index, kept in first-seen order."""

    def __init__(self):
        self.by_key = {}
        self.items = []

    def add(self, key, item):
        idx = self.by_key.get(key)
        if idx is None:
            idx = len(self.items)
            self.by_key[key] = idx
            self.items.append(item)
        return idx


def repack_glb(glb, scene_info, app_version=""):
    """Rebuild a compact single-scene GLB with content-hash dedup.

    Returns (glb_bytes, result) where result carries the node/part maps and
    stats the payload builder needs.
    """
    g = glb.gltf
    old_nodes = g.get("nodes", [])
    kept = scene_info["kept"]

    new_index = {old: new for new, old in enumerate(kept)}

    bin_parts = []          # unique blobs, in first-seen order
    bin_len = 0
    bvs = _Remapper()

    def add_buffer_view(old_bv_idx):
        nonlocal bin_len
        old_bv = g["bufferViews"][old_bv_idx]
        blob = _bv_bytes(glb, old_bv_idx)
        key = (hashlib.sha256(blob).digest(), old_bv.get("byteStride"), old_bv.get("target"))
        existing = bvs.by_key.get(key)
        if existing is not None:
            return existing
        pad = (-bin_len) % 4
        if pad:
            bin_parts.append(b"\x00" * pad)
            bin_len += pad
        new_bv = {"buffer": 0, "byteOffset": bin_len, "byteLength": len(blob)}
        if "byteStride" in old_bv:
            new_bv["byteStride"] = old_bv["byteStride"]
        if "target" in old_bv:
            new_bv["target"] = old_bv["target"]
        idx = bvs.add(key, new_bv)
        bin_parts.append(blob)
        bin_len += len(blob)
        return idx

    accessors = _Remapper()

    def add_accessor(old_idx):
        acc = dict(g["accessors"][old_idx])
        if "bufferView" in acc:
            acc["bufferView"] = add_buffer_view(acc["bufferView"])
        if "sparse" in acc:
            sparse = json.loads(json.dumps(acc["sparse"]))
            sparse["indices"]["bufferView"] = add_buffer_view(sparse["indices"]["bufferView"])
            sparse["values"]["bufferView"] = add_buffer_view(sparse["values"]["bufferView"])
            acc["sparse"] = sparse
        acc.pop("name", None)
        return accessors.add(_content_key(acc, drop=()), acc)

    materials = _Remapper()

    def add_material(old_idx):
        mat = json.loads(json.dumps(g["materials"][old_idx]))
        _strip_extensions(mat)
        # Remap texture refs BEFORE keying, so identical-looking materials that
        # reference content-identical textures dedupe to the same entry and a
        # dedup hit never re-remaps already-new indices.
        _remap_texture_refs(mat)
        key = _content_key(mat)  # name-insensitive: identical looks merge
        return materials.add(key, mat)

    images = _Remapper()

    def add_image(old_idx):
        img = dict(g["images"][old_idx])
        img.pop("name", None)
        if "bufferView" in img:
            blob = _bv_bytes(glb, img["bufferView"])
            key = ("img", hashlib.sha256(blob).digest(), img.get("mimeType"))
            existing = images.by_key.get(key)
            if existing is not None:
                return existing
            img["bufferView"] = add_buffer_view(img["bufferView"])
            return images.add(key, img)
        return images.add(("img-uri", img.get("uri"), img.get("mimeType")), img)

    samplers = _Remapper()
    textures = _Remapper()

    def add_texture(old_idx):
        tex = dict(g["textures"][old_idx])
        tex.pop("name", None)
        if "source" in tex:
            tex["source"] = add_image(tex["source"])
        if "sampler" in tex:
            samp = dict(g["samplers"][tex["sampler"]])
            samp.pop("name", None)
            tex["sampler"] = samplers.add(_content_key(samp, drop=()), samp)
        return textures.add(_content_key(tex, drop=()), tex)

    def _remap_texture_refs(obj):
        """Recursively remap {'index': <texture>} textureInfo dicts in a material."""
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k in ("baseColorTexture", "metallicRoughnessTexture", "normalTexture",
                         "occlusionTexture", "emissiveTexture") and isinstance(v, dict):
                    v["index"] = add_texture(v["index"])
                else:
                    _remap_texture_refs(v)
        elif isinstance(obj, list):
            for v in obj:
                _remap_texture_refs(v)

    meshes = _Remapper()

    def add_mesh(old_idx):
        mesh = json.loads(json.dumps(g["meshes"][old_idx]))
        mesh.pop("name", None)
        for prim in mesh.get("primitives", []):
            prim["attributes"] = {k: add_accessor(v) for k, v in prim["attributes"].items()}
            if "indices" in prim:
                prim["indices"] = add_accessor(prim["indices"])
            if "material" in prim:
                prim["material"] = add_material(prim["material"])
            draco = prim.get("extensions", {}).get("KHR_draco_mesh_compression")
            if draco:
                # draco['attributes'] values are Draco-internal ids — never remapped.
                draco["bufferView"] = add_buffer_view(draco["bufferView"])
            _strip_extensions(prim)
        return meshes.add(_content_key(mesh, drop=()), mesh)

    # --- nodes ---------------------------------------------------------
    new_nodes = []
    node_map = {}          # new node index -> part id (== new mesh index)
    mirrored_nodes = []
    for old in kept:
        src = old_nodes[old]
        node = {}
        for key in ("name", "matrix", "translation", "rotation", "scale"):
            if key in src:
                node[key] = src[key]
        children = [new_index[c] for c in src.get("children", []) if c in new_index]
        if children:
            node["children"] = children
        if "mesh" in src:
            part_id = add_mesh(src["mesh"])
            node["mesh"] = part_id
            extras = dict(src.get("extras") or {})
            extras["partId"] = part_id
            node["extras"] = extras
            node_map[new_index[old]] = part_id
            if _node_determinant(src) < 0:
                mirrored_nodes.append(new_index[old])
        elif src.get("extras"):
            node["extras"] = src["extras"]
        new_nodes.append(node)

    roots = [new_index[r] for r in g["scenes"][scene_info["scene_index"]].get("nodes", [])
             if r in new_index]

    out = {
        "asset": {"version": "2.0",
                  "generator": f"pictureBOM BomDom {app_version}".strip()},
        "scene": 0,
        "scenes": [{"name": scene_info["scene_name"], "nodes": roots}],
        "nodes": new_nodes,
    }
    if meshes.items:
        out["meshes"] = meshes.items
    if accessors.items:
        out["accessors"] = accessors.items
    if materials.items:
        out["materials"] = materials.items
    if textures.items:
        out["textures"] = textures.items
    if samplers.items:
        out["samplers"] = samplers.items
    if images.items:
        out["images"] = images.items
    if bvs.items:
        out["bufferViews"] = bvs.items
        out["buffers"] = [{"byteLength": bin_len}]

    used = set()
    for mesh in meshes.items:
        for prim in mesh.get("primitives", []):
            if "KHR_draco_mesh_compression" in prim.get("extensions", {}):
                used.add("KHR_draco_mesh_compression")
    for mat in materials.items:
        used.update(mat.get("extensions", {}).keys())
    if used:
        out["extensionsUsed"] = sorted(used)
        required = used & KNOWN_REQUIRED_EXTENSIONS
        if required:
            out["extensionsRequired"] = sorted(required)

    glb_bytes = _emit_glb(out, b"".join(bin_parts))

    # Part grouping for the payload: one part per unique mesh.
    parts = {}
    for new_node_idx, part_id in node_map.items():
        name = clean_node_name(new_nodes[new_node_idx].get("name", ""))
        entry = parts.setdefault(part_id, {
            "id": part_id, "name": name, "raw_names": set(), "instances": 0,
            "mirrored": False,
        })
        entry["instances"] += 1
        entry["raw_names"].add(new_nodes[new_node_idx].get("name", ""))
        if new_node_idx in mirrored_nodes:
            entry["mirrored"] = True

    result = {
        "node_map": node_map,
        "parts": [parts[k] for k in sorted(parts)],
        "mirrored_nodes": mirrored_nodes,
        "empty_node_names": [old_nodes[i].get("name", "") for i in scene_info["empty_nodes"]],
        # Subassembly grouping nodes (children, no mesh): their BOM rows have 3D
        # presence through their children and must not be flagged unmatched.
        "group_node_names": [n.get("name", "") for n in new_nodes
                             if "mesh" not in n and n.get("children")],
        "stats": {
            "scenes_in": len(g.get("scenes", [])),
            "nodes_in_scene": len(kept),
            "mesh_instances": len(node_map),
            "unique_parts": len(parts),
            "meshes_in_file": len(g.get("meshes", [])),
            "bytes_in": len(glb.bin) + len(json.dumps(g)),
            "bytes_out": len(glb_bytes),
        },
    }
    return glb_bytes, result


def _strip_extensions(obj):
    ext = obj.get("extensions")
    if isinstance(ext, dict):
        for name in STRIPPED_EXTENSIONS:
            ext.pop(name, None)
        if not ext:
            obj.pop("extensions", None)


def _emit_glb(gltf_dict, bin_chunk):
    payload = json.dumps(gltf_dict, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((-len(payload)) % 4)
    chunks = struct.pack("<II", len(payload), CHUNK_JSON) + payload
    if bin_chunk:
        bin_chunk = bin_chunk + b"\x00" * ((-len(bin_chunk)) % 4)
        chunks += struct.pack("<II", len(bin_chunk), CHUNK_BIN) + bin_chunk
    return struct.pack("<III", GLB_MAGIC, 2, 12 + len(chunks)) + chunks


# ---------------------------------------------------------------------------
# Appearance fallback: the SolidWorks GLB exporter sometimes drops all
# appearances (every part comes out one default gray) even while the same
# session displays and JPG-captures them correctly. When the repacked GLB
# shows that signature, recolor per part from appearance data read over COM
# during traversal. Per-part color only — face-level detail and textures
# cannot be recovered this way.
# ---------------------------------------------------------------------------

_PS_SAMPLE = r"""
Add-Type -AssemblyName System.Drawing
$jobs = Get-Content -Raw -Path $args[0] | ConvertFrom-Json
$result = @{}
foreach ($j in $jobs) {
  try {
    $bmp = New-Object System.Drawing.Bitmap($j.src)
    $w = $bmp.Width; $h = $bmp.Height
    $sx = [Math]::Max(1, [int]($w / 64)); $sy = [Math]::Max(1, [int]($h / 48))
    $inner = New-Object System.Collections.ArrayList
    $bg = New-Object System.Collections.ArrayList
    for ($y = 2; $y -lt $h - 2; $y += $sy) {
      $l = $bmp.GetPixel(2, $y); $r = $bmp.GetPixel($w - 3, $y)
      [void]$bg.Add(@($y, [int]$l.R, [int]$l.G, [int]$l.B, [int]$r.R, [int]$r.G, [int]$r.B))
      for ($x = 2; $x -lt $w - 2; $x += $sx) {
        $c = $bmp.GetPixel($x, $y)
        [void]$inner.Add(@($y, [int]$c.R, [int]$c.G, [int]$c.B))
      }
    }
    $result[$j.name] = @{ inner = $inner; bg = $bg }
    $bmp.Dispose()
  } catch { Write-Error "sample failed: $($j.src): $_" }
}
$result | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $args[1] -Encoding utf8
"""


def _dominant_color(inner, bg_rows):
    """Dominant non-background color from row-sampled pixels.

    The capture viewport background is a vertical gradient, so each sampled
    pixel is compared against the edge colors of its own row — parts survive
    even when their gray is close to some other part of the gradient.
    """
    bg_by_y = {row[0]: ((row[1], row[2], row[3]), (row[4], row[5], row[6]))
               for row in bg_rows}
    ys = sorted(bg_by_y)

    def bg_for(y):
        nearest = min(ys, key=lambda v: abs(v - y))
        return bg_by_y[nearest]

    def dist2(a, b):
        return sum((a[i] - b[i]) ** 2 for i in range(3))

    part_px = []
    for y, r, g, b in inner:
        px = (r, g, b)
        if any(dist2(px, edge) < 40 ** 2 for edge in bg_for(y)):
            continue
        part_px.append(px)
    if len(part_px) < 40:
        return None

    buckets = {}
    for px in part_px:
        buckets.setdefault((px[0] // 24, px[1] // 24, px[2] // 24), []).append(px)
    dominant = max(buckets.values(), key=len)
    n = len(dominant)
    return (sum(p[0] for p in dominant) / n / 255.0,
            sum(p[1] for p in dominant) / n / 255.0,
            sum(p[2] for p in dominant) / n / 255.0,
            1.0, 1.0, 0.3, 0.3, 0.0, 0.0)


def sample_part_colors(images_dir, part_names, timeout=120):
    """{part name: MaterialPropertyValues-shaped tuple} from capture images.

    Mechanism-agnostic color source: the JPGs show each part exactly as
    SolidWorks renders it, whatever appearance system produced the look.
    """
    jobs = []
    for name in part_names:
        src = _find_part_image(images_dir, name)
        if src:
            jobs.append({"name": name, "src": src})
    if not jobs:
        return {}

    with tempfile.TemporaryDirectory(prefix="picturebom_colors_") as tmp:
        jobs_path = os.path.join(tmp, "jobs.json")
        out_path = os.path.join(tmp, "out.json")
        script_path = os.path.join(tmp, "sample.ps1")
        with open(jobs_path, "w", encoding="utf-8") as f:
            json.dump(jobs, f)
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(_PS_SAMPLE)
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", script_path, jobs_path, out_path],
                capture_output=True, timeout=timeout, check=False)
            with open(out_path, encoding="utf-8-sig") as f:
                sampled = json.load(f)
        except (subprocess.SubprocessError, OSError, ValueError) as e:
            log.warning("Part color sampling failed: %s", e)
            return {}

    colors = {}
    for name, data in sampled.items():
        try:
            color = _dominant_color(data["inner"], data["bg"])
        except Exception:
            continue
        if color:
            colors[name] = color
    return colors


def _appearance_dropped(gltf):
    """True when every primitive shares one identical material — the
    exporter's no-appearances signature. A real assembly with legitimate
    appearances always carries at least a handful of distinct materials."""
    mats = gltf.get("materials", [])
    if not mats:
        return True
    return len({_content_key(m) for m in mats}) == 1


def inject_component_colors(glb_bytes, parts, component_colors, sample_fallback=None):
    """Recolor a single-material GLB per part from COM appearance tuples.

    parts: repack result parts list (id == mesh index in the repacked GLB).
    component_colors: {BOM part name: 9-double MaterialPropertyValues} —
    exact assembly-context overrides read over COM.
    sample_fallback: optional callable(part_names) -> same-shaped dict, used
    for parts without an override (capture-image sampling). Only invoked when
    the GLB actually shows the dropped-appearances signature.
    Returns (new_glb_bytes, recolored_part_count); (glb_bytes, 0) when the
    GLB has real materials or no colors are available.
    """
    glb = parse_glb(glb_bytes)
    g = glb.gltf
    if not _appearance_dropped(g):
        return glb_bytes, 0

    component_colors = dict(component_colors or {})
    if sample_fallback is not None:
        missing = [p.get("bom_name") or p.get("name") or "" for p in parts
                   if not ((p.get("bom_name") and p["bom_name"] in component_colors)
                           or (p.get("name") and p["name"] in component_colors))]
        missing = [n for n in missing if n]
        if missing:
            for name, vals in (sample_fallback(missing) or {}).items():
                component_colors.setdefault(name, vals)
    if not component_colors:
        return glb_bytes, 0

    def material_for(vals):
        r, gr, b = vals[0], vals[1], vals[2]
        shininess = vals[6] if len(vals) > 6 else 0.3
        transparency = vals[7] if len(vals) > 7 else 0.0
        mat = {"pbrMetallicRoughness": {
            "baseColorFactor": [round(r, 5), round(gr, 5), round(b, 5),
                                round(1.0 - min(max(transparency, 0.0), 0.95), 5)],
            "metallicFactor": 0,
            "roughnessFactor": round(min(max(1.0 - 0.8 * shininess, 0.05), 1.0), 5),
        }}
        if transparency > 0.01:
            mat["alphaMode"] = "BLEND"
        return mat

    by_part_id = {}
    for part in parts:
        vals = (component_colors.get(part.get("bom_name") or "")
                or component_colors.get(part.get("name") or ""))
        if vals:
            by_part_id[part["id"]] = vals

    if not by_part_id:
        return glb_bytes, 0

    mat_cache = {}
    recolored = set()
    for part_id, vals in by_part_id.items():
        if part_id >= len(g.get("meshes", [])):
            continue
        key = tuple(round(v, 5) for v in vals)
        if key not in mat_cache:
            g.setdefault("materials", []).append(material_for(vals))
            mat_cache[key] = len(g["materials"]) - 1
        for prim in g["meshes"][part_id].get("primitives", []):
            prim["material"] = mat_cache[key]
        recolored.add(part_id)

    return _emit_glb(g, glb.bin), len(recolored)


# ---------------------------------------------------------------------------
# BOM matching (linking only — a wrong match highlights the wrong row,
# it can never corrupt geometry)
# ---------------------------------------------------------------------------

def match_parts_to_bom(parts, empty_node_names, bom_names, group_node_names=()):
    """Link repacked parts to BOM row names.

    parts: repack result 'parts' list (mutated: gains bom_name/matched).
    empty_node_names: names of meshless leaf nodes (hidden components).
    bom_names: iterable of BOM part names (file basenames from traversal).
    group_node_names: names of subassembly grouping nodes (have 3D geometry
    through their children — their rows count as matched).

    Returns a reconciliation dict for the payload plus warning strings.
    """
    by_fold = {}
    by_sanitized = {}
    for name in bom_names:
        by_fold.setdefault(name.casefold(), name)
        by_sanitized.setdefault(sanitize_filename(name).casefold(), name)

    warnings = []
    matched_bom = set()
    unmatched_parts = []

    for part in parts:
        raw = sorted(part["raw_names"])[0] if part["raw_names"] else part["name"]
        stripped = clean_node_name(raw)
        t_unstripped = by_fold.get(raw.casefold())
        t_stripped = by_fold.get(stripped.casefold())
        chosen = None
        if t_unstripped and t_stripped and t_unstripped != t_stripped:
            chosen = t_unstripped  # a part literally named like an instance suffix
            warnings.append(
                f"Part name {raw!r} matches both {t_unstripped!r} and {t_stripped!r}; "
                f"using exact name {t_unstripped!r}")
        else:
            chosen = t_stripped or t_unstripped
        if chosen is None:
            chosen = by_sanitized.get(sanitize_filename(stripped).casefold())
        part["bom_name"] = chosen
        part["matched"] = chosen is not None
        if chosen:
            matched_bom.add(chosen)
        else:
            unmatched_parts.append({"part_id": part["id"], "raw_name": stripped,
                                    "instances": part["instances"]})

    empty_folds = {clean_node_name(n).casefold() for n in empty_node_names}
    group_folds = {clean_node_name(n).casefold() for n in group_node_names}
    hidden_rows, unmatched_rows = [], []
    for name in bom_names:
        if name in matched_bom or name.casefold() in group_folds:
            continue
        if name.casefold() in empty_folds:
            hidden_rows.append(name)
        else:
            unmatched_rows.append(name)

    if unmatched_parts:
        warnings.append(
            f"{len(unmatched_parts)} 3D part(s) could not be linked to a BOM row "
            f"(first: {unmatched_parts[0]['raw_name']!r})")
    if hidden_rows:
        warnings.append(
            f"{len(hidden_rows)} BOM row(s) are hidden in the model and have no 3D geometry: "
            + ", ".join(hidden_rows[:5]) + ("…" if len(hidden_rows) > 5 else ""))
    if unmatched_rows:
        warnings.append(
            f"{len(unmatched_rows)} BOM row(s) have no matching 3D node: "
            + ", ".join(unmatched_rows[:5]) + ("…" if len(unmatched_rows) > 5 else ""))

    return {
        "unmatched_nodes": unmatched_parts,
        "hidden_rows": hidden_rows,
        "unmatched_rows": unmatched_rows,
    }, warnings


# ---------------------------------------------------------------------------
# Thumbnails (PowerShell System.Drawing — no new Python dependency)
# ---------------------------------------------------------------------------

_PS_RESIZE = r"""
Add-Type -AssemblyName System.Drawing
$jobs = Get-Content -Raw -Path $args[0] | ConvertFrom-Json
foreach ($j in $jobs) {
  try {
    $img = [System.Drawing.Image]::FromFile($j.src)
    $scale = [Math]::Min(1.0, $j.max / [Math]::Max($img.Width, $img.Height))
    $w = [Math]::Max(1, [int]($img.Width * $scale))
    $h = [Math]::Max(1, [int]($img.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.DrawImage($img, 0, 0, $w, $h)
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
             Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, [long]$j.quality)
    $bmp.Save($j.dst, $codec, $params)
    $gfx.Dispose(); $bmp.Dispose(); $img.Dispose()
  } catch {
    Write-Error "thumb failed: $($j.src): $_"
  }
}
"""


def make_thumbnails(images_dir, part_names, max_px=THUMBNAIL_MAX_PX,
                    quality=THUMBNAIL_JPEG_QUALITY, timeout=120):
    """Batch-recompress captured part JPGs into small data URIs.

    Returns {part_name: data URI}. Missing images are skipped; a total failure
    returns {} (callers degrade to a no-thumbnail HTML with a warning).
    """
    jobs, sources = [], {}
    with tempfile.TemporaryDirectory(prefix="picturebom_thumbs_") as tmp:
        for i, name in enumerate(part_names):
            src = _find_part_image(images_dir, name)
            if not src:
                continue
            dst = os.path.join(tmp, f"{i}.jpg")
            jobs.append({"src": src, "dst": dst, "max": max_px, "quality": quality})
            sources[name] = dst
        if not jobs:
            return {}

        jobs_path = os.path.join(tmp, "jobs.json")
        script_path = os.path.join(tmp, "resize.ps1")
        with open(jobs_path, "w", encoding="utf-8") as f:
            json.dump(jobs, f)
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(_PS_RESIZE)
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", script_path, jobs_path],
                capture_output=True, timeout=timeout, check=False)
        except (subprocess.SubprocessError, OSError) as e:
            log.warning("Thumbnail resize subprocess failed: %s", e)
            return {}

        thumbs = {}
        for name, dst in sources.items():
            try:
                with open(dst, "rb") as f:
                    thumbs[name] = ("data:image/jpeg;base64,"
                                    + base64.b64encode(f.read()).decode("ascii"))
            except OSError:
                continue
        return thumbs


def _find_part_image(images_dir, name):
    base = sanitize_filename(name)
    for ext in (".jpg", ".jpeg", ".bmp", ".png"):
        candidate = os.path.join(images_dir, base + ext)
        if os.path.isfile(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Payload / HTML assembly
# ---------------------------------------------------------------------------

def _gzip_b64(data):
    return base64.b64encode(gzip.compress(data, 9, mtime=0)).decode("ascii")


def _rows_with_vendor_urls(rows):
    out = []
    for row in rows:
        row = dict(row)
        row.pop("file_path", None)  # never leak local paths into the shared HTML
        row.pop("doc_type", None)
        row["vendor_url"] = _vendor_url(row.get("vendor", ""), row.get("vendor_part_no", ""))
        out.append(row)
    return out


def build_payload(assembly, repack_result, reconciliation, warnings, bom, thumbs,
                  geometry, generated, app_version):
    parts = []
    for part in repack_result["parts"]:
        parts.append({
            "id": part["id"],
            "name": part["name"],
            "bom_name": part.get("bom_name"),
            "matched": part.get("matched", False),
            "instances": part["instances"],
            "mirrored": part["mirrored"],
            "thumbnail": thumbs.get(part.get("bom_name") or part["name"]),
        })
    return {
        "schema": PAYLOAD_SCHEMA,
        "generated": generated,
        "app_version": app_version,
        "assembly": assembly,
        "geometry": geometry,
        "parts": parts,
        "node_map": {str(k): v for k, v in repack_result["node_map"].items()},
        "mirrored_nodes": repack_result["mirrored_nodes"],
        "bom": bom,
        "reconciliation": reconciliation,
        "warnings": warnings,
    }


def build_html(template_text, payload, glb_bytes, mode, viewer_exports=True):
    """Substitute the four sentinels. base64 content is injection-safe.

    The config block stays plain JSON on purpose: the file owner can open the
    exported HTML in a text editor and flip "allow_exports" after the fact.
    """
    meta_b64 = _gzip_b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    glb_b64 = _gzip_b64(glb_bytes) if mode == "embedded" else ""
    config = json.dumps({"allow_exports": bool(viewer_exports)})
    for sentinel in (SENTINEL_META, SENTINEL_GLB, SENTINEL_MODE, SENTINEL_CONFIG):
        if sentinel not in template_text:
            raise PictureBOMError(f"Viewer template is missing the {sentinel} slot")
    html = (template_text
            .replace(SENTINEL_MODE, mode)
            .replace(SENTINEL_CONFIG, config)
            .replace(SENTINEL_META, meta_b64)
            .replace(SENTINEL_GLB, glb_b64))
    return html


def load_viewer_template():
    ref = resources.files("picturebom").joinpath("assets/bomdom/viewer_template.html")
    try:
        return ref.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError) as e:
        raise PictureBOMError(
            "BomDom viewer template not found (assets/bomdom/viewer_template.html). "
            "This install is missing the viewer build artifact.") from e


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def export_bomdom_html(glb_path, output_dir, base_name, timestamp, *,
                       hierarchical_rows, flat_parts, bom_names, bom_mode,
                       images_dir, assembly_file, active_config="",
                       app_version="", generated="", on_status=None,
                       size_limit_mb=25, template_text=None, viewer_exports=True,
                       component_colors=None):
    """Post-process a raw SolidWorks GLB into a BomDom HTML (plus sidecar if huge).

    Never raises past this function for repack-stage problems: falls back to
    embedding the unmodified single-scene GLB, and ultimately returns
    {'html_path': None, ...} so the caller's Excel output is never blocked.
    Hard input problems (unreadable/invalid raw GLB) raise PictureBOMError.
    """
    def status(msg):
        if on_status:
            on_status(msg)
        log.info(msg)

    glb = parse_glb(glb_path)
    warnings = validate_glb(glb)

    scene_index = select_scene(glb.gltf, active_config)
    scene_info = index_scene(glb, scene_index)

    try:
        status("Optimizing 3D model"
               f" ({len(scene_info['mesh_nodes'])} instances)...")
        glb_bytes, repack = repack_glb(glb, scene_info, app_version)
        stats = repack["stats"]
        status(f"3D geometry: {stats['mesh_instances']} instances -> "
               f"{stats['unique_parts']} unique parts, "
               f"{stats['bytes_out'] / 1e6:.1f} MB")
    except PictureBOMError:
        raise
    except Exception:
        log.exception("BomDom repack failed; falling back to unmodified GLB")
        warnings.append("3D optimization failed; embedding the unoptimized model")
        with open(glb_path, "rb") as f:
            glb_bytes = f.read()
        repack = {"node_map": {}, "parts": [], "mirrored_nodes": [],
                  "empty_node_names": [], "group_node_names": [],
                  "stats": {"mesh_instances": 0,
                            "unique_parts": 0,
                            "bytes_out": len(glb_bytes)}}

    reconciliation, match_warnings = match_parts_to_bom(
        repack["parts"], repack["empty_node_names"], list(bom_names),
        repack["group_node_names"])
    warnings.extend(match_warnings)

    # Appearance fallback: recolor per part from COM-read appearances when the
    # exporter dropped them (matching must run first — it links parts to the
    # BOM names the color map is keyed by).
    if repack["parts"]:
        sampler = ((lambda names: sample_part_colors(images_dir, names))
                   if images_dir else None)
        glb_bytes, recolored = inject_component_colors(
            glb_bytes, repack["parts"], component_colors or {}, sampler)
        if recolored:
            msg = (f"SolidWorks exported no appearances (all parts default gray); "
                   f"recovered per-part colors from the model for {recolored} part(s). "
                   f"Face-level colors and textures are not available in this mode.")
            warnings.append(msg)
            status(msg)

    thumbs = {}
    if images_dir and repack["parts"]:
        status("Preparing thumbnails...")
        wanted = {p.get("bom_name") or p["name"] for p in repack["parts"]}
        thumbs = make_thumbnails(images_dir, sorted(wanted))
        if not thumbs:
            warnings.append("Thumbnails could not be generated; the 3D BOM panel "
                            "will show part names only")

    template = template_text if template_text is not None else load_viewer_template()

    html_name = f"{base_name}_{timestamp}.html"
    html_path = os.path.join(output_dir, html_name)
    sidecar_name = f"{base_name}_{timestamp}.glb"

    geometry = {
        "mode": "embedded",
        "encoding": "glb+gzip+base64",
        "sidecar_filename": None,
        "draco": glb.draco,
        "glb_bytes": len(glb_bytes),
    }
    assembly = {"name": base_name, "file": assembly_file, "config": active_config,
                "scene_name": scene_info["scene_name"]}
    bom = {"mode": bom_mode,
           "hierarchical_rows": _rows_with_vendor_urls(hierarchical_rows),
           "flat_parts": _rows_with_vendor_urls(flat_parts)}

    payload = build_payload(assembly, repack, reconciliation, warnings, bom,
                            thumbs, geometry, generated, app_version)

    html = build_html(template, payload, glb_bytes, "embedded", viewer_exports)
    projected_mb = len(html) / 1e6
    mode = "embedded"
    sidecar_path = None

    if projected_mb > size_limit_mb:
        status(f"Projected HTML {projected_mb:.1f} MB exceeds {size_limit_mb} MB — "
               "writing HTML + separate 3D data file")
        mode = "sidecar"
        geometry["mode"] = "sidecar"
        geometry["sidecar_filename"] = sidecar_name
        payload = build_payload(assembly, repack, reconciliation, warnings, bom,
                                thumbs, geometry, generated, app_version)
        html = build_html(template, payload, b"", "sidecar", viewer_exports)
        sidecar_path = os.path.join(output_dir, sidecar_name)
        with open(sidecar_path, "wb") as f:
            f.write(glb_bytes)

    status(f"Writing interactive 3D BOM ({len(html) / 1e6:.1f} MB)...")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)

    return {
        "html_path": html_path,
        "html_mode": mode,
        "sidecar_path": sidecar_path,
        "html_projected_mb": round(projected_mb, 2),
        "warnings": warnings,
        "reconciliation": reconciliation,
        "stats": repack["stats"],
    }
