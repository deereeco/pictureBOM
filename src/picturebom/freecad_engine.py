"""
FreeCAD as pictureBOM's CAD engine for STEP files.

pictureBOM never imports FreeCAD. It finds a FreeCAD installation, launches
freecad.exe with its own private configuration (so the user's FreeCAD
settings are untouched) and hands it freecad_worker.py plus a job file. The
worker imports the STEP, renders the part pictures, exports the glTF model
and streams progress back through a small events file. See
freecad_worker.py for the other half.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

FREECAD_MIN_VERSION = (1, 0)
CONFIG_VERSION = 1   # bump when the generated user.cfg changes
DEFAULT_TIMEOUT_S = 60 * 60
EXIT_GRACE_S = 15    # how long to wait for FreeCAD to exit after it reported done

WINGET_HINT = "winget install FreeCAD.FreeCAD"
DOWNLOAD_URL = "https://www.freecad.org/downloads.php"

_VERSION_RE = re.compile(r"(\d+)\.(\d+)(?:\.(\d+))?")


class FreeCADError(Exception):
    """FreeCAD could not be found or the worker did not finish."""


class FreeCADNotFound(FreeCADError):
    pass


def _config_home():
    return os.path.join(os.path.expanduser("~"), ".picturebom", "freecad")


# ---------------------------------------------------------------------------
# Locating FreeCAD
# ---------------------------------------------------------------------------

def _candidate_dirs():
    roots = []
    for var in ("LOCALAPPDATA",):
        base = os.environ.get(var)
        if base:
            roots.append(os.path.join(base, "Programs"))
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = os.environ.get(var)
        if base:
            roots.append(base)
    seen = set()
    for root in roots:
        for d in sorted(glob.glob(os.path.join(root, "FreeCAD*")), reverse=True):
            if d.lower() not in seen and os.path.isdir(d):
                seen.add(d.lower())
                yield d


def _exe_from(path):
    """Resolve a user-supplied path (exe, bin dir or install dir) to freecad.exe."""
    if not path:
        return None
    path = os.path.expandvars(os.path.expanduser(str(path).strip().strip('"')))
    if os.path.isfile(path):
        return path
    for rel in ("freecad.exe", os.path.join("bin", "freecad.exe"), "FreeCAD.exe",
                os.path.join("bin", "FreeCAD.exe")):
        cand = os.path.join(path, rel)
        if os.path.isfile(cand):
            return cand
    return None


def _version_of(exe):
    """Version from the install folder name ("FreeCAD 1.1" -> "1.1"), else ""."""
    for part in reversed(os.path.normpath(exe).split(os.sep)):
        m = _VERSION_RE.search(part)
        if m and "freecad" in part.lower():
            return m.group(0)
    return ""


def _version_tuple(text):
    m = _VERSION_RE.search(text or "")
    if not m:
        return None
    return tuple(int(x) for x in m.groups() if x is not None)


def find_freecad(explicit=None):
    """Locate freecad.exe.

    Order: explicit path (setting/flag), PICTUREBOM_FREECAD env var, per-user
    installs (%LOCALAPPDATA%\\Programs\\FreeCAD*), machine installs (Program
    Files), then PATH. Returns {"exe", "version", "source"} or None.
    """
    tried = []
    for source, cand in (("setting", explicit),
                         ("environment", os.environ.get("PICTUREBOM_FREECAD"))):
        if cand:
            exe = _exe_from(cand)
            if exe:
                return {"exe": exe, "version": _version_of(exe), "source": source}
            tried.append(str(cand))

    def found(exe, source):
        info = {"exe": exe, "version": _version_of(exe), "source": source}
        if tried:
            # A configured path that does not exist must not silently pass:
            # say which one was ignored so the user can fix or clear it.
            info["ignored"] = tried[0]
        return info

    for d in _candidate_dirs():
        exe = _exe_from(d)
        if exe:
            return found(exe, "installed")
    which = shutil.which("freecad") or shutil.which("FreeCAD")
    if which:
        return found(which, "PATH")
    return None


def describe_missing(explicit=None):
    msg = ("FreeCAD was not found on this machine. Install it with "
           f"\"{WINGET_HINT}\" (or from {DOWNLOAD_URL}), or point pictureBOM at "
           "your FreeCAD folder under Advanced.")
    if explicit:
        msg = f"FreeCAD was not found at {explicit!r}. " + msg
    return msg


def check_version(info):
    """Warning string when the found FreeCAD looks older than supported, else None."""
    v = _version_tuple(info.get("version", ""))
    if v and v < FREECAD_MIN_VERSION:
        return (f"FreeCAD {info['version']} found; pictureBOM was tested with "
                f"{'.'.join(map(str, FREECAD_MIN_VERSION))} or newer — the run "
                "will be attempted anyway.")
    return None


# ---------------------------------------------------------------------------
# Private FreeCAD configuration
# ---------------------------------------------------------------------------

_USER_CFG = """<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FCParameters>
  <FCParamGroup Name="Root">
    <FCParamGroup Name="BaseApp">
      <FCParamGroup Name="Preferences">
        <FCParamGroup Name="General">
          <FCBool Name="ShowSplasher" Value="0"/>
          <FCText Name="AutoloadModule">PartWorkbench</FCText>
          <FCText Name="BackgroundAutoloadModules"></FCText>
        </FCParamGroup>
        <FCParamGroup Name="Document">
          <FCBool Name="DuplicateLabels" Value="1"/>
          <FCBool Name="AutoSaveEnabled" Value="0"/>
          <FCBool Name="CreateNewDoc" Value="0"/>
        </FCParamGroup>
        <FCParamGroup Name="View">
          <FCInt Name="AntiAliasing" Value="3"/>
          <FCBool Name="ShowNaviCube" Value="0"/>
          <FCBool Name="CornerCoordSystem" Value="0"/>
          <FCBool Name="ShowAxisCross" Value="0"/>
          <FCBool Name="Gradient" Value="0"/>
        </FCParamGroup>
        <FCParamGroup Name="Mod">
          <FCParamGroup Name="Start">
            <FCBool Name="ShowOnStartup" Value="0"/>
            <FCBool Name="FirstStart2024" Value="0"/>
          </FCParamGroup>
          <FCParamGroup Name="AddonManager">
            <FCBool Name="AutoCheck" Value="0"/>
          </FCParamGroup>
          <FCParamGroup Name="Import">
            <FCBool Name="ShowProgress" Value="0"/>
            <FCBool Name="UseLinkGroup" Value="0"/>
            <FCBool Name="ReduceObjects" Value="0"/>
            <FCBool Name="ExpandCompound" Value="0"/>
            <FCBool Name="UseBaseName" Value="1"/>
            <FCBool Name="ImportHiddenObject" Value="1"/>
            <FCInt Name="ImportMode" Value="0"/>
            <FCParamGroup Name="hSTEP">
              <FCBool Name="ReadShapeCompoundMode" Value="1"/>
            </FCParamGroup>
          </FCParamGroup>
        </FCParamGroup>
      </FCParamGroup>
    </FCParamGroup>
  </FCParamGroup>
