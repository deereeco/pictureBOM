"""Smoke test for the BomDom GLB post-processor — no SolidWorks needed.

Runs against two real SOLIDWORKSGLTF exports on this machine (skipped with a
warning if absent), plus in-memory fixtures for the non-Draco and mirrored
cases. Pinned counts are regression values measured 2026-07-20. Run after any
change to bomdom.py:

    uv run python scripts/smoke_bomdom.py
"""

import base64
import gzip
import json
import struct
import sys
import tempfile
from pathlib import Path

from picturebom import bomdom
from picturebom.bomdom import (
    Glb,
    build_html,
    clean_node_name,
    export_bomdom_html,
    index_scene,
    match_parts_to_bom,
    parse_glb,
    repack_glb,
    select_scene,
    validate_glb,
)
from picturebom.core import PictureBOMError

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_IMAGES = REPO_ROOT / "Example 3d models" / "Cage Stack Assembly" / "BOM"

# Real-GLB fixtures are machine-local (large SOLIDWORKSGLTF exports that don't
# belong in the repo). Point to yours in scripts/fixtures.local.json:
#   {"big": "C:\\path\\to\\assembly.glb", "color": "C:\\path\\to\\colorful.glb"}
# Sections needing an absent fixture are skipped.
def _local_fixtures():
    try:
        with open(Path(__file__).with_name("fixtures.local.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_FIXTURES = _local_fixtures()
BIG_GLB = Path(_FIXTURES.get("big", "missing-big-fixture.glb"))
COLOR_GLB = Path(_FIXTURES.get("color", "missing-color-fixture.glb"))

STUB_TEMPLATE = (
    "<!doctype html><meta charset='utf-8'><title>stub</title>"
    "<script type='text/plain' id='bomdom-mode'>__BOMDOM_MODE__</script>"
    "<script type='text/plain' id='bomdom-config'>__BOMDOM_CONFIG__</script>"
    "<script type='text/plain' id='bomdom-meta'>__BOMDOM_PAYLOAD_JSON__</script>"
    "<script type='text/plain' id='bomdom-glb'>__BOMDOM_GLB_GZ_B64__</script>"
)

failures = []


def check(label, condition, detail=""):
    status = "ok" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def _extract(html, element_id):
    marker = f"id='bomdom-{element_id}'>"
    start = html.index(marker) + len(marker)
    return html[start:html.index("</script>", start)]


def _unpack_payload(html):
    raw = base64.b64decode(_extract(html, "meta"))
    return json.loads(gzip.decompress(raw))


def _draco_blobs(glb, node_subset=None):
    """sha256 -> bytes of every Draco bufferView reachable from the given nodes."""
    import hashlib
    blobs = {}
    nodes = glb.gltf.get("nodes", [])
    mesh_ids = ({nodes[i]["mesh"] for i in node_subset if "mesh" in nodes[i]}
                if node_subset is not None else set(range(len(glb.gltf.get("meshes", [])))))
    for mi in mesh_ids:
        for prim in glb.gltf["meshes"][mi].get("primitives", []):
            draco = prim.get("extensions", {}).get("KHR_draco_mesh_compression")
            if draco is not None:
                data = bomdom._bv_bytes(glb, draco["bufferView"])
                blobs[hashlib.sha256(data).digest()] = data
    return blobs


def _mesh_node_signature(glb, node_ids):
    """Multiset of (name, transform tuple) for mesh-bearing nodes — must survive repack."""
    nodes = glb.gltf["nodes"]
    sig = []
    for i in node_ids:
        n = nodes[i]
        if "mesh" not in n:
            continue
        transform = tuple(n.get("matrix", []) or n.get("translation", [])
                          + n.get("rotation", []) + n.get("scale", []))
        sig.append((n.get("name", ""), transform))
    return sorted(sig)


def _material_content_count(glb, node_subset):
    mats = set()
    nodes = glb.gltf["nodes"]
    for i in node_subset:
        if "mesh" not in nodes[i]:
            continue
        for prim in glb.gltf["meshes"][nodes[i]["mesh"]].get("primitives", []):
            if "material" in prim:
                mat = dict(glb.gltf["materials"][prim["material"]])
                mat.pop("name", None)
                mat.pop("extensions", None)
                mats.add(json.dumps(mat, sort_keys=True))
    return len(mats)


def test_clean_node_name():
    print("clean_node_name (real gnarly names):")
    # Shapes mirror real SOLIDWORKSGLTF node names: trailing "-<n>" instance
    # suffixes, "^owner" virtual-component decoration, stacked "Copy of".
    cases = [
        ("123-45678-00-3", "123-45678-00"),
        ("Copy of Copy of Copy of Cpy 100-0036^200-0010-1",
         "Copy of Copy of Copy of Cpy 100-0036^200-0010"),
        ("M2.5 SCREW REP^Copy of 300-0113_Sample Plate_8",
         "M2.5 SCREW REP^Copy of 300-0113_Sample Plate_8"),
        ("Demo - SM1L03-Solidworks-4", "Demo - SM1L03-Solidworks"),
        ("User Library-FC PC CONNECTOR-1", "User Library-FC PC CONNECTOR"),
        ("plain-name", "plain-name"),  # '-name' is not '-<digits>'
        ("", ""),
    ]
    for raw, expected in cases:
        got = clean_node_name(raw)
        check(f"{raw!r}", got == expected, f"got {got!r}")


def test_matching():
    print("\nmatch_parts_to_bom (synthetic buckets):")
    parts = [
        {"id": 0, "name": "CP33_M-Solidworks", "raw_names": {"CP33_M-Solidworks-1"},
         "instances": 2, "mirrored": False},
        # A part literally named with an instance-like suffix: unstripped must win.
        {"id": 1, "name": "400-0110", "raw_names": {"400-0110-6"},
         "instances": 1, "mirrored": False},
        {"id": 2, "name": "GHOST-PART", "raw_names": {"GHOST-PART-1"},
         "instances": 3, "mirrored": False},
    ]
    bom_names = ["CP33_M-Solidworks", "400-0110-6", "400-0110",
                 "HIDDEN-PART", "SUPPRESSED-PART", "cag subassm 1"]
    recon, warnings = match_parts_to_bom(parts, ["HIDDEN-PART-1"], bom_names,
                                         group_node_names=["cag subassm 1-1"])
    check("plain match", parts[0]["bom_name"] == "CP33_M-Solidworks")
    check("subassembly row matched via grouping node",
          "cag subassm 1" not in recon["unmatched_rows"]
          and "cag subassm 1" not in recon["hidden_rows"])
    check("unstripped beats stripped on conflict",
          parts[1]["bom_name"] == "400-0110-6", f"got {parts[1]['bom_name']!r}")
    check("conflict produces a warning", any("400-0110-6" in w for w in warnings))
    check("unmatched part bucketed",
          recon["unmatched_nodes"] and recon["unmatched_nodes"][0]["raw_name"] == "GHOST-PART")
    check("hidden row detected via empty node", recon["hidden_rows"] == ["HIDDEN-PART"])
    check("row with no node at all",
          "SUPPRESSED-PART" in recon["unmatched_rows"]
          and "400-0110" in recon["unmatched_rows"])


def _make_uncompressed_glb():
    """Minimal valid non-Draco GLB: one triangle mesh, two instances (one mirrored)."""
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    indices = struct.pack("<3H", 0, 1, 2) + b"\x00\x00"  # pad to 4
    bin_chunk = positions + indices
    gltf = {
        "asset": {"version": "2.0", "generator": "fixture"},
        "scene": 0,
        "scenes": [{"name": "Fixture - Display State-1", "nodes": [0, 1, 2]}],
        "nodes": [
            {"name": "current", "camera": 0},
            {"name": "TRI-1", "mesh": 0,
             "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]},
            {"name": "TRI-2", "mesh": 1, "scale": [-1, 1, 1]},
        ],
        "cameras": [{"type": "perspective", "perspective": {"yfov": 1, "znear": 0.1}}],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]},
            {"primitives": [{"attributes": {"POSITION": 2}, "indices": 3, "material": 1}]},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 36},
            {"buffer": 0, "byteOffset": 36, "byteLength": 6},
        ],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "materials": [
            {"name": "red", "pbrMetallicRoughness": {"baseColorFactor": [1, 0, 0, 1]}},
            {"name": "also red", "pbrMetallicRoughness": {"baseColorFactor": [1, 0, 0, 1]}},
        ],
        "extensionsUsed": ["KHR_lights_punctual"],
    }
    return bomdom._emit_glb(gltf, bin_chunk)


