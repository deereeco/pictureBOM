"""Build real BomDom preview HTMLs from the two local SOLIDWORKSGLTF exports.

This is the main verification harness for the viewer template: it synthesizes
a plausible BOM from each GLB's own scene-0 node names, runs the REAL
picturebom.bomdom.export_bomdom_html twice per file (embedded + forced
sidecar), then statically sanity-checks the produced HTML the same way
scripts/smoke_bomdom.py does (sentinels gone, payload extractable, GLB magic).

    uv run python scripts/preview_bomdom.py

Open the results in Chrome/Edge from web/preview_out/ for the manual checks.
"""

import base64
import gzip
import json
import sys
from collections import Counter
from pathlib import Path

from picturebom.bomdom import (
    clean_node_name,
    export_bomdom_html,
    index_scene,
    parse_glb,
    select_scene,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "web" / "preview_out"


def _local_fixtures():
    """Machine-local GLB fixtures — see the note in scripts/smoke_bomdom.py."""
    try:
        with open(Path(__file__).with_name("fixtures.local.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


GLBS = [Path(p) for p in _local_fixtures().values()]

failures = []


def check(label, condition, detail=""):
    status = "ok" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def _extract(html, element_id):
    # Mirrors scripts/smoke_bomdom.py: single-quoted id attribute contract.
    marker = f"id='bomdom-{element_id}'>"
    start = html.index(marker) + len(marker)
    return html[start:html.index("</script>", start)]


def _unpack_payload(html):
    return json.loads(gzip.decompress(base64.b64decode(_extract(html, "meta"))))


def synthesize_bom(glb_path):
    """Fake BOM rows derived from the GLB's own default-scene node names."""
    glb = parse_glb(str(glb_path))
    scene_info = index_scene(glb, select_scene(glb.gltf, None))
    nodes = glb.gltf.get("nodes", [])
    counts = Counter(
        clean_node_name(nodes[i].get("name", "")) for i in scene_info["mesh_nodes"])
    counts.pop("", None)

    # Deliberately unmistakable sample data: a dev preview has no access to the
    # real SolidWorks properties, and realistic-looking fakes (real vendor
    # names, borrowed thumbnails) read as pipeline bugs to reviewers.
    rows, flat = [], []
    for i, (name, qty) in enumerate(sorted(counts.items())):
        vendor = "Sample Vendor" if i < 6 else ""
        part_no = f"SAMPLE-{1000 + i}" if vendor else ""
        rows.append({
            "level": f"{i + 1}.0", "type": "Part", "name": name, "quantity": qty,
            "description": "Sample data (preview build — not from SolidWorks)",
            "vendor": vendor, "vendor_part_no": part_no,
        })
        flat.append({
            "name": name, "total_quantity": qty,
            "description": "Sample data (preview build — not from SolidWorks)",
            "vendor": vendor, "vendor_part_no": part_no, "where_used": glb_path.stem,
        })
    return rows, flat, [r["name"] for r in rows]


def stage_preview_images(bom_names, dest):
    """No thumbnails in dev previews: borrowed images under wrong part names
    caused more confusion than coverage. The real thumbnail path is exercised
    by actual pictureBOM exports (and smoke_bomdom.py)."""
    return None


def run_one(glb_path):
    print(f"\n{glb_path.name}:")
    if not glb_path.is_file():
        print(f"  [skip] fixture not present: {glb_path}")
        return

    rows, flat, bom_names = synthesize_bom(glb_path)
    images_dir = stage_preview_images(bom_names, OUT_DIR / "_preview_images" / glb_path.stem)
    common = dict(
        hierarchical_rows=rows, flat_parts=flat, bom_names=bom_names,
        bom_mode="flat", images_dir=images_dir,
        assembly_file=glb_path.with_suffix(".SLDASM").name,
        active_config="Default", app_version="0.6.0-preview",
        generated="2026-07-20T00:00:00",
        on_status=lambda m: print(f"    {m}"),
    )
    base = glb_path.stem

    res_emb = export_bomdom_html(str(glb_path), str(OUT_DIR), base, "embedded", **common)
    res_side = export_bomdom_html(str(glb_path), str(OUT_DIR), base, "sidecar",
                                  size_limit_mb=1, **common)

    check("default run produced HTML", res_emb["html_path"] is not None)
    check("forced 1 MB limit produced sidecar mode", res_side["html_mode"] == "sidecar")

    # -- static sanity on the embedded output -----------------------------
    html = Path(res_emb["html_path"]).read_text(encoding="utf-8")
    check("no __BOMDOM_ sentinel left", "__BOMDOM_" not in html)
    payload = _unpack_payload(html)
    check("payload schema", payload["schema"] == "picturebom.bomdom/1")
    check("parts present in payload", len(payload["parts"]) > 0,
          f"got {len(payload['parts'])}")
    if res_emb["html_mode"] == "embedded":
        glb_bytes = gzip.decompress(base64.b64decode(_extract(html, "glb")))
        check("embedded GLB magic bytes", glb_bytes[:4] == b"glTF")
        check("payload geometry mode embedded", payload["geometry"]["mode"] == "embedded")
    thumbs = sum(1 for p in payload["parts"] if p.get("thumbnail"))
    print(f"    thumbnails embedded: {thumbs}/{len(payload['parts'])}")

    # -- static sanity on the sidecar output -------------------------------
    html2 = Path(res_side["html_path"]).read_text(encoding="utf-8")
    check("sidecar: no sentinel left", "__BOMDOM_" not in html2)
    check("sidecar: GLB slot empty", _extract(html2, "glb") == "")
    payload2 = _unpack_payload(html2)
    check("sidecar: payload names the pack file",
          payload2["geometry"]["sidecar_filename"] == Path(res_side["sidecar_path"]).name)
    check("sidecar: .glb written", Path(res_side["sidecar_path"]).is_file())

    for p in (res_emb["html_path"], res_side["html_path"], res_side["sidecar_path"]):
        if p:
            print(f"    {Path(p).name}: {Path(p).stat().st_size / 1e6:.2f} MB")
    for w in res_emb["warnings"]:
        print(f"    warning: {w}")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    template = REPO_ROOT / "src" / "picturebom" / "assets" / "bomdom" / "viewer_template.html"
    if not template.is_file():
        sys.exit("viewer template missing — run `node scripts/build_viewer.mjs` first")
    print(f"Template: {template} ({template.stat().st_size / 1e6:.2f} MB)")
    print(f"Output:   {OUT_DIR}")

    for glb in GLBS:
        run_one(glb)

    print(f"\n{'ALL CHECKS PASSED' if not failures else f'{len(failures)} FAILURE(S): {failures}'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
