import urllib.parse
from typing import Any
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.services.mcp_service import fetch_tags, fetch_search

router = APIRouter(prefix="/api/search", tags=["search"])


class SearchRequest(BaseModel):
    q: str = ""
    tags: list[str] = []
    limit: int = 20


@router.get("/tags")
async def get_tags():
    return {"tags": await fetch_tags()}


def _normalize_search_result(row: list | tuple) -> dict[str, Any] | None:
    """Convert a raw MCP search result row into a structured dict for the frontend."""
    if not isinstance(row, (list, tuple)) or len(row) < 6:
        return None
    filename = str(row[0])
    summary = str(row[2])
    chunk0_id = str(row[3])
    score = float(row[4]) if row[4] else 0.0
    doc_tags = row[5] if isinstance(row[5], list) else []
    document_id = row[6] if len(row) > 6 else None
    _, ext = __import__("os").path.splitext(filename.lower())
    importable_extensions = {".xml", ".xmi", ".ttl", ".json", ".jsonld", ".sql", ".txt", ".html", ".htm", ".csv"}
    return {
        "filename": filename,
        "safe_filename": urllib.parse.quote(filename),
        "extension": ext,
        "summary": summary,
        "chunk0_id": chunk0_id,
        "document_id": document_id,
        "score": round(score, 4),
        "tags": doc_tags,
        "is_pdf": ext == ".pdf",
        "can_add_to_assistant": ext in importable_extensions,
    }


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
