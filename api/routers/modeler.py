import os
from io import BytesIO

from fastapi import APIRouter, Request, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse, Response

from api.dependencies import generate_svg_for_bytes

router = APIRouter(prefix="/api/modeler", tags=["modeler"])


@router.post("/import")
async def modeler_import(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        filename = file.filename or "document.txt"
        svg_text = generate_svg_for_bytes(file_bytes, filename)
        return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erreur d'import : {e}") from e
