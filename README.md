# pictureBOM

Automatically capture isometric images of every part in a SolidWorks assembly and generate an Excel Bill of Materials with embedded thumbnails.

## What it does

Point pictureBOM at a SolidWorks assembly file (`.sldasm`). It will:

1. Open each part in SolidWorks and take an isometric screenshot
2. Build an Excel spreadsheet with a picture of every component alongside its part number, description, vendor, and quantity

The output Excel file is named after the assembly with a timestamp (e.g. `MainFrame_2026-04-14_143025.xlsx`) so consecutive runs never overwrite each other.

## Requirements

- **Windows** (SolidWorks is Windows-only)
- **SolidWorks** installed and running before you click Run
- **Python 3.10+** (if running from source)

> **Important:** Pack and Go your assembly before running. Files locked in PDM will not open correctly.

## Installation (Windows)

### Option A: Run from source

1. Install Python 3.10+ from [python.org](https://www.python.org/downloads/). During install, check **"Add Python to PATH"**.

2. Open **Command Prompt** or **PowerShell** and clone the repo:
   ```
   git clone https://github.com/deereeco/pictureBOM.git
   cd pictureBOM
   ```

3. Install dependencies:
   ```
   pip install -e .
   ```

4. Launch the GUI:
   ```
   python app.py
   ```
   A browser tab will open automatically at `http://127.0.0.1:5000`.

### Option B: Build a standalone .exe

If you want to distribute pictureBOM to other engineers who don't have Python installed:

1. Follow Option A first (you need the source and dependencies to build).

2. Install PyInstaller:
   ```
   pip install pyinstaller
   ```

3. Build the executable:
   ```
   python build.py
   ```

4. The output is at `dist\pictureBOM\`. **Copy this entire folder** to a location on a local Windows drive (e.g. `C:\pictureBOM\`). The `.exe` will not work if you only copy the exe — it needs the `_internal\` folder next to it.

5. Distribute the copied folder to other engineers. They double-click `pictureBOM.exe` to launch.

> **Note:** The .exe must be built on Windows (not WSL/Linux). It must also be run from a local Windows path (e.g. `C:\`), not a network or WSL path (`\\wsl.localhost\...`).

## Usage

1. Open SolidWorks with your assembly (or have it accessible on disk).
2. Launch pictureBOM (either `python app.py` or the `.exe`).
3. Set the **Assembly File** path to your `.sldasm` file.
4. Set the **Output Directory** where images and the Excel BOM will be saved.
5. Choose your **Image Quality** and **Assembly Mode**:
   - **Parts only (flat)** -- every unique part listed once with total quantity
   - **Include sub-assemblies (nested)** -- hierarchical list including sub-assemblies
   - **Linked (two-sheet)** -- Sheet 1 is an editable parts list, Sheet 2 is a hierarchical view linked by formulas
6. Click **Run pictureBOM**.
7. When complete, use **Open Output Folder** to find your files or **Download Copy of BOM** to grab the Excel through the browser.

## Shutting down

- Use the **Quit** button in the top-right corner to shut down the server.
- If you close the browser tab, the server will automatically shut down after ~30 seconds.

## Command-line interface

For scripting or automation, a CLI is also available:

```
python cli.py path/to/assembly.sldasm -o output_folder
```

Run `python cli.py --help` for all options.

## Project structure

```
pictureBOM/
  app.py          -- Flask web GUI (entry point for browser interface)
  cli.py          -- Command-line interface
  picturebom.py   -- Core library (SolidWorks COM, image capture, Excel generation)
  build.py        -- PyInstaller build script
  templates/      -- HTML template
  static/         -- JavaScript, CSS
```
