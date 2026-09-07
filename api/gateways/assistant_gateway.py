"""Assistant gateway: encapsulate assistant session operations.

Keeps HTTP/JSON serialization in the router and moves business rules
(history files, model linking, session lifecycle) here.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from data_model_utils import ModelProcessingError

from api.naming import model_name_from_filename as _model_name_from_filename, unique_model_name
from api.services.assistant_history import AssistantHistory
from api.services.assistant_import import build_import_session_name, parse_and_upload_model_file
from api.services.mcp_service import delete_model_mcp, fetch_document_file
from api.utils.text import _slugify_session_name


def _normalize_origin(origin: Optional[str], default: str = "assistant") -> str:
    value = (origin or default).strip().lower()
    if value not in {"assistant", "modeler", "external_api"}:
        return default
    return value


async def import_assistant_model_file(
    file_bytes: bytes,
    filename: str,
    name: Optional[str],
    origin: Optional[str],
    username: str,
) -> dict[str, Any]:
    session_origin = _normalize_origin(origin, "assistant")
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
        raise ValueError(e.title, e.details) from e

    return {
        "name": session_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
        "origin": session_origin,
    }


async def import_assistant_model_from_document(
    doc_id: str,
    origin: Optional[str],
    username: str,
) -> dict[str, Any]:
    session_origin = _normalize_origin(origin, "assistant")

    file_data = await fetch_document_file(doc_id)
    if not file_data.get("success"):
        raise ValueError(file_data.get("error", "Document introuvable"))

    try:
        import base64
        file_bytes = base64.b64decode(file_data["file_base64"])
    except Exception as e:
        raise ValueError(f"Failed to decode document: {e}") from e

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
        raise ValueError(e.title, e.details) from e

    return {
        "name": session_name,
        "display_name": display_name,
        "source_format": json_data.get("source_format", "unknown"),
        "origin": session_origin,
    }


async def list_assistant_sessions(username: str, origin: Optional[str] = None) -> dict[str, list[dict[str, Any]]]:
    sessions: list[dict[str, Any]] = []
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)

        session_origin = h.origin or "assistant"
        if origin is None and session_origin == "modeler" and h.assistant_model_name:
            continue
        if origin and session_origin != origin.strip().lower():
            continue

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


async def find_session_by_model(username: str, model_name: str, origin: Optional[str] = None) -> dict[str, Any]:
    target_origin = _normalize_origin(origin, "modeler")
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
    return {"session": best_session, "model_name": model_name, "origin": target_origin}


async def delete_assistant_session(username: str, session: str, origin: Optional[str] = None) -> dict[str, Any]:
    target_origin = _normalize_origin(origin, "assistant")
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

    return {"ok": True, "deleted_models": deleted_models, "failed_models": failed_models}


async def touch_assistant_session(username: str, session: str, origin: Optional[str] = None) -> dict[str, Any]:
    import os
    target_origin = _normalize_origin(origin, "assistant")
    history = AssistantHistory(user=username, session=session, origin=target_origin)
    for fp in (history.display_fp, history.llm_fp):
        if fp.exists():
            os.utime(fp, None)
    return {"ok": True}


async def rename_assistant_session(
    username: str,
    session: str,
    new_display_name: str,
    origin: Optional[str] = None,
) -> dict[str, Any]:
    from fastapi import HTTPException

    target_origin = _normalize_origin(origin, "assistant")
    old_history = AssistantHistory(user=username, session=session, origin=target_origin)
    if not old_history._session_exists():
        raise HTTPException(status_code=404, detail={"error": "session_not_found", "message": "Session inconnue"})

    new_stored_name = _slugify_session_name(new_display_name.strip())
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
    new_history.display_name = new_display_name.strip()
    new_history.origin = target_origin
    new_history.save()

    if old_history.display_fp.exists():
        old_history.display_fp.unlink()
    if old_history.llm_fp.exists():
        old_history.llm_fp.unlink()

    return {
        "name": new_stored_name,
        "display_name": new_display_name.strip(),
        "origin": target_origin,
    }


async def link_assistant_session_model(
    username: str,
    session: str,
    model_name: str,
    origin: Optional[str] = None,
) -> dict[str, Any]:
    from fastapi import HTTPException

    target_origin = _normalize_origin(origin, "modeler")
    history = AssistantHistory(user=username, session=session, origin=target_origin)
    if not history._session_exists():
        raise HTTPException(status_code=404, detail={"error": "session_not_found", "message": "Session inconnue"})

    history.assistant_model_name = model_name.strip()
    history.assistant_model_names = [model_name.strip()]
    history.display_name = history.display_name or history.display_fp.stem
    history.save()
    return {"ok": True}


async def get_assistant_history(username: str, session: str, origin: Optional[str] = None) -> dict[str, Any]:
    target_origin = _normalize_origin(origin, "assistant")
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
