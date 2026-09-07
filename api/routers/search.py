from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.gateways import search_gateway as search_gw
from api.schemas.search import SearchRequest

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/tags")
async def get_tags():
    return await search_gw.get_tags()


@router.post("")
async def search(request: SearchRequest):
    result = await search_gw.search(
        query=request.q,
        tags=request.tags,
        limit=request.limit,
    )
    return JSONResponse(result)
