"""
pictureBOM CLI — Command-line interface for pictureBOM.

Usage:
    picturebom "C:\\path\\to\\assembly.sldasm" -o "C:\\output"
    picturebom "C:\\path\\to\\model.step" -o "C:\\output" --html
    picturebom --csv "bom.csv" --images "C:\\images" -o "C:\\output"
"""

import argparse
import logging
import os
import sys

from . import stepfile
from .core import PictureBOMError, run_pipeline


def main():
    parser = argparse.ArgumentParser(
        description="Export isometric images of every part in a SolidWorks assembly "
                    "and generate an Excel visual BOM.",
    )
    parser.add_argument(
        "assembly",
        nargs="?",
        default=None,
        help="Path to the SolidWorks assembly file (.sldasm), or a STEP file "
             "(.step/.stp — read with FreeCAD, no SolidWorks needed). May be "
             "omitted when --csv, --images and (for --html) --glb are all "
             "provided — that combination runs without any CAD program.",
    )
    parser.add_argument(
        "--engine",
        choices=["auto", "freecad", "solidworks"],
        default="auto",
        help="CAD engine for a STEP input: auto (FreeCAD when installed) or "
             "freecad. Reading STEP files through SolidWorks arrives in a "
             "later version. Ignored for .sldasm input.",
    )
    parser.add_argument(
        "--step-as",
        choices=["part", "assembly"],
        default=None,
        help="For a STEP file that is one part with several bodies: list it "
             "as one part, or as an assembly with one row per body. Asked "
             "interactively when omitted.",
    )
    parser.add_argument(
        "--freecad",
        default=None,
        metavar="PATH",
        help="freecad.exe (or its install folder) when pictureBOM does not "
             "find FreeCAD by itself. Also read from the PICTUREBOM_FREECAD "
             "environment variable.",
    )
    parser.add_argument(
        "-o", "--output-dir",
        default="./output",
        help="Output directory for images and BOM (default: ./output)",
    )
    parser.add_argument(
        "--bom-mode",
        choices=["flat", "nested", "linked"],
        default=None,
        help="BOM layout: flat (parts only), nested (hierarchical with "
             "sub-assemblies), or linked (two-sheet workbook with formulas). "
             "Default: flat",
    )
    parser.add_argument(
        "--include-subassemblies",
        action="store_true",
        help="Deprecated: use --bom-mode nested instead.",
    )
    parser.add_argument("--width", type=int, default=1920, help="Image width (default: 1920)")
    parser.add_argument("--height", type=int, default=1080, help="Image height (default: 1080)")
    parser.add_argument("--debug", action="store_true", help="Print property names found on each part")
    parser.add_argument(
        "--csv",
        default=None,
        help="Path to an existing BOM table to use as the data source instead "
             "of SolidWorks properties: a .csv, or the .xlsx from an earlier "
             "run (every run also writes a .csv twin of its workbook).",
    )
    parser.add_argument(
        "--properties",
        default=None,
        metavar="NAME[,NAME...]",
        help="Extra SolidWorks custom properties to read per part, "
             "comma-separated (e.g. \"Process,Finish\"). Each becomes a "
             "column in the Excel/CSV and a filterable facet in the 3D "
             "viewer. Ignored when --csv supplies the table.",
    )
    parser.add_argument(
        "--images",
        default=None,
        help="Path to a folder of existing part images. Skips SolidWorks image capture.",
    )
    parser.add_argument(
        "--glb",
        default=None,
        help="Path to a .glb exported from the same assembly by an earlier "
             "run. Skips the slow SolidWorks 3D export for --html.",
    )
    parser.add_argument(
        "--html",
        action="store_true",
        help="Also export an interactive 3D BOM as a single .html file "
             "(needs SolidWorks 2024+).",
    )
    parser.add_argument(
        "--no-excel",
        action="store_true",
        help="Skip the Excel BOM (only valid together with --html).",
    )
    parser.add_argument(
        "--discard-glb",
        action="store_true",
        help="Delete the raw SolidWorks .glb export after the HTML is built "
             "(kept by default so --glb can reuse it on a later run).",
    )
    parser.add_argument(
        "--sidecar",
        action="store_true",
        help="Always write the 3D data as a separate .glb next to the HTML "
             "instead of embedding it (keep the two files together).",
    )
    parser.add_argument(
        "--up-axis",
        choices=["x", "y", "z", "+x", "+y", "+z", "-x", "-y", "-z"],
        default="+y",
        help="Model axis the 3D viewer points up when the HTML is opened "
             "(default +y, glTF's convention; most CAD assemblies want +z). "
             "Readers can change it in the viewer's View menu.",
    )
    parser.add_argument(
        "--no-viewer-exports",
        action="store_true",
        help="Hide the Export menu inside the 3D BOM viewer (recipients can view "
             "but not re-export parts lists; hand-editable in the HTML afterwards).",
    )

    args = parser.parse_args()

    if args.no_excel and not args.html:
        parser.error("--no-excel requires --html (nothing would be produced)")
    if not args.html:
        for flag, present in [("--glb", args.glb is not None),
                              ("--sidecar", args.sidecar),
                              ("--up-axis", args.up_axis != "+y"),
                              ("--discard-glb", args.discard_glb)]:
            if present:
                parser.error(f"{flag} requires --html "
                             "(it only affects the 3D interactive BOM)")
    if args.assembly is None and not (
            args.csv and args.images and (args.glb or not args.html)):
        parser.error("assembly is required unless --csv, --images and "
                     "(for --html) --glb are all provided")
    is_step = bool(args.assembly) and stepfile.is_step_file(args.assembly)
    if not is_step:
        for flag, present in [("--step-as", args.step_as is not None),
                              ("--freecad", args.freecad is not None),
                              ("--engine", args.engine != "auto")]:
            if present:
                parser.error(f"{flag} only applies to STEP (.step/.stp) input")

    # Set up logging for CLI output
    level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(level=level, format="%(message)s")

    # Check for overwrites interactively before starting the pipeline
    output_dir = os.path.abspath(args.output_dir)
    overwrite = False

    if args.images is None and os.path.isdir(output_dir):
        existing = [f for f in os.listdir(output_dir)
                    if f.lower().endswith((".jpg", ".jpeg", ".bmp", ".png"))]
        if existing:
            answer = input(
                f"Output folder already contains {len(existing)} image(s): {output_dir}\n"
                f"Overwrite existing images? (y/n): "
            ).strip().lower()
            if answer != "y":
                print("Aborted.")
                return
            overwrite = True

    def on_progress(current, total, part_name, success, image_path, **_):
        status = "" if success else "  WARNING: Failed"
        print(f"[{current}/{total}] Capturing {part_name}...{status}")

    # Resolve bom_mode: explicit flag wins, else fall back to legacy flag
    bom_mode = args.bom_mode
    if bom_mode is None:
        bom_mode = "nested" if args.include_subassemblies else "flat"

    # A STEP that is one part with several bodies: ask how to list it (the
    # GUI asks the same question the moment the file is picked).
    step_as = args.step_as
    if is_step and os.path.isfile(args.assembly):
        try:
            info = stepfile.inspect(args.assembly)
        except stepfile.StepError as e:
            print(f"ERROR: {e}")
            sys.exit(1)
        print(stepfile.describe(info))
        if step_as is None and stepfile.needs_part_or_assembly_choice(info):
            answer = input(
                f"This STEP file is one part with {info['body_count']} bodies. "
                "List it as one (p)art or as an (a)ssembly of its bodies? [p/a]: "
            ).strip().lower()
            step_as = "assembly" if answer.startswith("a") else "part"

    try:
        result = run_pipeline(
            assembly_path=args.assembly,
            output_dir=args.output_dir,
            width=args.width,
            height=args.height,
            bom_mode=bom_mode,
            csv_path=args.csv,
            images_dir=args.images,
            glb_path=args.glb,
            debug=args.debug,
            on_progress=on_progress,
            overwrite=overwrite,
            output_excel=not args.no_excel,
            output_html=args.html,
            keep_raw_glb=not args.discard_glb,
            html_sidecar=args.sidecar,
            viewer_exports=not args.no_viewer_exports,
            viewer_up_axis=args.up_axis,
            part_properties=args.properties,
            engine=args.engine,
            step_as=step_as,
            freecad_path=args.freecad,
        )
        if result["excel_path"]:
            print(f"\nDone! BOM saved to: {result['excel_path']}")
        if result.get("bom_csv_path"):
            print(f"BOM data (feed back in with --csv): {result['bom_csv_path']}")
        if result.get("html_path"):
            print(f"3D interactive BOM: {result['html_path']}"
                  f" ({result.get('html_projected_mb')} MB)")
            if result.get("html_mode") == "sidecar":
                print(f"  3D data file (keep next to the HTML): {result['sidecar_path']}")
        if not result["excel_path"] and result["total_components"] == 0:
            print("No components found.")
        for warning in result.get("warnings", []):
            print(f"WARNING: {warning}")
    except PictureBOMError as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
