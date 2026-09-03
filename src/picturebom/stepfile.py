"""
Read the product structure of a STEP file (ISO 10303-21) without a CAD kernel.

A STEP file is plain text. The entities that describe *what* is in the file
(products, the assembly tree, how many bodies each part has) are a tiny
fraction of it — the rest is geometry we never need to look at here. This
module pulls out just that structure so pictureBOM can:

* scan a file the moment the user picks it (single part or assembly? how
  many parts? which CAD system wrote it?),
* build BOM rows in exactly the shape the SolidWorks traversal produces,
  so every downstream writer (Excel, CSV, the 3D BOM) works unchanged,
* name parts the same way FreeCAD names them when it imports the file,
  so pictures and 3D nodes line up with BOM rows.

Geometry, pictures and the glTF model come from a CAD engine (FreeCAD, see
freecad_engine.py); this module deliberately has no dependencies.
"""

import os
import re
from collections import OrderedDict

STEP_EXTENSIONS = (".step", ".stp")

# Document types shared with core.py (kept literal so this module stays
# import-light; core asserts they agree).
DOC_PART = 1
DOC_ASSEMBLY = 2

_SOLID_TYPES = {"MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP"}
_SURFACE_TYPES = {"SHELL_BASED_SURFACE_MODEL"}
_PD_TYPES = {"PRODUCT_DEFINITION", "PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS"}
_SHAPE_REP_TYPES = {
    "SHAPE_REPRESENTATION",
    "ADVANCED_BREP_SHAPE_REPRESENTATION",
    "MANIFOLD_SURFACE_SHAPE_REPRESENTATION",
    "FACETED_BREP_SHAPE_REPRESENTATION",
    "GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION",
    "GEOMETRICALLY_BOUNDED_WIREFRAME_SHAPE_REPRESENTATION",
}

# Only these entity types are parsed. The alternation is anchored on the
# opening parenthesis so PRODUCT never swallows PRODUCT_CONTEXT etc.
_WANTED_TYPES = sorted(
    {"PRODUCT", "NEXT_ASSEMBLY_USAGE_OCCURRENCE", "PRODUCT_DEFINITION_SHAPE",
     "SHAPE_DEFINITION_REPRESENTATION", "SHAPE_REPRESENTATION_RELATIONSHIP",
     "STYLED_ITEM"}
    | _PD_TYPES | _SHAPE_REP_TYPES | _SOLID_TYPES | _SURFACE_TYPES,
    key=len, reverse=True)
_ENTITY_RE = re.compile(
    r"#(\d+)\s*=\s*(PRODUCT_DEFINITION_FORMATION[A-Z_]*|"
    + "|".join(re.escape(t) for t in _WANTED_TYPES)
    + r")\s*\((.*?)\)\s*;",
    re.S)
_HEADER_RE = re.compile(r"(FILE_NAME|FILE_SCHEMA|FILE_DESCRIPTION)\s*\((.*?)\)\s*;", re.S)
_REF_RE = re.compile(r"#(\d+)")

_SCHEMA_LABELS = (
    ("AP242", "AP242"),
    ("AUTOMOTIVE_DESIGN", "AP214"),
    ("CONFIG_CONTROL_DESIGN", "AP203"),
    ("AP203", "AP203"),
    ("AP214", "AP214"),
)


class StepError(Exception):
    """The file is not a STEP file pictureBOM can read."""


def is_step_file(path):
    """True when the path has a STEP extension (.step/.stp, any case)."""
    return bool(path) and str(path).lower().endswith(STEP_EXTENSIONS)


def root_name_for(path):
    """Output base name for a STEP input: the file stem, trimmed.

    File names like "Domitron 3d Printer .STEP" carry a trailing space that
    would otherwise land in the middle of every output name.
    """
    return os.path.splitext(os.path.basename(path))[0].strip() or "STEP"


# ---------------------------------------------------------------------------
# Low-level text helpers
# ---------------------------------------------------------------------------

