"""Authentication router: register, login, logout, current user, change password."""

import json

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from api.services.auth_service import (
    create_session,
    get_session_cookie,
    SESSION_COOKIE,
    SESSION_MAX_AGE_DAYS,
    verify_password,
)
from api.services.user_store import create_user, get_user_by_username, update_user_password, get_user_by_id
from api.services.usage_store import get_usage


router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthBody(BaseModel):
    username: str = Field(..., min_length=2, max_length=64, pattern=r"^[a-zA-Z0-9_\-]+$")
    password: str = Field(..., min_length=4, max_length=128)


class ChangePasswordBody(BaseModel):
    old_password: str = Field(..., min_length=4, max_length=128)
    password: str = Field(..., min_length=4, max_length=128)


class UserResponse(BaseModel):
    id: int
    username: str


def set_session_cookie(response: Response, username: str):
    cookie = create_session(username)
    max_age = SESSION_MAX_AGE_DAYS * 24 * 60 * 60
    response.set_cookie(
        key=SESSION_COOKIE,
        value=cookie,
        httponly=True,
        secure=False,  # adjust to True when served over HTTPS
        samesite="lax",
        max_age=max_age,
        path="/",
    )


def clear_session_cookie(response: Response):
    response.delete_cookie(key=SESSION_COOKIE, path="/")


async def require_user(request: Request) -> str:
    username = get_session_cookie(request)
    if not username:
        raise HTTPException(status_code=401, detail="not_authenticated")
    return username


async def require_user_or_api_key(request: Request) -> str:
    """Allow authentication either via web session cookie or API key header."""
    username = get_session_cookie(request)
    if username:
        return username

    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        key = auth_header[7:].strip()
        from api.services.api_key_store import verify_api_key

        api_key = verify_api_key(key)
        if api_key:
            user = get_user_by_id(api_key.user_id)
            if user:
                return user["username"]

    raise HTTPException(status_code=401, detail="not_authenticated")


@router.post("/register")
async def register(body: AuthBody, response: Response):
    try:
        user = create_user(body.username, body.password)
    except ValueError as exc:
        if str(exc) == "username_exists":
            return Response(status_code=409, content=json.dumps({"detail": "username_exists"}))
        raise
    set_session_cookie(response, user["username"])
    return user


@router.post("/login")
async def login(body: AuthBody, response: Response):
    user = get_user_by_username(body.username)
    if not user or not verify_password(body.password, user["salt"], user["password_hash"]):
        return Response(status_code=401, content=json.dumps({"detail": "invalid_credentials"}))
    set_session_cookie(response, user["username"])
    return {"id": user["id"], "username": user["username"]}


@router.post("/logout")
async def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
async def me(request: Request):
    username = get_session_cookie(request)
    if not username:
        return Response(status_code=401, content=json.dumps({"detail": "not_authenticated"}))
    user = get_user_by_username(username)
    if not user:
        clear_session_cookie(Response())
        return Response(status_code=401, content=json.dumps({"detail": "user_not_found"}))
    return {"id": user["id"], "username": user["username"]}


@router.post("/change-password")
async def change_password(request: Request, body: ChangePasswordBody):
    username = get_session_cookie(request)
    if not username:
        return Response(status_code=401, content=json.dumps({"detail": "not_authenticated"}))
    user = get_user_by_username(username)
    if not user:
        return Response(status_code=401, content=json.dumps({"detail": "user_not_found"}))
    if not verify_password(body.old_password, user["salt"], user["password_hash"]):
        return Response(status_code=401, content=json.dumps({"detail": "invalid_old_password"}))
    update_user_password(user["id"], body.password)
    return {"ok": True}


@router.get("/usage")
async def usage(
    request: Request,
    scale: str = "day",
    username: str = Depends(require_user),
):
    """Return token usage for the authenticated user over a given time scale.

    Scales: day, week, month, total.
    """
    valid_scales = {"day", "week", "month", "total"}
    if scale not in valid_scales:
        scale = "day"
    return get_usage(username=username, scale=scale)
