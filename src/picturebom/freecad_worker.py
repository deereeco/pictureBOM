"""
pictureBOM's FreeCAD worker — runs INSIDE freecad.exe, never imported by pictureBOM.

freecad_engine.py launches FreeCAD with this file as the script to execute
and a job description in the PB_JOB environment variable (path of a JSON
file). The worker imports the STEP, renders one picture per requested part,
exports the whole model to glTF, and reports back through two files next to
the job: events.jsonl (one JSON object per line, streamed while it runs) and
result.json (written once at the end).

Runs on FreeCAD's bundled Python (3.11 as of FreeCAD 1.1): standard library
only, no pictureBOM imports, no f-string features newer than 3.8.
"""

import json
import os
import sys
import time
import traceback

JOB_PATH = os.environ.get("PB_JOB")
_events = None
T_START = time.time()


def emit(kind, **data):
    data["type"] = kind
    data["t"] = round(time.time() - T_START, 3)
    line = json.dumps(data, ensure_ascii=False)
    if _events is not None:
        _events.write(line + "\n")
        _events.flush()
    try:
        import FreeCAD
        FreeCAD.Console.PrintMessage("[picturebom] " + line + "\n")
    except Exception:
        pass


def status(message):
    emit("status", message=message)


def quit_freecad():
    """Ask Qt to leave the event loop once the script returns."""
    try:
        try:
            from PySide import QtCore
        except ImportError:
            from PySide6 import QtCore  # noqa
        QtCore.QTimer.singleShot(100, QtCore.QCoreApplication.quit)
    except Exception:
        os._exit(0)


def hard_exit():
    """Skip FreeCAD's document teardown — everything we produced is on disk."""
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(0)


# ---------------------------------------------------------------------------

def _label_index(doc):
    """{label: [objects]} for the imported shapes and containers."""
    index = {}
    for obj in doc.Objects:
        if obj.isDerivedFrom("Part::Feature") or obj.TypeId == "App::Part":
            index.setdefault(obj.Label, []).append(obj)
    return index


def _find(index, name, want_container):
    """Best object for a STEP product name: exact label first, then casefold."""
    objs = index.get(name)
    if objs is None:
        fold = name.casefold()
        for label, cands in index.items():
            if label.casefold() == fold or label.strip().casefold() == fold:
                objs = cands
                break
    if not objs:
        return None
    containers = [o for o in objs if o.TypeId == "App::Part"]
    features = [o for o in objs if o.isDerivedFrom("Part::Feature")]
    if want_container and containers:
        return containers[0]
    if features:
        return features[0]
    return containers[0] if containers else None


def _local_shape(obj):
    """The object's geometry in its own coordinate system (assembly placement removed)."""
    import FreeCAD
    import Part
    if obj.TypeId == "App::Part":
        shp = Part.getShape(obj)
        if shp.isNull():
            return shp
        return shp.transformed(obj.Placement.inverse().toMatrix())
    shp = obj.Shape.copy()
    shp.Placement = FreeCAD.Placement()
    return shp


def _face_colors(obj):
    """Per-face RGB list for a feature, or None when unavailable/mismatched."""
    try:
        vo = obj.ViewObject
        cols = list(vo.DiffuseColor)
        faces = len(obj.Shape.Faces)
        if len(cols) == faces and faces > 0:
            return [tuple(c[:3]) for c in cols]
        if len(cols) == 1:
            return [tuple(cols[0][:3])] * faces
    except Exception:
        pass
    return None


def _shape_color(obj):
    """One representative colour (0..1 floats) for a feature or container."""
    try:
        if obj.TypeId == "App::Part":
            for child in obj.Group:
                c = _shape_color(child)
                if c:
                    return c
            return None
        cols = _face_colors(obj)
        if cols:
            # Dominant colour by face count (an area weighting would be nicer,
            # but the first-order picture is what the glTF carries anyway).
            counts = {}
            for c in cols:
                key = tuple(round(x, 3) for x in c)
                counts[key] = counts.get(key, 0) + 1
            return max(counts.items(), key=lambda kv: kv[1])[0]
        c = obj.ViewObject.ShapeColor
        return tuple(c[:3])
    except Exception:
        return None


def _container_face_colors(obj, shape):
    """Per-face colours for a container's compound, child by child."""
    import Part
    out = []
    for child in obj.Group:
        if child.isDerivedFrom("Part::Feature"):
            cols = _face_colors(child)
            n = len(child.Shape.Faces)
            if cols is None:
                base = _shape_color(child) or (0.8, 0.8, 0.8)
                cols = [base] * n
            out.extend(cols)
        elif child.TypeId == "App::Part":
            sub = Part.getShape(child)
            out.extend(_container_face_colors(child, sub))
    if len(out) == len(shape.Faces):
        return out
    return None