def decode_string(raw):
    """Decode a STEP string literal body (without its quotes).

    Handles the ISO 10303-21 escapes CAD exporters actually emit: doubled
    quotes, \\X2\\...\\X0\\ (UTF-16) and \\X4\\...\\X0\\ (UTF-32) runs,
    \\X\\hh single bytes and \\S\\c shifted characters. SolidWorks writes
    the "é" of "Défaut" as \\X2\\00E9\\X0\\.
    """
    s = raw.replace("''", "'")

    def _utf16(m):
        try:
            return bytes.fromhex(m.group(1)).decode("utf-16-be")
        except (ValueError, UnicodeDecodeError):
            return m.group(0)

    def _utf32(m):
        try:
            return bytes.fromhex(m.group(1)).decode("utf-32-be")
        except (ValueError, UnicodeDecodeError):
            return m.group(0)

    s = re.sub(r"\\X2\\([0-9A-Fa-f]+)\\X0\\", _utf16, s)
    s = re.sub(r"\\X4\\([0-9A-Fa-f]+)\\X0\\", _utf32, s)
    s = re.sub(r"\\X\\([0-9A-Fa-f]{2})", lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r"\\S\\(.)", lambda m: chr((ord(m.group(1)) + 128) & 0xFF), s)
    return s.replace("\\\\", "\\")


def _split_args(s):
    """Split an entity's argument text at top-level commas."""
    out, depth, cur, instr = [], 0, [], False
    for ch in s:
        if ch == "'":
            instr = not instr
        if not instr:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                out.append("".join(cur).strip())
                cur = []
                continue
        cur.append(ch)
    tail = "".join(cur).strip()
    if tail or out:
        out.append(tail)
    return out


def _ref(tok):
    tok = (tok or "").strip()
    return int(tok[1:]) if tok.startswith("#") and tok[1:].isdigit() else None


def _text(tok):
    tok = (tok or "").strip()
    if len(tok) >= 2 and tok[0] == "'" and tok[-1] == "'":
        return decode_string(tok[1:-1])
    return ""


def _refs_in(tok):
    return [int(x) for x in _REF_RE.findall(tok or "")]


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------

class Product:
    """One product definition (a part or assembly file in CAD terms)."""

    __slots__ = ("pd_id", "name", "description", "children", "solids",
                 "surfaces")

    def __init__(self, pd_id, name, description):
        self.pd_id = pd_id
        self.name = name
        self.description = description
        self.children = []   # child pd_ids, one entry per occurrence, file order
        self.solids = 0
        self.surfaces = 0

    @property
    def is_assembly(self):
        return bool(self.children)

    @property
    def body_count(self):
        return self.solids + self.surfaces


class Structure:
    """Parsed product structure of one STEP file."""

    def __init__(self, path):
        self.path = path
        self.file_name = os.path.basename(path)
        self.root_name = root_name_for(path)
        self.schema = ""
        self.originating_system = ""
        self.preprocessor = ""
        self.products = OrderedDict()   # pd_id -> Product (file order)
        self.roots = []                 # pd_ids with no parent
        self.styled_items = 0
        self.warnings = []

    # -- derived facts ------------------------------------------------------

    @property
    def exporter(self):
        """Human label for the writing system, e.g. "SolidWorks 2024"."""
        return (self.originating_system or self.preprocessor or "").strip()

    @property
    def has_colors(self):
        return self.styled_items > 0

    @property
    def single_product(self):
        """True for a part file: one root with no occurrences beneath it."""
        return len(self.roots) == 1 and not self.products[self.roots[0]].is_assembly

    def root(self):
        return self.products[self.roots[0]] if self.roots else None

    def walk(self):
        """Yield (depth, product, occurrence_count, parent) in tree order,
        one entry per distinct child under each parent."""
        def rec(pd_id, depth, seen):
            parent = self.products[pd_id]
            groups = OrderedDict()
            for child in parent.children:
                groups.setdefault(child, 0)
                groups[child] += 1
            for child, count in groups.items():
                yield depth, self.products[child], count, parent
                if self.products[child].is_assembly and child not in seen:
                    yield from rec(child, depth + 1, seen | {child})
        for r in self.roots:
            yield from rec(r, 1, {r})

    def leaf_parts(self):
        """Distinct part (non-assembly) products, tree order."""
        seen, out = set(), []
        for _depth, prod, _count, _parent in self.walk():
            if not prod.is_assembly and prod.pd_id not in seen:
                seen.add(prod.pd_id)
                out.append(prod)
        if not out and self.roots:
            out = [self.products[r] for r in self.roots
                   if not self.products[r].is_assembly]
        return out

    def assemblies(self):
        seen, out = set(), []
        for _depth, prod, _count, _parent in self.walk():
            if prod.is_assembly and prod.pd_id not in seen:
                seen.add(prod.pd_id)
                out.append(prod)
        return out

    def instance_count(self):
        """Total part occurrences with assembly multiplicity applied."""
        total = 0

        def rec(pd_id, mult, seen):
            nonlocal total
            for child in self.products[pd_id].children:
                prod = self.products[child]
                if prod.is_assembly:
                    if child not in seen:
                        rec(child, mult, seen | {child})
                else:
                    total += mult
        for r in self.roots:
            rec(r, 1, {r})
        return total

    def depth(self):
        return max((d for d, *_ in self.walk()), default=0)


