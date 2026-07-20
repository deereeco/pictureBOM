"""Proof-of-concept: Excel 365 in-cell pictures via xlsxwriter.

Builds a demo BOM workbook from the example Cage Stack Assembly images using
every mechanism the real export port will use: embed_image (Place in Cell),
Status dropdown, Vendor dropdown from a hidden Lists sheet, vendor
conditional-format colors, and Thorlabs/McMaster hyperlinks.

Run:  uv run python scripts/poc_incell_demo.py

Then open the workbook in Excel 365 and verify:
  1. Pictures are cell VALUES: sort any column -> pictures move with rows.
  2. Select all rows, change row height once -> all pictures rescale.
  3. Click a picture cell -> option to view the picture full size.
  4. Status and Vendor dropdowns work.
  5. Picking/typing a vendor recolors the cell (McMaster yellow, Thorlabs
     red, Unknown gray).
  6. Vendor Part No links open the Thorlabs/McMaster product page.
"""

import re
import sys
from pathlib import Path
from urllib.parse import quote

import xlsxwriter

REPO_ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = REPO_ROOT / "Example 3d models" / "Cage Stack Assembly" / "BOM"
OUTPUT_PATH = IMAGES_DIR / "poc_incell_demo.xlsx"

# --- Constants mirroring the planned core.py port ---
HEADER_BG = "#1F3864"
BORDER_COLOR = "#BFBFBF"
PICTURE_COL_WIDTH = 18
DATA_ROW_HEIGHT = 45
HEADER_ROW_HEIGHT = 30
BUFFER_ROWS = 20  # smaller than production's 200, enough to demo

STATUS_OPTIONS = ["To Order", "Ordered", "Received", "Installed"]
COMMON_VENDORS = ["Thorlabs", "McMaster-Carr", "Newport", "Digi-Key", "Unknown"]

VENDOR_HIGHLIGHTS = {
    "mcmaster": ("#FFEB9C", "#9C6500"),
    "thorlabs": ("#FFC7CE", "#9C0006"),
    "unknown": ("#D9D9D9", "#3F3F3F"),
}
VENDOR_URL_TEMPLATES = {
    "thorlabs": "https://www.thorlabs.com/thorproduct.cfm?partnumber={pn}",
    "mcmaster": "https://www.mcmaster.com/{pn}/",
}
_MCMASTER_PN_RE = re.compile(r"^\d{4,6}[A-Z]{1,2}\d{1,4}$")
_THORLABS_PN_RE = re.compile(r"^[A-Z]{1,4}\d+[A-Z0-9]*(?:[/-][A-Z0-9]+)*$")

HEADERS = ["Picture", "Part Number", "Description", "Qty",
           "Vendor", "Vendor Part No", "Status"]

# (image file, part number, description, qty, vendor, vendor part no)
ROWS = [
    ("CCM1-4ER_M-Solidworks.jpg", "CCM1-4ER_M-Solidworks",
     "30 mm Cage Cube, 4 SM1-threaded ports", 1, "Thorlabs", "CCM1-4ER/M"),
    ("CP33_M-Solidworks.jpg", "CP33_M-Solidworks",
     "30 mm Cage Plate, SM1 thread", 2, "Thorlabs", "CP33/M"),
    ("CRM1T_M-Solidworks.jpg", "CRM1T_M-Solidworks",
     "Rotation Mount for 1in optics", 1, "Thorlabs", "CRM1T/M"),
    ("ER3-Solidworks.jpg", "ER3-Solidworks",
     "Cage Assembly Rod, 3in", 4, "Thorlabs", "ER3"),
    ("KC1T_M-Solidworks.jpg", "KC1T_M-Solidworks",
     "Kinematic Mount for 1in optics", 1, "Thorlabs", "KC1T/M"),
    ("ER3-Solidworks.jpg", "91290A115",
     "Socket head cap screw M3x10 (fake demo row)", 8, "McMaster-Carr", "91290A115"),
    ("cag subassm 1.jpg", "MYSTERY-BRACKET-01",
     "Custom bracket, vendor TBD (demo row)", 1, "Unknown", ""),
]


