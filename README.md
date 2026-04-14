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
- **Python 3.10+** installed on Windows

> **Important:** Pack and Go your assembly before running. Files locked in PDM will not open correctly.

## Installation (Windows)

### Step 1: Install Python

If you don't already have Python installed:

1. Download Python 3.10+ from [python.org/downloads](https://www.python.org/downloads/).
2. Run the installer. **Check "Add Python to PATH"** at the bottom of the first screen -- this is required.
3. Click "Install Now".
4. To verify it worked, open **Command Prompt** or **PowerShell** and run:
   ```
   python --version
   ```
   You should see something like `Python 3.13.3`. If you get an error, restart your terminal and try again.

> **Note:** pip comes bundled with Python, so you don't need to install it separately.

### Step 2: Download pictureBOM

If you have git installed:
```
git clone https://github.com/deereeco/pictureBOM.git
cd pictureBOM
```

If you don't have git, download the repo as a ZIP from GitHub and extract it, then open a terminal in that folder.

### Step 3: Install dependencies and run

**Using pip** (comes with Python):
```
pip install -e .
python app.py
```

**Or using uv** (faster alternative, handles virtual environments automatically):
1. Install uv by running this in PowerShell:
   ```
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```
2. Then run:
   ```
   uv run python app.py
   ```

---

A browser tab will open automatically at `http://127.0.0.1:5000`.

## Usage

1. Open SolidWorks with your assembly (or have it accessible on disk).
2. Launch pictureBOM (`python app.py` or `uv run python app.py`).
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
  templates/      -- HTML template
  static/         -- JavaScript, CSS
```