def _schema_label(raw):
    up = (raw or "").upper()
    for key, label in _SCHEMA_LABELS:
        if key in up:
            return label
    return raw.strip("' ") if raw else ""


def read_structure(path):
    """Parse the product structure of a STEP file. Raises StepError."""
    if not os.path.isfile(path):
        raise StepError(f"STEP file not found: {path}")
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    if "ISO-10303-21" not in text[:2000]:
        raise StepError("Not a STEP file (missing the ISO-10303-21 header): "
                        f"{os.path.basename(path)}")
    head, sep, body = text.partition("DATA;")
    if not sep:
        raise StepError("STEP file has no DATA section: "
                        f"{os.path.basename(path)}")

    st = Structure(path)
    for m in _HEADER_RE.finditer(head):
        args = _split_args(m.group(2))
        if m.group(1) == "FILE_NAME" and len(args) >= 6:
            st.preprocessor = _text(args[4])
            st.originating_system = _text(args[5])
        elif m.group(1) == "FILE_SCHEMA":
            st.schema = _schema_label(m.group(2))

    ents = {}
    for m in _ENTITY_RE.finditer(body):
        ents[int(m.group(1))] = (m.group(2), m.group(3))

    # PRODUCT <- PRODUCT_DEFINITION_FORMATION <- PRODUCT_DEFINITION
    product_names = {}
    for eid, (etype, argtext) in ents.items():
        if etype == "PRODUCT":
            args = _split_args(argtext)
            name = _text(args[1]) if len(args) > 1 else ""
            ident = _text(args[0]) if args else ""
            desc = _text(args[2]) if len(args) > 2 else ""
            product_names[eid] = (name or ident, desc if desc != name else "")
    formation_product = {}
    for eid, (etype, argtext) in ents.items():
        if etype.startswith("PRODUCT_DEFINITION_FORMATION"):
            args = _split_args(argtext)
            formation_product[eid] = _ref(args[2]) if len(args) > 2 else None
    for eid, (etype, argtext) in ents.items():
        if etype in _PD_TYPES:
            args = _split_args(argtext)
            prod_id = formation_product.get(_ref(args[2]) if len(args) > 2 else None)
            name, desc = product_names.get(prod_id, ("", ""))
            st.products[eid] = Product(eid, name, desc)
    if not st.products:
        raise StepError("STEP file contains no product definitions: "
                        f"{os.path.basename(path)}")

    # Assembly tree: NEXT_ASSEMBLY_USAGE_OCCURRENCE(id, name, desc, parent, child, designator)
    has_parent = set()
    for eid, (etype, argtext) in ents.items():
        if etype == "NEXT_ASSEMBLY_USAGE_OCCURRENCE":
            args = _split_args(argtext)
            if len(args) < 5:
                continue
            parent, child = _ref(args[3]), _ref(args[4])
            if parent in st.products and child in st.products and parent != child:
                st.products[parent].children.append(child)
                has_parent.add(child)
    st.roots = [pid for pid, p in st.products.items()
                if p.children and pid not in has_parent]
    if not st.roots:
        # A part file: no occurrences at all. Prefer a product that owns geometry.
        st.roots = [next(iter(st.products))]

    # Body census: PD <- PRODUCT_DEFINITION_SHAPE <- SHAPE_DEFINITION_REPRESENTATION -> rep,
    # plus reps linked by a plain SHAPE_REPRESENTATION_RELATIONSHIP (SolidWorks
    # keeps the placement in one representation and the B-rep in another).
    pds_pd = {}
    for eid, (etype, argtext) in ents.items():
        if etype == "PRODUCT_DEFINITION_SHAPE":
            args = _split_args(argtext)
            target = _ref(args[2]) if len(args) > 2 else None
            if target in st.products:
                pds_pd[eid] = target
    rep_links = {}
    for eid, (etype, argtext) in ents.items():
        if etype == "SHAPE_REPRESENTATION_RELATIONSHIP":
            args = _split_args(argtext)
            if len(args) >= 4:
                a, b = _ref(args[2]), _ref(args[3])
                if a and b:
                    rep_links.setdefault(a, set()).add(b)
                    rep_links.setdefault(b, set()).add(a)
    for eid, (etype, argtext) in ents.items():
        if etype != "SHAPE_DEFINITION_REPRESENTATION":
            continue
        args = _split_args(argtext)
        if len(args) < 2:
            continue
        pd = pds_pd.get(_ref(args[0]))
        rep = _ref(args[1])
        if pd is None or rep is None:
            continue
        reps = {rep} | rep_links.get(rep, set())
        prod = st.products[pd]
        for r in reps:
            rtype, rargs = ents.get(r, ("", ""))
            if rtype not in _SHAPE_REP_TYPES:
                continue
            rsplit = _split_args(rargs)
            for item in _refs_in(rsplit[1] if len(rsplit) > 1 else ""):
                itype, iargs = ents.get(item, ("", ""))
                if itype in _SOLID_TYPES:
                    prod.solids += 1
                elif itype in _SURFACE_TYPES:
                    isplit = _split_args(iargs)
                    prod.surfaces += max(1, len(_refs_in(isplit[1] if len(isplit) > 1 else "")))

    st.styled_items = sum(1 for etype, _ in ents.values() if etype == "STYLED_ITEM")

    # Name hygiene: blank names get a stable placeholder; duplicate names get
    # numbered so two different parts never share one BOM row or picture.
    seen = {}
    for prod in st.products.values():
        base = prod.name.strip() or f"Part {prod.pd_id}"
        key = base.casefold()
        if key in seen:
            seen[key] += 1
            prod.name = f"{base} ({seen[key]})"
            st.warnings.append(
                f"Two different products are both named {base!r}; "
                f"the second is listed as {prod.name!r}")
        else:
            seen[key] = 1
            prod.name = base
    return st


