"""Assistant chatbot streaming orchestrator.

Contains the main assistant_stream_generator logic, tool call execution loop,
model attachment / SVG emission and usage recording.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncGenerator
from uuid import uuid4

from openai.types.chat import ChatCompletionSystemMessageParam

from api.naming import display_name_from_stored as _display_model_name
from api.routers.search import _normalize_search_result
from api.services.assistant_history import AssistantHistory
from api.services.assistant_mcp_client import AssistantMCPClient
from api.services.assistant_streaming import (
    _create_completion_streaming,
    _emit_progress_queue,
    _event,
    _generate_model_svg,
)
from api.services.mcp_service import fetch_search, get_model_mcp, upload_model_mcp


async def assistant_stream_generator(
    request: Any,
    username: str,
) -> AsyncGenerator[str, None]:
    from api.routers.assistant import AssistantStreamRequest, _safe_json_loads, _slugify_session_name

    user_input = request.user_message.strip()
    if not user_input:
        yield _event("error", {"message": "Message vide."})
        return

    origin = (request.origin or "assistant").strip().lower()
    if origin not in {"assistant", "modeler", "external_api"}:
        origin = "assistant"

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
        origin=origin,
    )

    raw_names = [n.strip() for n in (request.model_names or []) if n.strip()]
    if request.model_name and request.model_name.strip():
        raw_names.insert(0, request.model_name.strip())
    model_names = list(dict.fromkeys(raw_names))[:3]
    selected_tags = request.tags or []
    # Remember the models attached to this session so we can reopen them later.
    # Also record the origin so the modeler can find only its own conversations.
    if model_names:
        history.assistant_model_names = model_names
        # Keep the legacy single-model field in sync for older clients.
        history.assistant_model_name = model_names[0]

    # Persist the user message (and selected source tags) as display events so
    # the timeline can be replayed exactly.
    history.add_display_event({"kind": "user", "content": user_input})
    if selected_tags:
        history.add_display_event({"kind": "selected_tags", "tags": selected_tags})

    state = {
        "user": username,
        "name": model_names[0] if model_names else session_name,
        "package": "",
        "selected_tags": selected_tags,
        "allowed_model_names": model_names,
    }

    # Build a mapping from stored model names to clean display names.
    model_display_names = {name: _display_model_name(name) for name in model_names}

    # Load the uploaded models from the MCP server to inject them into the LLM context.
    current_model_prompt = ""
    loaded_models: dict[str, dict[str, Any]] = {}
    if model_names:
        parts: list[str] = []
        for idx, name in enumerate(model_names, start=1):
            try:
                model_data = await get_model_mcp(username, name)
                if model_data:
                    loaded_models[name] = model_data
                    xmi = model_data.get("xmi") if isinstance(model_data.get("xmi"), dict) else model_data
                    # Use the display name (without timestamp suffix) in the LLM prompt.
                    display_name = model_display_names[name]
                    parts.append(
                        f"[MODEL {idx} - name={display_name}]\n"
                        + json.dumps(xmi, ensure_ascii=False, indent=2)
                    )
            except Exception as e:
                print(f"[Assistant] Failed to load model context for {name}: {e}")
        if parts:
            current_model_prompt = (
                "[ATTACHED MODELS - JSON STRUCTURES]\n"
                + "\n\n".join(parts)
                + "\n\n[CURRENT USER MESSAGE]\n\n"
            )

    history.start_new_request(user_input)
    history.add_user_message(user_input, track_trace=False)

    if is_new_session:
        history.display_messages.insert(
            0,
            ChatCompletionSystemMessageParam(role="session_name", content=session_name),
        )

    yield _event("user", {"content": user_input, "session": session_name, "is_new_session": is_new_session, "origin": origin})

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

                usage_totals = {"prompt_tokens": 0, "completion_tokens": 0, "source": "tiktoken"}

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
                        usage = payload.get("usage", {})
                        usage_totals["prompt_tokens"] += int(usage.get("prompt_tokens", 0))
                        usage_totals["completion_tokens"] += int(usage.get("completion_tokens", 0))
                        if usage.get("source") == "usage":
                            usage_totals["source"] = "usage"

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

                        display_payload = await _build_tool_display_payload(name, arguments, parsed_tool, selected_tags)

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
                        summary = _summarize_tool_result(name, parsed_tool)
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
                        # display request. Use the model name returned/used by the tool so the
                        # correct model card is refreshed.
                        target_model_name = _target_model_name_for_tool(name, arguments, state, model_names)

                        # If the assistant created/mutated a model that is not yet attached
                        # to this session (e.g. starting from scratch), attach it now so it
                        # appears in the model pill and is loaded into the LLM context next turn.
                        # Also tag it as imported_from_assistant so it does not show up as a
                        # standalone modeler history item.
                        newly_attached = False
                        if target_model_name and target_model_name not in history.assistant_model_names:
                            history.assistant_model_names.append(target_model_name)
                            if not history.assistant_model_name:
                                history.assistant_model_name = target_model_name
                            newly_attached = True
                            try:
                                current_model = await get_model_mcp(username, target_model_name)
                                if current_model:
                                    current_model["imported_from_assistant"] = True
                                    await upload_model_mcp(username, target_model_name, current_model)
                            except Exception as e:
                                print(f"[Assistant] Failed to tag newly attached model {target_model_name}: {e}", flush=True)

                        # Notify the UI live when a new model is attached so the pill
                        # appears immediately without reloading the conversation.
                        if newly_attached:
                            history.add_display_event({"kind": "model_attached", "model_name": target_model_name, "source": name})
                            yield _event("model_attached", {"model_name": target_model_name, "source": name})
                            async for line in _drain_out_queue():
                                yield line

                        should_display_svg = name in {"add_class", "add_attribute", "add_connector", "display_model_visualization"} and target_model_name
                        if should_display_svg:
                            try:
                                current_model = await get_model_mcp(username, target_model_name)
                                if current_model:
                                    svg_text = _generate_model_svg(current_model)
                                    if svg_text:
                                        history.add_display_event({"kind": "model_svg", "svg": svg_text, "model_name": target_model_name, "source": name})
                                        yield _event("model_svg", {"svg": svg_text, "model_name": target_model_name, "source": name})
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
                    yield _event("assistant_done", {"content": "", "usage": usage_totals})
                    break

            # Record accumulated token usage for the whole assistant turn once we exit the loop.
            if usage_totals["prompt_tokens"] + usage_totals["completion_tokens"] > 0:
                from api.services.usage_store import record_usage
                record_usage(
                    username=username,
                    prompt_tokens=usage_totals["prompt_tokens"],
                    completion_tokens=usage_totals["completion_tokens"],
                    endpoint="assistant",
                    model=_get_llm_model(),
                    source=usage_totals.get("source", "tiktoken"),
                )

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


def _get_llm_model() -> str:
    """Return the configured LLM model name."""
    from api.dependencies import _LLM_MODEL
    return _LLM_MODEL


async def _build_tool_display_payload(
    name: str,
    arguments: dict[str, Any],
    parsed_tool: Any,
    selected_tags: list[str],
) -> dict[str, Any] | None:
    """Build a UI display payload for supported tools."""
    if name != "retrieve_documents":
        return None

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
        results = [_normalize_search_result(row) for row in search_rows]
        results = [r for r in results if r is not None]
        return {
            "type": "search",
            "query": query_terms,
            "results": results,
            "result_count": len(results),
        }
    except Exception as exc:
        return {"type": "search", "query": query_terms, "results": [], "result_count": 0, "error": str(exc)}


def _target_model_name_for_tool(
    name: str,
    arguments: dict[str, Any],
    state: dict[str, Any],
    model_names: list[str],
) -> str:
    """Determine which model name a tool call targets."""
    if name == "display_model_visualization":
        return arguments.get("model_name", "").strip()
    if name in {"add_class", "add_attribute", "add_connector"}:
        return arguments.get("model_name", state.get("name", "")).strip()
    if model_names:
        return model_names[0]
    return ""


def _summarize_tool_result(name: str, parsed_tool: Any) -> str:
    """Return a short French observation summary for a tool result."""
    tool_results = parsed_tool.get("tool_results") if isinstance(parsed_tool, dict) else None
    if name == "retrieve_documents":
        filenames = []
        if isinstance(tool_results, list):
            for item in tool_results:
                if isinstance(item, (list, tuple)) and len(item) >= 1:
                    filenames.append(str(item[0]))
                elif isinstance(item, dict):
                    filenames.append(str(item.get("filename") or item.get("file") or item.get("name") or ""))
        return f"J'ai récupéré {len(filenames)} document(s) : {', '.join(filenames)}." if filenames else "Aucun document pertinent trouvé."
    if name == "add_class":
        title = tool_results.get("name") if isinstance(tool_results, dict) else None
        return f"Classe '{title}' ajoutée au modèle." if title else "Classe ajoutée au modèle."
    if name == "add_attribute":
        attr_name = tool_results.get("name") if isinstance(tool_results, dict) else None
        class_name = tool_results.get("class_name") if isinstance(tool_results, dict) else None
        return f"Attribut '{attr_name}' ajouté à la classe '{class_name}'." if attr_name and class_name else "Attribut ajouté au modèle."
    if name == "add_connector":
        rel_name = tool_results.get("rel_label") if isinstance(tool_results, dict) else None
        return f"Relation '{rel_name}' ajoutée au modèle." if rel_name else "Relation ajoutée au modèle."
    if name == "style_guide_check":
        return "Vérification du guide de style effectuée."
    if name == "metadata_checker":
        return "Vérification des métadonnées effectuée."
    if name == "reuse_check":
        return "Vérification de réutilisation effectuée."
    if name == "validator_check":
        return "Validation effectuée."
    if name == "display_model_visualization":
        return "Affichage de la visualisation du modèle demandé."
    return f"Résultat de {name} reçu."
