from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from api.routers.auth import require_user
from api.services.api_key_store import create_api_key, list_api_keys, revoke_api_key
from api.services.user_store import get_user_by_username


router = APIRouter(prefix="/api/external/v1/keys", tags=["external-api-keys"])


class ApiKeyCreateBody(BaseModel):
    name: Optional[str] = Field(None, max_length=64)


class ApiKeyCreateResponse(BaseModel):
    id: int
    name: Optional[str]
    key: str
    created_at: str


class ApiKeyListItem(BaseModel):
    id: int
    name: Optional[str]
    created_at: str
    last_used_at: Optional[str]


async def require_user_web(request: Request) -> str:
    return await require_user(request)


@router.post("", response_model=ApiKeyCreateResponse)
async def create_key(body: ApiKeyCreateBody, username: str = Depends(require_user_web)):
    user = get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="user_not_found")
    plain_key, api_key = create_api_key(user["id"], name=body.name)
    return ApiKeyCreateResponse(
        id=api_key.id,
        name=api_key.name,
        key=plain_key,
        created_at=api_key.created_at.isoformat(),
    )


@router.get("", response_model=list[ApiKeyListItem])
async def list_keys(username: str = Depends(require_user_web)):
    user = get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="user_not_found")
    keys = list_api_keys(user["id"])
    return [
        ApiKeyListItem(
            id=k.id,
            name=k.name,
            created_at=k.created_at.isoformat(),
            last_used_at=k.last_used_at.isoformat() if k.last_used_at else None,
        )
        for k in keys
    ]


@router.delete("/{key_id}")
async def revoke_key(key_id: int, username: str = Depends(require_user_web)):
    user = get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=401, detail="user_not_found")
    ok = revoke_api_key(user["id"], key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="key_not_found")
    return {"ok": True}
