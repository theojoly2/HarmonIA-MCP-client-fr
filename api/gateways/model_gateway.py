"""Model gateway: encapsulate data_model_utils and SVG generation.

This module acts as a single entry point to the external data_model_utils
package so that routers/services do not depend directly on its internals.
"""

from __future__ import annotations

import base64
import re
from io import BytesIO
from typing import Any

from data_model_utils import _detect_file_type, generate_visualisation
from data_model_utils.import_json import json_file_to_model
from data_model_utils.import_sql import sql_to_model
from data_model_utils.import_text import text_to_model
from data_model_utils.import_ttl import ttl_to_json
from data_model_utils.import_xml import xml_to_json


def detect_file_type(file_bytes: bytes, filename: str) -> str | None:
    return _detect_file_type(file_bytes, filename)


def detect_file_type_with_fallback(file_bytes: bytes, filename: str) -> str | None:
    kind = _detect_file_type(file_bytes, filename)
    if not kind and filename:
        import os
        _, ext = os.path.splitext(filename.lower())
        if ext == ".ttl":
            kind = "ttl"
        elif ext in (".xml", ".xmi"):
            kind = "xml"
        elif ext in (".json", ".jsonld"):
            kind = "json"
        elif ext == ".sql":
            kind = "sql"
        elif ext in (".txt", ".html", ".htm", ".csv"):
            kind = "text"
    return kind


def parse_model_json(file_bytes: bytes, filename: str, kind: str) -> dict[str, Any]:
    if kind in {"xml", "xmi"}:
        json_data = xml_to_json(BytesIO(file_bytes))
    elif kind == "ttl":
        json_data = ttl_to_json(BytesIO(file_bytes))
        if isinstance(json_data.get("xmi"), dict):
            json_data = json_data["xmi"]
    elif kind == "json":
        json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
        if isinstance(json_data.get("xmi"), dict):
            json_data = json_data["xmi"]
    elif kind == "sql":
        json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
        if isinstance(json_data.get("xmi"), dict):
            json_data = json_data["xmi"]
    elif kind == "text":
        json_data = text_to_model(BytesIO(file_bytes), filename=filename)
        if isinstance(json_data.get("xmi"), dict):
            json_data = json_data["xmi"]
    else:
        raise ValueError("Format non supporté pour la modélisation.")
    return json_data


def generate_svg(json_data: dict[str, Any]) -> str:
    svg_result = generate_visualisation(json_data)
    svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
    svg_text = svg_bytes.decode("utf-8", errors="replace")
    svg_text = re.sub(r'style="([^"]*)background:#000000([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
    svg_text = re.sub(r"style='([^']*)background:#000000([^']*)'", r"style='\1background:#ffffff\2'", svg_text, flags=re.IGNORECASE)
    svg_text = re.sub(r'style="([^"]*)background:#FFFFFF([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
    if "<svg" in svg_text and "background:" not in svg_text:
        svg_text = svg_text.replace("<svg", '<svg style="background:#ffffff;"', 1)
    return svg_text


def extract_main_class_name(json_data: dict[str, Any]) -> tuple[str, str]:
    main_class_name = ""
    root_pkg_id = ""
    for elem in json_data.get("elements", []):
        if _safe_text(elem.get("type")) == "uml:Package" and not root_pkg_id:
            root_pkg_id = _safe_text(elem.get("ID"))
    for elem in json_data.get("elements", []):
        if _safe_text(elem.get("type")) == "uml:Class" and _safe_text(elem.get("package")) == root_pkg_id:
            main_class_name = _safe_text(elem.get("name"))
            break
    return main_class_name, root_pkg_id


def _safe_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def escape_xml_attr(value: str) -> str:
    return value.replace("\u0026", "\u0026amp;").replace('"', "\u0026quot;").replace("<", "\u0026lt;").replace(">", "\u0026gt;")


def base64_for_bytes(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def generate_empty_model(display_name: str) -> tuple[str, dict[str, Any]]:
    """Return (svg_text, stored_data) for a brand-new empty model."""
    xmi = {"elements": [], "connectors": []}
    svg_text = generate_svg(xmi)
    stored_data = {
        "xmi": xmi,
        "svg": svg_text,
        "source_filename": "",
        "source_format": "empty",
        "name": display_name,
    }
    return svg_text, stored_data


def regenerate_svg_for_model(model: dict[str, Any]) -> str:
    """Regenerate SVG from model JSON, preserving main-class hint."""
    svg = model.get("svg", "")
    xmi = model.get("xmi")
    if isinstance(xmi, dict) and (xmi.get("elements") or xmi.get("connectors")):
        try:
            svg = generate_svg(xmi)
        except Exception as e:
            print(f"[regenerate_svg_for_model] SVG regeneration failed: {e}", flush=True)
            return svg
    # Preserve main-class hint from the original SVG if present.
    if svg:
        match = re.search(r'data-main-class="([^"]*)"', model.get("svg", ""))
        main_class = match.group(1) if match else ""
        if main_class and "data-main-class=" not in svg:
            svg = svg.replace("<svg", f'<svg data-main-class="{escape_xml_attr(main_class)}"', 1)
    return svg


def generate_svg_for_bytes(file_bytes: bytes, filename: str) -> str:
    """Full pipeline: detect, parse, generate SVG and embed main class name."""
    kind = detect_file_type_with_fallback(file_bytes, filename)
    if not kind:
        raise ValueError("Format non supporté pour la modélisation.")
    json_data = parse_model_json(file_bytes, filename, kind)
    svg_text = generate_svg(json_data)
    main_class_name, _ = extract_main_class_name(json_data)
    if main_class_name and "<svg" in svg_text:
        svg_text = svg_text.replace("<svg", f'<svg data-main-class="{escape_xml_attr(main_class_name)}"', 1)
    return svg_text
