"""Assistant chatbot router.

Streams model-building chat responses with tool calling, mirroring
autre_version's chat_logic in a FastAPI/Vanilla-JS stack.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Form, HTTPException, Request, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from api.naming import display_name_from_stored as _display_model_name, model_name_from_filename as _model_name_from_filename, unique_model_name
from api.routers.auth import require_user
from api.services.assistant_history import AssistantHistory
from api.services.assistant_import import build_import_session_name, parse_and_upload_model_file
from api.services.assistant_orchestrator import assistant_stream_generator
from api.services.assistant_streaming import _event
from api.services.mcp_service import delete_model_mcp, fetch_document_file
from data_model_utils import ModelProcessingError

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class AssistantStreamRequest(BaseModel):
    session: str = "default"
    user_message: str
    model_name: str = ""
    model_names: list[str] = []
    tags: list[str] = []
    origin: str = "assistant"


class AssistantRenameBody(BaseModel):
    name: str


class LinkModelBody(BaseModel):
    model_name: str


class AssistantSessionRequest(BaseModel):
    session: str = "default"


class ImportFromDocumentRequest(BaseModel):
    doc_id: str
    origin: str = "assistant"


def _safe_json_loads(text: str | None) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _slugify_session_name(text: str) -> str:
    slug = (
        text.lower()
        .strip()
        .replace("'", " ")
        .replace("-", " ")
        .replace("_", " ")
        .replace(".", " ")
    )
    slug = re.sub(r"[^a-z0-9\s]", "", slug)
    slug = re.sub(r"\s+", "_", slug)
    slug = slug[:40]
    if not slug:
        slug = "session"
    return f"{slug}"


@router.post("/stream")
async def stream_assistant_response(
    request: AssistantStreamRequest,
    username: str = Depends(require_user),
):
    return StreamingResponse(
        assistant_stream_generator(request, username),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
        },
    )


@router.post("/import")
async def import_assistant_model(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    origin: Optional[str] = Form("assistant"),
    username: str = Depends(require_user),
):
    """
    Import a model for the assistant chatbot, mirroring autre_version's upload_xml:
    parse the file locally, build the JSON model, add a 'Generated' package for
    XMI/XML, and upload the model to the MCP server so it becomes context for the LLM.
    """
    session_origin = (origin or "assistant").strip().lower()
    if session_origin not in {"assistant", "modeler", "external_api"}:
        session_origin = "assistant"

    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {e}") from e

    filename = file.filename or "model.txt"
    display_name = (name or filename).strip() or "imported_model"
    session_name = unique_model_name(_model_name_from_filename(display_name))

    try:
        json_data = await parse_and_upload_model_file(
            file_bytes=file_bytes,
            filename=filename,
            username=username,
            session_name=session_name,
            add_generated_package=True,
        )
    except ModelProcessingError as e:
        raise HTTPException(status_code=400, detail={"title": e.title, "details": e.details}) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e

    return JSONResponse({
        "name": session_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
        "origin": session_origin,
    })


@router.post("/import-from-document")
async def import_assistant_model_from_document(
    request: ImportFromDocumentRequest,
    username: str = Depends(require_user),
):
    """
    Import a model for the assistant chatbot from a document already stored in
    the vector index. Mirrors /api/assistant/import but fetches the file bytes
    from the document store.
    """
    session_origin = (request.origin or "assistant").strip().lower()
    if session_origin not in {"assistant", "modeler", "external_api"}:
        session_origin = "assistant"

    file_data = await fetch_document_file(request.doc_id)
    if not file_data.get("success"):
        raise HTTPException(status_code=404, detail=file_data.get("error", "Document introuvable"))

    try:
        import base64
        file_bytes = base64.b64decode(file_data["file_base64"])
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode document: {e}") from e

    filename = file_data.get("filename", "document")
    display_name = filename
    session_name = build_import_session_name(display_name, add_timestamp=True)

    try:
        json_data = await parse_and_upload_model_file(
            file_bytes=file_bytes,
            filename=filename,
            username=username,
            session_name=session_name,
            add_generated_package=True,
        )
    except ModelProcessingError as e:
        raise HTTPException(status_code=400, detail={"title": e.title, "details": e.details}) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e

    return JSONResponse({
        "name": session_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
        "origin": session_origin,
    })


@router.get("/test-stream")
async def test_stream():
    """Endpoint de test pour vérifier le streaming temps réel sans LLM."""
    async def generator():
        import asyncio
        for i in range(5):
            yield _event("assistant_text", {"content": f"chunk {i} "})
            await asyncio.sleep(0.5)
        yield _event("done", {})

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/sessions")
async def list_assistant_sessions(
    origin: Optional[str] = None,
    username: str = Depends(require_user),
):
    sessions = []
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        # Use the display file mtime as the last activity timestamp.
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)

        session_origin = h.origin or "assistant"
        # When listing standalone assistant history, hide modeler-originated
        # sessions that are tied to a model; those are surfaced via the modeler
        # entry instead.
        if origin is None and session_origin == "modeler" and h.assistant_model_name:
            continue
        if origin and session_origin != origin.strip().lower():
            continue

        # Build a short preview from the first user message in display_messages.
        preview = ""
        for msg in h.display_messages:
            if msg.get("role") == "user" and msg.get("content"):
                preview = str(msg["content"]).strip().replace("\n", " ")[:80]
                break

        sessions.append({
            "name": session,
            "display_name": h.display_name or "",
            "last_opened_at": mtime,
            "preview": preview,
            "model_name": h.assistant_model_name,
            "model_names": h.assistant_model_names if h.assistant_model_names else ([h.assistant_model_name] if h.assistant_model_name else []),
            "origin": session_origin,
        })
    sessions.sort(key=lambda s: s["last_opened_at"], reverse=True)
    return {"sessions": sessions}


@router.get("/sessions/by-model")
async def find_assistant_session_by_model(
    model_name: str,
    origin: str = "modeler",
    username: str = Depends(require_user),
):
    """Return the most recently touched assistant session linked to a model.

    The origin parameter lets callers scope the search to the modeler assistant
    (default) or to the standalone assistant.
    """
    target_origin = (origin or "modeler").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "modeler"

    best_session = ""
    best_mtime = 0
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        if h.assistant_model_name != model_name:
            continue
        if h.origin != target_origin:
            continue
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)
        if mtime >= best_mtime:
            best_mtime = mtime
            best_session = session
    if not best_session:
        # Empty result is expected when the model has never been chatted with.
        # Return 200 so the client can start a fresh session without logging a 404.
        return {"session": "", "model_name": model_name, "origin": target_origin}
    return {"session": best_session, "model_name": model_name, "origin": target_origin}


@router.delete("/sessions/{session}")
async def delete_assistant_session(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    """Delete an assistant session and cascade-delete linked models.

    For modeler-origin sessions the linked model is removed. For standalone
    assistant sessions we also remove models that were imported exclusively
    through the assistant (assistant_model_names). Models created or edited in
    the modeler remain untouched for standalone assistant sessions.
    """
    target_origin = (origin or "assistant").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "assistant"

    history = AssistantHistory(user=username, session=session, origin=target_origin)
    linked_models = list(history.assistant_model_names or [])
    if history.assistant_model_name and history.assistant_model_name not in linked_models:
        linked_models.insert(0, history.assistant_model_name)

    if history.display_fp.exists():
        history.display_fp.unlink()
    if history.llm_fp.exists():
        history.llm_fp.unlink()

    deleted_models: list[str] = []
    failed_models: list[tuple[str, str]] = []
    for model_name in linked_models:
        try:
            await delete_model_mcp(username, model_name)
            deleted_models.append(model_name)
        except Exception as e:
            failed_models.append((model_name, str(e)))
            print(f"[Assistant delete session] failed to delete linked model {model_name}: {e}", flush=True)

    return {"ok": True, "deleted_models": deleted_models, "failed_models": failed_models}


@router.post("/sessions/{session}/open")
async def touch_assistant_session(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    """Update the session file mtime so it bubbles to the top of the history list."""
    target_origin = (origin or "assistant").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "assistant"

    history = AssistantHistory(user=username, session=session, origin=target_origin)
    for fp in (history.display_fp, history.llm_fp):
        if fp.exists():
            # Use None so os.utime sets both atime and mtime to the current
            # system time. The listing endpoint reads st_mtime * 1000 (ms).
            os.utime(fp, None)
    return {"ok": True}


@router.patch("/sessions/{session}/rename")
async def rename_assistant_session(
    session: str,
    body: AssistantRenameBody,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    """Rename an assistant session by moving its display and llm files."""
    target_origin = (origin or "assistant").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "assistant"

    old_history = AssistantHistory(user=username, session=session, origin=target_origin)
    if not old_history._session_exists():
        raise HTTPException(status_code=404, detail="Session inconnue")

    new_display_name = body.name.strip()
    new_stored_name = _slugify_session_name(new_display_name)
    # Append a timestamp suffix to keep the internal name unique, just like new sessions.
    new_stored_name = f"{new_stored_name}__{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    new_history = AssistantHistory(user=username, session=new_stored_name, origin=target_origin)
    new_history.display_messages = old_history.display_messages
    new_history.display_events = old_history.display_events
    new_history.system_messages = old_history.system_messages
    new_history.conversation_summary = old_history.conversation_summary
    new_history.current_request_trace = old_history.current_request_trace
    new_history.current_request_llm_messages = old_history.current_request_llm_messages
    new_history.current_request_user_input = old_history.current_request_user_input
    new_history.last_two_messages_fullish = old_history.last_two_messages_fullish
    new_history.last_execution_plan_full = old_history.last_execution_plan_full
    new_history.retained_retrieve_documents = old_history.retained_retrieve_documents
    new_history.last_tool_observations_compact = old_history.last_tool_observations_compact
    new_history.assistant_model_name = old_history.assistant_model_name
    new_history.assistant_model_names = old_history.assistant_model_names
    new_history.display_name = new_display_name
    new_history.origin = target_origin
    new_history.save()

    if old_history.display_fp.exists():
        old_history.display_fp.unlink()
    if old_history.llm_fp.exists():
        old_history.llm_fp.unlink()

    return {
        "name": new_stored_name,
        "display_name": new_display_name,
        "origin": target_origin,
    }


@router.post("/sessions/{session}/link-model")
async def link_assistant_session_model(
    session: str,
    body: LinkModelBody,
    origin: str = "modeler",
    username: str = Depends(require_user),
):
    """Update the model name linked to a modeler-originated assistant session."""
    target_origin = (origin or "modeler").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "modeler"

    history = AssistantHistory(user=username, session=session, origin=target_origin)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail="Session inconnue")

    history.assistant_model_name = body.model_name.strip()
    history.assistant_model_names = [body.model_name.strip()]
    history.display_name = history.display_name or history.display_fp.stem
    history.save()
    return {"ok": True}


@router.get("/history")
async def get_assistant_history(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    target_origin = (origin or "assistant").strip().lower()
    if target_origin not in {"assistant", "modeler", "external_api"}:
        target_origin = "assistant"

    history = AssistantHistory(user=username, session=session, origin=target_origin)
    messages = history.load_display_messages()
    display_events = history.display_events
    return {
        "session": session,
        "display_name": history.display_name or "",
        "messages": messages,
        "display_events": display_events,
        "model_name": history.assistant_model_name,
        "model_names": history.assistant_model_names if history.assistant_model_names else ([history.assistant_model_name] if history.assistant_model_name else []),
        "origin": history.origin or target_origin,
    }