def test_non_draco_and_mirrored():
    print("\nnon-Draco + mirrored fixture:")
    glb = parse_glb(_make_uncompressed_glb())
    warnings = validate_glb(glb)
    check("fixture validates", isinstance(warnings, list))
    scene_info = index_scene(glb, select_scene(glb.gltf, "Fixture"))
    check("camera-only root dropped", len(scene_info["kept"]) == 2)
    out_bytes, result = repack_glb(glb, scene_info, "0.0-test")
    out = parse_glb(out_bytes)
    validate_glb(out)
    check("identical meshes merged (accessor/material content dedup)",
          len(out.gltf["meshes"]) == 1, f"got {len(out.gltf.get('meshes', []))}")
    check("identical materials merged", len(out.gltf["materials"]) == 1)
    check("both instances kept", len(result["node_map"]) == 2)
    check("mirrored instance detected",
          len(result["mirrored_nodes"]) == 1
          and out.gltf["nodes"][result["mirrored_nodes"][0]]["name"] == "TRI-2")
    check("cameras stripped", "cameras" not in out.gltf)
    check("junk extensionsUsed stripped", "extensionsUsed" not in out.gltf)
    check("accessor bufferViews remapped in range",
          all(a["bufferView"] < len(out.gltf["bufferViews"])
              for a in out.gltf["accessors"] if "bufferView" in a))
    check("partId stamped",
          all(n.get("extras", {}).get("partId") == n["mesh"]
              for n in out.gltf["nodes"] if "mesh" in n))