def _bodies(shape):
    """Bodies in the order the STEP census counts them: solids, else shells."""
    solids = list(shape.Solids)
    if solids:
        return solids
    return list(shape.Shells)


def _hex(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, c)) * 255)) for c in rgb)


def _opaque_alpha():
    """Fourth component of a DiffuseColor entry meaning "opaque".

    FreeCAD 1.0 switched colour tuples from (r, g, b, transparency) to
    (r, g, b, alpha): the same 0.0 that used to mean opaque now hides the face.
    """
    import FreeCAD
    try:
        major = int(FreeCAD.Version()[0])
    except (ValueError, IndexError, TypeError):
        major = 1
    return 1.0 if major >= 1 else 0.0


class Renderer:
    """One scratch document + one feature reused for every picture."""

    def __init__(self, width, height, line_width):
        import FreeCAD
        import FreeCADGui
        self.width = width
        self.height = height
        self.alpha = _opaque_alpha()
        self.doc = FreeCAD.newDocument("picturebom_render")
        self.feat = self.doc.addObject("Part::Feature", "Part")
        vo = self.feat.ViewObject
        vo.DisplayMode = "Flat Lines"
        vo.LineWidth = line_width
        vo.LineColor = (0.14, 0.16, 0.19)
        vo.PointSize = 1.0
        self.view = FreeCADGui.getDocument(self.doc.Name).ActiveView
        self.view.setCameraType("Orthographic")

    def render(self, shape, face_colors, base_color, path):
        self.feat.Shape = shape
        vo = self.feat.ViewObject
        n = max(1, len(shape.Faces))
        a = self.alpha
        if face_colors and len(face_colors) == len(shape.Faces):
            vo.DiffuseColor = [tuple(c[:3]) + (a,) for c in face_colors]
        elif base_color:
            vo.ShapeColor = tuple(base_color[:3])
            vo.DiffuseColor = [tuple(base_color[:3]) + (a,)] * n
        else:
            vo.ShapeColor = (0.78, 0.82, 0.85)
            vo.DiffuseColor = [(0.78, 0.82, 0.85, a)] * n
        self.doc.recompute()
        self.view.viewIsometric()
        self.view.fitAll()
        self.view.saveImage(path, self.width, self.height, "White")
        return os.path.isfile(path) and os.path.getsize(path) > 0

    def close(self):
        import FreeCAD
        try:
            FreeCAD.closeDocument(self.doc.Name)
        except Exception:
            pass


