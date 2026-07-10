from __future__ import annotations

from typing import Any
from io import BytesIO
import json
import re
import uuid
from html import unescape

"""
import_text.py
Fallback pour fichiers texte (.txt), HTML, CSV, ou tout format texte non
nativement supporté. Tente d'extraire un JSON/TTL embedded, ou génère un
diagramme PlantUML minimal représentant la structure textuelle.
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clean_name(name: str) -> str:
    s = _safe_text(name)
    s = re.sub(r"[\s\{\}<>:\\\"\[\]]", " ", s)
    return s.strip() or "Unnamed"


def _make_id(prefix: str, seed: str) -> str:
    u = uuid.uuid5(uuid.NAMESPACE_URL, str(seed))
    s = str(u).replace("-", "_").upper()
    return f"{prefix}_{s[:24]}"


def _extract_json_objects(text: str) -> list[Any]:
    """Extrait tous les objets/tableaux JSON valides d'un texte."""
    objects: list[Any] = []
    decoder = json.JSONDecoder()
    i = 0
    while i < len(text):
        # Avance jusqu'au prochain { ou [ potentiel
        while i < len(text) and text[i] not in {"{", "["}:
            i += 1
        if i >= len(text):
            break
        try:
            obj, end = decoder.raw_decode(text, i)
            objects.append(obj)
            i += end
        except json.JSONDecodeError:
            i += 1
    return objects


def _try_extract_ttl_header(text: str) -> dict[str, Any] | None:
    """Détecte un @prefix et quelques triples basiques."""
    prefixes = re.findall(r"@prefix\s+(\w+):\s+<([^\u003e]+)>", text)
    if not prefixes:
        return None
    model = {"elements": [], "connectors": []}
    pkg_id = _make_id("EAPK", "ttl_embedded")
    model["elements"].append({
        "name": "Embedded TTL",
        "ID": pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [],
    })

    # Détection simple des classes OWL (a owl:Class) et propriétés
    classes: dict[str, dict[str, Any]] = {}
    for match in re.finditer(
        r"<([^\u003e]+)>\s+a\s+(?:owl:Class|rdfs:Class)\s*;?",
        text,
        re.IGNORECASE,
    ):
        uri = match.group(1)
        name = uri.split("#")[-1].split("/")[-1]
        cls_id = _make_id("EAID", uri)
        cls = {
            "name": _clean_name(name),
            "ID": cls_id,
            "uri": uri,
            "type": "uml:Class",
            "visibility": "public",
            "package": pkg_id,
            "tags": [{"name": "uri", "value": uri}],
            "attributes": [],
        }
        classes[uri] = cls
        model["elements"].append(cls)

    # rdfs:subClassOf
    for match in re.finditer(
        r"<([^\u003e]+)>\s+rdfs:subClassOf\s+<([^\u003e]+)>",
        text,
        re.IGNORECASE,
    ):
        child_uri = match.group(1)
        parent_uri = match.group(2)
        child = classes.get(child_uri)
        if child is None:
            name = child_uri.split("#")[-1].split("/")[-1]
            child = {
                "name": _clean_name(name),
                "ID": _make_id("EAID", child_uri),
                "uri": child_uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": pkg_id,
                "tags": [{"name": "uri", "value": child_uri}],
                "attributes": [],
            }
            classes[child_uri] = child
            model["elements"].append(child)
        parent_name = parent_uri.split("#")[-1].split("/")[-1]
        parent = classes.get(parent_uri)
        if parent is None:
            parent = {
                "name": _clean_name(parent_name),
                "ID": _make_id("EAID", parent_uri),
                "uri": parent_uri,
                "type": "uml:Class",
                "visibility": "public",
                "package": pkg_id,
                "tags": [{"name": "uri", "value": parent_uri}],
                "attributes": [],
            }
            classes[parent_uri] = parent
            model["elements"].append(parent)
        conn_id = _make_id("CONN", f"{child['ID']}:{parent['ID']}:subClassOf")
        model["connectors"].append({
            "connector_id": conn_id,
            "source_id": child["ID"],
            "target_id": parent["ID"],
            "source_name": child["name"],
            "target_name": parent["name"],
            "relationship": "Generalization",
            "name": "subClassOf",
            "uri": "http://www.w3.org/2000/01/rdf-schema#subClassOf",
            "lb": "",
            "lt": "",
            "rb": "",
            "rt": "",
            "tags": [{"name": "connector_id", "value": conn_id}],
            "tags_source": [],
            "tags_target": [],
        })

    return model


