"""pictureBOM — SolidWorks visual BOM generator."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("picturebom")
except PackageNotFoundError:  # running from a source checkout without install
    __version__ = "0.0.0.dev0"

from .core import (
    PictureBOMError,
    compare_boms,
    generate_comparison_excel,
    generate_excel_bom,
    run_pipeline,
)
