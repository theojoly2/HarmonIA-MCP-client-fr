from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.gateways import document_gateway as document_gw

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessageRequest(BaseModel):
    document_id: str
    user_message: str
    history: list[dict] = []


@router.post("/stream")
async def stream_chat_response(request: ChatMessageRequest, http_request: Request):
    stream = await document_gw.stream_chat_document(request, http_request)
    return StreamingResponse(
        stream,
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )
