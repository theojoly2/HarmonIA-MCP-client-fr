"""Shared SSE/event-streaming helpers."""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncGenerator, Callable, Optional, TypeVar


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


def _parse_sse_data_line(line: str) -> Optional[dict[str, Any]]:
    """Parse a `data: {...}` SSE line produced by `_event`."""
    if not line.startswith("data: "):
        return None
    return _safe_json_loads(line[6:])


T = TypeVar("T")


async def _stream_filtered_events(
    source: AsyncGenerator[str, None],
    transform: Callable[[dict[str, Any]], Optional[dict[str, Any]]],
    heartbeat_interval: float = 0.5,
) -> AsyncGenerator[str, None]:
    """Stream raw SSE lines, apply a transform, and emit heartbeats while waiting.

    The transform receives the parsed `{"kind": ..., ...}` payload and should
    return a replacement payload (or None to drop the event). The output is
    re-serialised with `_event`, preserving the original kind when the
    transformed payload contains a `kind` key.
    """
    done = asyncio.Event()

    async def _heartbeat() -> None:
        while not done.is_set():
            await asyncio.sleep(heartbeat_interval)
            yield _event(":heartbeat", {})

    async def _pump() -> AsyncGenerator[str, None]:
        async for line in source:
            event = _parse_sse_data_line(line)
            if event is None:
                continue
            transformed = transform(event)
            if transformed is None:
                continue
            kind = transformed.pop("kind", "event")
            yield _event(kind, transformed)
        done.set()

    pump_task: Optional[asyncio.Task] = None
    try:
        pump_task = asyncio.create_task(_consume_async_generator(_pump()))
        while not pump_task.done():
            yield _event(":heartbeat", {})
            try:
                await asyncio.wait_for(done.wait(), timeout=heartbeat_interval)
            except asyncio.TimeoutError:
                pass
        await pump_task
    finally:
        if pump_task is not None and not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass


async def _consume_async_generator(gen: AsyncGenerator[Any, None]) -> None:
    """Consume an async generator to completion inside a task."""
    async for _ in gen:
        pass


async def _collect_filtered_events(
    source: AsyncGenerator[str, None],
    transform: Callable[[dict[str, Any]], Optional[dict[str, Any]]],
    stop_kind: str = "assistant_done",
) -> list[dict[str, Any]]:
    """Collect transformed events from a raw SSE stream and stop at `stop_kind`."""
    events: list[dict[str, Any]] = []
    async for line in source:
        event = _parse_sse_data_line(line)
        if event is None:
            continue
        transformed = transform(event)
        if transformed is None:
            continue
        events.append(transformed)
        if transformed.get("kind") == stop_kind:
            break
    return events
