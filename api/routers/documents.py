from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from api.gateways import document_gateway as document_gw

router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("/{document_id}/file")
async def get_document_file(document_id: str):
    return await document_gw.serve_document_file(document_id)


@router.get("/{document_id}/visualize")
async def visualize_document(document_id: str):
    return await document_gw.visualize_document(document_id)
