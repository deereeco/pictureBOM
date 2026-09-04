"""Refresh the GitHub Pages demo after a viewer change.

docs/index.html IS the Domitron 3D-printer BomDom (deereeco.github.io/pictureBOM).
Every update that lands on main should show up there, version number in the
footer included, so the live site can be used to check changes. This script
repacks the existing export with the CURRENT viewer template and stamps the
current package version into its payload — no SolidWorks or FreeCAD run; the
BOM data, GLB and hand-edited config (up_axis, allow_exports) are lifted from
the file as-is.

    uv run python scripts/refresh_demo.py            # rewrite docs/index.html
    uv run python scripts/refresh_demo.py --check    # exit 1 if it is stale
    uv run python scripts/refresh_demo.py IN OUT     # repack any BomDom file

Build the template first (cd web && npm run build) or the repack ships the old
viewer.
"""

import base64
import gzip
import json
import sys
import tomllib
from pathlib import Path

from picturebom.bomdom import build_html, load_viewer_template

REPO_ROOT = Path(__file__).resolve().parents[1]
DEMO = REPO_ROOT / "docs" / "index.html"


def _slot(html, name):
    # Single-quoted id attributes are the contract with build_viewer.mjs.
    marker = f"id='bomdom-{name}'>"
    start = html.index(marker) + len(marker)
    return html[start:html.index("</script>", start)]


def package_version():
    with open(REPO_ROOT / "pyproject.toml", "rb") as f:
        return tomllib.load(f)["project"]["version"]


def repack(html, version):
    """Return (new_html, summary) for an existing BomDom export."""
    mode = _slot(html, "mode").strip()
    config = json.loads(_slot(html, "config"))
    payload = json.loads(gzip.decompress(base64.b64decode(_slot(html, "meta"))))
    glb_b64 = "".join(_slot(html, "glb").split())
    glb = gzip.decompress(base64.b64decode(glb_b64)) if glb_b64 else b""
    old_version = payload.get("app_version")
    payload["app_version"] = version
    out = build_html(load_viewer_template(), payload, glb, mode,
                     viewer_exports=config.get("allow_exports", True),
                     up_axis=config.get("up_axis", "+y"))
    summary = (f"{payload.get('assembly', {}).get('name', '?')}: {len(payload.get('parts', []))} parts, "
               f"GLB {len(glb) / 1e6:.2f} MB, mode={mode}, up_axis={config.get('up_axis')}, "
               f"app_version {old_version} -> {version}")
    return out, summary


def main(argv):
    check = "--check" in argv
    args = [a for a in argv if not a.startswith("--")]
    src = Path(args[0]) if args else DEMO
    dst = Path(args[1]) if len(args) > 1 else src
    version = package_version()
    html = src.read_text(encoding="utf-8")
    out, summary = repack(html, version)
    if check:
        # Line endings are normalised by git; compare content, not bytes.
        stale = out.replace("\r\n", "\n") != html.replace("\r\n", "\n")
        print(f"{'STALE' if stale else 'current'}: {src} ({summary})")
        return 1 if stale else 0
    dst.write_text(out, encoding="utf-8", newline="\n")
    print(f"{summary}\nwrote {dst} ({dst.stat().st_size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
