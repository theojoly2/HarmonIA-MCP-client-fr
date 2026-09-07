"""Assistant chatbot router.

Streams model-building chat responses with tool calling, mirroring
autre_version's chat_logic in a FastAPI/Vanilla-JS stack.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from api.security import require_user
from api.schemas.assistant import (
    AssistantStreamRequest,
    AssistantRenameBody,
    LinkModelBody,
    ImportFromDocumentRequest,
)
from api.gateways import assistant_gateway as assistant_gw
from api.services.assistant_orchestrator import assistant_stream_generator
from api.services.assistant_streaming import _event
from api.utils.sse import _safe_json_loads

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


__all__ = ["router", "AssistantStreamRequest", "_event", "_safe_json_loads"]


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
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {e}") from e

    try:
        result = await assistant_gw.import_assistant_model_file(
            file_bytes=file_bytes,
            filename=file.filename or "model.txt",
            name=name,
            origin=origin,
            username=username,
        )
    except ValueError as e:
        if len(e.args) == 2 and isinstance(e.args[1], list):
            raise HTTPException(status_code=400, detail={"title": e.args[0], "details": e.args[1]}) from e
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e

    return JSONResponse(result)


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
    try:
        result = await assistant_gw.import_assistant_model_from_document(
            doc_id=request.doc_id,
            origin=request.origin,
            username=username,
        )
    except ValueError as e:
        if len(e.args) == 2 and isinstance(e.args[1], list):
            raise HTTPException(status_code=400, detail={"title": e.args[0], "details": e.args[1]}) from e
        detail = str(e)
        status = 404 if "introuvable" in detail.lower() else 400
        raise HTTPException(status_code=status, detail=detail) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e

    return JSONResponse(result)


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
    return await assistant_gw.list_assistant_sessions(username, origin)


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
    return await assistant_gw.find_session_by_model(username, model_name, origin)


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
    return await assistant_gw.delete_assistant_session(username, session, origin)


@router.post("/sessions/{session}/open")
async def touch_assistant_session(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    """Update the session file mtime so it bubbles to the top of the history list."""
    return await assistant_gw.touch_assistant_session(username, session, origin)


@router.patch("/sessions/{session}/rename")
async def rename_assistant_session(
    session: str,
    body: AssistantRenameBody,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    """Rename an assistant session by moving its display and llm files."""
    return await assistant_gw.rename_assistant_session(
        username=username,
        session=session,
        new_display_name=body.name,
        origin=origin,
    )


@router.post("/sessions/{session}/link-model")
async def link_assistant_session_model(
    session: str,
    body: LinkModelBody,
    origin: str = "modeler",
    username: str = Depends(require_user),
):
    """Update the model name linked to a modeler-originated assistant session."""
    return await assistant_gw.link_assistant_session_model(
        username=username,
        session=session,
        model_name=body.model_name,
        origin=origin,
    )


@router.get("/history")
async def get_assistant_history(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    return await assistant_gw.get_assistant_history(username, session, origin)