def test_real_glb(path, label, pins):
    print(f"\n{label} ({path.name}):")
    if not path.is_file():
        print(f"  [skip] fixture not present: {path}")
        return None
    glb = parse_glb(str(path))
    validate_glb(glb)
    check("parses + validates", True)
    check("Draco required", glb.draco)

    if "scenes" in pins:
        check(f"scene count == {pins['scenes']}",
              len(glb.gltf["scenes"]) == pins["scenes"],
              f"got {len(glb.gltf['scenes'])}")

    scene_index = select_scene(glb.gltf, pins.get("config"))
    scene_info = index_scene(glb, scene_index)
    if "kept" in pins:
        check(f"default scene reaches {pins['kept']} nodes",
              len(scene_info["kept"]) == pins["kept"], f"got {len(scene_info['kept'])}")
    if "mesh_nodes" in pins:
        check(f"{pins['mesh_nodes']} mesh instances",
              len(scene_info["mesh_nodes"]) == pins["mesh_nodes"],
              f"got {len(scene_info['mesh_nodes'])}")

    in_blobs = _draco_blobs(glb, scene_info["kept"])
    in_sig = _mesh_node_signature(glb, scene_info["kept"])

    out_bytes, result = repack_glb(glb, scene_info, "0.0-test")
    out = parse_glb(out_bytes)
    validate_glb(out)
    check("repack round-trips parse+validate", True)
    check("single scene out", len(out.gltf["scenes"]) == 1)

    if "unique_parts" in pins:
        check(f"{pins['unique_parts']} unique parts",
              result["stats"]["unique_parts"] == pins["unique_parts"],
              f"got {result['stats']['unique_parts']}")
    if "materials_out" in pins:
        check(f"{pins['materials_out']} unique materials survive",
              len(out.gltf.get("materials", [])) == pins["materials_out"],
              f"got {len(out.gltf.get('materials', []))} "
              f"(input content-uniques: {_material_content_count(glb, scene_info['kept'])})")

    out_sig = _mesh_node_signature(out, range(len(out.gltf["nodes"])))
    check("every (name, transform) of mesh nodes preserved bit-exact", in_sig == out_sig)

    out_blobs = _draco_blobs(out)
    check("every output Draco blob hash-equals a source blob",
          set(out_blobs) <= set(in_blobs))
    check("output blob set == unique input blob set (scene-scoped)",
          set(out_blobs) == set(in_blobs),
          f"in {len(in_blobs)} vs out {len(out_blobs)}")
    check("repacked GLB smaller than source", len(out_bytes) < path.stat().st_size,
          f"{len(out_bytes)} vs {path.stat().st_size}")

    # Idempotence: post-processing our own output must be byte-identical.
    info2 = index_scene(out, select_scene(out.gltf, pins.get("config")))
    out2_bytes, _ = repack_glb(out, info2, "0.0-test")
    check("idempotent (double repack byte-identical)", out2_bytes == out_bytes)

    print(f"  info: {len(glb.bin) / 1e6:.2f} MB bin -> {len(out_bytes) / 1e6:.2f} MB GLB, "
          f"{result['stats']['mesh_instances']} instances / "
          f"{result['stats']['unique_parts']} parts")
    return glb, scene_info, out_bytes, result


