"""
pictureBOM — Export isometric JPG images of every part in a SolidWorks assembly
and generate an Excel visual BOM with embedded thumbnails.

Usage:
    # Full pipeline: capture images + build Excel BOM from SolidWorks
    python picturebom.py "C:\\path\\to\\assembly.sldasm" -o "C:\\output"

    # Use existing images + CSV (no SolidWorks needed)
    python picturebom.py --csv "bom.csv" --images "C:\\images" -o "C:\\output"

    # Recapture images but use an existing CSV for BOM data
    python picturebom.py "C:\\path\\to\\assembly.sldasm" --csv "bom.csv" -o "C:\\output"
"""

import argparse
import csv
import os
import re
import sys

import pythoncom
import win32com.client
from openpyxl import Workbook
from openpyxl.drawing.image import Image as XlImage
from openpyxl.utils import get_column_letter

# SolidWorks constants
SW_DOC_PART = 1
SW_DOC_ASSEMBLY = 2
SW_OPEN_DOC_OPTIONS_SILENT = 1
SW_VIEW_ISOMETRIC = 7


def connect_to_solidworks():
    """Attach to a running SolidWorks instance."""
    try:
        sw_app = win32com.client.GetActiveObject("SldWorks.Application")
    except pythoncom.com_error:
        print("ERROR: SolidWorks is not running. Please open SolidWorks and try again.")
        sys.exit(1)
    return sw_app


def open_document(sw_app, file_path, doc_type):
    """Open a SolidWorks document silently. Returns the IModelDoc2 or None."""
    errors = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
    warnings = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)

    model_doc = sw_app.OpenDoc6(
        file_path,
        doc_type,
        SW_OPEN_DOC_OPTIONS_SILENT,
        "",       # default configuration
        errors,
        warnings,
    )
    return model_doc


def close_document(sw_app, model_doc):
    """Close a document without saving."""
    sw_app.CloseDoc(model_doc.GetTitle)


def sanitize_filename(name):
    """Remove or replace characters that are invalid in file names."""
    return re.sub(r'[<>:"/\\|?*]', "_", name).strip()


def get_component_base_name(component_name):
    """Strip the instance suffix (e.g., 'Bolt-2' -> 'Bolt')."""
    return re.sub(r"-\d+$", "", component_name)


def get_custom_property(cpm, prop_name):
    """Read a custom property value. Returns empty string if not found."""
    try:
        val = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_BSTR, "")
        resolved = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_BSTR, "")
        was_resolved = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_BOOL, False)
        cpm.Get6(prop_name, False, val, resolved, was_resolved, False)
        return resolved.value or ""
    except Exception:
        return ""


def get_part_properties(comp_doc):
    """Extract Description, Vendor, and Vendor Part No from a component's custom properties."""
    props = {"description": "", "vendor": "", "vendor_part_no": ""}
    if comp_doc is None:
        return props

    try:
        cpm = comp_doc.Extension.CustomPropertyManager("")
        props["description"] = get_custom_property(cpm, "Description")
        props["vendor"] = get_custom_property(cpm, "Vendor")
        props["vendor_part_no"] = get_custom_property(cpm, "Vendor Part No")
    except Exception:
        pass

    return props


def traverse_assembly(assembly_doc, include_subassemblies=False):
    """
    Walk the assembly component tree and return a dict of unique components
    with quantities and custom properties.

    Returns:
        dict: {normalized_file_path: {name, file_path, doc_type, quantity, description, vendor, vendor_part_no}}
    """
    components = assembly_doc.GetComponents(False)  # False = all levels, not just top
    if components is None:
        return {}

    unique = {}

    for comp in components:
        if comp.IsSuppressed:
            continue

        file_path = comp.GetPathName
        if not file_path:
            continue

        normalized = file_path.lower().strip()
        is_assembly = normalized.endswith(".sldasm")

        if is_assembly and not include_subassemblies:
            continue

        if normalized in unique:
            unique[normalized]["quantity"] += 1
            continue

        doc_type = SW_DOC_ASSEMBLY if is_assembly else SW_DOC_PART
        base_name = get_component_base_name(comp.Name2)

        # Read custom properties from the component's model doc
        comp_doc = comp.GetModelDoc2
        props = get_part_properties(comp_doc)

        unique[normalized] = {
            "name": base_name,
            "file_path": file_path,
            "doc_type": doc_type,
            "quantity": 1,
            "description": props["description"],
            "vendor": props["vendor"],
            "vendor_part_no": props["vendor_part_no"],
        }

    return unique


