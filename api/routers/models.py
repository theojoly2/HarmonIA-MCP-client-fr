"""User model history router."""

import json
from typing import Optional

from fastapi import APIRouter, Request, Response, UploadFile, File, Form, Depends
from pydantic import BaseModel

from api.dependencies import generate_svg_for_bytes
from api.routers.auth import require_user
from api.services.model_store import (
    delete_model,
    ensure_user_store,
    get_model,
    list_models,
    rename_model,
    save_model,
)


router = APIRouter(prefix="/api/models", tags=["models"])


class ImportResponse(BaseModel):
    id: str
    name: str
    source_format: str
    created_at: str
    updated_at: str


class RenameBody(BaseModel):
    name: str


@router.get("")
async def get_models(username: str = Depends(require_user)):
    ensure_user_store(username)
    return {"models": list_models(username)}


@router.post("/import", response_model=ImportResponse)
async def import_model(
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    username: str = Depends(require_user),
):
    ensure_user_store(username)
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

    payload = save_model(
        username=username,
        model_data=stored_data,
        name=display_name,
        source_format=kind or "unknown",
    )
    return ImportResponse(
        id=payload["id"],
        name=payload["name"],
        source_format=payload["source_format"],
        created_at=payload["created_at"],
        updated_at=payload["updated_at"],
    )


@router.get("/{model_id}")
async def read_model(model_id: str, username: str = Depends(require_user)):
    model = get_model(username, model_id)
    if not model:
        return Response(status_code=404, content=json.dumps({"detail": "model_not_found"}))
    return model


@router.post("/{model_id}/open")
async def open_model(model_id: str, username: str = Depends(require_user)):
    model = get_model(username, model_id)
    if not model:
        return Response(status_code=404, content=json.dumps({"detail": "model_not_found"}))
    svg = model.get("data", {}).get("svg", "")
    if not svg:
        return Response(status_code=422, content=json.dumps({"detail": "no_svg_for_model"}))
    return Response(content=svg.encode("utf-8"), media_type="image/svg+xml", headers={
        "X-Model-Id": model_id,
        "X-Model-Name": model.get("name", ""),
    })


@router.post("/{model_id}/open-source")
async def open_model_source(model_id: str, username: str = Depends(require_user)):
    model = get_model(username, model_id)
    if not model:
        return Response(status_code=404, content=json.dumps({"detail": "model_not_found"}))
    data = model.get("data", {})
    source_b64 = data.get("source_bytes_b64")
    if source_b64:
        import base64
        source_bytes = base64.b64decode(source_b64)
    elif "ttl_raw" in data:
        source_bytes = data["ttl_raw"].encode("utf-8")
    elif "source" in data:
        source_bytes = json.dumps(data["source"], ensure_ascii=False).encode("utf-8")
    else:
        source_bytes = b""
    from fastapi.responses import StreamingResponse
    from io import BytesIO
    return StreamingResponse(BytesIO(source_bytes), media_type="application/octet-stream", headers={
        "X-Model-Id": model_id,
        "X-Model-Name": model.get("name", ""),
        "X-Source-Format": model.get("source_format", ""),
    })


@router.patch("/{model_id}/rename")
async def rename(model_id: str, body: RenameBody, username: str = Depends(require_user)):
    meta = rename_model(username, model_id, body.name.strip())
    return meta


@router.delete("/{model_id}")
async def remove(model_id: str, username: str = Depends(require_user)):
    delete_model(username, model_id)
    return {"ok": True}


def base64_for_bytes(data: bytes) -> str:
    import base64
    return base64.b64encode(data).decode("ascii")
