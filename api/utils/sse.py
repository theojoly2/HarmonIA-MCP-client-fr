"""Shared SSE/event-streaming helpers."""

from __future__ import annotations

import json
from typing import Any


def _safe_json_loads(text: str | None) -> Any:
    """Safely parse a JSON string, returning None on any failure."""
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _event(kind: str, payload: dict[str, Any]) -> str:
    """Return an SSE data line for the given event kind and payload."""
    if kind.startswith(":"):
        # Comment-style heartbeat or control line.
        return f"{kind}\n\n"
    return f"event: {kind}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
