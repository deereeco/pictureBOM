"""
pictureBOM Web GUI — Flask-based interface for pictureBOM.

Usage:
    picturebom-gui
    # Opens browser to http://127.0.0.1:5000
"""

import json
import logging
import os
import queue
import signal
import subprocess
import threading
import webbrowser

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

from . import __version__
from . import core as picturebom

app = Flask(__name__)

log = logging.getLogger(__name__)

# Settings file location
SETTINGS_PATH = os.path.join(os.path.expanduser("~"), ".picturebom", "settings.json")

# Absolute default so launches from a Start Menu shortcut (CWD = System32)
# never write output relative to the working directory.
DEFAULT_OUTPUT_DIR = os.path.join(os.path.expanduser("~"), "Documents", "pictureBOM")

# Job state — one job at a time (SolidWorks is single-instance)
_job_lock = threading.Lock()
_job = {
    "running": False,
    "events": queue.Queue(),
    "output_dir": None,
}


# ---------------------------------------------------------------------------
# Settings persistence
# ---------------------------------------------------------------------------

def _load_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_settings(data):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# Serializes read-modify-write cycles on settings.json: the request thread
# (POST /api/settings) and the job worker (timing_history append) both merge
# into the file and would otherwise race and drop each other's writes.
_settings_lock = threading.Lock()


def _merge_settings(update_fn):
    """Load settings, apply update_fn(settings) in place, save — atomically."""
    with _settings_lock:
        settings = _load_settings()
        update_fn(settings)
        _save_settings(settings)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html", version=__version__), 200, {"Cache-Control": "no-cache"}


@app.route("/api/settings", methods=["GET"])
def get_settings():
    settings = _load_settings()
    if not settings.get("output_dir"):
        settings["output_dir"] = DEFAULT_OUTPUT_DIR
    return jsonify(settings)


@app.route("/api/settings", methods=["POST"])
def save_settings():
    # Merge into the existing file: the client only posts form fields, and a
    # full replace would erase server-written keys like timing_history.
    data = request.json or {}
    _merge_settings(lambda settings: settings.update(data))
    return jsonify({"ok": True})


@app.route("/api/version")
def get_version():
    return jsonify({"version": __version__})


@app.route("/api/browse", methods=["POST"])
def browse():
    """Open a native Windows file/folder dialog and return the selected path."""
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)

    mode = request.json.get("mode", "file")
    if mode == "folder":
        path = filedialog.askdirectory(title="Select Folder")
    elif mode == "csv":
        path = filedialog.askopenfilename(
            title="Select CSV File",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")],
        )
    elif mode == "excel":
        path = filedialog.askopenfilename(
            title="Select BOM Excel File",
            filetypes=[("Excel files", "*.xlsx"), ("All files", "*.*")],
        )
    else:
        path = filedialog.askopenfilename(
            title="Select SolidWorks Assembly",
            filetypes=[("SolidWorks Assembly", "*.sldasm"), ("All files", "*.*")],
        )

    root.destroy()
    return jsonify({"path": path or ""})


@app.route("/api/run", methods=["POST"])
def run_job():
    """Start the pictureBOM pipeline in a background thread."""
    with _job_lock:
        if _job["running"]:
            return jsonify({"error": "A job is already running."}), 409
        _job["running"] = True
        _job["events"] = queue.Queue()

    params = request.json
    output_dir = os.path.abspath(params.get("output_dir") or DEFAULT_OUTPUT_DIR)
    _job["output_dir"] = output_dir

    def worker():
        # COM requires per-thread initialization
        import pythoncom
        pythoncom.CoInitialize()
        try:
            def on_progress(current, total, part_name, success, image_path,
                            elapsed_seconds=0):
                _job["events"].put({
                    "type": "progress",
                    "current": current,
                    "total": total,
                    "part_name": part_name,
                    "success": success,
                    "image": os.path.basename(image_path) if image_path else None,
                    "elapsed_seconds": round(elapsed_seconds, 2),
                })

            def on_status(message):
                _job["events"].put({"type": "status", "message": message})

            result = picturebom.run_pipeline(
                assembly_path=params["assembly_path"],
                output_dir=output_dir,
                width=int(params.get("width", 1920)),
                height=int(params.get("height", 1080)),
                bom_mode=params.get("bom_mode", "flat"),
                csv_path=params.get("csv_path") or None,
                images_dir=params.get("images_dir") or None,
                debug=False,
                on_progress=on_progress,
                on_status=on_status,
                overwrite=True,
            )
            # Persist timing history for future estimates (skip if no capture data)
            timing = result.get("timing", {})
            if timing.get("per_component_avg") and result.get("total_components"):
                def append_run(settings):
                    runs = settings.get("timing_history", {}).get("runs", [])
                    runs.append({
                        "per_component_avg": timing["per_component_avg"],
                        "excel_seconds": timing["excel_seconds"],
                        "components": result["total_components"],
                    })
                    settings["timing_history"] = {"runs": runs[-20:]}
                _merge_settings(append_run)

            _job["events"].put({"type": "done", "result": result})
        except Exception as e:
            import traceback
            log.error("Job failed:\n%s", traceback.format_exc())
            _job["events"].put({"type": "error", "message": str(e)})
        finally:
            pythoncom.CoUninitialize()
            with _job_lock:
                _job["running"] = False

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"status": "started"})


