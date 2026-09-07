"""External API router.

Authenticated via API keys (Bearer token). Provides headless access to
Assistant conversations with limited, non-sensitive event exposure.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from api.gateways import external_api_gateway as external_gw
from api.security import require_user_or_api_key


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


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------


@router.post("/conversations", response_model=CreateConversationResponse)
async def create_conversation(
    body: CreateConversationBody,
    username: str = Depends(require_user_or_api_key),
):
    result = await external_gw.create_conversation(username, body.title)
    return CreateConversationResponse(**result)


@router.get("/conversations")
async def list_conversations(username: str = Depends(require_user_or_api_key)):
    return await external_gw.list_conversations(username)


@router.get("/conversations/{conversation_id}/models", response_model=list[ConversationModelItem])
async def list_conversation_models(
    conversation_id: str,
    username: str = Depends(require_user_or_api_key),
):
    items = await external_gw.list_conversation_models(username, conversation_id)
    return [ConversationModelItem(**item) for item in items]


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    username: str = Depends(require_user_or_api_key),
):
    return await external_gw.delete_conversation(username, conversation_id)


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
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"failed_to_read_file: {e}") from e

    result = await external_gw.import_model_into_conversation(
        username=username,
        conversation_id=conversation_id,
        file_bytes=file_bytes,
        filename=file.filename or "model.txt",
        name=name,
    )
    return ImportModelResponse(**result)


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


@router.post("/conversations/{conversation_id}/chat")
async def chat_with_conversation(
    conversation_id: str,
    body: ChatBody,
    username: str = Depends(require_user_or_api_key),
):
    return await external_gw.chat_with_conversation(
        username=username,
        conversation_id=conversation_id,
        message=body.message,
        stream=body.stream,
    )


# ---------------------------------------------------------------------------
# Model export
# ---------------------------------------------------------------------------


@router.get("/models/{model_name}/export")
async def export_model_route(
    model_name: str,
    format: str = "xmi",
    username: str = Depends(require_user_or_api_key),
):
    return await external_gw.export_model_external(username, model_name, format)


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
    data = await request.json()
    doc_id = data.get("doc_id")
    if not doc_id:
        raise HTTPException(status_code=400, detail="doc_id_required")

    result = await external_gw.import_model_from_document(
        username=username,
        conversation_id=conversation_id,
        doc_id=doc_id,
    )
    return ImportModelResponse(**result)