# ---------------------------------------------------------------------------
# Public summaries
# ---------------------------------------------------------------------------

def inspect(path):
    """Quick facts about a STEP file for the UI and CLI (no geometry read)."""
    st = read_structure(path)
    root = st.root()
    leaf_parts = st.leaf_parts()
    solids = sum(p.solids for p in leaf_parts)
    surfaces = sum(p.surfaces for p in leaf_parts)
    return {
        "path": os.path.abspath(path),
        "file_name": st.file_name,
        "root_name": st.root_name,
        "top_product": root.name if root else "",
        "exporter": st.exporter,
        "schema": st.schema,
        "products": len(st.products),
        "unique_parts": len(leaf_parts),
        "assemblies": len(st.assemblies()),
        "instances": st.instance_count() if not st.single_product else 1,
        "depth": st.depth(),
        "single_product": st.single_product,
        "body_count": root.body_count if (root and st.single_product) else None,
        "solid_bodies": solids,
        "surface_bodies": surfaces,
        "has_colors": st.has_colors,
        "warnings": list(st.warnings),
    }


def describe(info):
    """One-line human summary of an inspect() result."""
    src = f"STEP from {info['exporter']}" if info.get("exporter") else "STEP file"
    if info.get("schema"):
        src += f" ({info['schema']})"
    if info["single_product"]:
        bodies = info.get("body_count") or 0
        what = (f"one part with {bodies} bodies" if bodies > 1
                else "one part")
    else:
        what = (f"{info['unique_parts']} unique parts in {info['instances']} "
                f"instances, {info['depth']} level"
                + ("s" if info['depth'] != 1 else ""))
    return f"{src} · {what}"


