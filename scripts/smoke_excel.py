"""Smoke test for the Excel export pipeline — no SolidWorks needed.

Builds every export mode (flat, nested, CSV, linked, comparison) from canned
BOM dicts plus the example Cage Stack Assembly images, then round-trips each
output through parse_bom_excel and compares against the pre-port openpyxl
workbook. Run after any change to the Excel writers:

    uv run python scripts/smoke_excel.py
"""

import sys
import tempfile
from pathlib import Path

from picturebom.core import (
    _build_flat_from_hierarchical,
    _generate_linked_excel_bom,
    _vendor_url,
    compare_boms,
    generate_comparison_excel,
    generate_excel_bom,
    parse_bom_excel,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = REPO_ROOT / "Example 3d models" / "Cage Stack Assembly" / "BOM"
# Newest generated workbook in the (machine-local) example folder, else the
# committed showcase workbook — same content, always present in a clone.
_workbooks = sorted(IMAGES_DIR.glob("Cage2-sjm_*.xlsx"))
OLD_WORKBOOK = (_workbooks[-1] if _workbooks
                else REPO_ROOT / "docs" / "samples" / "Cage2-sjm_pictureBOM.xlsx")

# Mimics traverse_assembly_hierarchical() output for a small assembly:
# one subassembly (x2) containing two parts, plus two top-level parts.
def _hrow(level, row_type, name, qty, desc, vendor, vendor_pn):
    return {"level": level, "type": row_type, "name": name, "quantity": qty,
            "description": desc, "vendor": vendor, "vendor_part_no": vendor_pn,
            "file_path": f"C:\\fake\\{name}.sldprt"}


HIER_ROWS = [
    _hrow("1.0", "Assembly", "cag subassm 1", 2, "Cage subassembly", "", ""),
    _hrow("1.1", "Part", "CP33_M-Solidworks", 2, "30 mm Cage Plate",
          "Thorlabs", "CP33/M"),
    _hrow("1.2", "Part", "ER3-Solidworks", 4, "Cage Assembly Rod 3in",
          "", "ER3"),
    _hrow("2.0", "Part", "KC1T_M-Solidworks", 1, "Kinematic Mount",
          "Thorlabs", "KC1T/M"),
    _hrow("3.0", "Part", "91290A115", 8, "M3x10 socket head cap screw",
          "McMaster-Carr", "91290A115"),
]
# Subassembly multiplier is 2, so true totals double the per-parent counts.
EXPECTED_TOTALS = {"CP33_M-Solidworks": 4, "ER3-Solidworks": 8,
                   "KC1T_M-Solidworks": 1, "91290A115": 8}

CSV_COLUMNS = ["Part Number", "Description", "Qty", "Vendor", "Vendor Part No"]
CSV_ROWS = [
    {"Part Number": "CP33_M-Solidworks", "Description": "30 mm Cage Plate",
     "Qty": "4", "Vendor": "Thorlabs", "Vendor Part No": "CP33/M"},
    {"Part Number": "91290A115", "Description": "M3x10 SHCS",
     "Qty": "8", "Vendor": "McMaster-Carr", "Vendor Part No": "91290A115"},
    # '=' prefix must survive as text (strings_to_formulas off), and the
    # None vendor (ragged CSV row) must not pollute the vendor dropdown.
    {"Part Number": "EQ-TEST", "Description": "=see drawing 42",
     "Qty": "1", "Vendor": None, "Vendor Part No": None},
]

failures = []


def check(label, condition, detail=""):
    status = "ok" if condition else "FAIL"
    print(f"  [{status}] {label}" + (f" — {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(label)


def main():
    if not OLD_WORKBOOK.is_file():
        sys.exit(f"Missing reference workbook: {OLD_WORKBOOK}")
    out_dir = Path(tempfile.mkdtemp(prefix="picturebom_smoke_"))
    print(f"Outputs: {out_dir}\n")
    images = str(IMAGES_DIR)

    print("_vendor_url:")
    check("thorlabs by vendor",
          _vendor_url("Thorlabs", "CP33/M")
          == "https://www.thorlabs.com/thorproduct.cfm?partnumber=CP33%2FM")
    check("mcmaster by vendor",
          _vendor_url("McMaster-Carr", "91290A115")
          == "https://www.mcmaster.com/91290A115/")
    check("thorlabs by PN shape", _vendor_url("", "ER3") is not None)
    check("mcmaster by PN shape",
          _vendor_url("", "91290A115") == "https://www.mcmaster.com/91290A115/")
    check("unknown vendor -> no link", _vendor_url("Newport", "XYZ-1") is None)
    check("blank PN -> no link", _vendor_url("Thorlabs", "") is None)

    flat_parts = _build_flat_from_hierarchical(HIER_ROWS, "Cage2-sjm")

    print("\nflat mode:")
    flat_path = out_dir / "flat.xlsx"
    generate_excel_bom(flat_parts, images, str(flat_path))
    parsed = parse_bom_excel(str(flat_path))["parts"]
    check("all parts parsed", set(parsed) == set(EXPECTED_TOTALS),
          f"got {sorted(parsed)}")
    check("total quantities",
          {pn: p["qty"] for pn, p in parsed.items()} == EXPECTED_TOTALS,
          f"got { {pn: p['qty'] for pn, p in parsed.items()} }")

    from openpyxl import load_workbook
    wb = load_workbook(str(flat_path))
    ws = wb.active
    check("Status header is last column",
          ws.cell(row=1, column=8).value == "Status")
    check("blank Status cell is formatted (write_blank regression)",
          ws.cell(row=2, column=8).border.left.style == "thin",
          f"got {ws.cell(row=2, column=8).border.left.style!r}")
    wb.close()

    print("\nnested mode:")
    nested_path = out_dir / "nested.xlsx"
    generate_excel_bom(HIER_ROWS, images, str(nested_path), hierarchical=True)
    parsed = parse_bom_excel(str(nested_path))["parts"]
    check("hierarchical totals multiplied",
          {pn: p["qty"] for pn, p in parsed.items()} == EXPECTED_TOTALS,
          f"got { {pn: p['qty'] for pn, p in parsed.items()} }")

    print("\nCSV mode:")
    csv_path = out_dir / "csv.xlsx"
    generate_excel_bom(CSV_ROWS, images, str(csv_path), csv_columns=CSV_COLUMNS)
    parsed = parse_bom_excel(str(csv_path))["parts"]
    check("csv rows parsed",
          {pn: p["qty"] for pn, p in parsed.items()}
          == {"CP33_M-Solidworks": 4, "91290A115": 8, "EQ-TEST": 1},
          f"got { {pn: p['qty'] for pn, p in parsed.items()} }")
    check("'=' description stays text (strings_to_formulas regression)",
          parsed["EQ-TEST"]["description"] == "=see drawing 42",
          f"got {parsed['EQ-TEST']['description']!r}")
    wb = load_workbook(str(csv_path))
    lists = [c.value for c in wb["Lists"]["A"] if c.value]
    check("no 'None' in vendor dropdown (ragged CSV regression)",
          "None" not in lists, f"got {lists}")
    wb.close()

    print("\nlinked mode:")
    linked_path = out_dir / "linked.xlsx"
    _generate_linked_excel_bom(flat_parts, HIER_ROWS, images, str(linked_path))
    parsed = parse_bom_excel(str(linked_path))["parts"]
    check("Parts Only sheet parsed with totals",
          {pn: p["qty"] for pn, p in parsed.items()} == EXPECTED_TOTALS,
          f"got { {pn: p['qty'] for pn, p in parsed.items()} }")

    print("\ncompare old (openpyxl) vs new (xlsxwriter), both directions:")
    cmp_ab = compare_boms(str(OLD_WORKBOOK), str(flat_path))
    cmp_ba = compare_boms(str(flat_path), str(OLD_WORKBOOK))
    check("old-vs-new runs", isinstance(cmp_ab["rows"], list))
    check("new-vs-old runs", isinstance(cmp_ba["rows"], list))

    print("\ncomparison export:")
    cmp_path = out_dir / "comparison.xlsx"
    generate_comparison_excel(cmp_ab if cmp_ab["rows"] else cmp_ba, str(cmp_path))
    from openpyxl import load_workbook
    wb = load_workbook(str(cmp_path), data_only=True)
    check("Parts to Order sheet present", "Parts to Order" in wb.sheetnames)
    wb.close()

    print(f"\n{'ALL CHECKS PASSED' if not failures else f'{len(failures)} FAILURE(S): {failures}'}")
    print(f"Workbooks kept for manual inspection in {out_dir}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
