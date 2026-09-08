"""Document serving and visualisation router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import Response

from api.gateways import document_gateway as document_gw
from api.security import require_user_or_api_key
from api.utils.errors import domain_to_http, raise_api_error

router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/{document_id}/file")
async def get_document_file(document_id: str):
    try:
        data = await document_gw.get_document_file(document_id)
    except Exception as exc:
        raise domain_to_http(exc) from exc

    file_bytes, mime_type, safe_filename = document_gw.build_file_response_data(data)
    return Response(
        content=file_bytes,
        media_type=mime_type,
        headers={"Content-Disposition": f"inline; filename*=utf-8''{safe_filename}"},
    )


@router.get("/{document_id}/visualize")
async def visualize_document(document_id: str):
    try:
        svg_text = await document_gw.visualize_document(document_id)
    except Exception as exc:
        raise domain_to_http(exc) from exc
    return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")


@router.get("/{document_id}/download")
async def download_document_file(document_id: str, request: Request):
    """Programmatic document download (replaces the SPA catch-all handler)."""
    try:
        data = await document_gw.get_document_file(document_id)
    except Exception as exc:
        raise domain_to_http(exc) from exc

    file_bytes, mime_type, safe_filename = document_gw.build_file_response_data(data)
    return Response(
        content=file_bytes,
        media_type=mime_type,
        headers={"Content-Disposition": f"inline; filename*=utf-8''{safe_filename}"},
    )