def capture_component(sw_app, file_path, doc_type, output_path, width, height):
    """Open a component, set isometric view, and export a JPG image."""
    model_doc = open_document(sw_app, file_path, doc_type)
    if model_doc is None:
        return False

    try:
        errors = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        sw_app.ActivateDoc2(model_doc.GetTitle, False, errors)

        model_doc.ShowNamedView2("*Isometric", SW_VIEW_ISOMETRIC)
        model_doc.ViewZoomtofit2()

        export_data = win32com.client.VARIANT(pythoncom.VT_DISPATCH, None)
        save_errors = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        save_warnings = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        success = model_doc.Extension.SaveAs(
            output_path,
            0,              # swSaveAsCurrentVersion
            1,              # swSaveAsOptions_Silent
            export_data,    # Nothing (null dispatch)
            save_errors,
            save_warnings,
        )
        return bool(success)
    finally:
        close_document(sw_app, model_doc)



def load_csv_bom(csv_path):
    """Load a CSV file and return a list of row dicts. Expects a 'Part Number' column."""
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows, reader.fieldnames


def generate_excel_bom(bom_rows, images_dir, output_path, csv_columns=None):
    """
    Generate an Excel BOM with embedded thumbnail images.

    bom_rows: list of dicts with at least 'name' key. May also have
              description, quantity, vendor, vendor_part_no.
    images_dir: folder containing JPG images named <part_name>.jpg
    output_path: path to write the .xlsx file
    csv_columns: if provided, use these column names (from CSV import)
    """
    wb = Workbook()
    ws = wb.active
    ws.title = "Visual BOM"

    if csv_columns:
        # CSV mode: Picture + all original CSV columns
        headers = ["Picture"] + list(csv_columns)
        ws.append(headers)

        for col_idx in range(1, len(headers) + 1):
            ws.column_dimensions[get_column_letter(col_idx)].width = 20
        ws.column_dimensions["A"].width = 18  # Picture column

        for row_idx, row_data in enumerate(bom_rows, start=2):
            # Try to find image by part number
            part_number = row_data.get("Part Number", row_data.get("part_number", ""))
            safe_name = sanitize_filename(part_number)
            img_path = _find_image(images_dir, safe_name)

            ws.row_dimensions[row_idx].height = 60

            if img_path:
                _insert_image(ws, img_path, f"A{row_idx}")

            for col_idx, col_name in enumerate(csv_columns, start=2):
                ws.cell(row=row_idx, column=col_idx, value=row_data.get(col_name, ""))
    else:
        # SolidWorks traversal mode
        headers = ["Picture", "Part Number", "Description", "Qty", "Vendor", "Vendor Part No"]
        ws.append(headers)

        # Column widths
        ws.column_dimensions["A"].width = 18   # Picture
        ws.column_dimensions["B"].width = 25   # Part Number
        ws.column_dimensions["C"].width = 35   # Description
        ws.column_dimensions["D"].width = 8    # Qty
        ws.column_dimensions["E"].width = 20   # Vendor
        ws.column_dimensions["F"].width = 20   # Vendor Part No

        for row_idx, row_data in enumerate(bom_rows, start=2):
            safe_name = sanitize_filename(row_data["name"])
            img_path = _find_image(images_dir, safe_name)

            ws.row_dimensions[row_idx].height = 60

            if img_path:
                _insert_image(ws, img_path, f"A{row_idx}")

            ws.cell(row=row_idx, column=2, value=row_data["name"])
            ws.cell(row=row_idx, column=3, value=row_data.get("description", ""))
            ws.cell(row=row_idx, column=4, value=row_data.get("quantity", 1))
            ws.cell(row=row_idx, column=5, value=row_data.get("vendor", ""))
            ws.cell(row=row_idx, column=6, value=row_data.get("vendor_part_no", ""))

    # Bold header row
    from openpyxl.styles import Font
    for cell in ws[1]:
        cell.font = Font(bold=True)

    wb.save(output_path)
    return output_path


def _find_image(images_dir, safe_name):
    """Find an image file matching the part name (try .jpg then .bmp)."""
    for ext in (".jpg", ".jpeg", ".bmp", ".png"):
        path = os.path.join(images_dir, safe_name + ext)
        if os.path.isfile(path):
            return path
    return None


def _insert_image(ws, img_path, cell_ref):
    """Insert and size an image into a worksheet cell."""
    img = XlImage(img_path)
    # Scale to ~75px tall thumbnail (fits nicely in a ~60pt row)
    thumb_height = 75
    aspect = img.width / img.height if img.height else 1.78
    img.height = thumb_height
    img.width = int(thumb_height * aspect)
    img.anchor = cell_ref
    ws.add_image(img)