def run(job):
    import FreeCAD
    import FreeCADGui
    import Part

    result = {
        "ok": False,
        "freecad_version": ".".join(str(x) for x in FreeCAD.Version()[:3]),
        "images": {},
        "parts": {},
        "glb": None,
        "warnings": [],
        "timings": {},
    }

    try:
        mw = FreeCADGui.getMainWindow()
        if mw is not None:
            mw.hide()
    except Exception:
        pass

    step_path = job["step_path"]
    status("FreeCAD %s: importing %s..." % (result["freecad_version"], os.path.basename(step_path)))
    t0 = time.time()
    import ImportGui
    doc = FreeCAD.newDocument("picturebom_import")
    ImportGui.insert(step_path, doc.Name)
    doc.recompute()
    result["timings"]["import_seconds"] = round(time.time() - t0, 2)
    status("Imported %d objects in %.1f s" % (len(doc.Objects), time.time() - t0))

    index = _label_index(doc)
    unmatched = []

    # ---- census + colours for every product pictureBOM asked about ----
    for spec in job.get("parts", []):
        obj = _find(index, spec["product"], spec.get("is_assembly", False))
        if obj is None:
            unmatched.append(spec["product"])
            continue
        entry = {"found": True}
        try:
            shp = obj.Shape if obj.isDerivedFrom("Part::Feature") else Part.getShape(obj)
            if shp is not None and not shp.isNull():
                entry["solids"] = len(shp.Solids)
                entry["shells"] = 0 if shp.Solids else len(shp.Shells)
        except Exception:
            pass
        col = _shape_color(obj)
        if col:
            entry["color"] = _hex(col)
        result["parts"][spec["product"]] = entry
    if unmatched:
        result["warnings"].append(
            "%d STEP product(s) were not found among FreeCAD's imported objects: %s"
            % (len(unmatched), ", ".join(unmatched[:5]) + ("..." if len(unmatched) > 5 else "")))

    # ---- pictures ----
    images = job.get("images", [])
    if images:
        renderer = Renderer(job.get("width", 1920), job.get("height", 1080),
                            job.get("line_width", 2.0))
        total = len(images)
        t_render = time.time()
        for i, spec in enumerate(images, 1):
            t1 = time.time()
            ok = False
            try:
                obj = _find(index, spec["product"], spec.get("is_assembly", False))
                if obj is not None:
                    shp = _local_shape(obj)
                    body_index = spec.get("body_index")
                    face_colors = None
                    if body_index:
                        bodies = _bodies(shp)
                        if 1 <= body_index <= len(bodies):
                            shp = bodies[body_index - 1]
                        else:
                            result["warnings"].append(
                                "%s: body %d not found (%d bodies)"
                                % (spec["product"], body_index, len(bodies)))
                    elif obj.TypeId == "App::Part":
                        face_colors = _container_face_colors(obj, shp)
                    else:
                        face_colors = _face_colors(obj)
                    if shp is not None and not shp.isNull():
                        ok = renderer.render(shp, face_colors, _shape_color(obj), spec["image_path"])
            except Exception as e:  # keep going — one bad part must not sink the run
                result["warnings"].append("%s: picture failed (%s)" % (spec["name"], e))
                FreeCAD.Console.PrintError(traceback.format_exc())
            result["images"][spec["name"]] = spec["image_path"] if ok else None
            emit("progress", current=i, total=total, name=spec["name"], success=ok,
                 image=spec["image_path"] if ok else None,
                 elapsed_seconds=round(time.time() - t1, 3))
        renderer.close()
        result["timings"]["render_seconds"] = round(time.time() - t_render, 2)

    # ---- 3D model ----
    glb_path = job.get("glb_path")
    if glb_path:
        status("Exporting 3D model...")
        t2 = time.time()
        try:
            root_prod = job.get("root_product")
            body_names = job.get("body_names") or []
            if body_names and root_prod:
                # Multibody part read as an assembly: one node per body so the
                # 3D viewer can link each body to its own BOM row.
                obj = _find(index, root_prod, False)
                if obj is not None:
                    shp = obj.Shape
                    bodies = _bodies(shp)
                    base = _shape_color(obj) or (0.78, 0.82, 0.85)
                    parent_list = [p for p in obj.InList if p.TypeId == "App::Part"]
                    for n, body in zip(body_names, bodies):
                        f = doc.addObject("Part::Feature", "Body")
                        f.Label = n
                        f.Shape = body
                        f.ViewObject.ShapeColor = tuple(base)
                        for p in parent_list:
                            p.addObject(f)
                    doc.removeObject(obj.Name)
                    doc.recompute()
            roots = [o for o in doc.Objects if not o.InList
                     and (o.TypeId == "App::Part" or o.isDerivedFrom("Part::Feature"))]
            ImportGui.export(roots, glb_path)
            if os.path.isfile(glb_path) and os.path.getsize(glb_path) > 12:
                result["glb"] = glb_path
                status("3D model exported (%.1f MB)" % (os.path.getsize(glb_path) / 1e6))
            else:
                result["warnings"].append("FreeCAD wrote no glTF file")
        except Exception as e:
            result["warnings"].append("glTF export failed: %s" % e)
            FreeCAD.Console.PrintError(traceback.format_exc())
        result["timings"]["glb_seconds"] = round(time.time() - t2, 2)

    result["ok"] = True
    result["timings"]["total_seconds"] = round(time.time() - T_START, 2)
    return result


def main():
    global _events
    if not JOB_PATH or not os.path.isfile(JOB_PATH):
        sys.stderr.write("picturebom worker: PB_JOB not set or missing\n")
        hard_exit()
    with open(JOB_PATH, "r", encoding="utf-8") as f:
        job = json.load(f)
    work_dir = os.path.dirname(os.path.abspath(JOB_PATH))
    _events = open(os.path.join(work_dir, "events.jsonl"), "a", encoding="utf-8")
    result_path = os.path.join(work_dir, "result.json")
    try:
        result = run(job)
    except Exception as e:
        result = {"ok": False, "error": str(e), "traceback": traceback.format_exc()}
        emit("error", message=str(e))
    tmp = result_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    os.replace(tmp, result_path)
    emit("done", ok=bool(result.get("ok")))
    _events.close()
    if job.get("hard_exit", True):
        hard_exit()
    quit_freecad()


main()
