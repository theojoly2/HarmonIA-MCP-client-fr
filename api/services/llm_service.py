from api.dependencies import llm_client, _LLM_MODEL


async def stream_chat(messages: list, temperature: float = 0.2):
    response = await llm_client.chat.completions.create(
        model=_LLM_MODEL,
        messages=messages,
        temperature=temperature,
        stream=True,
    )
    async for chunk in response:
        if chunk.choices:
            token = chunk.choices[0].delta.content
            if token:
                yield token
