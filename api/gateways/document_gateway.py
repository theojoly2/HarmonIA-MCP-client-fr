"""Document gateway: encapsulate document file serving and preview visualisation.

This module contains no HTTP/response construction. Routers build the
FastAPI responses from the returned raw values.
"""

from __future__ import annotations

import base64
import urllib.parse
from typing import Any

from api.exceptions import NotFoundError, ProcessingError, ValidationError
from api.gateways.model_gateway import generate_svg_for_bytes
from api.services.mcp_service import fetch_document_context, fetch_document_file


async def get_document_file(document_id: str) -> dict[str, Any]:
    """Return raw file data for a document.

    Raises:
        NotFoundError: when the document does not exist.
    """
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise NotFoundError("document_not_found", data.get("error", "Document introuvable"))
    return data


def build_file_response_data(data: dict[str, Any]) -> tuple[bytes, str, str]:
    """Build (file_bytes, mime_type, safe_filename) from raw document data."""
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
    return file_bytes, mime_type, safe_filename


async def visualize_document(document_id: str) -> str:
    """Return SVG text visualising a document.

    Raises:
        NotFoundError: when the document does not exist.
        ValidationError: when the file format is unsupported.
        ProcessingError: when SVG generation fails unexpectedly.
    """
    data = await fetch_document_file(document_id)
    if not data.get("success"):
        raise NotFoundError("document_not_found", data.get("error", "Document introuvable"))

    file_bytes = base64.b64decode(data["file_base64"])
    filename = data.get("filename", "document")
    try:
        return generate_svg_for_bytes(file_bytes, filename)
    except ValueError as exc:
        raise ValidationError("unsupported_format", str(exc)) from exc
    except Exception as exc:
        raise ProcessingError("visualisation_failed", str(exc)) from exc


async def build_chat_messages(document_id: str, user_message: str, history: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Build the LLM message list for a document chat request.

    Raises:
        NotFoundError: when no context can be fetched for the document.
        ProcessingError: when the MCP call fails.
    """
    search_query = user_message
    if history:
        recent_context = " ".join([msg["content"] for msg in history[-2:]])
        search_query = f"Contexte récent: {recent_context} | Question: {user_message}"

    print(f"[Chat] Demande de contexte au MCP pour le doc: {document_id}...")
    try:
        context_text = await fetch_document_context(document_id, search_query)
    except Exception as exc:
        raise ProcessingError("context_fetch_failed", f"Impossible de récupérer le contexte du document: {exc}") from exc

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
    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_message})
    return messages
