"""Streaming utilities for the Assistant chatbot.

SSE event formatting, completion streaming, progress queue forwarding and
SVG regeneration helpers used by the assistant orchestrator.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections import defaultdict
from typing import Any, AsyncGenerator

from api.dependencies import _LLM_MODEL, llm_client
from data_model_utils import generate_visualisation


def _extract_delta_content(delta: Any) -> str:
    text = ""
    if hasattr(delta, "content") and delta.content:
        text += str(delta.content)
    return text


def _normalize_tool_calls(raw_tool_calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for call in raw_tool_calls:
        if not call.get("function", {}).get("name"):
            continue
        calls.append(
            {
                "id": call.get("id") or f"call_{len(calls)}",
                "type": call.get("type", "function"),
                "function": {
                    "name": call["function"]["name"],
                    "arguments": call["function"].get("arguments") or "{}",
                },
            }
        )
    return calls


async def _create_completion_streaming(
    llm_messages: list[dict[str, str]],
    tools: list[dict[str, Any]],
    tool_choice: str = "auto",
) -> AsyncGenerator[tuple[str, Any], None]:
    """Stream assistant text in real-time and finish with tool calls summary.

    Yields ("text", piece) for each text chunk and ("done", {"content": str,
    "tool_calls": [...], "usage": {...}}) at the end of the turn.
    """
    from api.services.token_counter import (
        count_messages_tokens,
        count_text_tokens,
        extract_usage_from_chunk,
    )

    # Estimate prompt tokens before sending (messages + tool schemas).
    prompt_estimate = count_messages_tokens(llm_messages, _LLM_MODEL)
    if tools:
        import json as _json
        prompt_estimate += count_text_tokens(_json.dumps(tools), _LLM_MODEL)

    stream = await llm_client.chat.completions.create(
        model=_LLM_MODEL,
        messages=llm_messages,
        tools=tools if tools else None,
        tool_choice=tool_choice if tools else None,
        temperature=0,
        stream=True,
    )

    assistant_text = ""
    pending_text = ""
    streamed_any_text = False
    last_flush = 0.0
    flush_interval = 0.03
    completion_estimate = 0
    usage_from_provider = None

    tool_calls_buffer: dict[int, dict[str, Any]] = defaultdict(
        lambda: {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
    )

    async for chunk in stream:
        # Capture usage from the provider if present in any chunk (often the last one).
        if usage_from_provider is None:
            usage_from_provider = extract_usage_from_chunk(chunk)

        choices = getattr(chunk, "choices", None) or []
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue

        text_piece = _extract_delta_content(delta)
        if text_piece:
            assistant_text += text_piece
            streamed_any_text = True
            completion_estimate += count_text_tokens(text_piece, _LLM_MODEL)
            yield ("text", text_piece)

        delta_tool_calls = getattr(delta, "tool_calls", None) or []
        for tc in delta_tool_calls:
            idx = getattr(tc, "index", 0) or 0
            entry = tool_calls_buffer[idx]
            tc_id = getattr(tc, "id", None)
            if tc_id:
                entry["id"] = tc_id
            tc_type = getattr(tc, "type", None)
            if tc_type:
                entry["type"] = tc_type
            function = getattr(tc, "function", None)
            if function is not None:
                fname = getattr(function, "name", None)
                fargs = getattr(function, "arguments", None)
                if fname:
                    entry["function"]["name"] += fname
                    completion_estimate += count_text_tokens(fname, _LLM_MODEL)
                if fargs:
                    entry["function"]["arguments"] += fargs
                    completion_estimate += count_text_tokens(fargs, _LLM_MODEL)

    if pending_text:
        flushed = pending_text
        pending_text = ""
        assistant_text += flushed
        streamed_any_text = True
        completion_estimate += count_text_tokens(flushed, _LLM_MODEL)
        yield ("text", flushed)

    tool_calls: list[dict[str, Any]] = []
    for idx in sorted(tool_calls_buffer.keys()):
        entry = tool_calls_buffer[idx]
        if entry["function"]["name"]:
            tool_calls.append(
                {
                    "id": entry["id"] or f"tool_call_{idx}",
                    "type": entry["type"],
                    "function": {
                        "name": entry["function"]["name"],
                        "arguments": entry["function"]["arguments"] or "{}",
                    },
                }
            )

    usage = {
        "prompt_tokens": prompt_estimate,
        "completion_tokens": completion_estimate,
        "source": "tiktoken",
    }
    if usage_from_provider:
        usage = {
            "prompt_tokens": usage_from_provider.get("prompt_tokens", prompt_estimate),
            "completion_tokens": usage_from_provider.get("completion_tokens", completion_estimate),
            "source": "usage",
        }

    yield (
        "done",
        {
            "content": assistant_text,
            "tool_calls": tool_calls,
            "streamed_any_text": streamed_any_text,
            "usage": usage,
        },
    )


def _event(kind: str, payload: dict[str, Any]) -> str:
    """Format event for Server-Sent Events streaming.

    Using the text/event-stream MIME type and the SSE wire format helps reverse
    proxies / CDNs recognise that the response must be forwarded incrementally
    instead of being buffered/compressed (e.g. Brotli) until the stream ends.
    """
    if kind.startswith(":"):
        # SSE comment/heartbeat line. Must start with a colon on its own line.
        return f": {kind[1:]}\n\n"
    data = json.dumps({"kind": kind, **payload}, ensure_ascii=False)
    return f"data: {data}\n\n"


def _generate_model_svg(model_data: dict[str, Any]) -> str:
    """Regenerate SVG text from the current model JSON, mirroring /api/models/{name}/open."""
    try:
        xmi = model_data.get("xmi") if isinstance(model_data.get("xmi"), dict) else model_data
        if not isinstance(xmi, dict) or (not xmi.get("elements") and not xmi.get("connectors")):
            return ""
        svg_result = generate_visualisation(xmi)
        svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
        svg_text = svg_bytes.decode("utf-8", errors="replace")
        # Preserve main-class hint if present in stored SVG.
        if svg_text and model_data.get("svg"):
            match = re.search(r'data-main-class="([^"]*)"', model_data.get("svg", ""))
            if match and "data-main-class=" not in svg_text:
                svg_text = svg_text.replace("<svg", f'<svg data-main-class="{match.group(1)}"', 1)
        return svg_text
    except Exception as e:
        print(f"[Assistant] SVG generation failed: {e}")
        return ""


async def _emit_progress_queue(
    queue: asyncio.Queue[str],
    sink: asyncio.Queue[str],
) -> None:
    """Forward progress events from a tool's progress queue into the main stream queue.

    This runs concurrently with the MCP tool call so the client sees progress
    updates even when the tool blocks for a long time.
    """
    while True:
        item = await queue.get()
        if item == "__done__":
            break
        await sink.put(item)
