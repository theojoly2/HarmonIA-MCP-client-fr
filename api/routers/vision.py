import os
from io import BytesIO

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import HTMLResponse, Response

from api.dependencies import generate_svg_for_bytes

router = APIRouter(prefix="/api/vision", tags=["vision"])


@router.post("/import")
async def vision_import(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        filename = file.filename or "document.txt"
        svg_text = generate_svg_for_bytes(file_bytes, filename)
        return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
    except Exception as e:
        import traceback
        traceback.print_exc()
        return HTMLResponse(f"<h3>Erreur d'import : {e}</h3>", status_code=500)
