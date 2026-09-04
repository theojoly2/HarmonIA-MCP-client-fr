import urllib.parse
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from api.schemas.search import SearchRequest, _normalize_search_result
from api.services.mcp_service import fetch_tags, fetch_search
from api.utils.sse import _event

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/tags")
async def get_tags():
    return {"tags": await fetch_tags()}


@router.post("")
async def search(request: SearchRequest):
    tags_data = await fetch_tags()
    raw_results = []
    if request.q:
        raw_results = await fetch_search(request.q, request.tags, request.limit)

    results = [_normalize_search_result(row) for row in raw_results]
    results = [r for r in results if r is not None]

    tags = [
        t.get("tag", t) if isinstance(t, dict) else str(t)
        for t in (tags_data or [])
    ]

    return JSONResponse({
        "results": results,
        "tags": tags,
        "selected_tags": request.tags,
        "query": request.q,
        "result_count": len(results),
        "is_centered": not bool(request.q),
    })
