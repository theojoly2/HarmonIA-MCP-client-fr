"""Unified model file parsing and upload service.

This module centralizes the logic that was previously duplicated across
`assistant_import.py`, `routers/models.py` and `routers/external_api.py`.
"""

from __future__ import annotations

import base64
from io import BytesIO
from typing import Any

from data_model_utils import _detect_file_type, ModelProcessingError
from data_model_utils.import_json import json_file_to_model
from data_model_utils.import_sql import sql_to_model
from data_model_utils.import_text import text_to_model
from data_model_utils.import_ttl import ttl_to_json
from data_model_utils.import_xml import xml_to_json


def _detect_kind(file_bytes: bytes, filename: str) -> str:
    """Detect the file type from content, with extension fallback."""
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
    if not kind:
        raise ModelProcessingError(
            "Unsupported file format.",
            "Please upload an XMI/XML, TTL, JSON, SQL or text file.",
        )
    return kind


def _build_xmi_wrapper(json_data: dict[str, Any]) -> dict[str, Any]:
    """Ensure the canonical xmi wrapper exists with elements/connectors."""
    if isinstance(json_data.get("xmi"), dict):
        json_data.setdefault("elements", json_data["xmi"].get("elements", []))
        json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
    else:
        json_data["xmi"] = {
            "elements": json_data.get("elements", []),
            "connectors": json_data.get("connectors", []),
        }
    return json_data


def parse_model_file(
    file_bytes: bytes,
    filename: str,
    source_format: str | None = None,
) -> dict[str, Any]:
    """Parse a model file and return a JSON representation.

    The returned dict always contains:
    - elements
    - connectors
    - xmi (canonical wrapper)
    - source_format
    - source_format-specific raw fields (xmi_raw, ttl_raw, json_raw, sql_raw, text_raw)
    """
    kind = source_format or _detect_kind(file_bytes, filename)
    json_data: dict[str, Any] = {}

    if kind in {"xml", "xmi"}:
        try:
            json_data = xml_to_json(BytesIO(file_bytes))
        except Exception as e:
            raise ModelProcessingError("Failed to parse the XML/XMI file.", str(e))
        elements = json_data.get("elements", [])
        if not elements:
            raise ModelProcessingError("Parsed XML has no elements.", "Ensure the XMI version is supported.")
        root_model_id = elements[0].get("ID")
        if not root_model_id:
            raise ModelProcessingError("Parsed XML root element is missing an ID.")
        json_data["xmi"] = {
            "elements": json_data.get("elements", []),
            "connectors": json_data.get("connectors", []),
        }
        json_data["source_format"] = "xmi"
        json_data["xmi_raw"] = file_bytes.decode("utf-8", errors="replace")
        json_data["xmi_xml"] = json_data["xmi_raw"]
    elif kind == "ttl":
        try:
            json_data = ttl_to_json(BytesIO(file_bytes))
        except Exception as e:
            raise ModelProcessingError("Failed to parse the TTL file.", str(e))
        json_data["source_format"] = "ttl"
        json_data["ttl_raw"] = file_bytes.decode("utf-8", errors="replace")
        _build_xmi_wrapper(json_data)
    elif kind == "json":
        try:
            json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the JSON/JSON-LD file.", str(e))
        json_data["source_format"] = "json"
        json_data["json_raw"] = file_bytes.decode("utf-8", errors="replace")
        _build_xmi_wrapper(json_data)
    elif kind == "sql":
        try:
            json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the SQL file.", str(e))
        json_data["source_format"] = "sql"
        json_data["sql_raw"] = file_bytes.decode("utf-8", errors="replace")
        _build_xmi_wrapper(json_data)
    elif kind == "text":
        try:
            json_data = text_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the text file.", str(e))
        json_data["source_format"] = "text"
        json_data["text_raw"] = file_bytes.decode("utf-8", errors="replace")
        _build_xmi_wrapper(json_data)
    else:
        raise ModelProcessingError(
            "Unsupported file format.",
            "Please upload an XMI/XML, TTL, JSON, SQL or text file.",
        )

    _build_xmi_wrapper(json_data)
    return json_data


def base64_for_bytes(file_bytes: bytes) -> str:
    """Return a base64 string for raw file bytes."""
    return base64.b64encode(file_bytes).decode("ascii")
