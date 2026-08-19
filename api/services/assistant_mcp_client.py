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
from typing import Any, Awaitable, Callable, Mapping, Optional
from uuid import uuid4

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
    "display_model_visualization",
}

# Internal MCP tool names that should be exposed to the LLM under a legacy alias.
_TOOL_ALIASES: dict[str, str] = {
    "retrieve_search_documents": "retrieve_documents",
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

    async def _call_tool_raw(
        self,
        tool_name: str,
        call_args: dict[str, Any],
        progress_handler: Optional[Callable[[float, Optional[float], Optional[str]], Awaitable[None]]] = None,
    ) -> Any:
        assert self.client is not None, "MCP client not initialized"
        try:
            if progress_handler is not None:
                progress_client = Client(
                    self.server_url,
                    sampling_handler=_sampling_handler,
                    progress_handler=progress_handler,
                )
                async with progress_client:
                    return await asyncio.wait_for(
                        progress_client.call_tool(tool_name, call_args),
                        timeout=240.0,
                    )
            return await asyncio.wait_for(
                self.client.call_tool(tool_name, call_args),
                timeout=240.0,
            )
        except asyncio.TimeoutError:
            return None

    async def tools(self) -> list[ChatCompletionToolParam]:
        assert self.client is not None, "MCP client not initialized"
        tools = await self.client.list_tools()
        allowed_model_names = self.state.get("allowed_model_names") or []
        exposed: list[ChatCompletionToolParam] = []
        for t in tools:
            exposed_name = _TOOL_ALIASES.get(t.name, t.name)
            if exposed_name not in EXPOSED_TOOLS:
                continue
            schema: dict[str, Any] = dict(t.inputSchema) if t.inputSchema else {}
            if exposed_name in {"add_class", "add_attribute", "add_connector"}:
                schema = self._ensure_model_name_schema(schema, allowed_model_names)
            exposed.append(
                ChatCompletionToolParam(
                    type="function",
                    function=FunctionDefinition(
                        name=exposed_name,
                        description=t.description or "",
                        parameters=schema,
                    ),
                )
            )
        return exposed

    @staticmethod
    def _ensure_model_name_schema(schema: dict[str, Any], allowed_model_names: list[str]) -> dict[str, Any]:
        """Inject a required model_name parameter into mutation tool schemas."""
        schema = dict(schema)
        properties: dict[str, Any] = dict(schema.get("properties") or {})
        if "model_name" not in properties:
            description = "Nom du modèle cible"
            if allowed_model_names:
                description += f". Valeurs autorisées : {', '.join(allowed_model_names)}"
            properties["model_name"] = {
                "type": "string",
                "description": description,
            }
            if allowed_model_names:
                properties["model_name"]["enum"] = allowed_model_names
        schema["properties"] = properties
        required: list[str] = list(schema.get("required") or [])
        if "model_name" not in required:
            required.append("model_name")
        schema["required"] = required
        return schema

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        progress_handler: Optional[Callable[[float, Optional[float], Optional[str]], Awaitable[None]]] = None,
    ) -> str:
        logger.info("[Assistant MCP] call_tool: %s args=%s", name, arguments)
        payload: dict[str, Any] = {
            "tool_name": name,
            "tool_arguments": arguments,
            "tool_results": "",
            "progress_handler": progress_handler,
        }

        if name not in EXPOSED_TOOLS:
            payload["tool_results"] = {
                "error": True,
                "invalid_tool_called": name,
                "available_tools": sorted(EXPOSED_TOOLS),
                "message": f"ATTENTION - VOUS AVEZ FAIT UNE ERREUR : l'outil '{name}' n'existe pas dans le catalogue des outils disponibles. Vous NE DEVEZ PAS rappeler '{name}'. Corrigez votre erreur en choisissant un outil VALIDE parmi ceux disponibles, puis poursuivez l'exécution du plan.",
            }
            payload.pop("progress_handler", None)
            return json.dumps(payload, ensure_ascii=False)

        # Map the LLM-facing alias back to the internal MCP tool name.
        internal_name = name
        for internal, exposed in _TOOL_ALIASES.items():
            if exposed == name:
                internal_name = internal
                break

        wrapper = getattr(self, f"_{name}", None)
        if wrapper is None:
            payload["tool_results"] = {
                "error": True,
                "invalid_tool_called": name,
                "available_tools": sorted(EXPOSED_TOOLS),
                "message": f"ATTENTION - VOUS AVEZ FAIT UNE ERREUR : l'outil '{name}' n'a pas d'implémentation côté serveur. Vous NE DEVEZ PAS rappeler '{name}'. Corrigez votre erreur en choisissant un outil VALIDE parmi ceux disponibles, puis poursuivez l'exécution du plan.",
            }
            payload.pop("progress_handler", None)
            return json.dumps(payload, ensure_ascii=False)

        try:
            payload["tool_name"] = internal_name
            payload = await wrapper(payload)
            payload["tool_name"] = name
        except Exception as e:
            logger.exception("call_tool failed for %s: %s", name, e)
            payload["tool_results"] = {"error": True, "message": f"Error calling tool '{name}': {e}"}

        payload.pop("progress_handler", None)
        return json.dumps(payload, ensure_ascii=False)

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
        selected_tags = _normalize_list_arg(self.state.get("selected_tags"))
        call_args = {
            "search_terms": _normalize_str_arg(search_terms),
            "limit": _normalize_int_arg(arguments.get("limit"), default=10),
            "return_full_document": _normalize_bool_arg(arguments.get("return_full_document"), default=True),
        }
        if selected_tags:
            call_args["tags"] = selected_tags
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw("retrieve_documents", call_args)
        payload["tool_results"] = self._extract_result(result) or []
        return payload

    async def _add_class(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}
        allowed = self.state.get("allowed_model_names") or []
        target_name = _normalize_str_arg(arguments.get("model_name"), default="")
        if not target_name:
            target_name = _normalize_str_arg(self.state.get("name"), default="")
        if allowed and target_name not in allowed:
            payload["tool_results"] = {"error": f"model_name '{target_name}' not in allowed models: {allowed}"}
            return payload
        required = {"title", "definition", "usage_note"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": target_name,
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
        allowed = self.state.get("allowed_model_names") or []
        target_name = _normalize_str_arg(arguments.get("model_name"), default="")
        if not target_name:
            target_name = _normalize_str_arg(self.state.get("name"), default="")
        if allowed and target_name not in allowed:
            payload["tool_results"] = {"error": f"model_name '{target_name}' not in allowed models: {allowed}"}
            return payload
        required = {"class_name", "attr_label", "attr_definition", "attr_uri"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": target_name,
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
        allowed = self.state.get("allowed_model_names") or []
        target_name = _normalize_str_arg(arguments.get("model_name"), default="")
        if not target_name:
            target_name = _normalize_str_arg(self.state.get("name"), default="")
        if allowed and target_name not in allowed:
            payload["tool_results"] = {"error": f"model_name '{target_name}' not in allowed models: {allowed}"}
            return payload
        required = {"source_name", "target_name", "rel_label", "rel_definition", "rel_uri"}
        missing = [arg for arg in required if not arguments.get(arg)]
        if missing:
            payload["tool_results"] = {"error": f"Missing arguments: {missing}"}
            return payload
        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "name": target_name,
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

        context_models = self.state.get("allowed_model_names") or []
        if context_models:
            observations.insert(0, {
                "type": "attached_models",
                "model_names": context_models,
                "count": len(context_models),
                "note": "These models are already loaded in the assistant context. Do not plan retrieval to find them; when mutating, specify the target model_name if several are attached.",
            })

        call_args = {
            "user": _normalize_str_arg(self.state.get("user"), default=""),
            "context_models": context_models,
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
        result = await self._call_tool_raw(
            "metadata_checker", call_args, progress_handler=payload.get("progress_handler")
        )
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
        result = await self._call_tool_raw(
            "reuse_check", call_args, progress_handler=payload.get("progress_handler")
        )
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
        result = await self._call_tool_raw(
            "validator_check", call_args, progress_handler=payload.get("progress_handler")
        )
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _style_guide_check(self, payload: dict[str, Any]) -> dict[str, Any]:
        arguments = payload.get("tool_arguments") or {}

        def _as_result_dict(value: Any) -> dict[str, Any]:
            if isinstance(value, dict):
                return value
            if isinstance(value, str):
                return {"report": value, "status": "error"}
            return {}

        self.tool_results.setdefault("validator_check", _as_result_dict(arguments.get("validator_check")))
        self.tool_results.setdefault("metadata_checker", _as_result_dict(arguments.get("metadata_checker")))
        self.tool_results.setdefault("reuse_check", _as_result_dict(arguments.get("reuse_check")))

        # Ensure previously stored results (from prior tool calls in the same request) are dicts.
        self.tool_results["validator_check"] = _as_result_dict(self.tool_results.get("validator_check"))
        self.tool_results["metadata_checker"] = _as_result_dict(self.tool_results.get("metadata_checker"))
        self.tool_results["reuse_check"] = _as_result_dict(self.tool_results.get("reuse_check"))

        call_args = {
            "validator_check": self.tool_results.get("validator_check") or {},
            "metadata_checks": self.tool_results.get("metadata_checker") or {},
            "reuse_checks": self.tool_results.get("reuse_check") or {},
            "language": _normalize_str_arg(arguments.get("language"), default="fr"),
        }
        payload["tool_arguments"] = call_args
        result = await self._call_tool_raw(
            "style_guide_check", call_args, progress_handler=payload.get("progress_handler")
        )
        payload["tool_results"] = self._extract_result(result) or {}
        return payload

    async def _display_model_visualization(self, payload: dict[str, Any]) -> dict[str, Any]:
        """UI-only tool: tells the assistant to show the current model SVG in the chat.

        This tool does not call the MCP server; the backend detects it and emits a
        `model_svg` SSE event that the front-end renders as the live model card.
        """
        arguments = payload.get("tool_arguments") or {}
        allowed = self.state.get("allowed_model_names") or []
        target_name = _normalize_str_arg(arguments.get("model_name", ""), default="")
        if not target_name and allowed:
            target_name = allowed[0]
        elif not target_name:
            target_name = _normalize_str_arg(self.state.get("name"), default="")
        payload["tool_arguments"] = {
            "model_name": target_name,
            "reason": _normalize_str_arg(arguments.get("reason", ""), default=""),
        }
        payload["tool_results"] = {"ok": True, "display": True, "model_name": target_name}
        return payload

    # ------------------------------------------------------------------
    # Direct UI helpers (not exposed to the LLM)
    # ------------------------------------------------------------------

    async def upload_model(self, arguments: dict[str, Any]) -> dict[str, Any]:
        """Upload a model JSON to the MCP server under the current user/session."""
        assert self.client is not None, "MCP client not initialized"
        model_payload = arguments.get("model")
        if not model_payload:
            return {}
        try:
            result = await self._call_tool_raw(
                "upload_model",
                {
                    "user": self.state.get("user"),
                    "name": self.state.get("name"),
                    "model": model_payload,
                },
            )
            if result is None:
                return {}
            return self._extract_result(result) or {}
        except Exception as e:
            logger.exception("upload_model failed: %s", e)
            return {}

    async def read_model(self) -> dict[str, Any]:
        """Read the current user/session model from the MCP resource."""
        assert self.client is not None, "MCP client not initialized"
        user = self.state.get("user")
        name = self.state.get("name")
        if not user or not name:
            return {}
        try:
            contents = await asyncio.wait_for(
                self.client.read_resource(f"resource://model/{user}/{name}"),
                timeout=15.0,
            )
            if not contents:
                return {}
            text = getattr(contents[0], "text", None)
            return _safe_json_loads(text) or {}
        except Exception as e:
            logger.exception("read_model failed: %s", e)
            return {}

    @staticmethod
    def _generate_id() -> str:
        return f"EAID_{str(uuid4()).upper().replace('-', '_')}"
