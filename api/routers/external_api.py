"""External API router.

Authenticated via API keys (Bearer token). Provides headless access to
Assistant conversations with limited, non-sensitive event exposure.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime
from io import BytesIO
from typing import Any, AsyncGenerator, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from api.naming import model_name_from_filename as _model_name_from_filename
from api.routers.auth import require_user_or_api_key
from api.schemas.assistant import AssistantStreamRequest
from api.services.assistant_orchestrator import assistant_stream_generator
from api.services.assistant_history import AssistantHistory
from api.services.assistant_mcp_client import AssistantMCPClient
from api.services.assistant_streaming import _event
from api.services.mcp_service import delete_model_mcp
from api.services.model_import import parse_model_file
from api.services.model_store import export_model
from data_model_utils import ModelProcessingError


router = APIRouter(prefix="/api/external/v1", tags=["external-api"])

ORIGIN_EXTERNAL = "external_api"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CreateConversationBody(BaseModel):
    title: Optional[str] = Field(None, max_length=120)


class CreateConversationResponse(BaseModel):
    conversation_id: str
    title: Optional[str]
    created_at: str


class ChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=20000)
    stream: bool = False


class ImportModelResponse(BaseModel):
    model_name: str
    display_name: str
    source_format: str


class ConversationModelItem(BaseModel):
    model_name: str
    display_name: str
    imported_at: str


class ExternalEvent(BaseModel):
    kind: str


class ToolStartEvent(ExternalEvent):
    kind: str = "tool_start"
    tool_name: str
    model_name: Optional[str] = None


class ToolEndEvent(ExternalEvent):
    kind: str = "tool_end"
    tool_name: str
    model_name: Optional[str] = None


class AssistantTextEvent(ExternalEvent):
    kind: str = "assistant_text"
    content: str


class AssistantDoneEvent(ExternalEvent):
    kind: str = "assistant_done"


class ErrorEvent(ExternalEvent):
    kind: str = "error"
    message: str


class ChatResponse(BaseModel):
    events: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _conversation_model_prefix(conversation_id: str) -> str:
    return f"api_conv_{conversation_id}__"


def _generate_conversation_id() -> str:
    return f"conv_{datetime.now().strftime('%Y%m%d%H%M%S%f')}_{secrets.token_hex(4)}"


def _external_model_name(conversation_id: str, filename: str) -> str:
    from api.naming import unique_model_name
    base = _model_name_from_filename(filename)
    return unique_model_name(f"{_conversation_model_prefix(conversation_id)}{base}")


def _extract_target_model_name(tool_name: str, arguments: dict[str, Any], state: dict[str, Any], model_names: list[str]) -> Optional[str]:
    if tool_name in {"add_class", "add_attribute", "add_connector"}:
        return arguments.get("model_name", state.get("name", "")).strip() or (model_names[0] if model_names else None)
    if tool_name == "display_model_visualization":
        return arguments.get("model_name", "").strip()
    return None


def _filter_external_event(event: dict[str, Any], model_names: list[str], state: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Transform internal SSE events into the limited external API surface."""
    kind = event.get("kind")

    if kind == "assistant_text":
        return {"kind": "assistant_text", "content": event.get("content", "")}

    if kind == "assistant_done":
        return {"kind": "assistant_done"}

    if kind == "tool_start":
        name = event.get("name", "")
        arguments = event.get("arguments") or {}
        model_name = _extract_target_model_name(name, arguments, state, model_names)
        return {"kind": "tool_start", "tool_name": name, "model_name": model_name}

    if kind == "tool_result":
        name = event.get("name", "")
        arguments = event.get("arguments") or {}
        model_name = _extract_target_model_name(name, arguments, state, model_names)
        return {"kind": "tool_end", "tool_name": name, "model_name": model_name}

    if kind == "error":
        return {"kind": "error", "message": event.get("message", "")}

    return None


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


@router.post("/conversations", response_model=CreateConversationResponse)
async def create_conversation(
    body: CreateConversationBody,
    username: str = Depends(require_user_or_api_key),
):
    conversation_id = _generate_conversation_id()
    title = body.title and body.title.strip()
    history = AssistantHistory(
        user=username,
        session=conversation_id,
        origin=ORIGIN_EXTERNAL,
    )
    if title:
        history.display_name = title
    history.save()
    return CreateConversationResponse(
        conversation_id=conversation_id,
        title=title,
        created_at=datetime.utcnow().isoformat() + "Z",
    )