def vendor_url(vendor, part_no):
    """Supplier URL for a part, or None. Vendor substring wins; blank vendor
    falls back to PN-shape heuristics (McMaster first — digit-led)."""
    if not part_no:
        return None
    v = (vendor or "").lower()
    for key, template in VENDOR_URL_TEMPLATES.items():
        if key in v:
            return template.format(pn=quote(part_no, safe=""))
    if not v:
        if _MCMASTER_PN_RE.match(part_no):
            return VENDOR_URL_TEMPLATES["mcmaster"].format(pn=quote(part_no, safe=""))
        if _THORLABS_PN_RE.match(part_no):
            return VENDOR_URL_TEMPLATES["thorlabs"].format(pn=quote(part_no, safe=""))
    return None


def main():
    missing = [f for f, *_ in ROWS if not (IMAGES_DIR / f).is_file()]
    if missing:
        sys.exit(f"Missing demo images in {IMAGES_DIR}: {missing}")

    wb = xlsxwriter.Workbook(str(OUTPUT_PATH))
    b = {"border": 1, "border_color": BORDER_COLOR}
    fmt_header = wb.add_format({**b, "bold": True, "font_color": "#FFFFFF",
                                "font_size": 11, "bg_color": HEADER_BG,
                                "align": "center", "valign": "vcenter",
                                "text_wrap": True})
    fmt_center = wb.add_format({**b, "align": "center", "valign": "vcenter"})
    fmt_left = wb.add_format({**b, "align": "left", "valign": "vcenter",
                              "text_wrap": True})
    fmt_link = wb.add_format({**b, "align": "center", "valign": "vcenter",
                              "font_color": "#0563C1", "underline": 1})
    cf_fmts = {key: wb.add_format({"bg_color": bg, "font_color": fg})
               for key, (bg, fg) in VENDOR_HIGHLIGHTS.items()}

    ws = wb.add_worksheet("Visual BOM")

    ws.set_row(0, HEADER_ROW_HEIGHT)
    for col, header in enumerate(HEADERS):
        ws.write(0, col, header, fmt_header)

    for idx, (img, pn, desc, qty, vendor, vpn) in enumerate(ROWS):
        r = idx + 1
        ws.set_row(r, DATA_ROW_HEIGHT)
        ws.embed_image(r, 0, str(IMAGES_DIR / img), {"cell_format": fmt_center})
        ws.write(r, 1, pn, fmt_center)
        ws.write(r, 2, desc, fmt_left)
        ws.write(r, 3, qty, fmt_center)
        ws.write(r, 4, vendor, fmt_center)
        url = vendor_url(vendor, vpn)
        if url:
            ws.write_url(r, 5, url, fmt_link, string=vpn)
        else:
            ws.write(r, 5, vpn, fmt_center)
        ws.write_blank(r, 6, None, fmt_center)

    first, last = 1, len(ROWS) + BUFFER_ROWS

    # Status dropdown (inline list — short and comma-free)
    ws.data_validation(first, 6, last, 6, {
        "validate": "list", "source": STATUS_OPTIONS, "ignore_blank": True})

    # Vendor dropdown fed from a hidden Lists sheet
    discovered = {row[4] for row in ROWS if row[4]}
    options = sorted(discovered - {"Unknown"}, key=str.lower)
    options += [v for v in COMMON_VENDORS if v not in options and v != "Unknown"]
    options.append("Unknown")
    lists_ws = wb.add_worksheet("Lists")
    for i, opt in enumerate(options):
        lists_ws.write(i, 0, opt)
    lists_ws.hide()
    ws.data_validation(first, 4, last, 4, {
        "validate": "list",
        "source": f"='Lists'!$A$1:$A${len(options)}",
        "ignore_blank": True})

    # Vendor color highlighting (Excel text-contains is case-insensitive)
    for key, fmt in cf_fmts.items():
        ws.conditional_format(first, 4, last, 4, {
            "type": "text", "criteria": "containing", "value": key,
            "format": fmt})

    ws.set_column(0, 0, PICTURE_COL_WIDTH)
    widths = [None, 22, 42, 8, 16, 16, 12]
    for col, w in enumerate(widths):
        if w:
            ws.set_column(col, col, w)
    ws.freeze_panes(1, 0)
    ws.activate()
    wb.close()

    print(f"Wrote {OUTPUT_PATH}")

    # Prove openpyxl can read an xlsxwriter workbook with rich-value image cells
    from picturebom.core import parse_bom_excel
    result = parse_bom_excel(str(OUTPUT_PATH))
    print(f"\nparse_bom_excel read {len(result['parts'])} parts back:")
    for pn, info in result["parts"].items():
        print(f"  {pn}: qty={info['qty']}")


if __name__ == "__main__":
    main()
