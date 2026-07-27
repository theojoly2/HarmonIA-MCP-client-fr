"""Search history router."""

import json
from typing import Optional

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from api.routers.auth import require_user
from api.services.search_history_store import delete_search, list_searches, save_search


router = APIRouter(prefix="/api/searches", tags=["searches"])


class SaveSearchBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)
    tags: list[str] = Field(default_factory=list)


class SearchHistoryItem(BaseModel):
    id: int
    username: str
    query: str
    tags: str
    created_at: str


@router.get("")
async def get_searches(username: str = Depends(require_user)):
    return {"searches": list_searches(username)}


@router.post("", response_model=SearchHistoryItem)
async def add_search(body: SaveSearchBody, username: str = Depends(require_user)):
    item = save_search(username, body.query, body.tags)
    return item


@router.delete("/{search_id}")
async def remove_search(search_id: int, username: str = Depends(require_user)):
    delete_search(username, search_id)
    return {"ok": True}
