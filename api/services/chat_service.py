"""Chat service: orchestrate document-based LLM chat streaming.

This service depends on the LLM client but does not handle HTTP responses.
The router builds the StreamingResponse from the yielded tokens.
"""

from __future__ import annotations

from typing import Any, AsyncGenerator

from api.dependencies import _LLM_MODEL, llm_client
from api.gateways.document_gateway import build_chat_messages
from api.services.token_counter import (
    count_messages_tokens,
    count_text_tokens,
    extract_usage_from_chunk,
)
from api.services.usage_store import record_usage


async def stream_chat_document(
    document_id: str,
    user_message: str,
    history: list[dict[str, Any]],
    username: str | None,
) -> AsyncGenerator[str, None]:
    """Stream a chat completion for a document and record token usage.

    Yields plain text tokens. The router wraps this in a StreamingResponse.
    """
    messages = await build_chat_messages(document_id, user_message, history)

    prompt_estimate = count_messages_tokens(messages, _LLM_MODEL)
    completion_estimate = 0
    usage_from_provider = None

    response_stream = await llm_client.chat.completions.create(
        model=_LLM_MODEL,
        messages=messages,
        temperature=0.2,
        stream=True,
    )
    async for chunk in response_stream:
        if usage_from_provider is None:
            usage_from_provider = extract_usage_from_chunk(chunk)
        if len(chunk.choices) > 0:
            token = chunk.choices[0].delta.content
            if token:
                completion_estimate += count_text_tokens(token, _LLM_MODEL)
                yield token

    if username:
        if usage_from_provider:
            record_usage(
                username=username,
                prompt_tokens=usage_from_provider.get("prompt_tokens", prompt_estimate),
                completion_tokens=usage_from_provider.get("completion_tokens", completion_estimate),
                endpoint="chat",
                model=_LLM_MODEL,
                source="usage",
            )
        else:
            record_usage(
                username=username,
                prompt_tokens=prompt_estimate,
                completion_tokens=completion_estimate,
                endpoint="chat",
                model=_LLM_MODEL,
                source="tiktoken",
            )
