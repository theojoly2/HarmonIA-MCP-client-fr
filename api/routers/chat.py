from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.dependencies import llm_client, _LLM_MODEL
from api.services.auth_service import get_session_cookie
from api.services.mcp_service import fetch_document_context
from api.services.token_counter import (
    count_messages_tokens,
    count_text_tokens,
    extract_usage_from_chunk,
)
from api.services.usage_store import record_usage

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessageRequest(BaseModel):
    document_id: str
    user_message: str
    history: list[dict] = []


async def rag_stream_generator(request: ChatMessageRequest, username: str | None = None):
    try:
        search_query = request.user_message
        if request.history:
            recent_context = " ".join([msg["content"] for msg in request.history[-2:]])
            search_query = f"Contexte récent: {recent_context} | Question: {request.user_message}"
        print(f"[Chat] Demande de contexte au MCP pour le doc: {request.document_id}...")
        context_text = await fetch_document_context(request.document_id, search_query)
        system_instruction = (
            "Tu es un assistant sémantique expert.\n"
            "Analyse les extraits de documents fournis ci-dessous pour répondre à la question.\n"
            "Consignes impératives :\n"
            "- Appuie-toi uniquement sur les faits explicités dans les extraits.\n"
            "- Si les extraits ne contiennent pas la réponse, dis-le clairement sans inventer.\n"
            "- Rédige tes réponses de manière claire en utilisant le format Markdown.\n\n"
            f"--- EXTRAITS PERTINENTS DU DOCUMENT ---\n{context_text}\n----------------------------------------"
        )
        messages = [{"role": "system", "content": system_instruction}]
        for msg in request.history:
            messages.append({"role": msg["role"], "content": msg["content"]})
        messages.append({"role": "user", "content": request.user_message})

        prompt_estimate = count_messages_tokens(messages, _LLM_MODEL)
        completion_estimate = 0
        usage_from_provider = None

        print("[Chat] Contexte reçu, début du streaming LLM...")
        response_stream = await llm_client.chat.completions.create(
            model=_LLM_MODEL,
            messages=messages,
            temperature=0.2,
            stream=True
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
    except Exception as e:
        print(f"[!] Erreur Chat Stream: {e}")
        yield f"\n\n*[Erreur de génération : {str(e)}]*"


@router.post("/stream")
async def stream_chat_response(request: ChatMessageRequest, http_request: Request):
    username = get_session_cookie(http_request)
    return StreamingResponse(
        rag_stream_generator(request, username=username),
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )
