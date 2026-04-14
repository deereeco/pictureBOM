"""
pictureBOM CLI — Command-line interface for pictureBOM.

Usage:
    python cli.py "C:\\path\\to\\assembly.sldasm" -o "C:\\output"
    python cli.py --csv "bom.csv" --images "C:\\images" -o "C:\\output"
"""

import argparse
import logging
import os
import sys

from picturebom import PictureBOMError, run_pipeline


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
        help="Path to an existing CSV file to use as the BOM data source.",
    )
    parser.add_argument(
        "--images",
        default=None,
        help="Path to a folder of existing part images. Skips SolidWorks image capture.",
    )

    args = parser.parse_args()

    # Set up logging for CLI output
    level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(level=level, format="%(message)s")

    # Check for overwrites interactively before starting the pipeline
    output_dir = os.path.abspath(args.output_dir)
    overwrite = False

    excel_path = os.path.join(output_dir, "bom.xlsx")
    if os.path.isfile(excel_path):
        answer = input(f"File already exists: {excel_path}\nOverwrite? (y/n): ").strip().lower()
        if answer != "y":
            print("Aborted.")
            return
        overwrite = True

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

    try:
        result = run_pipeline(
            assembly_path=args.assembly,
            output_dir=args.output_dir,
            width=args.width,
            height=args.height,
            bom_mode=bom_mode,
            csv_path=args.csv,
            images_dir=args.images,
            debug=args.debug,
            on_progress=on_progress,
            overwrite=overwrite,
        )
        if result["excel_path"]:
            print(f"\nDone! BOM saved to: {result['excel_path']}")
        elif result["total_components"] == 0:
            print("No components found.")
    except PictureBOMError as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
