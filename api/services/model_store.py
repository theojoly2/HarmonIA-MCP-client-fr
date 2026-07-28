"""MCP-backed model store proxy.

Calls tools exposed by the SemantiQ-MCP-server-fr to persist models as JSON
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
    save_model,
    touch_model,
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