</FCParameters>
"""

_SYSTEM_CFG = """<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FCParameters>
  <FCParamGroup Name="Root">
  </FCParamGroup>
</FCParameters>
"""


def ensure_config(config_dir=None):
    """Write pictureBOM's private FreeCAD user/system config. Returns (user, system).

    FreeCAD rewrites its config on exit (window geometry and the like), so the
    file is only regenerated when pictureBOM's template version changes.
    """
    config_dir = config_dir or _config_home()
    os.makedirs(config_dir, exist_ok=True)
    user_cfg = os.path.join(config_dir, "user.cfg")
    system_cfg = os.path.join(config_dir, "system.cfg")
    stamp = os.path.join(config_dir, "config_version.txt")
    current = None
    try:
        with open(stamp, encoding="utf-8") as f:
            current = int(f.read().strip())
    except (OSError, ValueError):
        pass
    if current != CONFIG_VERSION or not os.path.isfile(user_cfg):
        with open(user_cfg, "w", encoding="utf-8") as f:
            f.write(_USER_CFG)
        with open(system_cfg, "w", encoding="utf-8") as f:
            f.write(_SYSTEM_CFG)
        with open(stamp, "w", encoding="utf-8") as f:
            f.write(str(CONFIG_VERSION))
    return user_cfg, system_cfg


# ---------------------------------------------------------------------------
# Running the worker
# ---------------------------------------------------------------------------

def worker_script():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "freecad_worker.py")


def _tail(path, lines=25):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            data = f.read().splitlines()
        return "\n".join(data[-lines:])
    except OSError:
        return ""


def run_job(freecad, job, on_status=None, on_progress=None, timeout_s=DEFAULT_TIMEOUT_S,
            keep_dir=False):
    """Run one STEP job in FreeCAD and return the worker's result dict.

    job keys: step_path, parts [{product, is_assembly}], images [{name,
    product, is_assembly, body_index, image_path}], width, height, glb_path
    (or None), root_product, body_names (for a multibody part read as an
    assembly), line_width.

    on_status(message) and on_progress(current, total, name, success,
    image_path, elapsed_seconds=...) are called as the worker reports.
    Raises FreeCADError when FreeCAD fails to start, times out, or exits
    without writing a result; the message names the log file to look at.
    """
    exe = freecad["exe"]
    user_cfg, system_cfg = ensure_config()
    work_dir = tempfile.mkdtemp(prefix="picturebom-freecad-")
    job_path = os.path.join(work_dir, "job.json")
    events_path = os.path.join(work_dir, "events.jsonl")
    result_path = os.path.join(work_dir, "result.json")
    log_path = os.path.join(work_dir, "freecad.log")
    with open(job_path, "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=1)

    env = dict(os.environ)
    env["PB_JOB"] = job_path
    cmd = [exe, "-u", user_cfg, "-s", system_cfg, "--log-file", log_path,
           worker_script()]
    stdout = open(os.path.join(work_dir, "stdout.txt"), "w", encoding="utf-8")
    try:
        proc = subprocess.Popen(cmd, env=env, cwd=work_dir, stdout=stdout,
                                stderr=subprocess.STDOUT)
    except OSError as e:
        stdout.close()
        raise FreeCADError(f"Could not start FreeCAD ({exe}): {e}")

    deadline = time.time() + timeout_s
    offset = 0
    buffer = ""
    done = False
    done_at = None

    def pump():
        nonlocal offset, buffer, done, done_at
        if not os.path.isfile(events_path):
            return
        with open(events_path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(offset)
            chunk = f.read()
            offset = f.tell()
        if not chunk:
            return
        buffer += chunk
        lines = buffer.split("\n")
        buffer = lines.pop()  # possibly incomplete last line
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind = ev.get("type")
            if kind == "status" and on_status:
                on_status(ev.get("message", ""))
            elif kind == "progress" and on_progress:
                on_progress(ev.get("current", 0), ev.get("total", 0), ev.get("name", ""),
                            bool(ev.get("success")), ev.get("image"),
                            elapsed_seconds=ev.get("elapsed_seconds", 0))
            elif kind == "done":
                done = True
                done_at = time.time()
            elif kind == "error" and on_status:
                on_status("FreeCAD reported an error: " + str(ev.get("message", "")))

    try:
        while True:
            pump()
            code = proc.poll()
            if code is not None:
                pump()
                break
            if done and done_at and time.time() - done_at > EXIT_GRACE_S:
                proc.kill()
                break
            if time.time() > deadline:
                proc.kill()
                raise FreeCADError(
                    f"FreeCAD did not finish within {timeout_s // 60} minutes; "
                    f"see {log_path}")
            time.sleep(0.2)
    finally:
        stdout.close()

    if not os.path.isfile(result_path):
        tail = _tail(os.path.join(work_dir, "stdout.txt")) or _tail(log_path)
        raise FreeCADError(
            "FreeCAD exited without producing a result (exit code "
            f"{proc.returncode}). Log: {log_path}"
            + (f"\n{tail}" if tail else ""))
    with open(result_path, encoding="utf-8") as f:
        result = json.load(f)
    result["work_dir"] = work_dir
    result["log_path"] = log_path
    if not result.get("ok"):
        raise FreeCADError(
            "FreeCAD failed while reading the STEP file: "
            f"{result.get('error', 'unknown error')}. Log: {log_path}")
    if not keep_dir:
        shutil.rmtree(work_dir, ignore_errors=True)
        result["work_dir"] = None
    return result