def _extract_table_names_from_html(text: str) -> list[str]:
    """Extrait les noms de tableaux dans les dictionnaires de données HTML."""
    names: list[str] = []
    # 1) id explicite de table (ex. <table id="schema.table">)
    ids = re.findall(r"<table[^>]*id=\"([^\"]+)\"", text, re.IGNORECASE)
    for raw in ids:
        name = raw.split(".")[-1] if "." in raw else raw
        name = _clean_name(name)
        if name:
            names.append(name)
    if names:
        return names

    # 2) caption texte dans des tables pgModeler (strip inner HTML)
    for cap_match in re.finditer(r"<caption[^>]*>(.*?)</caption>", text, re.IGNORECASE | re.DOTALL):
        cap = re.sub(r"<[^>]+>", " ", cap_match.group(1))
        cap = unescape(" ".join(cap.split()))
        name = _clean_name(cap)
        if name:
            names.append(name)
    if names:
        return names

    # 3) fallback : balises h3/h2 proches de "table"
    headers = re.findall(r"<h[23][^>]*>\s*([^<]+(?:[Tt]able|dictionnaire|données)[^<]*)", text)
    return [_clean_name(h) for h in headers if _clean_name(h)]


def _html_to_model(text: str, filename: str) -> dict[str, Any]:
    """Parse un dictionnaire de données HTML (ex: pgModeler) en modèle UML.

    Chaque table devient une classe, chaque colonne un attribut,
    et les clés étrangères détectées créent des associations.
    """
    from html.parser import HTMLParser

    class _TableParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.tables: list[dict[str, Any]] = []
            self.current_table: dict[str, Any] | None = None
            self.current_row: list[dict[str, str]] | None = None
            self.current_cell: dict[str, str] | None = None
            self.in_cell = False
            self.skip_level = 0
            self.in_caption = False

        def handle_starttag(self, tag, attrs):
            attrs_dict = dict(attrs)
            if tag == "table":
                if self.current_table is not None:
                    self.skip_level += 1
                    return
                self.current_table = {
                    "id": attrs_dict.get("id"),
                    "caption": "",
                    "rows": [],
                }
            elif self.current_table is None or self.skip_level > 0:
                return
            elif tag == "caption":
                self.in_caption = True
                self.current_table["caption_parts"] = []
            elif tag == "tr":
                self.current_row = []
            elif tag in ("td", "th"):
                self.in_cell = True
                self.current_cell = {"class": attrs_dict.get("class", ""), "text": ""}

        def handle_endtag(self, tag):
            if tag == "table":
                if self.skip_level > 0:
                    self.skip_level -= 1
                    return
                if self.current_table:
                    self.tables.append(self.current_table)
                self.current_table = None
            elif self.current_table is None or self.skip_level > 0:
                return
            elif tag == "caption":
                self.in_caption = False
                self.current_table["caption"] = " ".join(
                    self.current_table.pop("caption_parts", [])
                )
            elif tag == "tr":
                if self.current_row is not None and self.current_table:
                    self.current_table["rows"].append(self.current_row)
                self.current_row = None
            elif tag in ("td", "th"):
                if self.current_cell and self.current_row is not None:
                    self.current_row.append(self.current_cell)
                self.in_cell = False
                self.current_cell = None

        def handle_data(self, data):
            if self.current_table is None or self.skip_level > 0:
                return
            text_data = unescape(data)
            if self.in_caption:
                self.current_table.setdefault("caption_parts", []).append(text_data)
            elif self.in_cell and self.current_cell:
                self.current_cell["text"] += text_data

    parser = _TableParser()
    parser.feed(text)

    model: dict[str, Any] = {"elements": [], "connectors": []}
    pkg_id = _make_id("EAPK", filename)
    root_name = _clean_name(re.sub(r"\.[^.]+$", "", filename))

    model["elements"].append({
        "name": root_name,
        "ID": pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [{"name": "filename", "value": filename}],
    })

    # Helper: strip HTML tags and normalize whitespace
    def _cell_text(cell_text: str) -> str:
        return " ".join(re.sub(r"<[^>]+>", " ", cell_text).split())

    # Build classes with attributes
    classes_by_id: dict[str, dict[str, Any]] = {}
    for table in parser.tables:
        raw_id = table["id"]
        if raw_id:
            table_name = raw_id.split(".")[-1]
        else:
            caption = " ".join(table["caption"].split())
            # pgModeler caption format: schema . table_name Table
            parts = caption.replace(".", " ").split()
            table_name = parts[-2] if len(parts) >= 2 and parts[-1].lower() == "table" else caption
        table_name = _clean_name(table_name)
        if not table_name or table_name.lower() == "table":
            continue

        cls_id = _make_id("EAID", raw_id or table_name)
        cls = {
            "name": table_name,
            "ID": cls_id,
            "uri": raw_id,
            "type": "uml:Class",
            "visibility": "public",
            "package": pkg_id,
            "tags": [{"name": "uri", "value": raw_id}] if raw_id else [],
            "attributes": [],
        }
        model["elements"].append(cls)
        classes_by_id[raw_id] = cls
        classes_by_id[table_name] = cls

        # Parse rows: expect header [Name, Data type, PK, FK, UQ, Not null, Default, Description]
        header_found = False
        for row in table["rows"]:
            cells = [_cell_text(c["text"]) for c in row]
            if not cells:
                continue
            # Header row detection
            if cells[0].strip().lower() == "name":
                header_found = True
                continue
            if not header_found:
                continue
            if len(cells) < 2:
                continue
            col_name = _clean_name(cells[0])
            if not col_name:
                continue
            col_type = _cell_text(cells[1]) or "String"
            pk = len(cells) > 2 and bool(cells[2].strip())
            fk = len(cells) > 3 and bool(cells[3].strip())
            not_null = len(cells) > 5 and bool(cells[5].strip())
            desc = _safe_text(cells[7]) if len(cells) > 7 else ""

            # Map SQL-ish types to UML types
            type_lower = col_type.lower()
            if "integer" in type_lower or type_lower == "int":
                uml_type = "Integer"
            elif "number" in type_lower or "numeric" in type_lower or "real" in type_lower or "double" in type_lower or "float" in type_lower:
                uml_type = "Real"
            elif "boolean" in type_lower or "bool" in type_lower:
                uml_type = "Boolean"
            elif "timestamp" in type_lower or "date" in type_lower:
                uml_type = "DateTime"
            elif "character" in type_lower or "varchar" in type_lower or "text" in type_lower:
                uml_type = "String"
            elif "geometry" in type_lower:
                uml_type = "Geometry"
            else:
                uml_type = "String"

            suffix = ""
            if pk:
                suffix = " {PK}"
            if not_null:
                suffix += " {NOT NULL}" if suffix else " {NOT NULL}"

            cls["attributes"].append({
                "name": col_name,
                "visibility": "public",
                "type": uml_type,
                "uri": None,
                "lower_bounds": "",
                "upper_bounds": "",
                "tags_attribute": [{"name": "description", "value": desc}] if desc else [],
                "is_fk": fk,
            })

    # Heuristic FK -> association.
    # Many FK columns in this dataset are named <table_prefix>_<target_table>_code,
    # where the first token is the source table prefix and the middle token(s)
    # identify the target table.
    # Examples:
    #   ba_lc_code  -> target t_local   (prefix ba = t_baie, middle lc = t_local)
    #   cb_bp1      -> target t_ebp      (prefix cb = t_cable, middle bp = t_ebp)
    #   st_ad_code  -> target t_adresse  (prefix st = t_site, middle ad = t_adresse)
    #   ti_ba_code  -> target t_baie     (prefix ti = t_tiroir, middle ba = t_baie)
    # We also accept columns where the last token is "code" and there is a middle token.
    for cls in model["elements"]:
        if cls.get("type") != "uml:Class":
            continue
        for attr in cls.get("attributes", []):
            if not attr.get("is_fk"):
                continue
            col_name = attr["name"]
            parts = col_name.split("_")
            if len(parts) < 2:
                continue

            # Candidate target tokens: all middle tokens (between first prefix and last "code"/number)
            target_tokens = parts[1:-1] if parts[-1].lower() in {"code", "codf", "codp"} else parts[1:]
            target_cls = None
            for token in target_tokens:
                # Exact match t_<token>
                target_cls = classes_by_id.get(f"t_{token}")
                if target_cls:
                    break
                # Match tables named <schema>.t_<token> or ending with _<token>
                for c in classes_by_id.values():
                    if c["name"].endswith(f"_{token}") or c["name"] == f"t_{token}":
                        target_cls = c
                        break
                if target_cls:
                    break

            if target_cls is None and len(parts) >= 3:
                # Try concatenation of middle tokens (e.g. ndcode -> t_noeud)
                middle = "".join(parts[1:-1]) if parts[-1].lower() in {"code", "codf", "codp"} else "".join(parts[1:])
                for suffix in ["", "t_"]:
                    target_cls = classes_by_id.get(f"{suffix}{middle}") or classes_by_id.get(f"t_{middle}")
                    if target_cls:
                        break
                if target_cls is None:
                    for c in classes_by_id.values():
                        if middle and (c["name"].endswith(f"_{middle}") or c["name"].endswith(middle)):
                            target_cls = c
                            break

            if target_cls:
                conn_id = _make_id("CONN", f"{cls['ID']}:{target_cls['ID']}:{col_name}")
                model["connectors"].append({
                    "connector_id": conn_id,
                    "source_id": cls["ID"],
                    "target_id": target_cls["ID"],
                    "source_name": cls["name"],
                    "target_name": target_cls["name"],
                    "relationship": "Association",
                    "name": col_name,
                    "uri": None,
                    "lb": "0..1",
                    "rb": "1",
                    "tags": [{"name": "connector_id", "value": conn_id}],
                    "tags_source": [],
                    "tags_target": [],
                })

    return model


