"""Smoke test for the STEP reader (stepfile.py) against local fixtures.

Runs without any CAD program. Fixtures live outside version control:
  * "Example 3d models/Domitron 3d Printer .STEP" (Dominic's 2019 printer,
    exported by SolidWorks 2024) — checked against known counts.
  * Any extra paths listed under "step" in scripts/fixtures.local.json are
    parsed and summarised without assertions.
Missing fixtures are skipped, not failed.

Usage:  uv run python scripts/smoke_step.py
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

from picturebom import stepfile  # noqa: E402

EXPECT_DOMITRON = {
    "root_name": "Domitron 3d Printer",
    "exporter": "SolidWorks 2024",
    "schema": "AP214",
    "unique_parts": 64,
    "assemblies": 15,
    "instances": 329,
    "depth": 4,
    "single_product": False,
    "solid_bodies": 75,
    "surface_bodies": 12,
    "has_colors": True,
}


def check(path, expect=None):
    t0 = time.time()
    info = stepfile.inspect(path)
    st = stepfile.read_structure(path)
    rows, comps = stepfile.build_rows(st)
    print(f"{os.path.basename(path)}: {stepfile.describe(info)}  "
          f"[{time.time() - t0:.2f}s, {len(rows)} rows, {len(comps)} components]")
    failures = []
    for key, want in (expect or {}).items():
        got = info.get(key)
        if got != want:
            failures.append(f"  {key}: expected {want!r}, got {got!r}")
    if expect is not None:
        names = [p.name for p in st.products.values()]
        if not any("Défaut" in n for n in names):
            failures.append("  unicode escape \\X2\\00E9\\X0\\ not decoded to 'é'")
        if "PCB^Endstop" not in names:
            failures.append("  virtual-component name 'PCB^Endstop' missing")
        washer = next((c for c in comps.values() if c["name"] == "01875 inner 05 outer"), None)
        if washer is None:
            failures.append("  expected part '01875 inner 05 outer' missing")
        t_nut = next((p for p in st.products.values()
                      if p.name == "15 Series 025-20 Drop-in T-Nut"), None)
        if t_nut is None or (t_nut.solids, t_nut.surfaces) != (0, 6):
            failures.append("  T-Nut body census should be 0 solids / 6 surfaces")
    return failures


def check_multibody():
    """The committed fixtures: one single-body part, one three-body part."""
    failures = []
    fx = os.path.join(ROOT, "scripts", "fixtures")
    single = stepfile.inspect(os.path.join(fx, "Test Bracket.step"))
    multi = stepfile.inspect(os.path.join(fx, "Kinematic Mount.step"))
    print(f"Test Bracket.step: {stepfile.describe(single)}")
    print(f"Kinematic Mount.step: {stepfile.describe(multi)}")
    if not single["single_product"] or stepfile.needs_part_or_assembly_choice(single):
        failures.append("  Test Bracket should be a single part needing no choice")
    if not (multi["single_product"] and multi["body_count"] == 3
            and stepfile.needs_part_or_assembly_choice(multi)):
        failures.append("  Kinematic Mount should be one product with 3 bodies")
    st = stepfile.read_structure(os.path.join(fx, "Kinematic Mount.step"))
    rows_part, _ = stepfile.build_rows(st, "part")
    rows_asm, comps_asm = stepfile.build_rows(st, "assembly")
    if len(rows_part) != 1 or len(rows_asm) != 3:
        failures.append(f"  expected 1 part row / 3 body rows, got {len(rows_part)} / {len(rows_asm)}")
    if [c["step_body_index"] for c in comps_asm.values()] != [1, 2, 3]:
        failures.append("  body rows should carry step_body_index 1..3")
    if rows_asm and rows_asm[0]["name"] != stepfile.body_row_name("Kinematic Mount", 1):
        failures.append(f"  unexpected body row name {rows_asm[0]['name']!r}")
    return failures


def main():
    total_failures = check_multibody()
    domitron = os.path.join(ROOT, "Example 3d models", "Domitron 3d Printer .STEP")
    if os.path.isfile(domitron):
        total_failures += check(domitron, EXPECT_DOMITRON)
    else:
        print("skip: Domitron fixture not present")

    fixtures = os.path.join(ROOT, "scripts", "fixtures.local.json")
    extra = []
    if os.path.isfile(fixtures):
        with open(fixtures, encoding="utf-8") as f:
            data = json.load(f)
        val = data.get("step")
        extra = val if isinstance(val, list) else ([val] if val else [])
    for path in extra:
        if os.path.isfile(path):
            total_failures += check(path)
        else:
            print(f"skip: {path} not present")

    if total_failures:
        print("FAILED:")
        print("\n".join(total_failures))
        sys.exit(1)
    print("ok")


if __name__ == "__main__":
    main()
