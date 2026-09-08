"""HTTP error helpers.

Keeps the documented error payload shape (`{"error": ..., "message": ...}`)
in a single place so routers stay consistent.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def api_error_payload(code: str, message: str, details: list[str] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"error": code, "message": message}
    if details:
        payload["details"] = details
    return payload


def raise_api_error(status_code: int, code: str, message: str, details: list[str] | None = None) -> None:
    raise HTTPException(status_code=status_code, detail=api_error_payload(code, message, details))


def domain_to_http(exc: Exception) -> HTTPException:
    """Translate a domain exception to an HTTPException.

    Falls back to a generic 500 for unexpected errors.
    """
    from api.exceptions import (
        AuthenticationError,
        ConflictError,
        NotFoundError,
        PermissionError,
        ProcessingError,
        ValidationError,
    )

    if isinstance(exc, NotFoundError):
        return HTTPException(status_code=404, detail=api_error_payload(exc.code, exc.message, exc.details))
    if isinstance(exc, ConflictError):
        return HTTPException(status_code=409, detail=api_error_payload(exc.code, exc.message, exc.details))
    if isinstance(exc, ValidationError):
        return HTTPException(status_code=400, detail=api_error_payload(exc.code, exc.message, exc.details))
    if isinstance(exc, AuthenticationError):
        return HTTPException(status_code=401, detail=api_error_payload(exc.code, exc.message, exc.details))
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=api_error_payload(exc.code, exc.message, exc.details))
    if isinstance(exc, ProcessingError):
        return HTTPException(status_code=500, detail=api_error_payload(exc.code, exc.message, exc.details))

    return HTTPException(status_code=500, detail=api_error_payload("internal_error", str(exc) or "Une erreur interne est survenue."))
