from __future__ import annotations

# Standard library imports
from typing import Any, Optional, Literal
from pathlib import Path
from io import BytesIO
import asyncio
import logging

# Local application imports
from .import_ttl import ttl_to_json
from .import_xml import xml_to_json
from .import_json import json_to_json, json_file_to_model
from .import_sql import sql_to_model
from .import_text import text_to_model
from .export_xml import json_to_xml
from .visualisation import get_image_bytes
from .export_ttl import jsonld_to_ttl_bytes


# ----------------------------------------------------------------------
# Config & logging
# ----------------------------------------------------------------------
CONTACT_EMAIL = "theo.joly2@developpement-durable.gouv.fr"
LOGGER_NAME = "model_utils"
logger = logging.getLogger(LOGGER_NAME)
logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setLevel(logging.INFO)
    _h.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_h)


# ----------------------------------------------------------------------
# Helpers d'erreurs (Remplacent les st.error de Streamlit)
# ----------------------------------------------------------------------
class ModelProcessingError(Exception):
    """Exception personnalisée pour remonter les erreurs proprement à l'API."""
    def __init__(self, title: str, details: Optional[str] = None):
        self.title = title
        self.details = details
        super().__init__(self.title)


async def with_timeout(coro, seconds: float = 60.0, on_timeout_msg: str = ""):
    """
    Await a coroutine with a timeout; lève une erreur propre si dépassé.
    """
    try:
        return await asyncio.wait_for(coro, timeout=seconds)
    except asyncio.TimeoutError:
        raise ModelProcessingError(
            title="The operation timed out.",
            details=on_timeout_msg or "The server took too long to respond."
        )


# ----------------------------------------------------------------------
# File type detection
# ----------------------------------------------------------------------
def _detect_file_type(
    first_bytes: bytes,
    filename: Optional[str] = None,
) -> Optional[Literal["xml", "ttl", "xmi", "json", "jsonld", "sql", "text"]]:
    """
    Detect file type from filename first, then from content.
    """
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix == ".ttl":
            return "ttl"
        if suffix == ".xmi":
            return "xmi"
        if suffix == ".xml":
            return "xml"
        if suffix in {".json", ".jsonld"}:
            return "json"
        if suffix == ".sql":
            return "sql"
        if suffix in {".txt", ".html", ".htm", ".csv"}:
            return "text"

    sniff = first_bytes[:512]
    if sniff.startswith(b"\xef\xbb\xbf"):
        sniff = sniff[3:]
    sniff = sniff.lstrip()

    if sniff.startswith(b"<") or sniff.startswith(b"<?xml"):
        return "xml"

    turtle_markers = (
        b"@prefix",
        b"@base",
        b"PREFIX ",
        b"BASE ",
        b"prefix ",
        b"base ",
    )
    if any(marker in sniff for marker in turtle_markers):
        return "ttl"

    json_markers = (b"{", b"[")
    if sniff.startswith(json_markers):
        return "json"

    sql_markers = (b"CREATE TABLE", b"create table", b"CREATE TABLE")
    if any(marker in sniff for marker in sql_markers):
        return "sql"

    return None


# ----------------------------------------------------------------------
# Export helpers
# ----------------------------------------------------------------------
def _get_model_name(json_data: dict[str, Any], default: str = "export") -> str:
    value = (json_data.get("name") or default).strip()
    return value or default


def _normalize_uploaded_model(
    *,
    kind: Literal["xml", "xmi", "ttl"],
    uploaded_json: dict[str, Any],
    server_model: Optional[dict[str, Any]],
) -> dict[str, Any]:
    """
    Preserve round-trip fields after server upload so both exports stay available.
    """
    model = dict(server_model or {})

    if kind == "ttl":
        model.setdefault("source_format", "ttl")
        model.setdefault("ttl_raw", uploaded_json.get("ttl_raw", ""))

        if uploaded_json.get("ttl") and not model.get("ttl"):
            model["ttl"] = uploaded_json["ttl"]

        if not model.get("elements") and uploaded_json.get("elements"):
            model["elements"] = uploaded_json.get("elements", [])

        if not model.get("connectors") and uploaded_json.get("connectors"):
            model["connectors"] = uploaded_json.get("connectors", [])

        if not isinstance(model.get("xmi"), dict):
            model["xmi"] = {
                "elements": model.get("elements", []),
                "connectors": model.get("connectors", []),
            }

        return model

    model.setdefault("source_format", "xmi")

    if not model.get("elements") and uploaded_json.get("elements"):
        model["elements"] = uploaded_json.get("elements", [])

    if not model.get("connectors") and uploaded_json.get("connectors"):
        model["connectors"] = uploaded_json.get("connectors", [])

    if not isinstance(model.get("xmi"), dict):
        model["xmi"] = {
            "elements": model.get("elements", []),
            "connectors": model.get("connectors", []),
        }

    return model


