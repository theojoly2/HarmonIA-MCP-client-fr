"""MCP-backed model store proxy.

Calls tools exposed by the HarmonIA-MCP-server-fr to persist models as JSON
in resources/semantic_model/models/{user}/{name}.json.
"""

import json
from typing import Any, Optional

from api.services.mcp_service import (
    add_attribute_mcp,
    add_class_mcp,
    add_connector_mcp,
    delete_model_mcp,
    get_model_mcp,
    list_models_mcp,
    rename_model_mcp,
    touch_model_mcp,
    upload_model_mcp,
)


async def list_models(username: str) -> list[dict[str, Any]]:
    return await list_models_mcp(username)


async def get_model(username: str, name: str) -> Optional[dict[str, Any]]:
    return await get_model_mcp(username, name)


async def touch_model(username: str, name: str) -> None:
    await touch_model_mcp(username, name)


async def save_model(
    username: str,
    name: str,
    model_data: dict[str, Any],
) -> dict[str, Any]:
    return await upload_model_mcp(username, name, model_data)


async def rename_model(username: str, old_name: str, new_name: str) -> dict[str, Any]:
    return await rename_model_mcp(username, old_name, new_name)


async def delete_model(username: str, name: str) -> None:
    await delete_model_mcp(username, name)


async def add_class(username: str, name: str, **kwargs) -> dict[str, Any]:
    return await add_class_mcp(username, name, **kwargs)


async def add_attribute(username: str, name: str, **kwargs) -> dict[str, Any]:
    return await add_attribute_mcp(username, name, **kwargs)


async def add_connector(username: str, name: str, **kwargs) -> dict[str, Any]:
    return await add_connector_mcp(username, name, **kwargs)


async def export_model(username: str, name: str, fmt: str) -> tuple[bytes, str, str]:
    """Export a persisted model as (bytes, content_type, extension)."""
    from data_model_utils import build_ttl_bytes, build_xmi_bytes, generate_visualisation, generate_visualisation_png

    model = await get_model(username, name)
    if not model:
        raise ValueError("model_not_found")

    fmt = (fmt or "").lower().strip()
    if fmt == "xmi":
        data = build_xmi_bytes(model)
        media_type = "application/xml"
        ext = "xmi"
    elif fmt == "ttl":
        data = build_ttl_bytes(model)
        media_type = "text/turtle"
        ext = "ttl"
    elif fmt == "svg":
        xmi = model.get("xmi")
        if not isinstance(xmi, dict) or (not xmi.get("elements") and not xmi.get("connectors")):
            raise ValueError("export_empty")
        result = generate_visualisation(xmi)
        data = result.getvalue() if hasattr(result, "getvalue") else result
        media_type = "image/svg+xml"
        ext = "svg"
    elif fmt == "png":
        xmi = model.get("xmi")
        if not isinstance(xmi, dict) or (not xmi.get("elements") and not xmi.get("connectors")):
            raise ValueError("export_empty")
        result = generate_visualisation_png(xmi)
        data = result.getvalue() if hasattr(result, "getvalue") else result
        media_type = "image/png"
        ext = "png"
    else:
        raise ValueError("unsupported_format")

    if not data:
        raise ValueError("export_empty")

    return data, media_type, ext
