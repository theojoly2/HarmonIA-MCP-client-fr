"""Token counting utilities.

Hybrid approach:
- If the provider response/chunks expose a ``usage`` object, use it (exact).
- Otherwise fall back to tiktoken estimation.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


try:
    import tiktoken
except ImportError:  # pragma: no cover
    tiktoken = None  # type: ignore


def _get_encoder(model: str | None):
    """Return a tiktoken encoder for the given model name.

    Falls back to cl100k_base (used by GPT-4 / text-embedding-ada-002) when
    the model name is unknown. This is an approximation for non-OpenAI models.
    """
    if tiktoken is None:
        return None
    name = (model or "").lower()
    # Map common model families to a known encoder.
    if "gpt-4" in name or "gpt-3.5" in name or "gpt-35" in name:
        try:
            return tiktoken.encoding_for_model(name)
        except KeyError:
            pass
    if "cl100k" in name:
        return tiktoken.get_encoding("cl100k_base")
    # Default approximation for everything else (Gemma, Llama, Mistral, ...).
    try:
        return tiktoken.get_encoding("cl100k_base")
    except Exception:  # pragma: no cover
        return None


def count_text_tokens(text: str, model: str | None = None) -> int:
    """Estimate the number of tokens in a plain text string."""
    if not text:
        return 0
    enc = _get_encoder(model)
    if enc:
        return len(enc.encode(text))
    # Very rough fallback if tiktoken is unavailable.
    return max(1, len(text) // 4)


def count_message_tokens(message: dict[str, Any], model: str | None = None) -> int:
    """Estimate tokens for a single chat message dict."""
    content = message.get("content") or ""
    if isinstance(content, list):
        # Multimodal / tool message content
        text_parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
        ]
        content = "\n".join(text_parts)
    tool_calls = message.get("tool_calls") or []
    text = content
    for tc in tool_calls:
        if isinstance(tc, dict):
            text += "\n" + (tc.get("function", {}).get("name") or "")
            text += "\n" + (tc.get("function", {}).get("arguments") or "")
        else:
            text += "\n" + (getattr(getattr(tc, "function", None), "name", "") or "")
            text += "\n" + (getattr(getattr(tc, "function", None), "arguments", "") or "")
    return count_text_tokens(text, model)


def count_messages_tokens(messages: list[dict[str, Any]], model: str | None = None) -> int:
    """Estimate prompt tokens from a list of chat messages."""
    if not messages:
        return 0
    total = sum(count_message_tokens(m, model) for m in messages)
    # Add a few overhead tokens per message for the chat template formatting.
    total += len(messages) * 3
    # Add general overhead for the response format.
    total += 3
    return max(0, total)


def extract_usage_from_chunk(chunk: Any) -> dict[str, int] | None:
    """Try to extract usage information from a streaming chunk."""
    if chunk is None:
        return None
    usage = getattr(chunk, "usage", None)
    if usage is None and isinstance(chunk, dict):
        usage = chunk.get("usage")
    if usage is None:
        return None
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    if prompt is None and isinstance(usage, dict):
        prompt = usage.get("prompt_tokens")
        completion = usage.get("completion_tokens")
    if prompt is not None or completion is not None:
        return {
            "prompt_tokens": int(prompt or 0),
            "completion_tokens": int(completion or 0),
            "total_tokens": int(getattr(usage, "total_tokens", None) or ((prompt or 0) + (completion or 0))),
        }
    return None


def extract_usage_from_response(response: Any) -> dict[str, int] | None:
    """Try to extract usage information from a non-streaming response."""
    if response is None:
        return None
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return None
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    total = getattr(usage, "total_tokens", None)
    if isinstance(usage, dict):
        prompt = usage.get("prompt_tokens", prompt)
        completion = usage.get("completion_tokens", completion)
        total = usage.get("total_tokens", total)
    return {
        "prompt_tokens": int(prompt or 0),
        "completion_tokens": int(completion or 0),
        "total_tokens": int(total or ((prompt or 0) + (completion or 0))),
    }


def format_token_count(n: int) -> str:
    """Format a token count with k/M suffixes."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")
    if n >= 1_000:
        return f"{n / 1_000:.1f}k".replace(".0k", "k")
    return str(n)
