"""Assistant chatbot router.

Streams model-building chat responses with tool calling, mirroring
autre_version's chat_logic in a FastAPI/Vanilla-JS stack.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections import defaultdict
from io import BytesIO
from typing import Any, AsyncGenerator, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from openai.types.chat import ChatCompletionSystemMessageParam

from api.dependencies import _LLM_MODEL, llm_client, render_results
from api.routers.auth import require_user
from api.services.assistant_history import AssistantHistory
from api.services.assistant_mcp_client import AssistantMCPClient
from api.services.mcp_service import fetch_search, upload_model_mcp, get_model_mcp, delete_model_mcp
from data_model_utils import _detect_file_type, ModelProcessingError, generate_visualisation
from data_model_utils.chat_data_structure import shorten_json

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class AssistantStreamRequest(BaseModel):
    session: str = "default"
    user_message: str
    model_name: str = ""
    tags: list[str] = []


class AssistantRenameBody(BaseModel):
    name: str


class AssistantSessionRequest(BaseModel):
    session: str = "default"


def _model_name_from_filename(filename: Optional[str]) -> str:
    import os as _os
    import re as _re
    base = filename or "imported_model"
    base = _os.path.splitext(base)[0]
    base = base.strip() or "imported_model"
    base = _re.sub(r"[^a-zA-Z0-9_\-]", "_", base)
    return base


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
) -> AsyncGenerator[tuple[str, Any], None]:
    """Stream assistant text in real-time and finish with tool calls summary.

    Yields ("text", piece) for each text chunk and ("done", {"content": str,
    "tool_calls": [...]}) at the end of the turn.
    """
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
            assistant_text += text_piece
            streamed_any_text = True
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
                if fargs:
                    entry["function"]["arguments"] += fargs

    if pending_text:
        flushed = pending_text
        pending_text = ""
        assistant_text += flushed
        streamed_any_text = True
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

    yield (
        "done",
        {
            "content": assistant_text,
            "tool_calls": tool_calls,
            "streamed_any_text": streamed_any_text,
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
    slug = slug[:40]
    if not slug:
        slug = "session"
    from datetime import datetime
    return f"{slug}"


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


async def assistant_stream_generator(
    request: AssistantStreamRequest,
    username: str,
) -> AsyncGenerator[str, None]:
    user_input = request.user_message.strip()
    if not user_input:
        yield _event("error", {"message": "Message vide."})
        return

    is_new_session = not request.session.strip()
    session_name = request.session.strip() or _slugify_session_name(user_input)

    # Make the session name unique by appending a timestamp when it comes from
    # a fresh user message, exactly like the modeler does for imported files.
    if is_new_session:
        from datetime import datetime
        session_name = f"{session_name}__{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    history = AssistantHistory(
        user=username,
        session=session_name,
    )

    model_name = request.model_name.strip()
    selected_tags = request.tags or []
    # Remember the model attached to this session so we can reopen it later.
    if model_name:
        history.assistant_model_name = model_name

    # Persist the user message (and selected source tags) as display events so
    # the timeline can be replayed exactly.
    history.add_display_event({"kind": "user", "content": user_input})
    if selected_tags:
        history.add_display_event({"kind": "selected_tags", "tags": selected_tags})

    state = {
        "user": username,
        "name": model_name or session_name,
        "package": "",
    }

    # Load the uploaded model from the MCP server to inject it into the LLM context.
    current_model_prompt = ""
    model_data: dict[str, Any] | None = None
    if model_name:
        try:
            model_data = await get_model_mcp(username, model_name)
            if model_data:
                # The model stored by the modeler contains a rich "xmi" wrapper.
                # Pass that canonical structure to the LLM so it sees classes,
                # attributes and connectors, not just a flat summary.
                xmi = model_data.get("xmi") if isinstance(model_data.get("xmi"), dict) else model_data
                current_model_prompt = (
                    "[CURRENT MODEL - JSON STRUCTURE]\n"
                    + json.dumps(xmi, ensure_ascii=False, indent=2)
                    + "\n\n[CURRENT USER MESSAGE]\n\n"
                )
        except Exception as e:
            print(f"[Assistant] Failed to load model context for {model_name}: {e}")

    history.start_new_request(user_input)
    history.add_user_message(user_input, track_trace=False)

    if is_new_session:
        history.display_messages.insert(
            0,
            ChatCompletionSystemMessageParam(role="session_name", content=session_name),
        )

    yield _event("user", {"content": user_input, "session": session_name, "is_new_session": is_new_session})

    # Shared output queue: assistant events, progress updates and heartbeats all go
    # here. A dedicated heartbeat task keeps pushing SSE comment lines so reverse
    # proxies / CDNs flush their buffers and the browser does not close the
    # connection during long MCP calls.
    out_queue: asyncio.Queue[str] = asyncio.Queue()

    async def _heartbeat() -> None:
        while True:
            await asyncio.sleep(0.2)
            await out_queue.put(_event(":heartbeat", {}))

    heartbeat_task = asyncio.create_task(_heartbeat())
    last_flush = asyncio.get_event_loop().time()

    async def _drain_out_queue() -> AsyncGenerator[str, None]:
        nonlocal last_flush
        while not out_queue.empty():
            last_flush = asyncio.get_event_loop().time()
            yield out_queue.get_nowait()



    try:
        async with AssistantMCPClient(state) as mcp_client:
            # SVG is only emitted after a model mutation or an explicit user request.
            # Do NOT send the imported-model snapshot automatically on every user message.

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
            max_loops = 6
            stream_started_at = asyncio.get_event_loop().time()
            # Track tool calls within this request. Key: "tool_name:args_json".
            # Value: {error: bool}. Used to avoid infinite loops while still allowing
            # retries after genuine errors.
            call_results: dict[str, dict[str, Any]] = {}

            while loop_count < max_loops:
                loop_count += 1
                is_last_loop = loop_count >= max_loops
                elapsed = asyncio.get_event_loop().time() - stream_started_at

                yield _event("thinking", {})
                # Give the HTTP layer a chance to flush before the LLM call starts.
                await asyncio.sleep(0.03)
                async for line in _drain_out_queue():
                    yield line

                llm_messages = [
                    {"role": msg["role"], "content": str(msg.get("content", ""))}
                    for msg in history.build_messages_for_llm(
                        current_user_input=user_input,
                        current_model_prompt=current_model_prompt,
                    )
                ]

                content = ""
                tool_calls: list[dict[str, Any]] = []
                streamed_any_text = False

                # On the last allowed loop, force the LLM to answer the user instead of
                # calling another tool. This guarantees a response even if the task is not
                # fully finished.
                effective_tool_schemas = [] if is_last_loop else tool_schemas
                effective_tool_choice = "none" if is_last_loop else "auto"

                async for stage, payload in _create_completion_streaming(
                    llm_messages=llm_messages,
                    tools=effective_tool_schemas,
                    tool_choice=effective_tool_choice,
                ):
                    if stage == "text":
                        streamed_any_text = True
                        content += str(payload)
                        yield _event("assistant_text", {"content": str(payload)})
                        async for line in _drain_out_queue():
                            yield line
                    elif stage == "done":
                        content = payload.get("content", "") or ""
                        tool_calls = _normalize_tool_calls(payload.get("tool_calls", []))
                        streamed_any_text = bool(payload.get("streamed_any_text", False))

                async for line in _drain_out_queue():
                    yield line

                if not content and not tool_calls:
                    yield _event("assistant_done", {"content": ""})
                    break

                if tool_calls:
                    print(f"[loop {loop_count}] tool_calls={[tc['function']['name'] for tc in tool_calls]}", flush=True)
                    if content.strip():
                        history.add_assistant_message(content, add_to_llm_request=False, track_trace=False)
                    history.add_assistant_message(content, tool_calls=tool_calls)
                    history.add_display_event({"kind": "assistant_tool_calls", "tool_calls": tool_calls})
                    yield _event("assistant_tool_calls", {"tool_calls": tool_calls})
                    async for line in _drain_out_queue():
                        yield line

                    # Track whether this loop contained only successful mutation/analysis tools.
                    # If so, we add a clear final observation at the end so the LLM stops.
                    all_tools_were_mutations = True
                    mutation_success_count = 0
                    analysis_tools = {"metadata_checker", "reuse_check", "validator_check", "style_guide_check"}
                    all_tools_were_analysis = True
                    analysis_success_count = 0

                    for tool_call in tool_calls:
                        function = tool_call["function"]
                        name = function["name"]
                        raw_arguments = function.get("arguments", "{}")
                        arguments = _safe_json_loads(raw_arguments) or {}
                        if not isinstance(arguments, dict):
                            arguments = {}

                        history.add_display_event({"kind": "tool_start", "name": name, "arguments": arguments})
                        yield _event("tool_start", {"name": name, "arguments": arguments})
                        async for line in _drain_out_queue():
                            yield line

                        # Deduplicate repeated calls within the same request.
                        # Allow retries only if the previous identical call failed.
                        call_key = f"{name}:{json.dumps(arguments, sort_keys=True, ensure_ascii=False)}"
                        previous = call_results.get(call_key)
                        if previous and not previous.get("error"):
                            tool_message = json.dumps({
                                "tool_name": name,
                                "tool_arguments": arguments,
                                "tool_results": {"status": "already_executed", "ok": True},
                            }, ensure_ascii=False)
                            parsed_tool = _safe_json_loads(tool_message) or {}
                        else:
                            progress_card_id: str | None = None
                            if name in {"metadata_checker", "reuse_check", "validator_check", "style_guide_check"}:
                                progress_card_id = f"progress-{name}-{uuid4().hex[:8]}"
                                history.add_display_event({"kind": "progress_start", "card_id": progress_card_id, "tool_name": name})
                                yield _event("progress_start", {"card_id": progress_card_id, "tool_name": name})
                                async for line in _drain_out_queue():
                                    yield line

                            queue: asyncio.Queue[str] = asyncio.Queue()

                            async def _progress_handler(progress: float, total: float | None, message: str | None) -> None:
                                if progress_card_id is None:
                                    return
                                pct = 0
                                if total and total > 0:
                                    pct = int(min(100, max(0, (progress / total) * 100)))
                                await queue.put(_event("progress_update", {
                                    "card_id": progress_card_id,
                                    "tool_name": name,
                                    "percent": pct,
                                    "step": int(progress),
                                    "total": int(total) if total else None,
                                    "message": message or "",
                                }))

                            # Run the MCP tool call in a background task while the main
                            # generator keeps draining the output queue (heartbeats +
                            # progress updates). This keeps the SSE connection alive.
                            call_task: asyncio.Task[str] = asyncio.create_task(
                                mcp_client.call_tool(name, arguments, progress_handler=_progress_handler)
                            )
                            progress_task: asyncio.Task[None] | None = None
                            if progress_card_id is not None:
                                progress_task = asyncio.create_task(_emit_progress_queue(queue, out_queue))
                            try:
                                while not call_task.done():
                                    async for line in _drain_out_queue():
                                        yield line
                                    await asyncio.sleep(0.05)
                                tool_message = call_task.result()
                            finally:
                                if progress_card_id is not None:
                                    await queue.put("__done__")
                                    if progress_task is not None:
                                        try:
                                            await asyncio.wait_for(progress_task, timeout=2.0)
                                        except Exception:
                                            pass
                                async for line in _drain_out_queue():
                                    yield line

                            if progress_card_id is not None:
                                history.add_display_event({"kind": "progress_done", "card_id": progress_card_id, "tool_name": name})
                                yield _event("progress_done", {"card_id": progress_card_id, "tool_name": name})
                                async for line in _drain_out_queue():
                                    yield line

                            parsed_tool = _safe_json_loads(tool_message) or {}
                            tool_results = parsed_tool.get("tool_results") if isinstance(parsed_tool, dict) else None
                            tool_error = (
                                isinstance(tool_results, dict) and bool(tool_results.get("error"))
                                or isinstance(tool_results, str) and (
                                    tool_results.lower().startswith("error") or "error" in tool_results.lower()
                                )
                            )
                            top_error = isinstance(parsed_tool, dict) and bool(parsed_tool.get("error"))
                            call_results[call_key] = {"error": bool(tool_error or top_error)}

                        is_mutation = name in {"add_class", "add_attribute", "add_connector"}
                        is_analysis = name in analysis_tools
                        all_tools_were_mutations = all_tools_were_mutations and is_mutation
                        all_tools_were_analysis = all_tools_were_analysis and is_analysis
                        if is_mutation and not call_results.get(call_key, {}).get("error"):
                            mutation_success_count += 1
                        if is_analysis and not call_results.get(call_key, {}).get("error"):
                            analysis_success_count += 1

                        # Keep the last execution plan in the LLM context so the assistant
                        # follows it instead of calling the planner again each turn.
                        if name == "plan_workflow_with_tools":
                            plan_content = tool_message or ""
                            if isinstance(parsed_tool, dict):
                                if "final_plan" in parsed_tool:
                                    plan_content = json.dumps(parsed_tool, ensure_ascii=False)
                                elif isinstance(parsed_tool.get("tool_results"), dict) and "final_plan" in parsed_tool["tool_results"]:
                                    plan_content = json.dumps(parsed_tool["tool_results"], ensure_ascii=False)
                            if plan_content:
                                history.last_execution_plan_full = plan_content
                                plan_ack = json.dumps({"final_plan": json.loads(plan_content)}, ensure_ascii=False)
                                history.add_assistant_message(
                                    plan_ack,
                                    add_to_llm_request=True,
                                    track_trace=False,
                                    add_to_display=False,
                                    add_to_events=False,
                                )

                        display_payload: dict[str, Any] | None = None
                        if name == "retrieve_documents":
                            query_terms = arguments.get("search_terms", "")
                            requested_limit = arguments.get("limit", 20)
                            try:
                                limit = int(requested_limit) if isinstance(requested_limit, (int, float, str)) and str(requested_limit).isdigit() else 20
                            except Exception:
                                limit = 20
                            try:
                                search_rows = await fetch_search(query_terms, selected_tags, limit)
                                if search_rows == "TIMEOUT":
                                    search_rows = []
                                rendered = render_results(search_rows, query=query_terms)
                                display_payload = {
                                    "type": "search",
                                    "query": query_terms,
                                    "results_html": rendered.get("results_html", ""),
                                }
                            except Exception as exc:
                                display_payload = {"type": "search", "query": query_terms, "results_html": f"<div class=\"text-red-600 p-4\">Erreur rendu recherche: {exc}</div>"}


                        history.add_display_event({"kind": "tool_result", "name": name, "result": parsed_tool, "display": display_payload})
                        yield _event("tool_result", {"name": name, "result": parsed_tool, "display": display_payload})
                        async for line in _drain_out_queue():
                            yield line

                        history.add_tool_message(
                            content=tool_message,
                            tool_call_id=tool_call["id"],
                            llm_content=tool_message,
                            tool_name=name,
                            arguments=arguments,
                        )

                        # Add a short assistant observation to the LLM context so the model
                        # clearly sees what happened instead of re-executing the same tool.
                        tool_results = parsed_tool.get("tool_results") if isinstance(parsed_tool, dict) else None
                        if name == "retrieve_documents":
                            filenames = []
                            if isinstance(tool_results, list):
                                for item in tool_results:
                                    if isinstance(item, (list, tuple)) and len(item) >= 1:
                                        filenames.append(str(item[0]))
                                    elif isinstance(item, dict):
                                        filenames.append(str(item.get("filename") or item.get("file") or item.get("name") or ""))
                            summary = f"J'ai récupéré {len(filenames)} document(s) : {', '.join(filenames)}." if filenames else "Aucun document pertinent trouvé."
                        elif name == "add_class":
                            title = tool_results.get("name") if isinstance(tool_results, dict) else None
                            summary = f"Classe '{title}' ajoutée au modèle." if title else "Classe ajoutée au modèle."
                        elif name == "add_attribute":
                            attr_name = tool_results.get("name") if isinstance(tool_results, dict) else None
                            class_name = tool_results.get("class_name") if isinstance(tool_results, dict) else None
                            summary = f"Attribut '{attr_name}' ajouté à la classe '{class_name}'." if attr_name and class_name else "Attribut ajouté au modèle."
                        elif name == "add_connector":
                            rel_name = tool_results.get("rel_label") if isinstance(tool_results, dict) else None
                            summary = f"Relation '{rel_name}' ajoutée au modèle." if rel_name else "Relation ajoutée au modèle."
                        elif name == "style_guide_check":
                            summary = "Vérification du guide de style effectuée."
                        elif name == "metadata_checker":
                            summary = "Vérification des métadonnées effectuée."
                        elif name == "reuse_check":
                            summary = "Vérification de réutilisation effectuée."
                        elif name == "validator_check":
                            summary = "Validation effectuée."
                        elif name == "display_model_visualization":
                            summary = "Affichage de la visualisation du modèle demandé."
                        else:
                            summary = f"Résultat de {name} reçu."
                        history.add_assistant_message(
                            f"[OBSERVATION] {summary}",
                            add_to_llm_request=True,
                            track_trace=False,
                            add_to_display=False,
                            add_to_events=False,
                        )

                        mcp_client.tool_results[name] = (
                            parsed_tool.get("tool_results") if isinstance(parsed_tool, dict) else parsed_tool
                        )

                        # SVG is only emitted on explicit model mutations or an explicit
                        # display request. In both cases, refresh/update the single active
                        # visualization card in place.
                        should_display_svg = name in {"add_class", "add_attribute", "add_connector", "display_model_visualization"} and model_name
                        if should_display_svg:
                            try:
                                current_model = await get_model_mcp(username, model_name)
                                if current_model:
                                    svg_text = _generate_model_svg(current_model)
                                    if svg_text:
                                        history.add_display_event({"kind": "model_svg", "svg": svg_text, "model_name": model_name, "source": name})
                                        yield _event("model_svg", {"svg": svg_text, "model_name": model_name, "source": name})
                                        async for line in _drain_out_queue():
                                            yield line
                            except Exception as e:
                                print(f"[Assistant] Failed to refresh SVG after {name}: {e}")

                        if name == "style_guide_check":
                            report = ""
                            if isinstance(parsed_tool, dict):
                                tool_results = parsed_tool.get("tool_results")
                                if isinstance(tool_results, dict):
                                    report = tool_results.get("report", "")
                                elif isinstance(tool_results, str):
                                    report = tool_results
                            if report:
                                history.add_assistant_message(report)
                                history.add_display_event({"kind": "assistant_done", "content": report})
                                yield _event("assistant_text", {"content": report})
                                async for line in _drain_out_queue():
                                    yield line
                                yield _event("assistant_done", {"content": report})
                                return

                    # After processing all tool calls, signal loop completion so the UI
                    # can render this iteration before the next LLM call starts.
                    yield _event("loop_done", {"loop": loop_count})
                    async for line in _drain_out_queue():
                        yield line

                    # If this loop contained only successful mutations or analysis tools,
                    # inject a final assistant observation telling the model to stop and
                    # answer the user. This prevents the LLM from re-issuing the same tool.
                    if all_tools_were_mutations and mutation_success_count > 0:
                        final_observation = f"[OBSERVATION] Les {mutation_success_count} mutation(s) demandée(s) ont été appliquées au modèle. Tu dois maintenant répondre à l'utilisateur avec un résumé de ce qui a été fait, sans appeler d'autre outil de mutation."
                        history.add_assistant_message(
                            final_observation,
                            add_to_llm_request=True,
                            track_trace=False,
                            add_to_display=False,
                            add_to_events=False,
                        )
                    elif all_tools_were_analysis and analysis_success_count > 0:
                        names = sorted({tc['function']['name'] for tc in tool_calls})
                        final_observation = (
                            "[OBSERVATION] "
                            + ", ".join(names)
                            + " exécuté(s) avec succès."
                        )
                        history.add_assistant_message(
                            final_observation,
                            add_to_llm_request=True,
                            track_trace=False,
                            add_to_display=False,
                            add_to_events=False,
                        )

                    continue

                else:
                    history.add_assistant_message(content)
                    yield _event("assistant_done", {"content": ""})
                    break

    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[Assistant stream error] {type(e).__name__}: {e}")
        yield _event("error", {"message": f"{type(e).__name__}: {e}"})
        return
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

    history.finalize_current_request_summary()
    history.save()
    yield _event("done", {})


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


@router.post("/stream")
async def stream_assistant_response(
    request: AssistantStreamRequest,
    username: str = Depends(require_user),
):
    return StreamingResponse(
        assistant_stream_generator(request, username),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
        },
    )


@router.post("/import")
async def import_assistant_model(
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    username: str = Depends(require_user),
):
    """
    Import a model for the assistant chatbot, mirroring autre_version's upload_xml:
    parse the file locally, build the JSON model, add a 'Generated' package for
    XMI/XML, and upload the model to the MCP server so it becomes context for the LLM.
    """
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read uploaded file: {e}") from e

    filename = file.filename or "model.txt"
    display_name = (name or filename).strip() or "imported_model"
    from datetime import datetime
    session_name = f"{_model_name_from_filename(display_name)}__{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    try:
        from data_model_utils import _detect_file_type
        from data_model_utils.import_ttl import ttl_to_json
        from data_model_utils.import_xml import xml_to_json
        from data_model_utils.import_json import json_file_to_model
        from data_model_utils.import_sql import sql_to_model
        from data_model_utils.import_text import text_to_model
        from api.services.assistant_mcp_client import AssistantMCPClient

        kind = _detect_file_type(file_bytes, filename)
        if kind is None:
            raise ModelProcessingError("Unsupported file format.", "Please upload an XMI/XML, TTL, JSON, SQL or text file.")

        json_data: dict[str, Any] = {}
        if kind in {"xml", "xmi"}:
            try:
                json_data = xml_to_json(BytesIO(file_bytes))
            except Exception as e:
                raise ModelProcessingError("Failed to parse the XML/XMI file.", str(e))

            elements = json_data.get("elements", [])
            if not elements:
                raise ModelProcessingError("Parsed XML has no elements.", "Ensure the XMI version is supported.")

            root_model_id = elements[0].get("ID")
            if not root_model_id:
                raise ModelProcessingError("Parsed XML root element is missing an ID.")

            async with AssistantMCPClient(state={"user": username, "name": session_name, "package": ""}) as mcp_client:
                generated_id = mcp_client._generate_id()

            elements.append({
                "name": "Generated",
                "ID": generated_id,
                "type": "uml:Package",
                "package": root_model_id,
                "tags": [],
            })
            json_data["elements"] = elements
            json_data["xmi"] = {
                "elements": json_data.get("elements", []),
                "connectors": json_data.get("connectors", []),
            }
            json_data["source_format"] = "xmi"
            json_data["xmi_raw"] = file_bytes.decode("utf-8", errors="replace")
            json_data["xmi_xml"] = json_data["xmi_raw"]
        elif kind == "ttl":
            try:
                json_data = ttl_to_json(BytesIO(file_bytes))
            except Exception as e:
                raise ModelProcessingError("Failed to parse the TTL file.", str(e))

            json_data["source_format"] = "ttl"
            json_data["ttl_raw"] = file_bytes.decode("utf-8", errors="replace")
            if "elements" in json_data or "connectors" in json_data:
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }
        elif kind == "json":
            try:
                json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
            except Exception as e:
                raise ModelProcessingError("Failed to parse the JSON/JSON-LD file.", str(e))
            json_data["source_format"] = "json"
            json_data["json_raw"] = file_bytes.decode("utf-8", errors="replace")
            if isinstance(json_data.get("xmi"), dict):
                json_data.setdefault("elements", json_data["xmi"].get("elements", []))
                json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
            else:
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }
        elif kind == "sql":
            try:
                json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
            except Exception as e:
                raise ModelProcessingError("Failed to parse the SQL file.", str(e))
            json_data["source_format"] = "sql"
            json_data["sql_raw"] = file_bytes.decode("utf-8", errors="replace")
            if isinstance(json_data.get("xmi"), dict):
                json_data.setdefault("elements", json_data["xmi"].get("elements", []))
                json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
            else:
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }
        else:  # text
            try:
                json_data = text_to_model(BytesIO(file_bytes), filename=filename)
            except Exception as e:
                raise ModelProcessingError("Failed to parse the text file.", str(e))
            json_data["source_format"] = "text"
            json_data["text_raw"] = file_bytes.decode("utf-8", errors="replace")
            if isinstance(json_data.get("xmi"), dict):
                json_data.setdefault("elements", json_data["xmi"].get("elements", []))
                json_data.setdefault("connectors", json_data["xmi"].get("connectors", []))
            else:
                json_data["xmi"] = {
                    "elements": json_data.get("elements", []),
                    "connectors": json_data.get("connectors", []),
                }

        async with AssistantMCPClient(state={"user": username, "name": session_name, "package": ""}) as mcp_client:
            server_model = await mcp_client.upload_model({"model": json_data})
            if not server_model:
                raise ModelProcessingError("MCP Server Error", "Model upload returned None.")

    except ModelProcessingError as e:
        raise HTTPException(status_code=400, detail={"title": e.title, "details": e.details}) from e
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e

    return JSONResponse({
        "name": session_name,
        "display_name": display_name,
        "source_format": kind or "unknown",
    })


@router.get("/test-stream")
async def test_stream():
    """Endpoint de test pour vérifier le streaming temps réel sans LLM."""
    async def generator():
        import asyncio
        for i in range(5):
            yield _event("assistant_text", {"content": f"chunk {i} "})
            await asyncio.sleep(0.5)
        yield _event("done", {})

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/sessions")
async def list_assistant_sessions(username: str = Depends(require_user)):
    sessions = []
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        # Use the display file mtime as the last activity timestamp.
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)

        # Build a short preview from the first user message in display_messages.
        preview = ""
        for msg in h.display_messages:
            if msg.get("role") == "user" and msg.get("content"):
                preview = str(msg["content"]).strip().replace("\n", " ")[:80]
                break

        sessions.append({
            "name": session,
            "display_name": h.display_name or "",
            "last_opened_at": mtime,
            "preview": preview,
            "model_name": h.assistant_model_name,
        })
    sessions.sort(key=lambda s: s["last_opened_at"], reverse=True)
    return {"sessions": sessions}


@router.get("/sessions/by-model")
async def find_assistant_session_by_model(
    model_name: str,
    username: str = Depends(require_user),
):
    """Return the most recently touched assistant session linked to a model."""
    best_session = ""
    best_mtime = 0
    for session in AssistantHistory.list_sessions(username):
        h = AssistantHistory(user=username, session=session)
        if h.assistant_model_name != model_name:
            continue
        mtime = 0
        if h.display_fp.exists():
            mtime = int(h.display_fp.stat().st_mtime * 1000)
        if mtime >= best_mtime:
            best_mtime = mtime
            best_session = session
    if not best_session:
        raise HTTPException(status_code=404, detail="Aucune conversation trouvée pour ce modèle")
    return {"session": best_session, "model_name": model_name}


@router.delete("/sessions/{session}")
async def delete_assistant_session(
    session: str,
    username: str = Depends(require_user),
):
    history = AssistantHistory(user=username, session=session)
    # Also delete the model linked to this assistant session so we do not leave
    # orphan models behind when a conversation is removed.
    linked_model = history.assistant_model_name
    if history.display_fp.exists():
        history.display_fp.unlink()
    if history.llm_fp.exists():
        history.llm_fp.unlink()
    if linked_model:
        try:
            await delete_model_mcp(username, linked_model)
        except Exception as e:
            print(f"[Assistant delete session] failed to delete linked model {linked_model}: {e}", flush=True)
    return {"ok": True}


@router.post("/sessions/{session}/open")
async def touch_assistant_session(
    session: str,
    username: str = Depends(require_user),
):
    """Update the session file mtime so it bubbles to the top of the history list."""
    history = AssistantHistory(user=username, session=session)
    for fp in (history.display_fp, history.llm_fp):
        if fp.exists():
            # Use None so os.utime sets both atime and mtime to the current
            # system time. The listing endpoint reads st_mtime * 1000 (ms).
            os.utime(fp, None)
    return {"ok": True}


@router.patch("/sessions/{session}/rename")
async def rename_assistant_session(
    session: str,
    body: AssistantRenameBody,
    username: str = Depends(require_user),
):
    """Rename an assistant session by moving its display and llm files."""
    old_history = AssistantHistory(user=username, session=session)
    if not old_history._session_exists():
        raise HTTPException(status_code=404, detail="Session inconnue")

    new_display_name = body.name.strip()
    new_stored_name = _slugify_session_name(new_display_name)
    # Append a timestamp suffix to keep the internal name unique, just like new sessions.
    from datetime import datetime
    new_stored_name = f"{new_stored_name}__{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

    new_history = AssistantHistory(user=username, session=new_stored_name)
    new_history.display_messages = old_history.display_messages
    new_history.display_events = old_history.display_events
    new_history.system_messages = old_history.system_messages
    new_history.conversation_summary = old_history.conversation_summary
    new_history.current_request_trace = old_history.current_request_trace
    new_history.current_request_llm_messages = old_history.current_request_llm_messages
    new_history.current_request_user_input = old_history.current_request_user_input
    new_history.last_two_messages_fullish = old_history.last_two_messages_fullish
    new_history.last_execution_plan_full = old_history.last_execution_plan_full
    new_history.retained_retrieve_documents = old_history.retained_retrieve_documents
    new_history.last_tool_observations_compact = old_history.last_tool_observations_compact
    new_history.assistant_model_name = old_history.assistant_model_name
    new_history.display_name = new_display_name
    new_history.save()

    if old_history.display_fp.exists():
        old_history.display_fp.unlink()
    if old_history.llm_fp.exists():
        old_history.llm_fp.unlink()

    return {"name": new_stored_name, "display_name": new_display_name}


@router.get("/history")
async def get_assistant_history(
    session: str,
    username: str = Depends(require_user),
):
    history = AssistantHistory(user=username, session=session)
    messages = history.load_display_messages()
    display_events = history.display_events
    return {
        "session": session,
        "display_name": history.display_name or "",
        "messages": messages,
        "display_events": display_events,
        "model_name": history.assistant_model_name,
    }