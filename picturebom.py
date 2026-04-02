"""
pictureBOM — Export isometric JPG images of every part in a SolidWorks assembly.

Usage:
    python picturebom.py assembly.sldasm -o ./output
    python picturebom.py assembly.sldasm -o ./output --include-subassemblies
"""

import argparse
import os
import re
import sys

import pythoncom
import win32com.client

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
    # SolidWorks appends -N for each instance; strip the last -digits segment
    return re.sub(r"-\d+$", "", component_name)


def traverse_assembly(assembly_doc, include_subassemblies=False):
    """
    Walk the assembly component tree and return a dict of unique components.

    Returns:
        dict: {normalized_file_path: {"name": str, "file_path": str, "doc_type": int}}
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
            # Virtual component — no file on disk
            continue

        normalized = file_path.lower().strip()
        is_assembly = normalized.endswith(".sldasm")

        if is_assembly and not include_subassemblies:
            continue

        if normalized in unique:
            continue  # already seen this part

        doc_type = SW_DOC_ASSEMBLY if is_assembly else SW_DOC_PART
        base_name = get_component_base_name(comp.Name2)

        unique[normalized] = {
            "name": base_name,
            "file_path": file_path,
            "doc_type": doc_type,
        }

    return unique


def capture_component(sw_app, file_path, doc_type, output_path, width, height):
    """Open a component, set isometric view, and export a JPG image."""
    model_doc = open_document(sw_app, file_path, doc_type)
    if model_doc is None:
        return False

    try:
        # Activate the document so it's the current view
        errors = win32com.client.VARIANT(pythoncom.VT_BYREF | pythoncom.VT_I4, 0)
        sw_app.ActivateDoc2(model_doc.GetTitle, False, errors)

        model_doc.ShowNamedView2("*Isometric", SW_VIEW_ISOMETRIC)
        model_doc.ViewZoomtofit2()

        # Use Extension.SaveAs to export as JPG (format inferred from extension)
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


def main():
    parser = argparse.ArgumentParser(
        description="Export isometric images of every part in a SolidWorks assembly."
    )
    parser.add_argument(
        "assembly",
        help="Path to the SolidWorks assembly file (.sldasm)",
    )
    parser.add_argument(
        "-o", "--output-dir",
        default="./output",
        help="Output directory for images (default: ./output)",
    )
    parser.add_argument(
        "--include-subassemblies",
        action="store_true",
        help="Also capture images of sub-assemblies (default: parts only)",
    )
    parser.add_argument("--width", type=int, default=1920, help="Image width (default: 1920)")
    parser.add_argument("--height", type=int, default=1080, help="Image height (default: 1080)")

    args = parser.parse_args()

    # Validate input
    assembly_path = os.path.abspath(args.assembly)
    if not os.path.isfile(assembly_path):
        print(f"ERROR: File not found: {assembly_path}")
        sys.exit(1)
    if not assembly_path.lower().endswith(".sldasm"):
        print("ERROR: Input file must be a SolidWorks assembly (.sldasm)")
        sys.exit(1)

    # Create output directory
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Connect to SolidWorks
    print("Connecting to SolidWorks...")
    sw_app = connect_to_solidworks()

    # Open the assembly
    print(f"Opening assembly: {assembly_path}")
    assy_doc = open_document(sw_app, assembly_path, SW_DOC_ASSEMBLY)
    if assy_doc is None:
        print("ERROR: Failed to open assembly file.")
        sys.exit(1)

    # Traverse and build component list
    print("Traversing assembly components...")
    components = traverse_assembly(assy_doc, args.include_subassemblies)
    total = len(components)
    print(f"Found {total} unique component(s)")

    if total == 0:
        print("No components to capture.")
        close_document(sw_app, assy_doc)
        return

    # Capture images
    success_count = 0
    for i, (_, comp) in enumerate(components.items(), 1):
        safe_name = sanitize_filename(comp["name"])
        output_path = os.path.join(output_dir, f"{safe_name}.jpg")

        print(f"[{i}/{total}] Capturing {comp['name']}...")

        try:
            ok = capture_component(
                sw_app,
                comp["file_path"],
                comp["doc_type"],
                output_path,
                args.width,
                args.height,
            )
            if ok:
                success_count += 1
            else:
                print(f"  WARNING: Failed to open {comp['name']}")
        except Exception as e:
            print(f"  WARNING: Error capturing {comp['name']}: {e}")

    # Cleanup
    close_document(sw_app, assy_doc)

    print(f"\nDone! {success_count}/{total} images saved to: {output_dir}")


if __name__ == "__main__":
    main()
