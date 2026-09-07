"""Search gateway: encapsulate search/tag operations."""

from __future__ import annotations

from typing import Any

from api.schemas.search import _normalize_search_result
from api.services.mcp_service import fetch_search, fetch_tags


async def get_tags() -> dict[str, list[Any]]:
    return {"tags": await fetch_tags()}


async def search(
    query: str,
    tags: list[str],
    limit: int,
) -> dict[str, Any]:
    tags_data = await fetch_tags()
    raw_results = []
    if query:
        raw_results = await fetch_search(query, tags, limit)

    results = [_normalize_search_result(row) for row in raw_results]
    results = [r for r in results if r is not None]

    tags_list = [
        t.get("tag", t) if isinstance(t, dict) else str(t)
        for t in (tags_data or [])
    ]

    return {
        "results": results,
        "tags": tags_list,
        "selected_tags": tags,
        "query": query,
        "result_count": len(results),
        "is_centered": not bool(query),
    }
