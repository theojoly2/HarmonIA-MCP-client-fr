"""Shared Pydantic schemas for the assistant endpoints."""

from __future__ import annotations

from pydantic import BaseModel


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


class RenameRequest(BaseModel):
    name: str


class TouchSessionRequest(BaseModel):
    session: str = "default"


class FindSessionRequest(BaseModel):
    model_name: str
    origin: str = "modeler"