def needs_part_or_assembly_choice(info):
    """True when the file is one product with several bodies (Q5 in the
    design notes): the user decides whether that's one part or an assembly."""
    return bool(info.get("single_product")) and (info.get("body_count") or 0) > 1


def body_row_name(product_name, index):
    """Row name for body N of a multibody product read as an assembly."""
    return f"{product_name} · body {index}"


def build_rows(structure, step_as="part"):
    """Build hierarchical BOM rows + unique components from a Structure.

    Mirrors core.traverse_assembly_hierarchical: rows carry level ("1.0",
    "1.1", ...), type, name, file_path (a stable pseudo path), doc_type,
    quantity, blank description/vendor/vendor_part_no, and an empty
    properties dict. components is keyed by the normalized pseudo path and
    additionally records, for the CAD engine, which STEP product (and which
    body, for a split multibody part) each row stands for.

    step_as: for a single-product file with several bodies, "part" gives one
    row and "assembly" one row per body. Ignored for assembly files.
    """
    rows, components = [], OrderedDict()
    st = structure

    def add_component(key, row, product, body_index=None):
        if key in components:
            return
        components[key] = {
            "name": row["name"],
            "file_path": row["file_path"],
            "doc_type": row["doc_type"],
            "quantity": row["quantity"],
            "description": row["description"],
            "vendor": row["vendor"],
            "vendor_part_no": row["vendor_part_no"],
            "properties": {},
            "color": None,
            "solid_bodies": None if body_index else product.solids,
            "surface_bodies": None if body_index else product.surfaces,
            "step_product": product.name,
            "step_body_index": body_index,
            "step_is_assembly": product.is_assembly,
        }

    def make_row(level, product, quantity, name=None, body_index=None):
        is_asm = product.is_assembly and body_index is None
        key = f"{st.path}::{product.pd_id}" + (f"::body{body_index}" if body_index else "")
        row = {
            "level": level,
            "type": "Assembly" if is_asm else "Part",
            "name": name or product.name,
            "file_path": key,
            "doc_type": DOC_ASSEMBLY if is_asm else DOC_PART,
            "quantity": quantity,
            "description": product.description or "",
            "vendor": "",
            "vendor_part_no": "",
            "properties": {},
        }
        rows.append(row)
        add_component(key.lower(), row, product, body_index)
        return row

    def level_str(prefix, idx):
        return f"{idx}.0" if prefix == "" else f"{prefix}.{idx}"

    def child_prefix(prefix, idx):
        return f"{idx}" if prefix == "" else f"{prefix}.{idx}"

    def traverse(parent, prefix, seen):
        groups = OrderedDict()
        for child in parent.children:
            groups.setdefault(child, 0)
            groups[child] += 1
        for idx, (child, count) in enumerate(groups.items(), 1):
            prod = st.products[child]
            make_row(level_str(prefix, idx), prod, count)
            if prod.is_assembly and child not in seen:
                traverse(prod, child_prefix(prefix, idx), seen | {child})

    root = st.root()
    if root is None:
        return rows, components
    if root.is_assembly:
        traverse(root, "", {root.pd_id})
    elif step_as == "assembly" and root.body_count > 1:
        for i in range(1, root.body_count + 1):
            make_row(f"{i}.0", root, 1, name=body_row_name(root.name, i),
                     body_index=i)
    else:
        make_row("1.0", root, 1)
    return rows, components
