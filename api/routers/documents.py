import base64
import urllib.parse

from fastapi import APIRouter, Request, Response, HTTPException
from fastapi.responses import JSONResponse

from api.dependencies import extract_filename_from_disposition, generate_svg_for_bytes
from api.services.mcp_service import fetch_document_file

router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/{document_id}/file")
async def get_document_file(document_id: str):
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise HTTPException(status_code=404, detail=f"Erreur de récupération: {data.get('error')}")
    b64_str = data["file_base64"]
    filename = data.get("filename", "document")
    ext = data.get("extension", "").lower()
    file_bytes = base64.b64decode(b64_str)
    mime_type = "text/plain; charset=utf-8"
    if ext == ".pdf":
        mime_type = "application/pdf"
    elif ext in [".html", ".htm"]:
        mime_type = "text/html; charset=utf-8"
    elif ext == ".json":
        mime_type = "application/json; charset=utf-8"
    safe_filename = urllib.parse.quote(filename)
    return Response(
        content=file_bytes,
        media_type=mime_type,
        headers={"Content-Disposition": f"inline; filename*=utf-8''{safe_filename}"}
    )


@router.get("/{document_id}/visualize")
async def visualize_document(document_id: str):
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise HTTPException(status_code=404, detail=f"Erreur de récupération: {data.get('error')}")
    file_bytes = base64.b64decode(data["file_base64"])
    filename = data.get("filename", "document")
    try:
        svg_text = generate_svg_for_bytes(file_bytes, filename)
        return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erreur de visualisation : {e}") from e
