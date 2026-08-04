"""Assistant chat history persistence.

Mirrors autre_version's two-file JSON layout:
- data/assistant_histories/{user}/{session}/display_messages.json
- data/assistant_histories/{user}/{session}/llm_messages.json
"""

from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any, Optional

from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionToolMessageParam,
    ChatCompletionUserMessageParam,
)

BASE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "assistant_histories"
BASE_DIR.mkdir(parents=True, exist_ok=True)

SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "prompts" / "system_prompt_v3.txt"
WELCOME_PROMPT_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "prompts" / "welcome_prompt.txt"


def _load_text(path: Path) -> str:
    if not path.exists():
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class AssistantHistory:
    """Persistent chat history for the Assistant chatbot."""

    def __init__(
        self,
        user: str,
        session: str,
        system_prompt: Optional[str] = None,
        welcome_prompt: Optional[str] = None,
    ) -> None:
        self.user = user
        self.session = session

        self.display_messages: list[ChatCompletionMessageParam] = []
        self.display_events: list[dict[str, Any]] = []
        self.system_messages: list[ChatCompletionMessageParam] = []
        self.conversation_summary: list[str] = []
        self.current_request_trace: list[dict[str, Any]] = []
        self.current_request_llm_messages: list[ChatCompletionMessageParam] = []
        self.current_request_user_input: str = ""
        self.last_two_messages_fullish: list[dict[str, str]] = []
        self.last_execution_plan_full: str = ""
        self.retained_retrieve_documents: list[dict[str, Any]] = []
        self.last_tool_observations_compact: list[dict[str, Any]] = []
        self.assistant_model_name: str = ""

        self.display_dir = BASE_DIR / user
        self.llm_dir = BASE_DIR / user / "llm"
        self.display_fp = self.display_dir / f"{session}.json"
        self.llm_fp = self.llm_dir / f"{session}.json"

        if self._session_exists():
            self.load()
        else:
            self._init_prompts(system_prompt, welcome_prompt)

    @classmethod
    def list_sessions(cls, user: str) -> list[str]:
        sessions: set[str] = set()
        display_dir = BASE_DIR / user
        llm_dir = BASE_DIR / user / "llm"
        for dp in (display_dir, llm_dir):
            if dp.exists():
                for fp in dp.glob("*.json"):
                    sessions.add(fp.stem)
        return sorted(sessions)

    def _session_exists(self) -> bool:
        return self.display_fp.exists() or self.llm_fp.exists()

    def _init_prompts(self, system_prompt: Optional[str], welcome_prompt: Optional[str]) -> None:
        system_prompt = system_prompt or _load_text(SYSTEM_PROMPT_PATH)
        welcome_prompt = welcome_prompt or _load_text(WELCOME_PROMPT_PATH)

        if system_prompt:
            self.add_system_message(system_prompt)
        # The welcome prompt is no longer persisted as a display message. It is
        # injected on-the-fly by the frontend when starting a brand-new session,
        # so that reopening a saved conversation does not show the welcome text.

    def add_system_message(self, content: str) -> None:
        self.system_messages.append(
            ChatCompletionSystemMessageParam(role="system", content=content)
        )

    def start_new_request(self, user_input: str) -> None:
        if self.current_request_user_input or self.current_request_trace:
            self.finalize_current_request_summary()
        self.current_request_user_input = user_input
        self.current_request_trace = []
        self.current_request_llm_messages = []

    def add_display_event(self, event: dict[str, Any]) -> None:
        """Persist a UI event (tool_start, progress_*, tool_result, model_svg) for replay on reload."""
        self.display_events.append(deepcopy(event))

    def add_user_message(self, content: str, track_trace: bool = False) -> None:
        self.display_messages.append(
            ChatCompletionUserMessageParam(role="user", content=content)
        )
        self.add_display_event({"kind": "user", "content": content})
        self._append_recent_message("user", content)
        if track_trace:
            self.current_request_trace.append({"type": "user_message", "content": content})

    def add_assistant_message(
        self,
        content: str,
        tool_calls: Optional[list[dict[str, Any]]] = None,
        add_to_llm_request: bool = True,
        track_trace: bool = True,
        add_to_display: bool = True,
    ) -> None:
        message = ChatCompletionAssistantMessageParam(role="assistant", content=content)
        if tool_calls:
            message["tool_calls"] = deepcopy(tool_calls)
        if add_to_display:
            self.display_messages.append(message)
        if add_to_llm_request:
            self.current_request_llm_messages.append(deepcopy(message))
        self._append_recent_message("assistant", content or "")

        parsed = self._safe_json_loads(content)
        if isinstance(parsed, dict) and "final_plan" in parsed:
            self.last_execution_plan_full = content or ""

        if not track_trace:
            return
        if tool_calls:
            self.current_request_trace.append(
                {
                    "type": "assistant_tool_calls",
                    "content": content,
                    "tool_calls": [
                        {
                            "id": call.get("id"),
                            "name": call.get("function", {}).get("name", "tool_call"),
                            "arguments": call.get("function", {}).get("arguments", "{}"),
                        }
                        for call in tool_calls
                    ],
                }
            )
        else:
            self.current_request_trace.append({"type": "assistant_message", "content": content})

    def add_tool_message(
        self,
        content: str,
        tool_call_id: str,
        llm_content: Optional[str] = None,
        tool_name: str = "",
        arguments: Optional[dict[str, Any]] = None,
        add_to_llm_request: bool = True,
        track_trace: bool = True,
    ) -> None:
        self.display_messages.append(
            ChatCompletionToolMessageParam(
                role="tool",
                content=content,
                tool_call_id=tool_call_id,
            )
        )
        if add_to_llm_request:
            self.current_request_llm_messages.append(
                ChatCompletionToolMessageParam(
                    role="tool",
                    content=llm_content if llm_content is not None else content,
                    tool_call_id=tool_call_id,
                )
            )
            self._append_recent_message("tool", llm_content if llm_content is not None else content)
        if track_trace:
            compact = self._compact_tool_observation(content, tool_name, arguments)
            self.last_tool_observations_compact.append(compact)
            self.last_tool_observations_compact = self.last_tool_observations_compact[-20:]
            self.current_request_trace.append(
                {
                    "type": "tool_result",
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name or "tool_call",
                    "result_summary": self._summarize_tool_content(content, tool_name),
                }
            )

    def build_messages_for_llm(
        self,
        current_user_input: str,
        current_model_prompt: str = "",
        max_summary_items: int = 10,
    ) -> list[ChatCompletionMessageParam]:
        llm_messages: list[ChatCompletionMessageParam] = [deepcopy(msg) for msg in self.system_messages]

        summary_blocks: list[str] = []
        if self.conversation_summary:
            summary_text = "\n\n".join(self.conversation_summary[-max_summary_items:])
            # Cap summary size so it does not drown the current plan/model context.
            if len(summary_text) > 3000:
                summary_text = self._truncate(summary_text, 3000)
            summary_blocks.append(
                "[STEP BY STEP SUMMARY OF OLDER REQUESTS]\n"
                "Use this as compact traceability for older turns.\n\n"
                f"{summary_text}"
            )
        if self.retained_retrieve_documents:
            summary_blocks.append(
                "[RETRIEVE_DOCUMENTS MEMORY ACROSS HISTORY]\n"
                + self._json_text(self.retained_retrieve_documents[-30:], 12000)
            )
        if summary_blocks:
            llm_messages.append(
                ChatCompletionSystemMessageParam(role="system", content="\n\n".join(summary_blocks))
            )

        recent_blocks: list[str] = []
        if self.last_two_messages_fullish:
            rendered: list[str] = []
            for i, msg in enumerate(self.last_two_messages_fullish[-2:], start=1):
                rendered.append(
                    f"[RECENT MESSAGE {i} - ROLE={msg.get('role', '')}]\n{self._truncate(msg.get('content', ''), 2000)}"
                )
            recent_blocks.append("\n\n".join(rendered))
        if self.last_execution_plan_full:
            plan_text = self.last_execution_plan_full
            if len(plan_text) > 6000:
                plan_text = self._truncate(plan_text, 6000)
            recent_blocks.append("[LAST EXECUTION PLAN - FULL]\n" + plan_text)
        if self.last_tool_observations_compact:
            recent_blocks.append(
                "[RECENT TOOL OBSERVATIONS - COMPACT]\n"
                + self._json_text(self.last_tool_observations_compact[-5:], 4000)
            )
        if recent_blocks:
            llm_messages.append(
                ChatCompletionSystemMessageParam(role="system", content="\n\n".join(recent_blocks))
            )

        user_content = (
            f"{current_model_prompt}{current_user_input}"
            if current_model_prompt
            else current_user_input
        )
        llm_messages.append(ChatCompletionUserMessageParam(role="user", content=user_content))
        llm_messages.extend(deepcopy(self.current_request_llm_messages))
        return llm_messages

    def finalize_current_request_summary(self) -> None:
        if not self.current_request_user_input and not self.current_request_trace:
            return
        lines: list[str] = []
        if self.current_request_user_input:
            lines.append(f"0. User request: {self._truncate(self.current_request_user_input, 600)}")
        step_index = 1
        for step in self.current_request_trace:
            stype = step.get("type")
            if stype == "assistant_message":
                lines.append(
                    f"{step_index}. Assistant message: {self._truncate(step.get('content', ''), 800)}"
                )
                step_index += 1
            elif stype == "assistant_tool_calls":
                content = self._truncate(step.get("content", ""), 500)
                if content:
                    lines.append(f"{step_index}. Assistant intent before tool call(s): {content}")
                    step_index += 1
                for call in step.get("tool_calls", []):
                    lines.append(
                        f"{step_index}. Tool call prepared: name={call.get('name', 'tool_call')} | "
                        f"arguments={call.get('arguments', '{}')}"
                    )
                    step_index += 1
            elif stype == "tool_result":
                lines.append(
                    f"{step_index}. Tool result: name={step.get('tool_name', 'tool_call')} | "
                    f"summary={step.get('result_summary', '')}"
                )
                step_index += 1
            elif stype == "user_message":
                lines.append(
                    f"{step_index}. User message: {self._truncate(step.get('content', ''), 600)}"
                )
                step_index += 1
        if lines:
            self.conversation_summary.append("\n".join(lines))
            self.conversation_summary = self.conversation_summary[-20:]
        self.current_request_user_input = ""
        self.current_request_trace = []
        self.current_request_llm_messages = []

    def save(self) -> None:
        if not self.user or not self.session:
            return
        self.display_dir.mkdir(parents=True, exist_ok=True)
        self.llm_dir.mkdir(parents=True, exist_ok=True)

        with open(self.display_fp, "w", encoding="utf-8") as f:
            json.dump({"display_messages": self.display_messages, "display_events": self.display_events}, f, ensure_ascii=False, indent=2)

        with open(self.llm_fp, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "system_messages": self.system_messages,
                    "conversation_summary": self.conversation_summary,
                    "current_request_user_input": self.current_request_user_input,
                    "current_request_trace": self.current_request_trace,
                    "current_request_llm_messages": self.current_request_llm_messages,
                    "last_two_messages_fullish": self.last_two_messages_fullish,
                    "last_execution_plan_full": self.last_execution_plan_full,
                    "retained_retrieve_documents": self.retained_retrieve_documents,
                    "last_tool_observations_compact": self.last_tool_observations_compact,
                    "display_events": self.display_events,
                    "assistant_model_name": self.assistant_model_name,
                },
                f,
                ensure_ascii=False,
                indent=2,
            )

    def load(self) -> None:
        if not self.user or not self.session:
            return
        if self.display_fp.exists():
            with open(self.display_fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.display_messages = data.get("display_messages", [])
                self.display_events = data.get("display_events", [])
        if self.llm_fp.exists():
            with open(self.llm_fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.system_messages = data.get("system_messages", [])
                self.conversation_summary = data.get("conversation_summary", [])
                self.current_request_user_input = data.get("current_request_user_input", "")
                self.current_request_trace = data.get("current_request_trace", [])
                self.current_request_llm_messages = data.get("current_request_llm_messages", [])
                self.last_two_messages_fullish = data.get("last_two_messages_fullish", [])
                self.last_execution_plan_full = data.get("last_execution_plan_full", "")
                self.retained_retrieve_documents = data.get("retained_retrieve_documents", [])
                self.last_tool_observations_compact = data.get("last_tool_observations_compact", [])
                self.display_events = data.get("display_events", [])
                self.assistant_model_name = data.get("assistant_model_name", "")
        if not self.system_messages:
            self._init_prompts(None, None)

    def load_display_messages(self) -> list[dict[str, Any]]:
        """Load only display messages for API history retrieval."""
        if not self.user or not self.session:
            return []
        if self.display_fp.exists():
            with open(self.display_fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("display_messages", [])
        return []

    def load_llm_messages(self) -> None:
        if not self.user or not self.session:
            return
        if self.llm_fp.exists():
            with open(self.llm_fp, "r", encoding="utf-8") as f:
                data = json.load(f)
                self.system_messages = data.get("system_messages", [])
                self.conversation_summary = data.get("conversation_summary", [])
                self.current_request_user_input = data.get("current_request_user_input", "")
                self.current_request_trace = data.get("current_request_trace", [])
                self.current_request_llm_messages = data.get("current_request_llm_messages", [])
                self.last_two_messages_fullish = data.get("last_two_messages_fullish", [])
                self.last_execution_plan_full = data.get("last_execution_plan_full", "")
                self.retained_retrieve_documents = data.get("retained_retrieve_documents", [])
                self.last_tool_observations_compact = data.get("last_tool_observations_compact", [])
                self.display_events = data.get("display_events", [])
                self.assistant_model_name = data.get("assistant_model_name", "")
        if not self.system_messages:
            self._init_prompts(None, None)

    def _append_recent_message(self, role: str, content: str) -> None:
        # Keep only user/assistant messages here, like autre_version. Tool results are
        # already available through current_request_llm_messages / tool observations.
        if role not in {"user", "assistant"}:
            return
        self.last_two_messages_fullish.append({"role": role, "content": self._truncate(content, 8000)})
        self.last_two_messages_fullish = self.last_two_messages_fullish[-6:]

    def _summarize_tool_content(self, content: str, tool_name: str) -> str:
        parsed = self._safe_json_loads(content)
        results = parsed
        if isinstance(parsed, dict) and "tool_results" in parsed:
            results = parsed["tool_results"]
        if tool_name == "retrieve_documents":
            filenames = self._extract_retrieve_filenames(content)
            if filenames:
                return f"{tool_name} | documents=[{', '.join(filenames)}]"
            return f"{tool_name} | results.count={len(results) if isinstance(results, list) else 0}"
        return f"{tool_name} | preview={self._truncate(content, 800)}"

    def _compact_tool_observation(
        self, content: str, tool_name: str, arguments: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        if tool_name == "retrieve_documents":
            filenames = self._extract_retrieve_filenames(content)
            self._remember_retrieve_documents(filenames, arguments)
            compact: dict[str, Any] = {
                "tool_name": tool_name,
                "search_terms": self._normalize_search_terms(arguments),
                "documents": filenames,
            }
            if isinstance(arguments, dict):
                if "limit" in arguments:
                    compact["limit"] = arguments["limit"]
                if "return_full_document" in arguments:
                    compact["return_full_document"] = arguments["return_full_document"]
            return compact
        compact = {"tool_name": tool_name, "summary": self._summarize_tool_content(content, tool_name)}
        parsed = self._safe_json_loads(content)
        if isinstance(parsed, dict):
            for key in ("status", "uri", "class_uri", "attribute_uri", "connector_uri", "title", "name"):
                if key in parsed:
                    compact[key] = parsed[key]
        return compact

    def _extract_retrieve_filenames(self, content: str) -> list[str]:
        parsed = self._safe_json_loads(content)
        results = parsed
        if isinstance(parsed, dict) and "tool_results" in parsed:
            results = parsed["tool_results"]
        filenames: list[str] = []
        if isinstance(results, list):
            for item in results:
                if isinstance(item, (list, tuple)) and len(item) >= 1:
                    filename = item[0]
                    if isinstance(filename, str) and filename.strip():
                        filenames.append(filename.strip())
                elif isinstance(item, dict):
                    filename = item.get("filename") or item.get("file") or item.get("name")
                    if isinstance(filename, str) and filename.strip():
                        filenames.append(filename.strip())
        return list(dict.fromkeys(filenames))

    def _normalize_search_terms(self, arguments: Optional[dict[str, Any]]) -> str:
        if not isinstance(arguments, dict):
            return ""
        value = arguments.get("search_terms", "")
        if isinstance(value, list):
            return " ; ".join(str(v).strip() for v in value if str(v).strip())
        return str(value or "").strip()

    def _remember_retrieve_documents(
        self, filenames: list[str], arguments: Optional[dict[str, Any]] = None
    ) -> None:
        search_terms = self._normalize_search_terms(arguments)
        limit = arguments.get("limit") if isinstance(arguments, dict) else None
        return_full_document = arguments.get("return_full_document") if isinstance(arguments, dict) else None
        if not filenames and not search_terms:
            return
        for entry in self.retained_retrieve_documents:
            if (
                entry.get("search_terms", "") == search_terms
                and entry.get("limit") == limit
                and entry.get("return_full_document") == return_full_document
            ):
                merged = list(dict.fromkeys(entry.get("documents", []) + filenames))
                entry["documents"] = merged
                return
        self.retained_retrieve_documents.append(
            {
                "search_terms": search_terms,
                "limit": limit,
                "return_full_document": return_full_document,
                "documents": filenames,
            }
        )
        self.retained_retrieve_documents = self.retained_retrieve_documents[-50:]

    @staticmethod
    def _safe_json_loads(text: Any) -> Any:
        if not text or not isinstance(text, str):
            return None
        try:
            return json.loads(text)
        except Exception:
            return None

    @staticmethod
    def _json_text(value: Any, limit: int = 1600) -> str:
        try:
            text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)
        except Exception:
            text = str(value)
        return AssistantHistory._truncate(text, limit)

    @staticmethod
    def _truncate(value: Any, limit: int = 300) -> str:
        text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
        if len(text) <= limit:
            return text
        if limit <= 5:
            return text[:limit]
        kept = limit - 5
        head = kept // 2
        tail = kept - head
        return text[:head] + "[...]" + text[-tail:]
