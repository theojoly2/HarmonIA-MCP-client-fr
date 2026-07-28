"""User model history router.

Models are persisted by name (unique per user) on the MCP server under
resources/semantic_model/models/{user}/{name}.json.
"""

import json
from typing import Optional

from fastapi import APIRouter, Request, Response, UploadFile, File, Form, Depends
from pydantic import BaseModel

from api.dependencies import generate_svg_for_bytes
from api.routers.auth import require_user
from api.services.model_store import (
    add_attribute,
    add_class,
    add_connector,
    delete_model,
    get_model,
    list_models,
    rename_model,
    save_model,
    touch_model,
)


router = APIRouter(prefix="/api/models", tags=["models"])


class ImportResponse(BaseModel):
    name: str
    source_format: str


class RenameBody(BaseModel):
    name: str


class ClassEditBody(BaseModel):
    class_name: str
    package: Optional[str] = None


class AttributeEditBody(BaseModel):
    class_name: str
    attribute_name: str
    attribute_type: Optional[str] = None


class ConnectorEditBody(BaseModel):
    source_class: str
    target_class: str
    connector_type: Optional[str] = "Association"


@router.get("")
async def get_models(username: str = Depends(require_user)):
    models = await list_models(username)
    return {"models": models}


@router.post("/import", response_model=ImportResponse)
async def import_model(
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    username: str = Depends(require_user),
):
    file_bytes = await file.read()
    filename = file.filename or "model.txt"
    display_name = name or filename

    # Generate SVG to validate + extract model JSON
    from io import BytesIO
    svg_text = generate_svg_for_bytes(file_bytes, filename)

    # Reconstruct the JSON model used by generate_svg_for_bytes
    from data_model_utils import _detect_file_type, json_file_to_model, sql_to_model, text_to_model, ttl_to_json, xml_to_json
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
        model_data = xml_to_json(BytesIO(file_bytes))
    elif kind == "ttl":
        model_data = ttl_to_json(BytesIO(file_bytes))
    elif kind == "json":
        model_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
    elif kind == "sql":
        model_data = sql_to_model(BytesIO(file_bytes), filename=filename)
    elif kind == "text":
        model_data = text_to_model(BytesIO(file_bytes), filename=filename)
    else:
        raise ValueError("Format non supporté pour la modélisation.")

    # Always keep the canonical xmi wrapper structure
    if isinstance(model_data, dict) and "xmi" in model_data:
        stored_data = model_data
    else:
        stored_data = {"xmi": model_data}

    stored_data["svg"] = svg_text
    stored_data["source_filename"] = filename
    stored_data["source_bytes_b64"] = base64_for_bytes(file_bytes)
    stored_data["source_format"] = kind or "unknown"
    stored_data["name"] = display_name

    payload = await save_model(
        username=username,
        name=display_name,
        model_data=stored_data,
    )
    return ImportResponse(
        name=payload.get("name", display_name),
        source_format=payload.get("source_format", kind or "unknown"),
    )


@router.get("/{model_name}")
async def read_model(model_name: str, username: str = Depends(require_user)):
    model = await get_model(username, model_name)
    if not model:
        return Response(status_code=404, content=json.dumps({"detail": "model_not_found"}))
    return model


@router.post("/{model_name}/open")
async def open_model(model_name: str, username: str = Depends(require_user)):
    model = await get_model(username, model_name)
    if not model:
        return Response(status_code=404, content=json.dumps({"detail": "model_not_found"}))
    svg = model.get("svg", "")
    if not svg:
        return Response(status_code=422, content=json.dumps({"detail": "no_svg_for_model"}))
    # Update last-opened time in the background so it bubbles to the top of the history list.
    # Do not block the SVG response if the MCP server is temporarily unreachable.
    import asyncio
    asyncio.create_task(touch_model(username, model_name))
    return Response(content=svg.encode("utf-8"), media_type="image/svg+xml", headers={
        "X-Model-Name": model.get("name", ""),
    })


@router.post("/{model_name}/touch")
async def touch_model_route(model_name: str, username: str = Depends(require_user)):
    await touch_model(username, model_name)
    return {"ok": True}


@router.patch("/{model_name}/rename")
async def rename(model_name: str, body: RenameBody, username: str = Depends(require_user)):
    meta = await rename_model(username, model_name, body.name.strip())
    return meta


@router.delete("/{model_name}")
async def remove(model_name: str, username: str = Depends(require_user)):
    await delete_model(username, model_name)
    return {"ok": True}


@router.post("/{model_name}/add-class")
async def add_class_route(model_name: str, body: ClassEditBody, username: str = Depends(require_user)):
    result = await add_class(
        username,
        model_name,
        class_name=body.class_name.strip(),
        package=(body.package or "").strip() or None,
    )
    return result


@router.post("/{model_name}/add-attribute")
async def add_attribute_route(model_name: str, body: AttributeEditBody, username: str = Depends(require_user)):
    result = await add_attribute(
        username,
        model_name,
        class_name=body.class_name.strip(),
        attribute_name=body.attribute_name.strip(),
        attribute_type=(body.attribute_type or "").strip() or None,
    )
    return result


@router.post("/{model_name}/add-connector")
async def add_connector_route(model_name: str, body: ConnectorEditBody, username: str = Depends(require_user)):
    result = await add_connector(
        username,
        model_name,
        source_class=body.source_class.strip(),
        target_class=body.target_class.strip(),
        connector_type=(body.connector_type or "Association").strip(),
    )
    return result


def base64_for_bytes(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")
