"""Import model file parsing and upload for the Assistant chatbot.

Shared helpers used by the /api/assistant/import and
/api/assistant/import-from-document endpoints.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any, Optional

from api.naming import model_name_from_filename as _model_name_from_filename, unique_model_name
from api.services.assistant_mcp_client import AssistantMCPClient
from data_model_utils import _detect_file_type, ModelProcessingError
from data_model_utils.import_json import json_file_to_model
from data_model_utils.import_sql import sql_to_model
from data_model_utils.import_text import text_to_model
from data_model_utils.import_ttl import ttl_to_json
from data_model_utils.import_xml import xml_to_json


async def parse_and_upload_model_file(
    file_bytes: bytes,
    filename: str,
    username: str,
    session_name: str,
    add_generated_package: bool = True,
) -> dict[str, Any]:
    """Detect file type, parse the model, then upload it to the MCP server.

    Returns the parsed ``json_data`` dict (with ``source_format`` and raw
    source fields set). The model is uploaded twice if needed: once raw and
    once tagged with ``imported_from_assistant=True``.
    """
    kind = _detect_file_type(file_bytes, filename)
    if kind is None:
        raise ModelProcessingError(
            "Unsupported file format.",
            "Please upload an XMI/XML, TTL, JSON, SQL or text file.",
        )

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

        if add_generated_package:
            async with AssistantMCPClient(state={"user": username, "name": session_name, "package": ""}) as mcp_client:
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
        if "elements" in json_data or "connectors" in json_data:
            json_data["xmi"] = {
                "elements": json_data.get("elements", []),
                "connectors": json_data.get("connectors", []),
            }
    elif kind == "json":
        try:
            json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the JSON/JSON-LD file.", str(e))
        json_data["source_format"] = "json"
        json_data["json_raw"] = file_bytes.decode("utf-8", errors="replace")
        if isinstance(json_data.get("xmi"), dict):
            json_data.setdefault("elements", json_data["xmi"].get("elements", []))
            json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
        else:
            json_data["xmi"] = {
                "elements": json_data.get("elements", []),
                "connectors": json_data.get("connectors", []),
            }
    elif kind == "sql":
        try:
            json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the SQL file.", str(e))
        json_data["source_format"] = "sql"
        json_data["sql_raw"] = file_bytes.decode("utf-8", errors="replace")
        if isinstance(json_data.get("xmi"), dict):
            json_data.setdefault("elements", json_data["xmi"].get("elements", []))
            json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
        else:
            json_data["xmi"] = {
                "elements": json_data.get("elements", []),
                "connectors": json_data.get("connectors", []),
            }
    else:  # text
        try:
            json_data = text_to_model(BytesIO(file_bytes), filename=filename)
        except Exception as e:
            raise ModelProcessingError("Failed to parse the text file.", str(e))
        json_data["source_format"] = "text"
        json_data["text_raw"] = file_bytes.decode("utf-8", errors="replace")
        if isinstance(json_data.get("xmi"), dict):
            json_data.setdefault("elements", json_data["xmi"].get("elements", []))
            json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
        else:
            json_data["xmi"] = {
                "elements": json_data.get("elements", []),
                "connectors": json_data.get("connectors", []),
            }

    # Ensure elements/connectors are populated for formats that don't set them.
    if isinstance(json_data.get("xmi"), dict):
        json_data.setdefault("elements", json_data["xmi"].get("elements", []))
        json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))

    async with AssistantMCPClient(state={"user": username, "name": session_name, "package": ""}) as mcp_client:
        server_model = await mcp_client.upload_model({"model": json_data})
        if not server_model:
            raise ModelProcessingError("MCP Server Error", "Model upload returned None.")

    # Mark models imported through the assistant so the history panel can
    # hide the standalone model entry and surface only the conversation.
    json_data["imported_from_assistant"] = True
    async with AssistantMCPClient(state={"user": username, "name": session_name, "package": ""}) as mcp_client:
        await mcp_client.upload_model({"model": json_data})

    return json_data


def build_import_session_name(display_name: str, add_timestamp: bool = True) -> str:
    """Derive a unique stored session/model name from a display name."""
    base = _model_name_from_filename(display_name)
    if add_timestamp:
        return unique_model_name(base)
    return base
