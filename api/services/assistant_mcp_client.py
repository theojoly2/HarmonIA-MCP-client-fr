"""MCP client for the Assistant chatbot.

Wraps the SemantiQ MCP server, exposes only the tools the assistant LLM is
allowed to call, and bridges server-side sampling (ctx.sample) back to the
configured OpenAI-compatible LLM.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import AsyncExitStack
from typing import Any, Mapping

from fastmcp import Client
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionToolParam
from openai.types.shared_params.function_definition import FunctionDefinition

from api.dependencies import llm_client, _LLM_MODEL

logger = logging.getLogger(__name__)
MCP_SERVER_URL = os.getenv("MCP_SERVER_URL", "http://127.0.0.1:8001/mcp")


EXPOSED_TOOLS: set[str] = {
    "retrieve_documents",
    "add_class",
    "add_attribute",
    "add_connector",
    "plan_workflow_with_tools",
    "metadata_checker",
    "reuse_check",
    "validator_check",
    "style_guide_check",
}


def _normalize_str_arg(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip() or default


def _normalize_int_arg(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except Exception:
        return default


def _normalize_bool_arg(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"true", "1", "yes", "on"}
    return bool(value)


def _normalize_list_arg(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return []


def _safe_json_loads(text: str | None) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


async def _sampling_handler(messages: list[Any], params: Any, context: Any) -> str:
    """Bridge MCP sampling requests to our OpenAI-compatible LLM client."""
    try:
        openai_messages: list[dict[str, str]] = []
        system_prompt = getattr(params, "systemPrompt", None)
        if system_prompt:
            openai_messages.append({"role": "system", "content": system_prompt})

        for m in messages:
            role = getattr(m, "role", None) or (m.get("role") if isinstance(m, dict) else "user")
            content_obj = getattr(m, "content", None) or (m.get("content") if isinstance(m, dict) else "")
            text = getattr(content_obj, "text", None)
            if text is None:
                text = str(content_obj)
            openai_messages.append({"role": role, "content": text})

        resp = await llm_client.chat.completions.create(
            model=_LLM_MODEL,
            messages=openai_messages,
            temperature=getattr(params, "temperature", 0.0) or 0.0,
            max_tokens=getattr(params, "maxTokens", 512) or 512,
            stop=getattr(params, "stopSequences", None) or None,
            stream=False,
        )
        if not resp.choices:
            return ""
        return (resp.choices[0].message.content or "").strip()
    except Exception as e:
        logger.exception("sampling_handler failed: %s", e)
        return f"[Sampling error: {e}]"


class AssistantMCPClient:
    """Async MCP client scoped to the assistant's exposed tools."""

    def __init__(
        self,
        state: Mapping[str, Any],
        server_url: str = MCP_SERVER_URL,
    ) -> None:
        self.state = state
        self.server_url = server_url
        self.exit_stack = AsyncExitStack()
        self.client: Client | None = None
        self.tool_results: dict[str, Any] = {}

    async def __aenter__(self) -> "AssistantMCPClient":
        self.client = Client(self.server_url, sampling_handler=_sampling_handler)
        await self.exit_stack.enter_async_context(self.client)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.exit_stack.aclose()

    async def tools(self) -> list[ChatCompletionToolParam]:
        assert self.client is not None, "MCP client not initialized"
        tools = await self.client.list_tools()
        exposed: list[ChatCompletionToolParam] = []
        for t in tools:
            if t.name in EXPOSED_TOOLS:
                exposed.append(
                    ChatCompletionToolParam(
                        type="function",
                        function=FunctionDefinition(
                            name=t.name,
                            description=t.description or "",
                            parameters=t.inputSchema,
                        ),
                    )
                )
        return exposed

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        logger.info("[Assistant MCP] call_tool: %s args=%s", name, arguments)
        payload: dict[str, Any] = {"tool_name": name, "tool_arguments": arguments, "tool_results": ""}

        if name not in EXPOSED_TOOLS:
            payload["tool_results"] = f"Tool '{name}' is not exposed."
            return json.dumps(payload, ensure_ascii=False)

        wrapper = getattr(self, f"_{name}", None)
        if wrapper is None:
            payload["tool_results"] = f"No wrapper implemented for '{name}'."
            return json.dumps(payload, ensure_ascii=False)

        try:
            payload = await wrapper(payload)
        except Exception as e:
            logger.exception("call_tool failed for %s: %s", name, e)
            payload["tool_results"] = f"Error calling tool '{name}': {e}"

        return json.dumps(payload, ensure_ascii=False)

    async def _call_tool_raw(self, tool_name: str, call_args: dict[str, Any]) -> Any:
        assert self.client is not None, "MCP client not initialized"
        try:
            return await asyncio.wait_for(
                self.client.call_tool(tool_name, call_args),
                timeout=240.0,
            )
        except asyncio.TimeoutError:
            return None

    def _extract_result(self, result: Any) -> Any:
        if result is None:
            return None
        content = getattr(result, "content", None)
        if isinstance(content, list) and content:
            text = getattr(content[0], "text", "")
            return _safe_json_loads(text) or text
        if isinstance(result, dict):
            return result
        return result

    async def _retrieve_documents(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        search_terms = arguments.get("search_terms")
        if not search_terms:
            payload["tool_results"] = {"error": "Missing 'search_terms'"}
            return payload
        call_args = {
            "search_terms": _normalize_str_arg(search_terms),
            "limit": _normalize_int_arg(arguments.get("limit"), default=10),
            "return_full_document": _normalize_bool_arg(arguments.get("return_full_document"), default=True),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("retrieve_documents", call_args)
        payload["tool_results"] = self._extract_result(result) or []
        return payload

    async def _add_class(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        required = {"title", "definition", "usage_note"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "package": _normalize_str_arg(self.state.get("package", ""), default=""),
            "uri": _normalize_str_arg(arguments.get("uri"), default=""),
            "title": _normalize_str_arg(arguments["title"]),
            "definition": _normalize_str_arg(arguments["definition"]),
            "usage_note": _normalize_str_arg(arguments["usage_note"]),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("add_class", call_args)
        payload["tool_results"] = self._extract_result(result) or {"ok": True}
        return payload

    async def _add_attribute(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        required = {"class_name", "attr_label", "attr_definition", "attr_uri"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "class_name": _normalize_str_arg(arguments["class_name"]),
            "attr_label": _normalize_str_arg(arguments["attr_label"]),
            "attr_definition": _normalize_str_arg(arguments["attr_definition"]),
            "attr_uri": _normalize_str_arg(arguments["attr_uri"]),
            "attr_usage_note": _normalize_str_arg(arguments.get("attr_usage_note", "")),
            "attr_type": _normalize_str_arg(arguments.get("attr_type"), default=""),
            "lower_bounds": _normalize_str_arg(arguments.get("lower_bounds", "")),
            "upper_bounds": _normalize_str_arg(arguments.get("upper_bounds", "")),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("add_attribute", call_args)
        payload["tool_results"] = self._extract_result(result) or {"ok": True}
        return payload

    async def _add_connector(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        required = {"source_name", "target_name", "rel_label", "rel_definition", "rel_uri"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "source_name": _normalize_str_arg(arguments["source_name"]),
            "target_name": _normalize_str_arg(arguments["target_name"]),
            "rel_label": _normalize_str_arg(arguments["rel_label"]),
            "rel_definition": _normalize_str_arg(arguments["rel_definition"]),
            "rel_uri": _normalize_str_arg(arguments["rel_uri"]),
            "relationship": _normalize_str_arg(arguments.get("relationship", "Association")),
            "lb": _normalize_str_arg(arguments.get("lb", "")),
            "rb": _normalize_str_arg(arguments.get("rb", "")),
            "lt": _normalize_str_arg(arguments.get("lt", "")),
            "rt": _normalize_str_arg(arguments.get("rt", "")),
            "rel_usage_note": _normalize_str_arg(arguments.get("rel_usage_note", "")),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("add_connector", call_args)
        payload["tool_results"] = self._extract_result(result) or {"ok": True}
        return payload

    async def _plan_workflow_with_tools(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        user_question = arguments.get("user_question")
        if not user_question:
            payload["tool_results"] = {"error": "Missing 'user_question'"}
            return payload

        raw_observations = arguments.get("observations") or []
        observations: list[Any] = []
        for item in raw_observations if isinstance(raw_observations, list) else [raw_observations]:
            if isinstance(item, dict):
                observations.append(item)
            elif isinstance(item, str):
                parsed = _safe_json_loads(item)
                if isinstance(parsed, dict):
                    observations.append(parsed)
                elif isinstance(parsed, list):
                    observations.extend(parsed)
                else:
                    observations.append({"text": item})
            else:
                observations.append({"value": item})

        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "user_question": _normalize_str_arg(user_question),
            "allowed_executor_tools": sorted(EXPOSED_TOOLS),
            "observations": observations,
            "max_steps": _normalize_int_arg(arguments.get("max_steps"), default=5),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("plan_workflow_with_tools", call_args)
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _metadata_checker(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "target_names": _normalize_list_arg(arguments.get("target_names")),
            "check_instruction": _normalize_str_arg(arguments.get("check_instruction", "")),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("metadata_checker", call_args)
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _reuse_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "vocabularies": _normalize_list_arg(arguments.get("vocabularies")),
            "n_documents": _normalize_int_arg(arguments.get("n_documents"), default=5),
            "target_names": _normalize_list_arg(arguments.get("target_names")),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("reuse_check", call_args)
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _validator_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": _normalize_str_arg(self.state.get("name"), default=""),
            "validation_server": _normalize_str_arg(arguments.get("validation_server", "")),
            "output_format": _normalize_str_arg(arguments.get("output_format", "text/turtle")),
            "validation_version": _normalize_str_arg(arguments.get("validation_version", "owl")),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("validator_check", call_args)
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _style_guide_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        self.tool_results.setdefault("validator_check", arguments.get("validator_check", {}))
        self.tool_results.setdefault("metadata_checker", arguments.get("metadata_checker", {}))
        self.tool_results.setdefault("reuse_check", arguments.get("reuse_check", {}))
        call_args = {
            "validator_check": self.tool_results.get("validator_check") or {},
            "metadata_checks": self.tool_results.get("metadata_checker") or {},
            "reuse_checks": self.tool_results.get("reuse_check") or {},
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("style_guide_check", call_args)
        payload["tool_results"] = self._extract_result(result) or {}
        return payload
