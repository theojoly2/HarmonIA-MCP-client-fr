"""External API gateway: encapsulate external API key authentication operations.

Mirrors the external API routes in api/routers/external_api.py.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime
from typing import Any, AsyncGenerator, Optional

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from api.naming import model_name_from_filename as _model_name_from_filename, unique_model_name
from api.schemas.assistant import AssistantStreamRequest
from api.services.assistant_history import AssistantHistory
from api.services.assistant_mcp_client import AssistantMCPClient
from api.services.assistant_orchestrator import assistant_stream_generator
from api.services.assistant_streaming import _event
from api.services.mcp_service import delete_model_mcp, fetch_document_file
from api.services.model_import import parse_model_file
from api.services.model_store import export_model
from data_model_utils import ModelProcessingError


ORIGIN_EXTERNAL = "external_api"


def _conversation_model_prefix(conversation_id: str) -> str:
    return f"api_conv_{conversation_id}__"


def _generate_conversation_id() -> str:
    return f"conv_{datetime.now().strftime('%Y%m%d%H%M%S%f')}_{secrets.token_hex(4)}"


def _external_model_name(conversation_id: str, filename: str) -> str:
    base = _model_name_from_filename(filename)
    return unique_model_name(f"{_conversation_model_prefix(conversation_id)}{base}")


def _extract_target_model_name(tool_name: str, arguments: dict[str, Any], state: dict[str, Any], model_names: list[str]) -> Optional[str]:
    if tool_name in {"add_class", "add_attribute", "add_connector"}:
        return arguments.get("model_name", state.get("name", "")).strip() or (model_names[0] if model_names else None)
    if tool_name == "display_model_visualization":
        return arguments.get("model_name", "").strip()
    return None


def _filter_external_event(event: dict[str, Any], model_names: list[str], state: dict[str, Any]) -> Optional[dict[str, Any]]:
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


def _parse_sse_line(line: str) -> Optional[dict[str, Any]]:
    if not line.startswith("data: "):
        return None
    try:
        return json.loads(line[6:])
    except Exception:
        return None


async def create_conversation(username: str, title: Optional[str] = None) -> dict[str, Any]:
    conversation_id = _generate_conversation_id()
    clean_title = title and title.strip()
    history = AssistantHistory(
        user=username,
        session=conversation_id,
        origin=ORIGIN_EXTERNAL,
    )
    if clean_title:
        history.display_name = clean_title
    history.save()
    return {
        "conversation_id": conversation_id,
        "title": clean_title,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }


async def list_conversations(username: str) -> dict[str, list[dict[str, Any]]]:
    sessions: list[dict[str, Any]] = []
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


async def list_conversation_models(username: str, conversation_id: str) -> list[dict[str, Any]]:
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    items: list[dict[str, Any]] = []
    for name in history.assistant_model_names:
        display_name = name
        if name.startswith(_conversation_model_prefix(conversation_id)):
            inner = name[len(_conversation_model_prefix(conversation_id)):]
            if "__" in inner:
                display_name = inner.rsplit("__", 1)[0]
        items.append({
            "model_name": name,
            "display_name": display_name.replace("_", " "),
            "imported_at": datetime.utcnow().isoformat() + "Z",
        })
    return items


async def delete_conversation(username: str, conversation_id: str) -> dict[str, Any]:
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


async def import_model_into_conversation(
    username: str,
    conversation_id: str,
    file_bytes: bytes,
    filename: str,
    name: Optional[str],
) -> dict[str, Any]:
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    max_models = 3
    if len(history.assistant_model_names) >= max_models:
        raise HTTPException(status_code=400, detail=f"maximum_{max_models}_models_reached")

    display_name = (name or filename).strip() or "imported_model"
    model_name = _external_model_name(conversation_id, filename)

    try:
        json_data = parse_model_file(file_bytes, filename)
        async with AssistantMCPClient(state={"user": username, "name": model_name, "package": ""}) as mcp_client:
            server_model = await mcp_client.upload_model({"model": json_data})
            if not server_model:
                raise ModelProcessingError("MCP Server Error", "Model upload returned None.")
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

    return {
        "model_name": model_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
    }


async def import_model_from_document(
    username: str,
    conversation_id: str,
    doc_id: str,
) -> dict[str, Any]:
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
        file_bytes = __import__("base64").b64decode(file_data["file_base64"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed_to_decode_document: {e}") from e

    filename = file_data.get("filename", "document")
    display_name = filename
    model_name = _external_model_name(conversation_id, filename)

    try:
        json_data = parse_model_file(file_bytes, filename)
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

    return {
        "model_name": model_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
    }


async def chat_with_conversation(
    username: str,
    conversation_id: str,
    message: str,
    stream: bool,
) -> StreamingResponse:
    history = AssistantHistory(user=username, session=conversation_id, origin=ORIGIN_EXTERNAL)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="conversation_not_found")

    model_names = history.assistant_model_names[:3]

    req = AssistantStreamRequest(
        session=conversation_id,
        user_message=message,
        model_names=model_names,
        origin=ORIGIN_EXTERNAL,
    )

    if stream:
        return StreamingResponse(
            _external_stream(req, username, model_names),
            media_type="text/event-stream",
            headers={
                "X-Accel-Buffering": "no",
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Connection": "keep-alive",
            },
        )

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
    state = {"name": model_names[0] if model_names else req.session}
    events: list[dict[str, Any]] = []
    heartbeat_stop = asyncio.Event()
    done_seen = False

    async def _heartbeat() -> None:
        while not heartbeat_stop.is_set():
            await asyncio.sleep(0.5)
            yield _event(":heartbeat", {})

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
                done_seen = True
        heartbeat_stop.set()

    collector_task = asyncio.create_task(_collector())
    while not collector_task.done():
        yield _event(":heartbeat", {})
        try:
            await asyncio.wait_for(heartbeat_stop.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass
    await collector_task

    yield _event("events", {"events": events})


async def export_model_external(
    username: str,
    model_name: str,
    format: str,
) -> StreamingResponse:
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
