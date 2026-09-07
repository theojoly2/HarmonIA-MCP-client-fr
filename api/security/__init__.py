"""Security / authentication guards.

This module keeps authentication concerns out of routers/auth.py so that other
routers can depend on security guards without importing a router.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

from api.services.auth_service import (
    create_session,
    get_session_cookie,
    SESSION_COOKIE,
    SESSION_MAX_AGE_DAYS,
    verify_password,
)
from api.services.user_store import get_user_by_id


def set_session_cookie(response, username: str):
    from fastapi.responses import Response
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


def clear_session_cookie(response):
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