def _build_fallback_model(text: str, filename: str) -> dict[str, Any]:
    """Crée un modèle minimaliste (package + note) pour texte non structuré."""
    model: dict[str, Any] = {"elements": [], "connectors": []}
    pkg_id = _make_id("EAPK", filename)
    root_name = _clean_name(re.sub(r"\.[^.]+$", "", filename))

    model["elements"].append({
        "name": root_name,
        "ID": pkg_id,
        "uri": None,
        "type": "uml:Package",
        "visibility": "public",
        "package": "",
        "tags": [{"name": "filename", "value": filename}],
    })

    # Si HTML contient des tables, crée des classes vides avec leurs noms
    if filename.lower().endswith(".html"):
        table_names = _extract_table_names_from_html(text)
        for i, tname in enumerate(table_names[:50]):
            cls_id = _make_id("EAID", f"{filename}.{tname}")
            model["elements"].append({
                "name": tname,
                "ID": cls_id,
                "uri": None,
                "type": "uml:Class",
                "visibility": "public",
                "package": pkg_id,
                "tags": [],
                "attributes": [],
            })

    # Ajoute une note avec les 5 premières lignes non vides
    lines = [l.strip() for l in text.splitlines() if l.strip()][:10]
    note_id = _make_id("EAID", f"note:{filename}")
    note_text = "\n".join(lines) if lines else "Aperçu non disponible"
    # Tronque pour PlantUML
    if len(note_text) > 300:
        note_text = note_text[:297] + "..."
    model["elements"].append({
        "name": note_text,
        "ID": note_id,
        "uri": None,
        "type": "uml:Class",
        "visibility": "public",
        "package": pkg_id,
        "tags": [{"name": "note", "value": note_text}],
        "attributes": [],
    })

    return model


