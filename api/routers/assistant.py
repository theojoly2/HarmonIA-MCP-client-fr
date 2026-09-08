"""Assistant chatbot router.

Streams model-building chat responses with tool calling.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from api.gateways import assistant_gateway as assistant_gw
from api.schemas.assistant import (
    AssistantStreamRequest,
    AssistantRenameBody,
    LinkModelBody,
    ImportFromDocumentRequest,
)
from api.security import require_user
from api.services.assistant_orchestrator import assistant_stream_generator
from api.utils.errors import api_error_payload, domain_to_http
from api.utils.sse import _event

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


SSE_HEADERS = {
    "X-Accel-Buffering": "no",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Connection": "keep-alive",
}


@router.post("/stream")
async def stream_assistant_response(
    request: AssistantStreamRequest,
    username: str = Depends(require_user),
):
    return StreamingResponse(
        assistant_stream_generator(request, username),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.post("/import")
async def import_assistant_model(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    origin: Optional[str] = Form("assistant"),
    username: str = Depends(require_user),
):
    """Import a model for the assistant chatbot."""
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=api_error_payload("failed_to_read_file", str(e))) from e

    try:
        result = await assistant_gw.import_assistant_model_file(
            file_bytes=file_bytes,
            filename=file.filename or "model.txt",
            name=name,
            origin=origin,
            username=username,
        )
    except ValueError as e:
        args = e.args
        if len(args) == 2 and isinstance(args[1], list):
            raise HTTPException(status_code=400, detail=api_error_payload(args[0], "Import validation failed", args[1])) from e
        raise HTTPException(status_code=400, detail=api_error_payload("import_failed", str(e))) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=api_error_payload("import_failed", str(e))) from e

    return JSONResponse(result)


@router.post("/import-from-document")
async def import_assistant_model_from_document(
    request: ImportFromDocumentRequest,
    username: str = Depends(require_user),
):
    """Import a model for the assistant chatbot from an indexed document."""
    try:
        result = await assistant_gw.import_assistant_model_from_document(
            doc_id=request.doc_id,
            origin=request.origin,
            username=username,
        )
    except Exception as e:
        raise domain_to_http(e) from e

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
    try:
        return await assistant_gw.list_assistant_sessions(username, origin)
    except Exception as e:
        raise domain_to_http(e) from e


@router.get("/sessions/by-model")
async def find_assistant_session_by_model(
    model_name: str,
    origin: str = "modeler",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.find_session_by_model(username, model_name, origin)
    except Exception as e:
        raise domain_to_http(e) from e


@router.delete("/sessions/{session}")
async def delete_assistant_session(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.delete_assistant_session(username, session, origin)
    except Exception as e:
        raise domain_to_http(e) from e


@router.post("/sessions/{session}/open")
async def touch_assistant_session(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.touch_assistant_session(username, session, origin)
    except Exception as e:
        raise domain_to_http(e) from e


@router.patch("/sessions/{session}/rename")
async def rename_assistant_session(
    session: str,
    body: AssistantRenameBody,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.rename_assistant_session(
            username=username,
            session=session,
            new_display_name=body.name,
            origin=origin,
        )
    except Exception as e:
        raise domain_to_http(e) from e


@router.post("/sessions/{session}/link-model")
async def link_assistant_session_model(
    session: str,
    body: LinkModelBody,
    origin: str = "modeler",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.link_assistant_session_model(
            username=username,
            session=session,
            model_name=body.model_name,
            origin=origin,
        )
    except Exception as e:
        raise domain_to_http(e) from e


@router.get("/history")
async def get_assistant_history(
    session: str,
    origin: str = "assistant",
    username: str = Depends(require_user),
):
    try:
        return await assistant_gw.get_assistant_history(username, session, origin)
    except Exception as e:
        raise domain_to_http(e) from e
