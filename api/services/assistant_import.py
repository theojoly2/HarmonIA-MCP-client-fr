"""Import model file parsing and upload for the Assistant chatbot.

Shared helpers used by the /api/assistant/import and
/api/assistant/import-from-document endpoints.
"""

from __future__ import annotations

from typing import Any

from api.naming import model_name_from_filename as _model_name_from_filename, unique_model_name
from api.services.assistant_mcp_client import AssistantMCPClient
from api.services.model_import import parse_model_file
from data_model_utils import ModelProcessingError


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
    json_data = parse_model_file(file_bytes, filename)

    elements = json_data.setdefault("elements", [])
    if add_generated_package and json_data.get("source_format") == "xmi" and elements:
        root_model_id = elements[0].get("ID")
        if root_model_id:
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
