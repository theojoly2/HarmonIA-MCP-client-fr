"""Global shared dependencies.

This module intentionally keeps only cross-cutting infrastructure:
- LLM client configuration
- Environment variables
- Small text/URL utilities

Presentation logic (HTML rendering, Markdown) has been moved to the frontend
or to app-specific services to keep the backend decoupled from the UI.
"""

import os
import re
import urllib.parse
from io import BytesIO

from dotenv import load_dotenv
from openai import AsyncOpenAI

from data_model_utils import (
    _detect_file_type,
    generate_visualisation,
    json_file_to_model,
    sql_to_model,
    text_to_model,
    ttl_to_json,
    xml_to_json,
)

load_dotenv()

_LLM_API_KEY = os.getenv("LLM_API_KEY", "not-needed")
_URL_API = os.getenv("URL_LLM_API", "")
_LLM_MODEL = os.getenv("LLM_MODEL", "")

llm_client = AsyncOpenAI(base_url=_URL_API, api_key=_LLM_API_KEY)


def safe_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def escape_xml_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def extract_filename_from_disposition(header: str) -> str:
    if not header:
        return ""
    match = re.search(r"filename\*=([^'\"]*)''([^;]+)", header, re.IGNORECASE)
    if match:
        return urllib.parse.unquote(match.group(2).strip('"'))
    match = re.search(r'filename=["\']?([^";]+)', header, re.IGNORECASE)
    if match:
        return match.group(1).strip('"')
    return ""


def generate_svg_for_bytes(file_bytes: bytes, filename: str) -> str:
    import re as _re
    kind = _detect_file_type(file_bytes, filename)
    if not kind and filename:
        import os as _os
        _, ext = _os.path.splitext(filename.lower())
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

    svg_result = generate_visualisation(json_data)
    svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
    svg_text = svg_bytes.decode("utf-8", errors="replace")
    svg_text = re.sub(r'style="([^"]*)background:#000000([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
    svg_text = re.sub(r"style='([^']*)background:#000000([^']*)'", r"style='\1background:#ffffff\2'", svg_text, flags=re.IGNORECASE)
    svg_text = re.sub(r'style="([^"]*)background:#FFFFFF([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
    if "<svg" in svg_text and "background:" not in svg_text:
        svg_text = svg_text.replace("<svg", '<svg style="background:#ffffff;"', 1)

    main_class_name = ""
    root_pkg_id = ""
    for elem in json_data.get("elements", []):
        if safe_text(elem.get("type")) == "uml:Package" and not root_pkg_id:
            root_pkg_id = safe_text(elem.get("ID"))
    for elem in json_data.get("elements", []):
        if safe_text(elem.get("type")) == "uml:Class" and safe_text(elem.get("package")) == root_pkg_id:
            main_class_name = safe_text(elem.get("name"))
            break
    if main_class_name and "<svg" in svg_text:
        svg_text = svg_text.replace("<svg", f'<svg data-main-class="{escape_xml_attr(main_class_name)}"', 1)
    return svg_text
