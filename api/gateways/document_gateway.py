"""Document gateway: encapsulate document file serving, preview visualisation
and chat streaming for a single document."""

from __future__ import annotations

import base64
import urllib.parse
from typing import Any

from fastapi import HTTPException
from fastapi.responses import Response

from api.dependencies import generate_svg_for_bytes
from api.services.auth_service import get_session_cookie
from api.services.mcp_service import fetch_document_context, fetch_document_file


async def serve_document_file(document_id: str) -> Response:
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise HTTPException(status_code=404, detail=f"Erreur de récupération: {data.get('error')}")

    b64_str = data["file_base64"]
    filename = data.get("filename", "document")
    ext = data.get("extension", "").lower()
    file_bytes = base64.b64decode(b64_str)

    mime_type = "text/plain; charset=utf-8"
    if ext == ".pdf":
        mime_type = "application/pdf"
    elif ext in [".html", ".htm"]:
        mime_type = "text/html; charset=utf-8"
    elif ext == ".json":
        mime_type = "application/json; charset=utf-8"

    safe_filename = urllib.parse.quote(filename)
    return Response(
        content=file_bytes,
        media_type=mime_type,
        headers={"Content-Disposition": f"inline; filename*=utf-8''{safe_filename}"}
    )


async def visualize_document(document_id: str) -> Response:
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise HTTPException(status_code=404, detail=f"Erreur de récupération: {data.get('error')}")

    file_bytes = base64.b64decode(data["file_base64"])
    filename = data.get("filename", "document")
    try:
        svg_text = generate_svg_for_bytes(file_bytes, filename)
        return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erreur de visualisation : {e}") from e


async def stream_chat_document(request: Any, http_request: Any) -> Any:
    from api.dependencies import llm_client, _LLM_MODEL
    from api.services.token_counter import count_messages_tokens, count_text_tokens, extract_usage_from_chunk
    from api.services.usage_store import record_usage

    username = get_session_cookie(http_request)

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

    async def generator():
        nonlocal completion_estimate, usage_from_provider
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

    return generator()
