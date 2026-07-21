from typing import Any
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from api.services.mcp_service import fetch_tags, fetch_search
from api.dependencies import render_results

router = APIRouter(prefix="/api/search", tags=["search"])


class SearchRequest(BaseModel):
    q: str = ""
    tags: list[str] = []
    limit: int = 20


@router.get("/tags")
async def get_tags():
    return {"tags": await fetch_tags()}


@router.post("")
async def search(request: SearchRequest):
    tags_data = await fetch_tags()
    results_data = []
    if request.q:
        results_data = await fetch_search(request.q, request.tags, request.limit)
    rendered = render_results(results_data, query=request.q)
    tags_html = ""
    selected_tags = set(request.tags)
    if not tags_data:
        tags_html = '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>'
    else:
        for t in tags_data:
            tag_name = t.get("tag", t) if isinstance(t, dict) else str(t)
            is_checked = "checked" if tag_name in selected_tags else ""
            tags_html += f"""
            <label class="cursor-pointer select-none tag-label">
                <input type="checkbox" name="t" value="{tag_name}" class="peer hidden" {is_checked}>
                <span class="inline-flex items-center rounded-full font-bold border-2 border-gray-200 text-gray-700 peer-checked:bg-black peer-checked:text-white peer-checked:border-black hover:border-gray-400 transition-colors">
                    <svg class="icon-unchecked w-3.5 h-3.5 mr-1.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                    <svg class="icon-checked w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                    {tag_name}
                </span>
            </label>
            """
    return JSONResponse({
        "results_html": rendered["results_html"],
        "tags_html": tags_html,
        "is_centered": rendered["is_centered"],
    })
