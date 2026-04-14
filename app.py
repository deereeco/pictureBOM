"""
pictureBOM Web GUI — Flask-based interface for pictureBOM.

Usage:
    python app.py
    # Opens browser to http://127.0.0.1:5000
"""

import json
import logging
import os
import queue
import sys
import threading
import webbrowser

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

import picturebom

# Detect PyInstaller frozen bundle
if getattr(sys, "frozen", False):
    _base_dir = sys._MEIPASS
else:
    _base_dir = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(_base_dir, "templates"),
    static_folder=os.path.join(_base_dir, "static"),
)

log = logging.getLogger(__name__)

# Settings file location
SETTINGS_PATH = os.path.join(os.path.expanduser("~"), ".picturebom", "settings.json")

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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify(_load_settings())


@app.route("/api/settings", methods=["POST"])
def save_settings():
    _save_settings(request.json)
    return jsonify({"ok": True})


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
    output_dir = os.path.abspath(params.get("output_dir", "./output"))
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
                settings = _load_settings()
                runs = settings.get("timing_history", {}).get("runs", [])
                runs.append({
                    "per_component_avg": timing["per_component_avg"],
                    "excel_seconds": timing["excel_seconds"],
                    "components": result["total_components"],
                })
                settings["timing_history"] = {"runs": runs[-20:]}
                _save_settings(settings)

            _job["events"].put({"type": "done", "result": result})
        except Exception as e:
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