def main():
    parser = argparse.ArgumentParser(
        description="Export isometric images of every part in a SolidWorks assembly "
                    "and generate an Excel visual BOM.",
    )
    parser.add_argument(
        "assembly",
        help="Path to the SolidWorks assembly file (.sldasm).",
    )
    parser.add_argument(
        "-o", "--output-dir",
        default="./output",
        help="Output directory for images and BOM (default: ./output)",
    )
    parser.add_argument(
        "--include-subassemblies",
        action="store_true",
        help="Also capture images of sub-assemblies (default: parts only)",
    )
    parser.add_argument("--width", type=int, default=1920, help="Image width (default: 1920)")
    parser.add_argument("--height", type=int, default=1080, help="Image height (default: 1080)")
    parser.add_argument(
        "--csv",
        default=None,
        help="Path to an existing CSV file to use as the BOM data source.",
    )
    parser.add_argument(
        "--images",
        default=None,
        help="Path to a folder of existing part images. Skips SolidWorks image capture.",
    )

    args = parser.parse_args()

    has_csv = args.csv is not None
    has_images = args.images is not None

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Where images live
    images_dir = os.path.abspath(args.images) if has_images else output_dir

    bom_rows = []
    csv_columns = None

    # --- SolidWorks pipeline (always runs) ---
    assembly_path = os.path.abspath(args.assembly)
    if not os.path.isfile(assembly_path):
        print(f"ERROR: File not found: {assembly_path}")
        sys.exit(1)
    if not assembly_path.lower().endswith(".sldasm"):
        print("ERROR: Input file must be a SolidWorks assembly (.sldasm)")
        sys.exit(1)

    # --- Check for overwrites before doing any work ---
    excel_path = os.path.join(output_dir, "bom.xlsx")
    if os.path.isfile(excel_path):
        answer = input(f"File already exists: {excel_path}\nOverwrite? (y/n): ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return

    if not has_images:
        existing_images = [f for f in os.listdir(output_dir) if f.lower().endswith((".jpg", ".jpeg", ".bmp", ".png"))] if os.path.isdir(output_dir) else []
        if existing_images:
            answer = input(
                f"Output folder already contains {len(existing_images)} image(s): {output_dir}\n"
                f"Overwrite existing images? (y/n): "
            ).strip().lower()
            if answer != "y":
                print("Aborted.")
                return

    print("Connecting to SolidWorks...")
    sw_app = connect_to_solidworks()

    print(f"Opening assembly: {assembly_path}")
    assy_doc = open_document(sw_app, assembly_path, SW_DOC_ASSEMBLY)
    if assy_doc is None:
        print("ERROR: Failed to open assembly file.")
        sys.exit(1)

    print("Traversing assembly components...")
    components = traverse_assembly(assy_doc, args.include_subassemblies)
    total = len(components)
    print(f"Found {total} unique component(s)")

    # BOM data comes from CSV if provided, otherwise from SolidWorks traversal
    if has_csv:
        csv_path = os.path.abspath(args.csv)
        if not os.path.isfile(csv_path):
            print(f"ERROR: CSV file not found: {csv_path}")
            sys.exit(1)
        print(f"Loading CSV: {csv_path}")
        bom_rows, csv_columns = load_csv_bom(csv_path)
        print(f"Loaded {len(bom_rows)} rows from CSV")
    else:
        bom_rows = list(components.values())

    # Capture images (skip if user provided --images)
    if not has_images and total > 0:
        success_count = 0
        for i, (_, comp) in enumerate(components.items(), 1):
            safe_name = sanitize_filename(comp["name"])
            img_output = os.path.join(output_dir, f"{safe_name}.jpg")

            print(f"[{i}/{total}] Capturing {comp['name']}...")
            try:
                ok = capture_component(
                    sw_app, comp["file_path"], comp["doc_type"],
                    img_output, args.width, args.height,
                )
                if ok:
                    success_count += 1
                else:
                    print(f"  WARNING: Failed to open {comp['name']}")
            except Exception as e:
                print(f"  WARNING: Error capturing {comp['name']}: {e}")

        print(f"\n{success_count}/{total} images captured.")
    elif has_images:
        print(f"Using existing images from: {images_dir}")

    close_document(sw_app, assy_doc)

    if not bom_rows:
        print("No BOM data to write.")
        return

    # Generate Excel BOM
    excel_path = os.path.join(output_dir, "bom.xlsx")
    print(f"Generating Excel BOM...")
    generate_excel_bom(bom_rows, images_dir, excel_path, csv_columns)
    print(f"Done! BOM saved to: {excel_path}")


if __name__ == "__main__":
    main()