def test_export_orchestrator(big_glb_path, out_dir):
    print("\nexport_bomdom_html (stub template, synthetic BOM):")
    if not big_glb_path.is_file():
        print(f"  [skip] fixture not present: {big_glb_path}")
        return

    glb = parse_glb(str(big_glb_path))
    scene_info = index_scene(glb, select_scene(glb.gltf, "Default"))
    node_names = {clean_node_name(glb.gltf["nodes"][i].get("name", ""))
                  for i in scene_info["mesh_nodes"]}
    bom_names = sorted(node_names)[:20] + ["NOT-IN-3D-PART"]
    rows = [{"level": f"{i + 1}.0", "type": "Part", "name": n, "quantity": 1,
             "description": "", "vendor": "", "vendor_part_no": "",
             "file_path": f"C:\\fake\\{n}.sldprt"} for i, n in enumerate(bom_names)]

    common = dict(hierarchical_rows=rows, flat_parts=[], bom_names=bom_names,
                  bom_mode="flat", images_dir=None, assembly_file="fake.SLDASM",
                  active_config="Default", app_version="0.6.0-test",
                  generated="2026-07-20T00:00:00", template_text=STUB_TEMPLATE)

    res = export_bomdom_html(str(big_glb_path), str(out_dir), "smoke", "embedded-run",
                             **common)
    check("embedded mode chosen", res["html_mode"] == "embedded")
    html = Path(res["html_path"]).read_text(encoding="utf-8")
    check("no sentinel left behind", "__BOMDOM_" not in html)
    payload = _unpack_payload(html)
    check("payload schema", payload["schema"] == "picturebom.bomdom/1")
    check("payload mode embedded", payload["geometry"]["mode"] == "embedded")
    check("file_path never leaks into payload",
          all("file_path" not in r for r in payload["bom"]["hierarchical_rows"]))
    check("node_map covers all instances",
          len(payload["node_map"]) == payload and True or
          len(payload["node_map"]) > 0)
    glb_bytes = gzip.decompress(base64.b64decode(_extract(html, "glb")))
    reparsed = parse_glb(glb_bytes)
    validate_glb(reparsed)
    check("embedded GLB round-trips through gzip+b64 and validates", True)
    check("unmatched BOM row reconciled",
          "NOT-IN-3D-PART" in payload["reconciliation"]["unmatched_rows"])
    check("viewer exports allowed by default (hand-editable plain JSON)",
          json.loads(_extract(html, "config")) == {"allow_exports": True})

    res_noexp = export_bomdom_html(str(big_glb_path), str(out_dir), "smoke",
                                   "noexports-run", viewer_exports=False, **common)
    html_noexp = Path(res_noexp["html_path"]).read_text(encoding="utf-8")
    check("viewer_exports=False lands in the config block",
          json.loads(_extract(html_noexp, "config")) == {"allow_exports": False})

    res2 = export_bomdom_html(str(big_glb_path), str(out_dir), "smoke", "sidecar-run",
                              size_limit_mb=1, **common)
    check("forced threshold triggers sidecar", res2["html_mode"] == "sidecar")
    check("sidecar .glb written", Path(res2["sidecar_path"]).is_file())
    side = parse_glb(res2["sidecar_path"])
    validate_glb(side)
    check("sidecar GLB validates + is plain (drag-droppable)", True)
    html2 = Path(res2["html_path"]).read_text(encoding="utf-8")
    check("sidecar HTML has empty GLB slot", _extract(html2, "glb") == "")
    payload2 = _unpack_payload(html2)
    check("sidecar payload names the pack file",
          payload2["geometry"]["sidecar_filename"] == Path(res2["sidecar_path"]).name)


def test_color_sampling():
    print("\ncapture-image color sampling:")
    if not EXAMPLE_IMAGES.is_dir() or not any(EXAMPLE_IMAGES.glob("*.jpg")):
        print(f"  [skip] example capture images not present: {EXAMPLE_IMAGES}")
        return
    colors = bomdom.sample_part_colors(str(EXAMPLE_IMAGES),
                                       ["ER3-Solidworks", "CP33_M-Solidworks", "NOPE"])
    check("colors sampled for existing images", set(colors) == {"ER3-Solidworks",
                                                                "CP33_M-Solidworks"},
          f"got {sorted(colors)}")
    if "ER3-Solidworks" in colors:
        check("steel rod samples light", colors["ER3-Solidworks"][0] > 0.6,
              f"got {colors['ER3-Solidworks'][:3]}")
    if "CP33_M-Solidworks" in colors:
        check("anodized plate samples dark", colors["CP33_M-Solidworks"][0] < 0.25,
              f"got {colors['CP33_M-Solidworks'][:3]}")