@router.get("/conversations")
async def list_conversations(username: str = Depends(require_user_or_api_key)):
    sessions = []
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        if h.origin != ORIGIN_EXTERNAL:
            continue
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)
        preview = ""
        for msg in h.display_messages:
            if msg.get("role") == "user" and msg.get("content"):
                preview = str(msg["content"]).strip().replace("\n", " ")[:80]
                break
        sessions.append({
            "conversation_id": session,
            "title": h.display_name or "",
            "last_activity_at": mtime,
            "preview": preview,
            "model_count": len(h.assistant_model_names),
        })
    sessions.sort(key=lambda s: s["last_activity_at"], reverse=True)
    return {"conversations": sessions}


@router.get("/conversations/{conversation_id}/models", response_model=list[ConversationModelItem])
async def list_conversation_models(
    conversation_id: str,
    username: str = Depends(require_user_or_api_key),
):
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    items: list[ConversationModelItem] = []
    for name in history.assistant_model_names:
        display_name = name
        if name.startswith(_conversation_model_prefix(conversation_id)):
            inner = name[len(_conversation_model_prefix(conversation_id)):]
            if "__" in inner:
                display_name = inner.rsplit("__", 1)[0]
        items.append(ConversationModelItem(
            model_name=name,
            display_name=display_name.replace("_", " "),
            imported_at=datetime.utcnow().isoformat() + "Z",
        ))
    return items


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    username: str = Depends(require_user_or_api_key),
):
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    for model_name in history.assistant_model_names:
        try:
            await delete_model_mcp(username, model_name)
        except Exception as e:
            print(f"[External API] Failed to delete model {model_name}: {e}", flush=True)

    if history.display_fp.exists():
        history.display_fp.unlink()
    if history.llm_fp.exists():
        history.llm_fp.unlink()

    return {"ok": True}


# ---------------------------------------------------------------------------
# Model import
# ---------------------------------------------------------------------------


@router.post("/conversations/{conversation_id}/import", response_model=ImportModelResponse)
async def import_model_into_conversation(
    conversation_id: str,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    username: str = Depends(require_user_or_api_key),
):
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    max_models = 3  # mirrors AssistantApp.modelNamesConfig.max
    if len(history.assistant_model_names) >= max_models:
        raise HTTPException(status_code=400, detail=f"maximum_{max_models}_models_reached")

    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed_to_read_file: {e}") from e

    filename = file.filename or "model.txt"
    display_name = (name or filename).strip() or "imported_model"
    model_name = _external_model_name(conversation_id, filename)

    try:
        json_data = parse_model_file(file_bytes, filename)
        async with AssistantMCPClient(state={"user": username, "name": model_name, "package": ""}) as mcp_client:
            server_model = await mcp_client.upload_model({"model": json_data})
            if not server_model:
                raise ModelProcessingError("MCP Server Error", "Model upload returned None.")
        # Mark models imported through the external API so the history panel can
        # hide the standalone model entry and surface only the conversation.
        json_data["imported_from_assistant"] = True
        async with AssistantMCPClient(state={"user": username, "name": model_name, "package": ""}) as mcp_client:
            await mcp_client.upload_model({"model": json_data})
    except ModelProcessingError as e:
        raise HTTPException(status_code=400, detail={"title": e.title, "details": e.details}) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"import_failed: {e}") from e

    history.assistant_model_names.append(model_name)
    if not history.assistant_model_name:
        history.assistant_model_name = model_name
    history.save()

    return ImportModelResponse(
        model_name=model_name,
        display_name=display_name,
        source_format=json_data.get("source_format", "unknown"),
    )


def _parse_model_file(file_bytes: bytes, filename: str) -> dict[str, Any]:
    """Deprecated: use api.services.model_import.parse_model_file instead.

    Kept here for backwards compatibility with any external callers; it now
    delegates to the unified parser.
    """
    return parse_model_file(file_bytes, filename)


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


@router.post("/conversations/{conversation_id}/chat")
async def chat_with_conversation(
    conversation_id: str,
    body: ChatBody,
    username: str = Depends(require_user_or_api_key),
):
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    model_names = history.assistant_model_names[:3]

    req = AssistantStreamRequest(
        session=conversation_id,
        user_message=body.message,
        model_names=model_names,
        origin=ORIGIN_EXTERNAL,
    )

    if body.stream:
        return StreamingResponse(
            _external_stream(req, username, model_names),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Connection": "keep-alive",
            },
        )

    # Non-stream mode: keep the connection alive with SSE heartbeats while the
    # assistant loop runs, then emit a single final event containing all events.
    # This avoids 504 Gateway Timeouts from proxies that cut idle HTTP connections.
    return StreamingResponse(
        _external_non_stream(req, username, model_names),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
        },
    )


