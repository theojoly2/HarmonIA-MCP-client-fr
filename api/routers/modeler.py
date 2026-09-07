from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import Response

from api.gateways.model_gateway import generate_svg_for_bytes

router = APIRouter(prefix="/api/modeler", tags=["modeler"])


@router.post("/import")
async def modeler_import(file: UploadFile = File(...)):
    try:
        file_bytes = await file.read()
        filename = file.filename or "document.txt"
        svg_text = generate_svg_for_bytes(file_bytes, filename)
        return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "unsupported_format", "message": str(exc)}) from exc
    except HTTPException:
        raise
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail={"error": "import_failed", "message": str(exc)}) from exc