def build_ttl_bytes(json_data: dict[str, Any]) -> bytes:
    """
    Build TTL bytes from a model if possible.
    Preference:
    1) ttl_raw
    2) ttl as JSON-LD transformed via jsonld_to_ttl_bytes
    """
    ttl_raw = json_data.get("ttl_raw")

    if isinstance(ttl_raw, bytes) and ttl_raw:
        return ttl_raw

    if isinstance(ttl_raw, str) and ttl_raw.strip():
        return ttl_raw.encode("utf-8")

    ttl_json = json_data.get("ttl")
    if ttl_json:
        ttl_bytes = jsonld_to_ttl_bytes(ttl_json)
        if isinstance(ttl_bytes, str):
            ttl_bytes = ttl_bytes.encode("utf-8")
        return ttl_bytes or b""

    logger.warning("TTL export unavailable: missing ttl_raw and ttl. Available keys=%s", list(json_data.keys()))
    raise ModelProcessingError("TTL export unavailable", "The model does not contain required TTL data.")


def build_xmi_bytes(json_data: dict[str, Any]) -> bytes:
    """
    Build XMI bytes from a model.
    """
    model_name = _get_model_name(json_data, "UML_Model")

    if isinstance(json_data.get("xmi"), dict):
        export_source = dict(json_data["xmi"])
    elif "elements" in json_data or "connectors" in json_data:
        export_source = {
            "elements": json_data.get("elements", []),
            "connectors": json_data.get("connectors", []),
        }
    else:
        logger.warning("XMI export unavailable: missing xmi/elements/connectors. Available keys=%s", list(json_data.keys()))
        raise ModelProcessingError("XMI export unavailable", "The model does not contain required XMI elements.")

    export_source.setdefault("model_name", model_name)

    bytes_data = json_to_xml(export_source)
    if isinstance(bytes_data, str):
        bytes_data = bytes_data.encode("utf-8")
    return bytes_data or b""


# ----------------------------------------------------------------------
# Main upload & conversion entrypoint
# ----------------------------------------------------------------------
async def process_and_upload_model(
    file_bytes: bytes, 
    filename: str, 
    mcp_client: Any
) -> dict[str, Any]:
    """
    Imports an XML/XMI or TTL file, converts it to a JSON-compatible dictionary,
    adds a 'Generated' package if XML, and uploads to the MCP server.
    """
    try:
        kind = _detect_file_type(file_bytes, filename)
        if kind is None:
            raise ModelProcessingError("Unsupported file format.", "Please upload an XMI/XML or TTL file.")

        json_data = {}
        
        if kind in {"xml", "xmi"}:
            try:
                json_data = xml_to_json(BytesIO(file_bytes))
            except Exception as e:
                raise ModelProcessingError("Failed to parse the XML/XMI file.", str(e))

            try:
                elements = json_data.get("elements", [])
                if not elements:
                    raise ModelProcessingError("Parsed XML has no elements.", "Ensure the XMI version is supported.")

                root_model_id = elements[0].get("ID")
                if not root_model_id:
                    raise ModelProcessingError("Parsed XML root element is missing an ID.")

                # On génère l'ID via le client comme avant
                generated_id = mcp_client._generate_id()

                elements.append({
                    "name": "Generated",
                    "ID": generated_id,
                    "type": "uml:Package",
                    "package": root_model_id,
                    "tags": [],
                })

                json_data["elements"] = elements
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }
            except Exception as e:
                raise ModelProcessingError("Could not append the 'Generated' package.", str(e))

            json_data["source_format"] = "xmi"
            json_data["xmi_raw"] = file_bytes.decode("utf-8", errors="replace")
            json_data["xmi_xml"] = json_data["xmi_raw"]

        else:
            try:
                json_data = ttl_to_json(BytesIO(file_bytes))
            except Exception as e:
                raise ModelProcessingError("Failed to parse the TTL file.", str(e))

            json_data["source_format"] = "ttl"
            json_data["ttl_raw"] = file_bytes.decode("utf-8", errors="replace")

            if "elements" in json_data or "connectors" in json_data:
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }

        # Upload au serveur MCP
        try:
            async with mcp_client:
                server_model = await with_timeout(
                    mcp_client.upload_model({"model": json_data}),
                    seconds=60.0,
                    on_timeout_msg="Uploading the model took too long."
                )
                if server_model is None:
                    raise ModelProcessingError("MCP Server Error", "Model returned None.")
        except Exception as e:
            raise ModelProcessingError("Uploading the model to the server failed.", str(e))

        # Normalisation finale
        final_model = _normalize_uploaded_model(
            kind=kind,
            uploaded_json=json_data,
            server_model=server_model or {},
        )

        return final_model

    except ModelProcessingError:
        raise
    except Exception as e:
        logger.exception("process_and_upload_model failed: %s", e)
        raise ModelProcessingError("A critical error occurred while processing the file.", str(e))


# ----------------------------------------------------------------------
# Visualisation
# ----------------------------------------------------------------------
def generate_visualisation(json_data: dict[str, Any], debug: bool = False) -> BytesIO:
    """
    Visualizes a JSON model and returns the image bytes directly.
    """
    try:
        image_bytes = get_image_bytes(json_data, debug=debug)
        if not image_bytes:
            raise ModelProcessingError("No image could be generated from the model.")
        return image_bytes
    except Exception as e:
        raise ModelProcessingError("Visualisation failed.", str(e))