@app.route("/api/progress")
def progress_stream():
    """SSE endpoint — streams progress events to the browser."""
    def generate():
        while True:
            try:
                event = _job["events"].get(timeout=30)
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                # Keep-alive heartbeat
                yield f"data: {json.dumps({'type': 'heartbeat'})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/quit", methods=["POST"])
def quit_server():
    """Shut down the server process."""
    os.kill(os.getpid(), signal.SIGTERM)
    return jsonify({"ok": True})


@app.route("/api/open-folder", methods=["POST"])
def open_folder():
    """Open the output directory in the system file explorer."""
    if not _job["output_dir"] or not os.path.isdir(_job["output_dir"]):
        return jsonify({"error": "Output directory not found"}), 404
    subprocess.Popen(["explorer", os.path.normpath(_job["output_dir"])])
    return jsonify({"ok": True})


@app.route("/api/images/<path:filename>")
def serve_image(filename):
    """Serve a captured image from the output directory."""
    if not _job["output_dir"]:
        return "No output directory", 404
    return send_from_directory(_job["output_dir"], filename)


@app.route("/api/download/<path:filename>")
def download_file(filename):
    """Serve the generated BOM file for download."""
    if not _job["output_dir"]:
        return "No output directory", 404
    return send_from_directory(_job["output_dir"], filename, as_attachment=True)


# ---------------------------------------------------------------------------
# BOM Comparison
# ---------------------------------------------------------------------------

_compare_state = {
    "output_dir": None,
    "image_dirs": [],  # [b_dir, a_dir] — search B first
}


@app.route("/api/recent-boms")
def recent_boms():
    """Return .xlsx files from the output directory, newest first."""
    settings = _load_settings()
    output_dir = os.path.abspath(settings.get("output_dir") or DEFAULT_OUTPUT_DIR)
    boms = []
    if os.path.isdir(output_dir):
        for fname in os.listdir(output_dir):
            # Skip comparison outputs — feeding them back into Compare is
            # meaningless and they'd crowd real BOMs out of the chip row.
            if fname.lower().endswith(".xlsx") and not fname.lower().startswith("comparison_"):
                full_path = os.path.join(output_dir, fname)
                boms.append({
                    "path": full_path,
                    "name": fname,
                    "modified": os.path.getmtime(full_path),
                })
    boms.sort(key=lambda b: b["modified"], reverse=True)
    return jsonify(boms[:20])


@app.route("/api/compare", methods=["POST"])
def compare():
    """Compare two BOM Excel files and return the results."""
    params = request.json
    bom_a = params.get("bom_a", "").strip()
    bom_b = params.get("bom_b", "").strip()

    if not bom_a or not bom_b:
        return jsonify({"error": "Both BOM files are required."}), 400
    if not os.path.isfile(bom_a):
        return jsonify({"error": f"File not found: {bom_a}"}), 400
    if not os.path.isfile(bom_b):
        return jsonify({"error": f"File not found: {bom_b}"}), 400

    try:
        result = picturebom.compare_boms(bom_a, bom_b)
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    # Generate comparison Excel
    settings = _load_settings()
    output_dir = os.path.abspath(settings.get("output_dir") or DEFAULT_OUTPUT_DIR)
    os.makedirs(output_dir, exist_ok=True)

    from datetime import datetime
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    excel_name = f"comparison_{timestamp}.xlsx"
    excel_path = os.path.join(output_dir, excel_name)
    picturebom.generate_comparison_excel(result, excel_path)

    # Store state for file serving
    _compare_state["output_dir"] = output_dir
    _compare_state["image_dirs"] = [
        os.path.dirname(os.path.abspath(bom_b)),
        os.path.dirname(os.path.abspath(bom_a)),
    ]

    # Build JSON response (image_path -> just the filename for the web UI)
    response_rows = []
    for row in result["rows"]:
        response_rows.append({
            "part_number": row["part_number"],
            "description": row["description"],
            "qty_a": row["qty_a"],
            "qty_b": row["qty_b"],
            "shortage": row["shortage"],
            "image": os.path.basename(row["image_path"]) if row["image_path"] else None,
        })

    return jsonify({
        "rows": response_rows,
        "summary": result["summary"],
        "bom_a": result["bom_a"],
        "bom_b": result["bom_b"],
        "excel_filename": excel_name,
    })


@app.route("/api/compare/download/<path:filename>")
def compare_download(filename):
    """Serve the comparison Excel file for download."""
    if not _compare_state["output_dir"]:
        return "No comparison output", 404
    return send_from_directory(_compare_state["output_dir"], filename,
                               as_attachment=True)


@app.route("/api/compare/images/<path:filename>")
def compare_image(filename):
    """Serve a part image from either BOM's directory (tries B first)."""
    for img_dir in _compare_state["image_dirs"]:
        full_path = os.path.join(img_dir, filename)
        if os.path.isfile(full_path):
            return send_from_directory(img_dir, filename)
    return "Image not found", 404


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    port = int(os.environ.get("PORT", 5000))
    # Open browser after a short delay so the server is ready
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    print(f"Starting pictureBOM GUI at http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
