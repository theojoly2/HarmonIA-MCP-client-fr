from api.dependencies import llm_client, _LLM_MODEL
from api.services.token_counter import (
    count_messages_tokens,
    count_text_tokens,
    extract_usage_from_chunk,
    format_token_count,
)
from api.services.usage_store import record_usage


async def stream_chat(messages: list, temperature: float = 0.2, username: str | None = None):
    """Stream a chat completion and optionally record token usage per user."""
    prompt_estimate = count_messages_tokens(messages, _LLM_MODEL)
    completion_estimate = 0
    usage_from_provider = None

    response = await llm_client.chat.completions.create(
        model=_LLM_MODEL,
        messages=messages,
        temperature=temperature,
        stream=True,
    )
    async for chunk in response:
        # Try to read usage from the final chunk if the provider includes it.
        if usage_from_provider is None:
            usage_from_provider = extract_usage_from_chunk(chunk)

        if chunk.choices:
            token = chunk.choices[0].delta.content
            if token:
                completion_estimate += count_text_tokens(token, _LLM_MODEL)
                yield token

    # Record usage when a user is associated with the request.
    if username:
        if usage_from_provider:
            record_usage(
                username=username,
                prompt_tokens=usage_from_provider.get("prompt_tokens", prompt_estimate),
                completion_tokens=usage_from_provider.get("completion_tokens", completion_estimate),
                endpoint="llm_service",
                model=_LLM_MODEL,
                source="usage",
            )
        else:
            record_usage(
                username=username,
                prompt_tokens=prompt_estimate,
                completion_tokens=completion_estimate,
                endpoint="llm_service",
                model=_LLM_MODEL,
                source="tiktoken",
            )


def format_usage_summary(prompt_tokens: int, completion_tokens: int) -> str:
    """Return a short human-readable summary like '1.2k / 0.9k'."""
    return f"{format_token_count(prompt_tokens)} / {format_token_count(completion_tokens)}"
