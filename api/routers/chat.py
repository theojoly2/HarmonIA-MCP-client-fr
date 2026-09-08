"""Document chat router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.security import get_session_cookie
from api.services.chat_service import stream_chat_document

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessageRequest(BaseModel):
    document_id: str
    user_message: str
    history: list[dict] = []


@router.post("/stream")
async def stream_chat_response(request: ChatMessageRequest, http_request: Request):
    username = get_session_cookie(http_request)
    stream = stream_chat_document(
        document_id=request.document_id,
        user_message=request.user_message,
        history=request.history,
        username=username,
    )
    return StreamingResponse(
        stream,
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
