"""
Build pictureBOM into a standalone Windows .exe using PyInstaller.

Usage:
    python build.py

Prerequisites:
    pip install pyinstaller   (or: uv pip install pyinstaller)

Output:
    dist/pictureBOM/pictureBOM.exe   (launch this to start the GUI)
"""

import subprocess
import sys

def main():
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", "pictureBOM",
        "--noconfirm",
        # Bundle templates and static files
        "--add-data", "templates;templates",
        "--add-data", "static;static",
        # pywin32 / COM hidden imports
        "--hidden-import", "win32com",
        "--hidden-import", "win32com.client",
        "--hidden-import", "pythoncom",
        "--hidden-import", "pywintypes",
        # Flask hidden imports
        "--hidden-import", "flask",
        # Single directory (faster startup, less antivirus trouble than --onefile)
        "--onedir",
        # No console window — the GUI runs in a browser
        "--noconsole",
        # Entry point
        "app.py",
    ]

    print("Building pictureBOM .exe ...")
    print(f"  Command: {' '.join(cmd)}\n")
    result = subprocess.run(cmd)
    if result.returncode == 0:
        print("\nBuild complete! Output: dist/pictureBOM/pictureBOM.exe")
    else:
        print("\nBuild failed.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