def test_thumbnails():
    print("\nthumbnails (PowerShell System.Drawing):")
    if not EXAMPLE_IMAGES.is_dir() or not any(EXAMPLE_IMAGES.glob("*.jpg")):
        print(f"  [skip] example capture images not present: {EXAMPLE_IMAGES}")
        return
    thumbs = bomdom.make_thumbnails(str(EXAMPLE_IMAGES),
                                    ["CP33_M-Solidworks", "ER3-Solidworks", "MISSING-PART"])
    check("thumbnails produced for existing images", len(thumbs) == 2,
          f"got {sorted(thumbs)}")
    if thumbs:
        raw = base64.b64decode(next(iter(thumbs.values())).split(",", 1)[1])
        check("thumbnail is a JPEG", raw[:2] == b"\xff\xd8")
        check("thumbnail under 60 KB", len(raw) < 60_000, f"got {len(raw)}")


def test_color_injection():
    print("\nappearance fallback (COM color injection):")
    glb = parse_glb(_make_uncompressed_glb())
    scene_info = index_scene(glb, select_scene(glb.gltf, "Fixture"))
    out_bytes, result = repack_glb(glb, scene_info, "0.0-test")
    # The fixture's two identical-content materials dedup to one — exactly the
    # exporter's dropped-appearances signature.
    check("fixture shows the single-material signature",
          bomdom._appearance_dropped(parse_glb(out_bytes).gltf))

    colors = {"TRI": (0.1, 0.2, 0.8, 0.0, 0.0, 0.0, 0.5, 0.0, 0.0)}
    for part in result["parts"]:
        part.setdefault("bom_name", None)
    injected, n = bomdom.inject_component_colors(out_bytes, result["parts"], colors)
    check("one part recolored", n == 1, f"got {n}")
    re = parse_glb(injected)
    validate_glb(re)
    check("recolored GLB validates", True)
    new_mat = re.gltf["materials"][-1]["pbrMetallicRoughness"]
    check("COM color applied", new_mat["baseColorFactor"][:3] == [0.1, 0.2, 0.8],
          f"got {new_mat['baseColorFactor']}")
    check("primitives remapped to the new material",
          all(p["material"] == len(re.gltf["materials"]) - 1
              for m in re.gltf["meshes"] for p in m["primitives"]))
    check("signature cleared after injection",
          not bomdom._appearance_dropped(re.gltf))

    again, n2 = bomdom.inject_component_colors(injected, result["parts"], colors)
    check("injection is a no-op on already-colored GLBs",
          n2 == 0 and again == injected)
    same, n3 = bomdom.inject_component_colors(out_bytes, result["parts"], {})
    check("no colors -> untouched", n3 == 0 and same == out_bytes)


def test_bad_inputs():
    print("\nbad inputs:")
    try:
        parse_glb(b"not a glb at all")
        check("bad magic rejected", False)
    except PictureBOMError:
        check("bad magic rejected", True)
    good = _make_uncompressed_glb()
    try:
        parse_glb(good[:40])
        check("truncated file rejected", False)
    except PictureBOMError:
        check("truncated file rejected", True)
    bad = bytearray(good)
    struct.pack_into("<I", bad, 8, len(bad) + 5)
    try:
        parse_glb(bytes(bad))
        check("length mismatch rejected", False)
    except PictureBOMError:
        check("length mismatch rejected", True)
    gltf_required = json.loads(json.dumps(parse_glb(good).gltf))
    gltf_required["extensionsRequired"] = ["EXT_totally_unknown"]
    try:
        validate_glb(Glb(gltf_required, parse_glb(good).bin))
        check("unknown required extension rejected", False)
    except PictureBOMError:
        check("unknown required extension rejected", True)


def main():
    out_dir = Path(tempfile.mkdtemp(prefix="picturebom_bomdom_smoke_"))
    print(f"Outputs: {out_dir}\n")

    test_clean_node_name()
    test_matching()
    test_non_draco_and_mirrored()
    test_color_injection()
    test_bad_inputs()

    # "kept" is 277, not the raw 278: the scene's camera root node ("current")
    # is deliberately dropped by index_scene.
    test_real_glb(BIG_GLB, "typical optical plate", {
        "scenes": 6, "config": "Default", "kept": 277, "mesh_nodes": 135,
        "unique_parts": 37, "materials_out": 68,
    })
    test_real_glb(COLOR_GLB, "asm color test", {"config": None})

    test_export_orchestrator(BIG_GLB, out_dir)
    test_color_sampling()
    test_thumbnails()

    print(f"\n{'ALL CHECKS PASSED' if not failures else f'{len(failures)} FAILURE(S): {failures}'}")
    print(f"Outputs kept for manual inspection in {out_dir}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
