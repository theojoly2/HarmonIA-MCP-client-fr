"""Shared Pydantic schemas for search endpoints."""

from __future__ import annotations

import urllib.parse
from typing import Any

from pydantic import BaseModel


class SearchRequest(BaseModel):
    q: str = ""
    tags: list[str] = []
    limit: int = 20


_IMPORTABLE_EXTENSIONS = {
    ".xml",
    ".xmi",
    ".ttl",
    ".json",
    ".jsonld",
    ".sql",
    ".txt",
    ".html",
    ".htm",
    ".csv",
}


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
    _, ext = urllib.parse.splitext(filename.lower())
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
        "can_add_to_assistant": ext in _IMPORTABLE_EXTENSIONS,
    }