def text_to_model(uploaded_file: BytesIO, filename: str = "document.txt") -> dict[str, Any]:
    """
    Convertit un fichier texte/HTML/fallback en modèle UML-compatible.
    """
    uploaded_file.seek(0)
    text = uploaded_file.read().decode("utf-8", errors="replace")

    # 1. Essayer JSON (en priorité un document JSON entier si le fichier est .txt)
    if filename.lower().endswith(".txt"):
        stripped = text.strip()
        if stripped.startswith(("{", "[")):
            try:
                data = json.loads(stripped)
                from .import_json import json_to_json
                result = json_to_json(data, filename=filename)
                if result.get("xmi", {}).get("elements"):
                    return result
            except Exception:
                pass

    for data in _extract_json_objects(text):
        try:
            # Import dynamique pour éviter cycle
            from .import_json import json_to_json
            result = json_to_json(data, filename=filename)
            if result.get("xmi", {}).get("elements"):
                return result
        except Exception:
            continue

    # 2. Essayer TTL basique
    ttl_model = _try_extract_ttl_header(text)
    if ttl_model and ttl_model.get("elements"):
        return {
            "xmi": ttl_model,
            "source_format": "ttl_embedded",
            "text_raw": text,
        }

    # 3. HTML dictionnaire de données
    if filename.lower().endswith(".html"):
        try:
            model = _html_to_model(text, filename)
            if len([e for e in model.get("elements", []) if e.get("type") == "uml:Class"]) > 1:
                return {
                    "xmi": model,
                    "source_format": "html",
                    "text_raw": text,
                }
        except Exception:
            pass

    # 4. Fallback
    model = _build_fallback_model(text, filename)
    return {
        "xmi": model,
        "source_format": "text",
        "text_raw": text,
    }
