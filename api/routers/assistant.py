"""Assistant chatbot router.

Streams model-building chat responses with tool calling, mirroring
autre_version's chat_logic in a FastAPI/Vanilla-JS stack.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from openai.types.chat import ChatCompletionSystemMessageParam

from api.dependencies import _LLM_MODEL, llm_client
from api.routers.auth import require_user
from api.services.assistant_history import AssistantHistory
from api.services.assistant_mcp_client import AssistantMCPClient

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class AssistantStreamRequest(BaseModel):
    session: str = "default"
    user_message: str
    model_name: str = ""


class AssistantSessionRequest(BaseModel):
    session: str = "default"


def _safe_json_loads(text: str | None) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


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
) -> dict[str, Any]:
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

    tool_calls_buffer: dict[int, dict[str, Any]] = defaultdict(
        lambda: {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
    )

    async for chunk in stream:
        choices = getattr(chunk, "choices", None) or []
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue

        text_piece = _extract_delta_content(delta)
        if text_piece:
            pending_text += text_piece
            now = asyncio.get_event_loop().time()
            should_flush = (
                (now - last_flush) >= flush_interval
                or text_piece.endswith((" ", "\n", ".", ",", ":", ";", "!", "?"))
                or len(pending_text) >= 40
            )
            if should_flush:
                assistant_text += pending_text
                pending_text = ""
                streamed_any_text = True
                last_flush = now

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
                if fargs:
                    entry["function"]["arguments"] += fargs

    if pending_text:
        assistant_text += pending_text
        streamed_any_text = True

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

    return {
        "content": assistant_text,
        "tool_calls": tool_calls,
        "streamed_any_text": streamed_any_text,
    }


def _event(kind: str, payload: dict[str, Any]) -> str:
    return json.dumps({"kind": kind, **payload}, ensure_ascii=False) + "\n"


def _slugify_session_name(text: str) -> str:
    import re
    slug = (
        text.lower()
        .strip()
        .replace("'", " ")
        .replace("-", " ")
        .replace("_", " ")
        .replace(".", " ")
    )
    slug = re.sub(r"[^a-z0-9\s]", "", slug)
    slug = re.sub(r"\s+", "_", slug)
    parts = slug.split("_")[:8]
    slug = "_".join(parts)[:80]
    if not slug:
        from datetime import datetime
        slug = datetime.now().strftime("session_%Y%m%d_%H%M%S")
    return slug


async def assistant_stream_generator(
    request: AssistantStreamRequest,
    username: str,
) -> AsyncGenerator[str, None]:
    user_input = request.user_message.strip()
    if not user_input:
        yield _event("error", {"message": "Message vide."})
        return

    session_name = request.session.strip() or _slugify_session_name(user_input)
    is_new_session = not request.session.strip()

    history = AssistantHistory(
        user=username,
        session=session_name,
    )

    state = {
        "user": username,
        "name": request.model_name or session_name,
        "package": "",
    }

    history.start_new_request(user_input)
    history.add_user_message(user_input, track_trace=False)

    if is_new_session:
        history.display_messages.insert(
            0,
            ChatCompletionSystemMessageParam(role="session_name", content=session_name),
        )

    yield _event("user", {"content": user_input, "session": session_name, "is_new_session": is_new_session})

    try:
        async with AssistantMCPClient(state) as mcp_client:
            tools = await mcp_client.tools()
            tool_schemas = [
                {
                    "type": t["type"],
                    "function": {
                        "name": t["function"]["name"],
                        "description": t["function"].get("description", ""),
                        "parameters": t["function"].get("parameters", {}),
                    },
                }
                for t in tools
            ]

            loop_count = 0
            max_loops = 10
            while loop_count < max_loops:
                loop_count += 1

                yield _event("thinking", {})

                llm_messages = [
                    {"role": msg["role"], "content": str(msg.get("content", ""))}
                    for msg in history.build_messages_for_llm(
                        current_user_input=user_input,
                        current_model_prompt="",
                    )
                ]

                streamed = await _create_completion_streaming(
                    llm_messages=llm_messages,
                    tools=tool_schemas,
                    tool_choice="auto",
                )

                content = streamed.get("content", "") or ""
                tool_calls = _normalize_tool_calls(streamed.get("tool_calls", []))
                streamed_any_text = bool(streamed.get("streamed_any_text", False))

                if streamed_any_text:
                    yield _event("assistant_text", {"content": content})

                if not content and not tool_calls:
                    yield _event("assistant_done", {"content": ""})
                    break

                if tool_calls:
                    history.add_assistant_message(content, tool_calls=tool_calls)
                    yield _event("assistant_tool_calls", {"tool_calls": tool_calls})

                    for tool_call in tool_calls:
                        function = tool_call["function"]
                        name = function["name"]
                        raw_arguments = function.get("arguments", "{}")
                        arguments = _safe_json_loads(raw_arguments) or {}
                        if not isinstance(arguments, dict):
                            arguments = {}

                        yield _event("tool_start", {"name": name, "arguments": arguments})

                        tool_message = await mcp_client.call_tool(name, arguments)
                        parsed_tool = _safe_json_loads(tool_message) or {}

                        yield _event("tool_result", {"name": name, "result": parsed_tool})

                        history.add_tool_message(
                            content=tool_message,
                            tool_call_id=tool_call["id"],
                            llm_content=tool_message,
                            tool_name=name,
                            arguments=arguments,
                        )

                        mcp_client.tool_results[name] = (
                            parsed_tool.get("tool_results") if isinstance(parsed_tool, dict) else parsed_tool
                        )

                        if name == "style_guide_check":
                            report = ""
                            if isinstance(parsed_tool, dict):
                                report = (parsed_tool.get("tool_results") or {}).get("report", "")
                            if report:
                                history.add_assistant_message(report)
                                yield _event("assistant_text", {"content": report})
                            yield _event("assistant_done", {"content": report})
                            break

                else:
                    history.add_assistant_message(content)
                    yield _event("assistant_done", {"content": content})
                    break

    except Exception as e:
        yield _event("error", {"message": str(e)})
        return

    history.finalize_current_request_summary()
    history.save()
    yield _event("done", {})


@router.post("/stream")
async def stream_assistant_response(
    request: AssistantStreamRequest,
    username: str = Depends(require_user),
):
    return StreamingResponse(
        assistant_stream_generator(request, username),
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/sessions")
async def list_assistant_sessions(username: str = Depends(require_user)):
    return {"sessions": AssistantHistory.list_sessions(username)}