async def _external_stream(
    req: AssistantStreamRequest,
    username: str,
    model_names: list[str],
) -> AsyncGenerator[str, None]:
    state = {"name": model_names[0] if model_names else req.session}
    async for line in assistant_stream_generator(req, username):
        event = _parse_sse_line(line)
        if event is None:
            continue
        external = _filter_external_event(event, model_names, state)
        if external:
            yield _event(external["kind"], {k: v for k, v in external.items() if k != "kind"})


async def _external_non_stream(
    req: AssistantStreamRequest,
    username: str,
    model_names: list[str],
) -> AsyncGenerator[str, None]:
    """Collect all external events and emit them inside a single SSE payload.

    The response still uses text/event-stream so reverse proxies and gateways
    treat it as a streaming response and keep the connection alive.
    """
    import asyncio

    state = {"name": model_names[0] if model_names else req.session}
    events: list[dict[str, Any]] = []

    # Heartbeat task keeps the TCP connection alive while the LLM loop runs.
    heartbeat_stop = asyncio.Event()

    async def _heartbeat() -> None:
        while not heartbeat_stop.is_set():
            await asyncio.sleep(0.5)
            yield _event(":heartbeat", {})

    done_seen = False

    async def _collector() -> None:
        nonlocal done_seen
        async for line in assistant_stream_generator(req, username):
            event = _parse_sse_line(line)
            if event is None:
                continue
            external = _filter_external_event(event, model_names, state)
            if external and not done_seen:
                events.append(external)
            if external and external["kind"] == "assistant_done":
                # Keep consuming the underlying generator until it naturally
                # terminates so that history.save() and cleanup run. Stop
                # recording events after the assistant is done.
                done_seen = True
        heartbeat_stop.set()

    # Run heartbeat and collector concurrently, flushing heartbeats while waiting.
    collector_task = asyncio.create_task(_collector())
    while not collector_task.done():
        # Heartbeat
        yield _event(":heartbeat", {})
        try:
            await asyncio.wait_for(heartbeat_stop.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass
    await collector_task

    yield _event("events", {"events": events})


def _parse_sse_line(line: str) -> Optional[dict[str, Any]]:
    if not line.startswith("data: "):
        return None
    try:
        return json.loads(line[6:])
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Model export
# ---------------------------------------------------------------------------


@router.get("/models/{model_name}/export")
async def export_model_route(
    model_name: str,
    format: str = "xmi",
    username: str = Depends(require_user_or_api_key),
):
    allowed = {"xmi", "ttl", "svg", "png"}
    if format not in allowed:
        raise HTTPException(status_code=400, detail=f"unsupported_format: choose from {', '.join(allowed)}")

    try:
        blob, content_type, extension = await export_model(username, model_name, format)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"export_failed: {e}") from e

    safe_name = model_name.replace("/", "_")
    headers = {
        "Content-Disposition": f'attachment; filename="{safe_name}.{extension}"',
    }
    return StreamingResponse(iter([blob]), media_type=content_type, headers=headers)


# ---------------------------------------------------------------------------
# Import from document (optional convenience)
# ---------------------------------------------------------------------------


@router.post("/conversations/{conversation_id}/import-from-document")
async def import_model_from_document(
    conversation_id: str,
    request: Request,
    username: str = Depends(require_user_or_api_key),
):
    """Import a model from an existing indexed document into a conversation."""
    from api.services.mcp_service import fetch_document_file

    data = await request.json()
    doc_id = data.get("doc_id")
    if not doc_id:
        raise HTTPException(status_code=400, detail="doc_id_required")

    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    max_models = 3
    if len(history.assistant_model_names) >= max_models:
        raise HTTPException(status_code=400, detail=f"maximum_{max_models}_models_reached")

    file_data = await fetch_document_file(doc_id)
    if not file_data.get("success"):
        raise HTTPException(status_code=404, detail=file_data.get("error", "document_not_found"))

    try:
        import base64
        file_bytes = base64.b64decode(file_data["file_base64"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed_to_decode_document: {e}") from e

    filename = file_data.get("filename", "document")
    display_name = filename
    model_name = _external_model_name(conversation_id, filename)

    try:
        json_data = _parse_model_file(file_bytes, filename)
        async with AssistantMCPClient(state={"user": username, "name": model_name, "package": ""}) as mcp_client:
            server_model = await mcp_client.upload_model({"model": json_data})
            if not server_model:
                raise ModelProcessingError("MCP Server Error", "Model upload returned None.")
    except ModelProcessingError as e:
        raise HTTPException(status_code=400, detail={"title": e.title, "details": e.details}) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"import_failed: {e}") from e

    history.assistant_model_names.append(model_name)
    if not history.assistant_model_name:
        history.assistant_model_name = model_name
    history.save()

    return ImportModelResponse(
        model_name=model_name,
        display_name=display_name,
        source_format=json_data.get("source_format", "unknown"),
    )
