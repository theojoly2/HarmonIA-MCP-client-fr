"""User model history router.

Models are persisted by name (unique per user) on the MCP server under
resources/semantic_model/models/{user}/{name}.json.
"""

import json
import re
from datetime import datetime
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


def _unique_model_name(name: str) -> str:
    """Append an invisible timestamp suffix so duplicate names never overwrite files."""
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    return f"{name}\u0001{timestamp}"


def _display_name(stored_name: str) -> str:
    """Strip the invisible timestamp suffix for UI display."""
    return stored_name.split("\u0001", 1)[0]


router = APIRouter(prefix="/api/models", tags=["models"])


class ImportResponse(BaseModel):
    name: str
    source_format: str


class RenameBody(BaseModel):
    name: str


class EmptyModelBody(BaseModel):
    name: str


class ClassEditBody(BaseModel):
    title: str
    definition: str = ""
    usage_note: str = ""
    package: Optional[str] = None
    uri: Optional[str] = None


class AttributeEditBody(BaseModel):
    class_name: str
    attr_label: str
    attr_definition: str = ""
    attr_uri: str
    attr_usage_note: str = ""
    attr_type: Optional[str] = None
    lower_bounds: str = ""
    upper_bounds: str = ""


class ConnectorEditBody(BaseModel):
    source_name: str
    target_name: str
    rel_label: str
    rel_definition: str = ""
    rel_uri: str
    relationship: str = "Association"
    lb: str = ""
    rb: str = ""
    lt: str = ""
    rt: str = ""
    rel_usage_note: str = ""


@router.get("")
async def get_models(username: str = Depends(require_user)):
    models = await list_models(username)
    for model in models:
        model["name"] = _display_name(model.get("name", ""))
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
    stored_name = _unique_model_name(display_name)

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
    stored_data["name"] = stored_name

    payload = await save_model(
        username=username,
        name=stored_name,
        model_data=stored_data,
    )
    return ImportResponse(
        name=_display_name(payload.get("name", stored_name)),
        source_format=payload.get("source_format", kind or "unknown"),
    )


@router.post("/create-empty", response_model=ImportResponse)
async def create_empty_model(body: EmptyModelBody, username: str = Depends(require_user)):
    """Create a brand-new empty model with an empty-class placeholder SVG."""
    from data_model_utils import generate_visualisation
    from io import BytesIO

    display_name = body.name.strip() or "Nouveau modèle"
    stored_name = _unique_model_name(display_name)
    xmi = {"elements": [], "connectors": []}
    svg_bytes = generate_visualisation(xmi)
    svg_text = svg_bytes.getvalue().decode("utf-8", errors="replace")

    stored_data = {
        "xmi": xmi,
        "svg": svg_text,
        "source_filename": "",
        "source_format": "empty",
        "name": stored_name,
    }

    payload = await save_model(
        username=username,
        name=stored_name,
        model_data=stored_data,
    )
    return ImportResponse(
        name=_display_name(payload.get("name", stored_name)),
        source_format="empty",
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
    # If the model JSON was mutated after import (e.g. add_class/add_attribute/add_connector),
    # regenerate the SVG from the current model JSON so edits are visible.
    xmi = model.get("xmi")
    if isinstance(xmi, dict) and (xmi.get("elements") or xmi.get("connectors")):
        try:
            from data_model_utils import generate_visualisation
            svg_result = generate_visualisation(xmi)
            svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
            svg = svg_bytes.decode("utf-8", errors="replace")
        except Exception as e:
            print(f"[open_model] SVG regeneration failed: {e}", flush=True)
    if not svg:
        return Response(status_code=422, content=json.dumps({"detail": "no_svg_for_model"}))
    # Update last-opened time in the background so it bubbles to the top of the history list.
    # Do not block the SVG response if the MCP server is temporarily unreachable.
    import asyncio
    asyncio.create_task(touch_model(username, model_name))
    # Preserve main-class hint from the original SVG if present.
    main_class = ""
    if svg and model.get("svg"):
        match = re.search(r'data-main-class="([^"]*)"', model.get("svg", ""))
        main_class = match.group(1) if match else ""
    if main_class and "data-main-class=" not in svg:
        svg = svg.replace("<svg", f'<svg data-main-class="{main_class}"', 1)
    return Response(content=svg.encode("utf-8"), media_type="image/svg+xml", headers={
        "X-Model-Name": _display_name(model.get("name", "")),
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
        title=body.title.strip(),
        definition=body.definition.strip(),
        usage_note=body.usage_note.strip(),
        package=(body.package or "").strip() or None,
        uri=(body.uri or "").strip() or None,
    )
    return result


@router.post("/{model_name}/add-attribute")
async def add_attribute_route(model_name: str, body: AttributeEditBody, username: str = Depends(require_user)):
    result = await add_attribute(
        username,
        model_name,
        class_name=body.class_name.strip(),
        attr_label=body.attr_label.strip(),
        attr_definition=body.attr_definition.strip(),
        attr_uri=body.attr_uri.strip(),
        attr_usage_note=body.attr_usage_note.strip(),
        attr_type=(body.attr_type or "").strip() or None,
        lower_bounds=body.lower_bounds.strip(),
        upper_bounds=body.upper_bounds.strip(),
    )
    return result


@router.post("/{model_name}/add-connector")
async def add_connector_route(model_name: str, body: ConnectorEditBody, username: str = Depends(require_user)):
    result = await add_connector(
        username,
        model_name,
        source_name=body.source_name.strip(),
        target_name=body.target_name.strip(),
        rel_label=body.rel_label.strip(),
        rel_definition=body.rel_definition.strip(),
        rel_uri=body.rel_uri.strip(),
        relationship=(body.relationship or "Association").strip(),
        lb=body.lb.strip(),
        rb=body.rb.strip(),
        lt=body.lt.strip(),
        rt=body.rt.strip(),
        rel_usage_note=body.rel_usage_note.strip(),
    )
    return result


def base64_for_bytes(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")
