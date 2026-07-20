import asyncio
import base64
import re
import urllib.parse
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
import markdown
from fastmcp import Client
import os
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

# --- Chargement de l'environnement ---
load_dotenv()

# Configuration LLM
_LLM_API_KEY = os.getenv("LLM_API_KEY", "not-needed")
_URL_API = os.getenv("URL_LLM_API", "")
_LLM_MODEL = os.getenv("LLM_MODEL", "")

llm_client = AsyncOpenAI(base_url=_URL_API, api_key=_LLM_API_KEY)


# Modèle de données attendu depuis le Javascript
class ChatMessageRequest(BaseModel):
    document_id: str
    user_message: str
    history: list[dict] = []


MCP_SERVER_URL = "http://127.0.0.1:8001/mcp"

app = FastAPI(title="Recherche Sémantique")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

LATEX_TO_UNICODE = {
    r'\rightarrow': '→', r'\leftarrow': '←', r'\leftrightarrow': '↔',
    r'\Rightarrow': '⇒', r'\Leftarrow': '⇐', r'\Leftrightarrow': '⇔',
    r'\leq': '≤', r'\geq': '≥', r'\neq': '≠', r'\approx': '≈',
    r'\in': '∈', r'\notin': '∉', r'\subset': '⊂', r'\cup': '∪', r'\cap': '∩',
    r'\forall': '∀', r'\exists': '∃', r'\land': '∧', r'\lor': '∨',
    r'\infty': '∞', r'\pm': '±', r'\times': '×', r'\cdot': '·',
    r'\alpha': 'α', r'\beta': 'β', r'\gamma': 'γ', r'\delta': 'δ',
    r'\lambda': 'λ', r'\mu': 'μ', r'\pi': 'π', r'\sigma': 'σ',
    r'\ldots': '…',
}


def _extract_filename_from_disposition(header: str) -> str:
    """Parse Content-Disposition header and extract filename (preferring filename*)."""
    if not header:
        return ""
    # filename*=utf-8''name.ext
    match = re.search(r"filename\*=([^'\"]*)''([^;]+)", header, re.IGNORECASE)
    if match:
        return urllib.parse.unquote(match.group(2).strip('"'))
    # filename="name.ext" or filename=name.ext
    match = re.search(r'filename=["\']?([^";]+)', header, re.IGNORECASE)
    if match:
        return match.group(1).strip('"')
    return ""


def _safe_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _escape_xml_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def normalize_latex(text: str) -> str:
    for latex, uni in LATEX_TO_UNICODE.items():
        text = text.replace(f'${latex}$', uni)
        text = text.replace(latex, uni)
    text = re.sub(r'\$([^$]{1,60})\$', r'\1', text)
    return text


async def fetch_tags_from_mcp():
    print("[Python] Récupération des tags...", flush=True)
    try:
        async with Client(MCP_SERVER_URL) as client:
            res = await asyncio.wait_for(client.call_tool("get_available_tags", {}), timeout=10.0)
            data = res.structured_content
            if isinstance(data, dict):
                if "tags" in data:
                    return data["tags"]
                if "result" in data and isinstance(data["result"], dict): return data["result"].get("tags", [])
                if "result" in data and isinstance(data["result"], list): return data["result"]
            if isinstance(data, list):
                return data
            return []
    except Exception as e:
        print(f"[Erreur Python] Tags : {e}", flush=True)
        return []


async def fetch_search_from_mcp(query: str, tags: list):
    print(f"[Python] Recherche en cours: '{query}' | Filtres: {tags}", flush=True)
    try:
        async with Client(MCP_SERVER_URL) as client:
            args = {"search_terms": query, "limit": 20}
            if tags:
                args["tags"] = tags
            res = await asyncio.wait_for(client.call_tool("retrieve_search_documents", args), timeout=240.0)

            data = None

            if hasattr(res, "structured_content") and res.structured_content:
                data = res.structured_content
            elif hasattr(res, "content"):
                import json
                text = "".join(getattr(c, "text", str(c)) for c in (res.content or []))
                if text:
                    try:
                        data = json.loads(text)
                    except:
                        pass

            if isinstance(data, dict):
                if "result" in data:
                    return data["result"]
                return data
            if isinstance(data, list):
                return data

            return []

    except asyncio.TimeoutError:
        print("[Erreur Python] Timeout atteint lors de la recherche.", flush=True)
        return "TIMEOUT"
    except Exception as e:
        print(f"[Erreur Python] Search : {e}", flush=True)
        return []


async def fetch_document_file_from_mcp(chunk0_id: str):
    print(f"[Python] Demande de fichier pour l'ID : {chunk0_id}", flush=True)
    try:
        async with Client(MCP_SERVER_URL) as client:
            res = await asyncio.wait_for(
                client.call_tool("get_document_file", {"document_id": chunk0_id}),
                timeout=15.0
            )
            data = res.structured_content
            if isinstance(data, dict) and "result" in data:
                data = data["result"]
            if isinstance(data, dict) and data.get("success"):
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
            else:
                err = data.get("error") if isinstance(data, dict) else "Document introuvable ou erreur de l'outil"
                return HTMLResponse(f"<h3>Erreur de récupération: {err}</h3>", status_code=404)
    except Exception as e:
        return HTMLResponse(f"<h3>Erreur serveur lors du téléchargement : {e}</h3>", status_code=500)


# ==========================================
# ROUTE RAG - STREAMING LLM
# ==========================================
@app.post("/api/chat/stream")
async def stream_chat_response(request: ChatMessageRequest):
    async def rag_stream_generator():
        try:
            # 1. Construire la requête de recherche
            search_query = request.user_message
            if request.history:
                recent_context = " ".join([msg["content"] for msg in request.history[-2:]])
                search_query = f"Contexte récent: {recent_context} | Question: {request.user_message}"

            # 2. Demander le contexte au serveur MCP
            print(f"[Chat] Demande de contexte au MCP pour le doc: {request.document_id}...")
            async with Client(MCP_SERVER_URL) as mcp_client:
                res = await asyncio.wait_for(
                    mcp_client.call_tool("retrieve_document_context", {
                        "document_id": request.document_id,
                        "query": search_query
                    }),
                    timeout=30.0
                )

                context_text = ""
                if isinstance(res.structured_content, dict) and "result" in res.structured_content:
                    context_text = res.structured_content["result"]
                else:
                    context_text = str(res.structured_content)
            
            # 3. Préparer le prompt
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

            # 4. Appeler l'API du LLM en streaming
            print("[Chat] Contexte reçu, début du streaming LLM...")
            response_stream = await llm_client.chat.completions.create(
                model=_LLM_MODEL,
                messages=messages,
                temperature=0.2,
                stream=True
            )

            # 5. Renvoyer les mots
            async for chunk in response_stream:
                if len(chunk.choices) > 0:
                    token = chunk.choices[0].delta.content
                    if token:
                        yield token

        except Exception as e:
            print(f"[!] Erreur Chat Stream: {e}")
            yield f"\n\n*[Erreur de génération : {str(e)}]*"

    return StreamingResponse(
        rag_stream_generator(),
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='13' cy='13' r='9' fill='none' stroke='%23111827' stroke-width='3.5'/%3E%3Cline x1='19' y1='19' x2='27' y2='27' stroke='%23111827' stroke-width='3.5' stroke-linecap='round'/%3E%3C/svg%3E">
    <title>Recherche Sémantique</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        html, body { height: 100%; scrollbar-gutter: stable; overflow: hidden; }
        body { display: flex; flex-direction: column; }

        #global-header { flex-shrink: 0; }
        #split-wrapper { flex: 1 1 0%; min-height: 0; }

        /* --- Floating Windows --- */
        .floating-window {
            position: fixed;
            display: flex;
            flex-direction: column;
            background: #ffffff;
            border: 1px solid #e5e7eb;
            border-radius: 1.25rem;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            overflow: hidden;
            z-index: 60;
            transform: translate(-50%, -50%);
        }
        .floating-window.active {
            z-index: 70;
        }

        .window-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.75rem 1rem;
            border-bottom: 1px solid #f3f4f6;
            background: #ffffff;
            cursor: move;
            user-select: none;
            flex-shrink: 0;
        }

        .resize-handle {
            position: absolute;
            bottom: 0;
            right: 0;
            width: 16px;
            height: 16px;
            cursor: se-resize;
            z-index: 10;
        }
        .resize-handle::after {
            content: '';
            position: absolute;
            bottom: 4px;
            right: 4px;
            width: 8px;
            height: 8px;
            border-right: 2px solid #d1d5db;
            border-bottom: 2px solid #d1d5db;
            border-radius: 0 0 2px 0;
        }

        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }

        @property --angle { syntax: "<angle>"; initial-value: 0deg; inherits: false; }
        @property --mouse-x { syntax: "<length>"; initial-value: 0px; inherits: false; }
        @property --mouse-y { syntax: "<length>"; initial-value: 0px; inherits: false; }
        @property --glow-size { syntax: "<length>"; initial-value: 0px; inherits: false; }

        @keyframes spin-halo { to { --angle: 360deg; } }
        @keyframes blink { 0%, 80%, 100% { opacity: 0; } 40% { opacity: 1; } }
        @keyframes fadeSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeSlideDown { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(8px); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes textPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        @keyframes btnOut { to { opacity: 0; transform: scale(0.85); } }
        @keyframes btnIn { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }

        /* --- Animations Magie --- */
        @keyframes sparkleCenterPulse {
            0%   { transform: scale(1) rotate(0deg); }
            20%  { transform: scale(0.75) rotate(10deg); }
            50%  { transform: scale(1.35) rotate(-15deg); }
            75%  { transform: scale(0.9) rotate(5deg); }
            100% { transform: scale(1) rotate(0deg); }
        }

        @keyframes sparkleOrbit {
            0%   { transform: rotate(0deg) scale(1); }
            15%  { transform: rotate(-25deg) scale(0.8); }
            50%  { transform: rotate(190deg) scale(1.4); }
            75%  { transform: rotate(165deg) scale(0.9); }
            100% { transform: rotate(180deg) scale(1); }
        }

        @keyframes magicColor {
            0%   { fill: currentColor; }
            20%  { fill: #f472b6; }
            40%  { fill: #fbbf24; }
            60%  { fill: #34d399; }
            80%  { fill: #818cf8; }
            100% { fill: currentColor; }
        }

        .user-msg-anchor { scroll-margin-top: 2px; }

        .magic-btn {
            position: relative;
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(0,0,0,0.1) 0%, transparent 100%);
            transition: background-color 0.2s, transform 0.1s, --glow-size 0.25s ease;
        }
        .magic-btn:active { transform: scale(0.95); }

        .sparkle-main { transform-origin: center; transform-box: fill-box; fill: currentColor; }
        .sparkle-orbit-path { transform-origin: 12px 12px; transform-box: view-box; fill: currentColor; }

        .magic-btn:hover .sparkle-main, .trigger-magic .sparkle-main {
            animation: sparkleCenterPulse 0.8s ease-in-out forwards, magicColor 0.8s linear forwards;
        }
        
        .magic-btn:hover .sparkle-orbit-path, .trigger-magic .sparkle-orbit-path {
            animation: sparkleOrbit 0.8s ease-in-out forwards, magicColor 0.8s linear forwards;
        }

        .magic-svg { overflow: visible; }

        /* SVG Interactive Viewer */
        .svg-viewer {
            width: 100%;
            height: 100%;
            background: #ffffff;
            position: relative;
            overflow: hidden;
            cursor: grab;
        }
        .svg-viewer:active {
            cursor: grabbing;
        }
        .svg-canvas {
            position: absolute;
            top: 0;
            left: 0;
            transform-origin: 0 0;
            will-change: transform;
        }
        .svg-canvas .svg-diagram {
            display: block;
            max-width: none;
            max-height: none;
        }

        /* Split pane transitions */
        #split-wrapper {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
        #left-pane, #right-pane {
            transition: width 0.45s cubic-bezier(0.4, 0, 0.2, 1),
                        flex 0.45s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #split-resizer {
            opacity: 0;
            transition: opacity 0.25s ease;
            z-index: 20;
        }
        #split-resizer.visible {
            opacity: 1;
        }

        .svg-controls {
            position: absolute;
            bottom: 1rem;
            right: 1rem;
            display: flex;
            gap: 0.5rem;
            z-index: 40;
        }
        .svg-ctrl-btn {
            width: 2rem;
            height: 2rem;
            border-radius: 9999px;
            background: rgba(255, 255, 255, 0.95);
            border: 1px solid #e5e7eb;
            color: #374151;
            font-size: 1.1rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            transition: all 0.15s ease;
            cursor: pointer;
            line-height: 1;
        }
        .svg-ctrl-btn:hover {
            background: #f9fafb;
            border-color: #d1d5db;
            transform: translateY(-1px);
        }
        .svg-ctrl-btn:active {
            transform: translateY(0);
        }

        /* Navigation tabs */
        .nav-tab {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem 1rem;
            border-radius: 9999px;
            font-size: 0.9rem;
            font-weight: 600;
            color: #6b7280;
            background: transparent;
            border: 1px solid transparent;
            transition: all 0.2s ease;
            cursor: pointer;
        }
        .nav-tab:hover { color: #111827; background: #f3f4f6; }
        .nav-tab.active { color: #111827; background: #111827; color: white; }

        /* Drop zone */
        .drop-zone {
            border: 2px dashed #d1d5db;
            border-radius: 1.5rem;
            background: #f9fafb;
            transition: all 0.2s ease;
        }
        .drop-zone.drag-over {
            border-color: #111827;
            background: #f3f4f6;
        }

        #submit-btn .btn-label { display: inline-block; animation: btnIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        #submit-btn .btn-label.leaving { animation: btnOut 0.15s ease-in forwards; }

        h1 a, h1 .title-glow { font-size: clamp(1.25rem, 2.5vw, 2.25rem); }

        .interactive-title { display: inline-block; position: relative; text-decoration: none; cursor: pointer; }

        .title-glow {
            display: inline-block;
            background-color: #111827;
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 100%);
            background-repeat: no-repeat;
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            color: transparent;
            transition: --glow-size 0.3s ease;
        }

        .chat-send-btn { background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255,255,255,0.5) 0%, transparent 100%); }

        #search-input {
            font-size: clamp(0.875rem, 1.3vw, 1.125rem);
            padding-top: clamp(0.6rem, 1vw, 0.875rem);
            padding-bottom: clamp(0.6rem, 1vw, 0.875rem);
            padding-left: clamp(0.875rem, 1.8vw, 1.5rem);
            padding-right: clamp(4.5rem, 9vw, 8rem);
        }

        #submit-btn {
            font-size: clamp(0.75rem, 1.1vw, 1rem);
            padding-left: clamp(0.875rem, 1.8vw, 1.5rem);
            padding-right: clamp(0.875rem, 1.8vw, 1.5rem);
            background-color: #111827;
            display: flex;
            align-items: center;
            justify-content: center;
            background-image: radial-gradient(circle var(--glow-size) at var(--mouse-x) var(--mouse-y), rgba(255,255,255,0.6) 0%, transparent 100%);
            transition: --glow-size 0.3s ease, background-color 0.4s ease, width 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            overflow: hidden;
            white-space: nowrap;
        }

        #submit-btn.loading { background-color: #6b7280; background-image: none; pointer-events: none; cursor: not-allowed; }

        .result-item { opacity: 0; }
        .result-item.visible { animation: fadeSlideUp 0.35s ease forwards; }
        .results-hiding { animation: fadeSlideDown 0.2s ease forwards; }

        #results-header { opacity: 0; animation: fadeIn 0.4s ease 0.1s forwards; }

        #page-wrapper {
            margin-inline: auto;
            transition: padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1);
        }

        #vision-page-wrapper {
            transition: padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.45s ease;
            justify-content: center;
            padding-top: 0;
            padding-bottom: 0;
        }
        #vision-page-wrapper.vision-top {
            justify-content: flex-start;
            padding-top: 0;
            padding-bottom: 0;
        }
        #vision-import-container {
            transition: opacity 0.45s ease, transform 0.45s ease, max-height 0.45s ease;
            overflow: hidden;
        }
        #vision-import-container.vision-import-hidden {
            opacity: 0;
            transform: translateY(-20px);
            max-height: 0;
            margin-bottom: 0;
            pointer-events: none;
        }

        #search-container { width: 100%; }

        .search-wrapper { position: relative; border-radius: 9999px; isolation: isolate; width: 100%; }

        .search-wrapper::before {
            content: '';
            position: absolute;
            inset: -6px;
            border-radius: 9999px;
            filter: blur(6px);
            z-index: -1;
            transition: opacity 0.6s ease;
            opacity: 0;
            pointer-events: none;
            will-change: opacity;
        }

        .search-wrapper.loading::before {
            background: conic-gradient(from var(--angle), rgba(244,114,182,0.35), rgba(129,140,248,0.35), rgba(56,189,248,0.35), rgba(52,211,153,0.35), rgba(251,191,36,0.35), rgba(244,114,182,0.35));
            animation: spin-halo 3s linear infinite;
            opacity: 1;
        }

        .dot-btn { animation: blink 1.4s infinite both; line-height: 1; color: rgba(255,255,255,0.45); }
        .dot-btn:nth-child(2) { animation-delay: 0.2s; }
        .dot-btn:nth-child(3) { animation-delay: 0.4s; }

        #loading-indicator { display: none; }
        #loading-indicator.visible {
            display: flex;
            align-items: baseline;
            justify-content: center;
            gap: 0.5rem;
            animation: textPulse 3s ease-in-out infinite;
        }

        #elapsed-timer { font-family: monospace; font-size: 0.8rem; color: #9ca3af; min-width: 2.5ch; }

        .tag-label span {
            font-size: clamp(0.7rem, 1vw, 0.875rem);
            padding: clamp(0.3rem, 0.55vw, 0.5rem) clamp(0.75rem, 1.2vw, 1.25rem);
            display: inline-flex;
            align-items: center;
            position: relative;
            overflow: hidden;
            transition: all 0.2s ease;
        }

        .tag-label input:checked ~ span .icon-unchecked { display: none; }
        .tag-label input:not(:checked) ~ span .icon-checked { display: none; }

        .tag-label input:not(:checked) ~ span {
            background-color: #ffffff;
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(0,0,0,0.15) 0%, transparent 100%);
            transition: --glow-size 0.25s ease, background-color 0.2s ease, border-color 0.2s ease;
        }

        .tag-label input:checked ~ span {
            background-color: #111827;
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255,255,255,0.6) 0%, transparent 100%);
            transition: --glow-size 0.25s ease, background-color 0.2s ease, border-color 0.2s ease;
        }

        .markdown-body { color: #1f2937; }
        .markdown-body p { margin-bottom: 0.75rem; }
        .markdown-body p:last-child { margin-bottom: 0; }
        .markdown-body ul { list-style-type: disc; padding-left: 1.5rem; margin-top: 0.5rem; margin-bottom: 0.75rem; }
        .markdown-body ol { list-style-type: decimal; padding-left: 1.5rem; margin-top: 0.5rem; margin-bottom: 0.75rem; }
        .markdown-body li { margin-bottom: 0.25rem; }
        .markdown-body strong { font-weight: 700; color: #111827; }
        .markdown-body em { font-style: italic; }
        .markdown-body code { font-family: monospace; background-color: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 0.25rem; font-size: 0.9em; }
        .markdown-body pre {
            background-color: #f3f4f6; padding: 0.75rem 1rem; border-radius: 0.5rem;
            overflow-x: auto; white-space: pre-wrap; word-wrap: break-word;
            overflow-wrap: anywhere; margin-top: 0.5rem; margin-bottom: 0.75rem; font-size: 0.85em;
        }
        .markdown-body pre code { background-color: transparent; padding: 0; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
    </style>
</head>
<body class="bg-white text-gray-900 font-sans antialiased selection:bg-gray-300">

    <!-- Global top bar -->
    <div id="global-header" class="sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div class="flex items-center gap-2">
            <button id="tab-search" class="nav-tab active" onclick="showPane('search')">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                Recherche
            </button>
            <button id="tab-vision" class="nav-tab" onclick="showPane('vision')">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                Vision
            </button>
        </div>
        <button id="close-vision-pane" onclick="closeVisionPane()" class="hidden magic-btn p-2 text-gray-400 hover:text-black rounded-full hover:bg-gray-100 transition-colors focus:outline-none" title="Fermer Vision">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
    </div>

    <!-- SPLIT LAYOUT WRAPPER -->
    <div id="split-wrapper" class="flex w-full h-full overflow-hidden bg-white">

        <!-- Left Pane: Search & Results -->
        <div id="left-pane" class="h-full overflow-y-auto flex-shrink-0" style="width: 100%;">
            <div class="px-4 sm:px-6" id="page-wrapper">
                <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8 mt-6">
                    <a href="?" class="interactive-title">
                        <span class="title-glow">Recherche Sémantique</span>
                    </a>
                </h1>

                <form method="POST" action="?" class="mb-4" id="search-form">
                    <div id="search-container">
                        <div class="search-wrapper" id="search-wrapper">
                            <input type="text" name="q" value="{{query_value}}" placeholder="Entrez votre recherche..." required
                                class="w-full rounded-full border-2 border-gray-300 focus:outline-none focus:border-black font-medium transition-colors placeholder-gray-500"
                                id="search-input">
                            <button type="submit" id="submit-btn"
                                class="absolute right-2 top-2 bottom-2 text-white rounded-full font-bold disabled:bg-gray-400 whitespace-nowrap overflow-hidden">
                                Chercher
                            </button>
                        </div>
                        <div id="tags-container" class="mt-5 flex flex-wrap gap-2 justify-center">
                            {{tags_html}}
                        </div>
                    </div>
                </form>

                <div id="loading-indicator" class="text-center mt-2 mb-6">
                    <span class="text-xs font-bold tracking-widest uppercase text-gray-400">Recherche en cours</span>
                    <span id="elapsed-timer"></span>
                </div>

                <div id="results-container" class="mt-4 pb-12">
                    {{results_html}}
                </div>
            </div>
        </div>

        <!-- Draggable Resizer -->
        <div id="split-resizer" class="hidden w-1.5 bg-gray-200 hover:bg-gray-300 active:bg-gray-400 cursor-col-resize z-20 flex-shrink-0 transition-colors"></div>

            <!-- Right Pane: Vision / Split View Content -->
        <div id="right-pane" class="hidden h-full bg-white border-l border-gray-200 overflow-hidden flex-shrink-0 flex flex-col" style="width: 0;">
            <div class="flex-1 relative overflow-hidden flex flex-col" id="right-pane-content">
                <div id="vision-page-wrapper" class="px-4 sm:px-6 flex flex-col items-center text-center flex-shrink-0 z-20 bg-white transition-all duration-500 ease-out">
                    <h1 class="font-bold tracking-tight text-center text-black mb-2 mt-2">
                        <button type="button" class="interactive-title bg-transparent border-0 p-0" onclick="showVisionHome();" title="Retour à l'accueil Vision">
                            <span class="title-glow">Vision Sémantique</span>
                        </button>
                    </h1>

                    <div id="vision-import-container" class="w-full max-w-md">
                        <p class="text-base font-medium mb-6 text-center max-w-md mx-auto text-gray-500">Importez un fichier (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML) pour le visualiser sous forme de diagramme.</p>
                        <label id="vision-drop-zone" class="drop-zone flex flex-col items-center justify-center w-full max-w-md mx-auto py-10 px-6 cursor-pointer hover:border-gray-400">
                            <svg class="w-10 h-10 mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            <span class="text-sm font-semibold text-gray-700">Glissez-déposez un fichier ici</span>
                            <span class="text-xs text-gray-400 mt-1">ou cliquez pour parcourir</span>
                            <input type="file" id="vision-file-input" class="hidden" accept=".ttl,.xml,.xmi,.json,.jsonld,.sql,.txt,.html,.htm,.csv">
                        </label>
                    </div>
                </div>
                <template id="vision-viewer-template">
                    <div id="svg-viewer" class="svg-viewer">
                        <div id="svg-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
                            <svg class="animate-spin h-8 w-8 text-gray-400 mb-3" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span class="text-sm font-medium ml-3">Génération de la modélisation...</span>
                        </div>
                        <div class="svg-canvas" id="vision-svg-canvas"></div>
                        <div class="svg-controls">
                            <button class="svg-ctrl-btn" onclick="svgZoomIn()" title="Zoom avant">+</button>
                            <button class="svg-ctrl-btn" onclick="svgZoomOut()" title="Zoom arrière">−</button>
                            <button class="svg-ctrl-btn" onclick="svgResetZoom()" title="Réinitialiser">⟲</button>
                        </div>
                    </div>
                </template>
            </div>
        </div>

    </div>

    <!-- Floating Preview Window -->
    <div id="preview-window" class="floating-window hidden" style="width: 800px; height: 600px; top: 50%; left: 50%;">
        <div class="window-header" id="preview-header">
            <div class="flex items-center gap-2 min-w-0">
                <svg class="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                <div class="min-w-0">
                    <h3 class="font-bold text-gray-900 text-sm leading-tight">Aperçu du document</h3>
                    <p class="text-xs text-gray-400 truncate" id="preview-filename">Chargement...</p>
                </div>
            </div>
            <button onclick="closePreviewWindow()" class="magic-btn text-gray-400 hover:text-black p-1.5 rounded-full transition-colors focus:outline-none flex-shrink-0" title="Fermer">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>
        <div class="flex-1 relative overflow-hidden" id="preview-body">
            <div id="preview-svg-viewer" class="svg-viewer">
                <div id="preview-svg-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
                    <svg class="animate-spin h-8 w-8 text-gray-400 mb-3" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span class="text-sm font-medium ml-3">Génération de la modélisation...</span>
                </div>
                <div class="svg-canvas"></div>
                <div class="svg-controls">
                    <button class="svg-ctrl-btn" onclick="previewSvgZoomIn()" title="Zoom avant">+</button>
                    <button class="svg-ctrl-btn" onclick="previewSvgZoomOut()" title="Zoom arrière">−</button>
                    <button class="svg-ctrl-btn" onclick="previewSvgResetZoom()" title="Réinitialiser">⟲</button>
                </div>
            </div>
        </div>
        <div class="resize-handle" data-target="preview-window"></div>
    </div>

    <!-- Floating Chat Window -->
    <div id="chat-window" class="floating-window hidden" style="width: 500px; height: 600px; top: 50%; left: 50%;">
        <div class="window-header" id="chat-header">
            <div class="flex items-center gap-2 min-w-0">
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container">
                    <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                    </svg>
                </div>
                <div class="min-w-0">
                    <h3 class="font-bold text-gray-900 text-sm leading-tight">Assistant Sémantique</h3>
                    <p class="text-xs text-gray-400 truncate" id="chat-filename">Chargement...</p>
                </div>
            </div>
            <button onclick="closeChatWindow()" class="magic-btn text-gray-400 hover:text-black p-1.5 rounded-full transition-colors focus:outline-none flex-shrink-0" title="Fermer">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4" id="chat-messages">
            <div class="flex flex-col items-start gap-3 mb-8">
                <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">
                    <p>Je prépare l'analyse de ce document. Quelle est votre question spécifique ?</p>
                </div>
                <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container">
                    <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                        <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                        <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                        <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                    </svg>
                </div>
            </div>
        </div>

        <div class="p-3 border-t border-gray-100">
            <form id="ai-chat-form" onsubmit="event.preventDefault(); handleChatSubmit();" class="relative flex items-center">
                <input type="text" id="ai-chat-input" placeholder="Interrogez le modèle..." 
                    class="w-full bg-gray-50 border border-gray-100 rounded-[2rem] pl-4 pr-12 py-3 text-sm font-medium focus:outline-none focus:bg-white focus:border-gray-300 focus:shadow-sm transition-all" autocomplete="off">
                <button type="submit" class="magic-btn chat-send-btn absolute right-2 text-white bg-black hover:bg-gray-800 rounded-full w-9 h-9 flex items-center justify-center transition-colors">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path></svg>
                </button>
            </form>
        </div>
        <div class="resize-handle" data-target="chat-window"></div>
    </div>

    <script>
        const wrapper = document.getElementById('page-wrapper');
        let IS_CENTERED = {{is_centered}};

        // --- SPLIT VIEW LOGIC ---
        let isResizing = false;
        const resizer = document.getElementById('split-resizer');
        const rightPane = document.getElementById('right-pane');
        const leftPane = document.getElementById('left-pane');

        let activePane = 'search'; // 'search' | 'vision' | 'split'

        // --- FLOATING WINDOWS SETUP ---
        function clampWindowPosition(win) {
            const rect = win.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const minVisible = 60; // at least 60px of each edge must stay visible
            let left = rect.left;
            let top = rect.top;
            left = Math.max(minVisible - rect.width, Math.min(vw - minVisible, left));
            top = Math.max(0, Math.min(vh - minVisible, top));
            win.style.left = left + 'px';
            win.style.top = top + 'px';
            win.style.transform = 'none';
        }

        function makeDraggable(headerId, windowId) {
            const header = document.getElementById(headerId);
            const win = document.getElementById(windowId);
            if (!header || !win) return;

            let isDragging = false;
            let startX = 0, startY = 0;
            let initialLeft = 0, initialTop = 0;

            header.addEventListener('mousedown', (e) => {
                if (e.target.closest('button')) return;
                isDragging = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = win.getBoundingClientRect();
                initialLeft = rect.left;
                initialTop = rect.top;
                bringToFront(windowId);
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                let left = initialLeft + dx;
                let top = initialTop + dy;
                win.style.left = left + 'px';
                win.style.top = top + 'px';
                win.style.transform = 'none';
            });

            window.addEventListener('mouseup', () => {
                if (!isDragging) return;
                isDragging = false;
                clampWindowPosition(win);
            });
        }

        function makeResizable(windowId, onResizeCallback) {
            const win = document.getElementById(windowId);
            const handle = win.querySelector('.resize-handle');
            if (!win || !handle) return;

            let isResizing = false;
            let startX = 0, startY = 0;
            let initialW = 0, initialH = 0;

            handle.addEventListener('mousedown', (e) => {
                isResizing = true;
                startX = e.clientX;
                startY = e.clientY;
                const rect = win.getBoundingClientRect();
                initialW = rect.width;
                initialH = rect.height;
                bringToFront(windowId);
                if (onResizeCallback) onResizeCallback('start');
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!isResizing) return;
                const dw = e.clientX - startX;
                const dh = e.clientY - startY;
                win.style.width = Math.max(320, initialW + dw) + 'px';
                win.style.height = Math.max(200, initialH + dh) + 'px';
                if (onResizeCallback) onResizeCallback('resize');
            });

            window.addEventListener('mouseup', () => {
                if (isResizing) {
                    isResizing = false;
                    clampWindowPosition(win);
                    if (onResizeCallback) onResizeCallback('end');
                }
            });
        }

        function bringToFront(windowId) {
            document.querySelectorAll('.floating-window').forEach(w => w.classList.remove('active'));
            const win = document.getElementById(windowId);
            if (win) win.classList.add('active');
        }

        document.querySelectorAll('.floating-window').forEach(win => {
            win.addEventListener('mousedown', () => bringToFront(win.id));
        });

        makeDraggable('preview-header', 'preview-window');
        makeResizable('preview-window', (phase) => {
            if (phase === 'start') {
                const viewer = document.getElementById('preview-svg-viewer');
                const svg = document.querySelector('#preview-svg-viewer .svg-canvas svg.svg-diagram');
                if (!viewer || !svg) return;
                const rect = viewer.getBoundingClientRect();
                // Store the world coordinate currently at the center of the viewer
                previewSvgState._resizeAnchorX = (rect.width / 2 - previewSvgState.x) / previewSvgState.scale;
                previewSvgState._resizeAnchorY = (rect.height / 2 - previewSvgState.y) / previewSvgState.scale;
            } else if (phase === 'resize' || phase === 'end') {
                const viewer = document.getElementById('preview-svg-viewer');
                const svg = document.querySelector('#preview-svg-viewer .svg-canvas svg.svg-diagram');
                if (!viewer || !svg) return;
                const rect = viewer.getBoundingClientRect();
                const ax = previewSvgState._resizeAnchorX;
                const ay = previewSvgState._resizeAnchorY;
                if (ax !== undefined && ay !== undefined) {
                    previewSvgState.x = (rect.width / 2) - ax * previewSvgState.scale;
                    previewSvgState.y = (rect.height / 2) - ay * previewSvgState.scale;
                }
                previewSvgClampPan();
                previewSvgApplyTransform();
            }
        });
        makeDraggable('chat-header', 'chat-window');
        makeResizable('chat-window');

        function centerWindow(windowId, offsetX = 0, offsetY = 0) {
            const win = document.getElementById(windowId);
            if (!win) return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const rect = win.getBoundingClientRect();
            let left = (vw - rect.width) / 2 + offsetX;
            let top = (vh - rect.height) / 2 + offsetY;
            win.style.left = left + 'px';
            win.style.top = top + 'px';
            win.style.transform = 'none';
            clampWindowPosition(win);
        }

        // --- PREVIEW WINDOW ---
        let currentPreviewDocId = null;
        let currentPreviewDocumentId = null;
        let previewSvgState = { scale: 1, x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 };

        function openPreviewWindow(docId, documentId, docName) {
            const win = document.getElementById('preview-window');
            const filenameEl = document.getElementById('preview-filename');
            const wasHidden = win.classList.contains('hidden');

            currentPreviewDocId = docId;
            currentPreviewDocumentId = documentId;
            if (filenameEl) filenameEl.textContent = decodeURIComponent(docName);

            win.classList.remove('hidden');
            if (wasHidden) {
                const chatWin = document.getElementById('chat-window');
                if (chatWin && !chatWin.classList.contains('hidden')) {
                    centerWindow('preview-window', 0, 0);
                } else {
                    centerWindow('preview-window', 0, 0);
                }
            }
            bringToFront('preview-window');

            // Reset loader
            const loading = document.getElementById('preview-svg-loading');
            const canvas = document.querySelector('#preview-svg-viewer .svg-canvas');
            if (loading) loading.classList.remove('hidden');
            if (canvas) {
                canvas.innerHTML = '';
                canvas.classList.remove('flex', 'items-center', 'justify-center', 'h-full', 'text-gray-500');
            }
            previewSvgState = { scale: 1, x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 };
            loadPreviewSvg(`?visualize=${docId}`);
        }

        function closePreviewWindow() {
            const win = document.getElementById('preview-window');
            if (win) win.classList.add('hidden');
        }

        function loadPreviewSvg(url) {
            const canvas = document.querySelector('#preview-svg-viewer .svg-canvas');
            const loading = document.getElementById('preview-svg-loading');
            if (!canvas) return;

            fetch(url)
                .then(r => r.text())
                .then(svgText => {
                    const mainClassMatch = svgText.match(/data-main-class="([^"]*)"/);
                    const mainClassName = mainClassMatch ? mainClassMatch[1] : '';
                    svgText = svgText.replace(/style="background:#000000;"/g, 'style="background:#ffffff;"');
                    svgText = svgText.replace(/background:#000000/g, 'background:#ffffff');
                    svgText = svgText.replace(/<svg/, '<svg class="svg-diagram"');
                    if (loading) loading.classList.add('hidden');
                    canvas.innerHTML = svgText;
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => previewSvgCenterDiagram(mainClassName));
                    });
                })
                .catch(err => {
                    canvas.innerHTML = `<div class="text-red-500 text-sm p-4 flex items-center justify-center h-full">Erreur de chargement du diagramme.</div>`;
                    if (loading) loading.classList.add('hidden');
                    console.error(err);
                });
        }

        function previewSvgApplyTransform() {
            const canvas = document.querySelector('#preview-svg-viewer .svg-canvas');
            if (!canvas) return;
            previewSvgClampPan();
            canvas.style.transform = `translate(${previewSvgState.x}px, ${previewSvgState.y}px) scale(${previewSvgState.scale})`;
        }

        function previewSvgClampPan() {
            const viewer = document.getElementById('preview-svg-viewer');
            const svg = document.querySelector('#preview-svg-viewer .svg-canvas svg.svg-diagram');
            if (!viewer || !svg) return;

            const viewerRect = viewer.getBoundingClientRect();
            let bounds;
            try { bounds = svg.getBBox(); } catch (e) {
                bounds = { x: 0, y: 0, width: parseFloat(svg.getAttribute('width')) || viewerRect.width, height: parseFloat(svg.getAttribute('height')) || viewerRect.height };
            }
            if (!bounds || !bounds.width || !bounds.height) return;

            const maxOverflow = 60;
            const scaledWidth = bounds.width * previewSvgState.scale;
            const scaledHeight = bounds.height * previewSvgState.scale;
            const minScreenLeft = maxOverflow - scaledWidth;
            const maxScreenLeft = viewerRect.width - maxOverflow;
            const minScreenTop = maxOverflow - scaledHeight;
            const maxScreenTop = viewerRect.height - maxOverflow;

            const currentScreenLeft = previewSvgState.x + bounds.x * previewSvgState.scale;
            const currentScreenTop = previewSvgState.y + bounds.y * previewSvgState.scale;

            const clampedScreenLeft = Math.max(minScreenLeft, Math.min(maxScreenLeft, currentScreenLeft));
            const clampedScreenTop = Math.max(minScreenTop, Math.min(maxScreenTop, currentScreenTop));

            previewSvgState.x = clampedScreenLeft - bounds.x * previewSvgState.scale;
            previewSvgState.y = clampedScreenTop - bounds.y * previewSvgState.scale;
        }

        function previewSvgCenterDiagram(mainClassName = '') {
            const viewer = document.getElementById('preview-svg-viewer');
            const canvas = document.querySelector('#preview-svg-viewer .svg-canvas');
            const svg = canvas ? canvas.querySelector('svg.svg-diagram') : null;
            if (!viewer || !canvas || !svg) return;

            try { svg.getBBox(); } catch (e) {}
            const viewerRect = viewer.getBoundingClientRect();
            let targetX = 0, targetY = 0, targetWidth = 0, targetHeight = 0, foundMain = false;

            if (mainClassName) {
                const allGroups = svg.querySelectorAll('g');
                for (const ent of allGroups) {
                    const textEls = ent.querySelectorAll('text');
                    for (const textEl of textEls) {
                        if (textEl.textContent.trim() === mainClassName) {
                            try {
                                const bbox = ent.getBBox();
                                targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                                foundMain = true;
                                break;
                            } catch (e) {}
                        }
                    }
                    if (foundMain) break;
                }
                if (!foundMain) {
                    const texts = svg.querySelectorAll('text');
                    for (const textEl of texts) {
                        if (textEl.textContent.trim() === mainClassName) {
                            try {
                                const parent = textEl.closest('g') || textEl;
                                const bbox = parent.getBBox();
                                targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                                foundMain = true;
                                break;
                            } catch (e) {}
                        }
                    }
                }
            }

            if (!foundMain) {
                try {
                    const bbox = svg.getBBox();
                    targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                } catch (e) {
                    targetWidth = parseFloat(svg.getAttribute('width')) || viewerRect.width;
                    targetHeight = parseFloat(svg.getAttribute('height')) || viewerRect.height;
                }
            }

            previewSvgState.x = (viewerRect.width / 2) - (targetX + targetWidth / 2) * previewSvgState.scale;
            previewSvgState.y = (viewerRect.height / 2) - (targetY + targetHeight / 2) * previewSvgState.scale;
            previewSvgApplyTransform();
        }

        function previewSvgZoomIn() { previewSvgZoomAt(previewViewerCenterPoint(), 1.2); }
        function previewSvgZoomOut() { previewSvgZoomAt(previewViewerCenterPoint(), 1 / 1.2); }

        function previewViewerCenterPoint() {
            const viewer = document.getElementById('preview-svg-viewer');
            if (!viewer) return { x: 0, y: 0 };
            const rect = viewer.getBoundingClientRect();
            return { x: rect.width / 2, y: rect.height / 2 };
        }

        function previewSvgZoomAt(point, factor) {
            const newScale = Math.min(4, Math.max(0.2, previewSvgState.scale * factor));
            previewSvgState.x = point.x - (point.x - previewSvgState.x) * (newScale / previewSvgState.scale);
            previewSvgState.y = point.y - (point.y - previewSvgState.y) * (newScale / previewSvgState.scale);
            previewSvgState.scale = newScale;
            previewSvgClampPan();
            previewSvgApplyTransform();
        }

        function previewSvgResetZoom() {
            previewSvgState.scale = 0.95;
            previewSvgCenterDiagram();
        }

        function initPreviewSvgEvents() {
            const viewer = document.getElementById('preview-svg-viewer');
            if (!viewer) return;

            viewer.addEventListener('wheel', (e) => {
                const canvas = document.querySelector('#preview-svg-viewer .svg-canvas');
                if (!canvas) return;
                e.preventDefault();
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                const rect = viewer.getBoundingClientRect();
                previewSvgZoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, factor);
            }, { passive: false });

            viewer.addEventListener('mousedown', (e) => {
                if (e.target.closest('.svg-controls')) return;
                previewSvgState.isDragging = true;
                previewSvgState.lastX = e.clientX;
                previewSvgState.lastY = e.clientY;
                viewer.style.cursor = 'grabbing';
            });

            window.addEventListener('mousemove', (e) => {
                if (!previewSvgState.isDragging) return;
                const dx = e.clientX - previewSvgState.lastX;
                const dy = e.clientY - previewSvgState.lastY;
                previewSvgState.lastX = e.clientX;
                previewSvgState.lastY = e.clientY;
                previewSvgState.x += dx;
                previewSvgState.y += dy;
                previewSvgClampPan();
                previewSvgApplyTransform();
            });

            window.addEventListener('mouseup', () => {
                if (previewSvgState.isDragging) {
                    previewSvgState.isDragging = false;
                    viewer.style.cursor = '';
                    previewSvgClampPan();
                    previewSvgApplyTransform();
                }
            });
        }

        initPreviewSvgEvents();

        function showVisionHome() {
            const content = document.getElementById('right-pane-content');
            content.innerHTML = `
                <div id="vision-page-wrapper" class="px-4 sm:px-6 flex flex-col items-center text-center flex-shrink-0 z-20 bg-white transition-all duration-500 ease-out">
                    <h1 class="font-bold tracking-tight text-center text-black mb-2 mt-2">
                        <button type="button" class="interactive-title bg-transparent border-0 p-0" onclick="showVisionHome();" title="Retour à l'accueil Vision">
                            <span class="title-glow">Vision Sémantique</span>
                        </button>
                    </h1>
                    <div id="vision-import-container" class="w-full max-w-md">
                        <p class="text-base font-medium mb-6 text-center max-w-md mx-auto text-gray-500">Importez un fichier (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML) pour le visualiser sous forme de diagramme.</p>
                        <label id="vision-drop-zone" class="drop-zone flex flex-col items-center justify-center w-full max-w-md mx-auto py-10 px-6 cursor-pointer hover:border-gray-400">
                            <svg class="w-10 h-10 mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            <span class="text-sm font-semibold text-gray-700">Glissez-déposez un fichier ici</span>
                            <span class="text-xs text-gray-400 mt-1">ou cliquez pour parcourir</span>
                            <input type="file" id="vision-file-input" class="hidden" accept=".ttl,.xml,.xmi,.json,.jsonld,.sql,.txt,.html,.htm,.csv">
                        </label>
                    </div>
                </div>
                <template id="vision-viewer-template">
                    <div id="svg-viewer" class="svg-viewer">
                        <div id="svg-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
                            <svg class="animate-spin h-8 w-8 text-gray-400 mb-3" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span class="text-sm font-medium ml-3">Génération de la modélisation...</span>
                        </div>
                        <div class="svg-canvas" id="vision-svg-canvas"></div>
                        <div class="svg-controls">
                            <button class="svg-ctrl-btn" onclick="svgZoomIn()" title="Zoom avant">+</button>
                            <button class="svg-ctrl-btn" onclick="svgZoomOut()" title="Zoom arrière">−</button>
                            <button class="svg-ctrl-btn" onclick="svgResetZoom()" title="Réinitialiser">⟲</button>
                        </div>
                    </div>
                </template>`;
            bindTitleGlow();
            bindTagEvents();
            initVisionImport();
            applyVisionCentering();
            showPane('vision');
        }

        function showPane(pane) {
            activePane = pane;
            const leftPane = document.getElementById('left-pane');
            const rightPane = document.getElementById('right-pane');
            const content = document.getElementById('right-pane-content');
            const resizer = document.getElementById('split-resizer');
            const closeVision = document.getElementById('close-vision-pane');
            const tabSearch = document.getElementById('tab-search');
            const tabVision = document.getElementById('tab-vision');

            function setVisible(element, visible) {
                if (!element) return;
                if (visible) element.classList.remove('hidden');
                else element.classList.add('hidden');
            }

            function setActive(element, active) {
                if (!element) return;
                if (active) element.classList.add('active');
                else element.classList.remove('active');
            }

            function updateResizer(show) {
                if (!resizer) return;
                if (show) {
                    resizer.classList.remove('hidden');
                    resizer.classList.add('visible');
                } else {
                    resizer.classList.remove('visible');
                    resizer.classList.add('hidden');
                }
            }

            if (rightPane) rightPane.style.transition = 'none';
            if (leftPane) leftPane.style.transition = 'none';

            if (pane === 'search') {
                leftPane.classList.remove('hidden');
                leftPane.style.width = '100%';
                leftPane.style.flex = '1 1 100%';
                rightPane.classList.add('hidden');
                rightPane.style.width = '0%';
                rightPane.style.flex = '0 0 0%';
                setVisible(closeVision, false);
                updateResizer(false);
                setActive(tabSearch, true);
                setActive(tabVision, false);
            } else if (pane === 'vision') {
                leftPane.classList.add('hidden');
                leftPane.style.width = '0%';
                leftPane.style.flex = '0 0 0%';
                rightPane.classList.remove('hidden');
                rightPane.style.width = '100%';
                rightPane.style.flex = '1 1 100%';
                setVisible(closeVision, false);
                updateResizer(false);
                setActive(tabSearch, false);
                setActive(tabVision, true);
                // Always ensure the Vision panel shows something: empty import state if nothing else.
                if (!content.querySelector('#vision-page-wrapper') && !content.querySelector('#svg-viewer')) {
                    ensureVisionContent();
                }
                applyVisionCentering();
            } else if (pane === 'split') {
                // Split mode is no longer used for search preview, kept for compatibility
                leftPane.classList.remove('hidden');
                leftPane.style.width = '50%';
                leftPane.style.flex = '0 0 50%';
                rightPane.classList.remove('hidden');
                rightPane.style.width = '50%';
                rightPane.style.flex = '0 0 50%';
                setVisible(closeVision, true);
                updateResizer(true);
                setActive(tabSearch, true);
                setActive(tabVision, false);
                if (!content.querySelector('#vision-page-wrapper') && !content.querySelector('#svg-viewer')) {
                    ensureVisionContent();
                }
            }

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (rightPane) rightPane.style.transition = '';
                    if (leftPane) leftPane.style.transition = '';
                });
            });

            setTimeout(() => {
                const svgViewer = document.getElementById('svg-viewer');
                if (svgViewer) {
                    svgClampPan();
                    svgApplyTransform();
                } else {
                    previewSvgClampPan();
                    previewSvgApplyTransform();
                }
            }, 500);
        }

        function ensureVisionContent() {
            const content = document.getElementById('right-pane-content');
            if (!content.querySelector('#vision-page-wrapper') && !content.querySelector('#svg-viewer')) {
                content.innerHTML = `
                    <div id="vision-page-wrapper" class="px-4 sm:px-6 flex-1 flex flex-col items-center justify-center text-center overflow-y-auto">
                        <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8 mt-6">
                            <button type="button" class="interactive-title bg-transparent border-0 p-0" onclick="showVisionHome();" title="Retour à l'accueil Vision">
                                <span class="title-glow">Vision Sémantique</span>
                            </button>
                        </h1>
                <div id="vision-import-container" class="w-full max-w-md mb-8 transition-all duration-500 ease-out">
                            <p class="text-base font-medium mb-6 text-center max-w-md mx-auto text-gray-500">Importez un fichier (TTL, XMI/XML, JSON/JSON-LD, SQL, TXT, HTML) pour le visualiser sous forme de diagramme.</p>
                            <label id="vision-drop-zone" class="drop-zone flex flex-col items-center justify-center w-full max-w-md mx-auto py-10 px-6 cursor-pointer hover:border-gray-400">
                                <svg class="w-10 h-10 mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                                <span class="text-sm font-semibold text-gray-700">Glissez-déposez un fichier ici</span>
                                <span class="text-xs text-gray-400 mt-1">ou cliquez pour parcourir</span>
                                <input type="file" id="vision-file-input" class="hidden" accept=".ttl,.xml,.xmi,.json,.jsonld,.sql,.txt,.html,.htm,.csv">
                            </label>
                        </div>
                    </div>`;
                bindTitleGlow();
                bindTagEvents();
                initVisionImport();
                applyVisionCentering();
            } else {
                // If the empty state is present but no listener has been attached, hook it up.
                const dropZone = document.getElementById('vision-drop-zone');
                if (dropZone) initVisionImport();
            }
        }

        function closeVisionPane() {
            showPane('search');
        }

        // Backwards compatibility
        function toggleSearchPane() {
            if (activePane === 'split') showPane('vision');
            else showPane('split');
        }

        function closeSplitView() {
            showPane('search');
        }

        resizer.addEventListener('mousedown', (e) => {
            if (!rightPane) return;
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            // Disable transitions during drag to follow mouse instantly
            rightPane.style.transition = 'none';
            leftPane.style.transition = 'none';
            e.preventDefault();
        });

        // --- SVG INTERACTIVE VIEWER (VISION PANEL) ---
        let svgViewerState = { scale: 1, x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 };
        const SVG_MIN_ZOOM = 0.2;
        const SVG_MAX_ZOOM = 4;
        const SVG_DEFAULT_ZOOM = 1;

        function svgApplyTransform() {
            const canvas = document.getElementById('vision-svg-canvas');
            if (!canvas) {
                const fallback = document.querySelector('#svg-viewer .svg-canvas');
                if (!fallback) return;
                fallback.style.transform = `translate(${svgViewerState.x}px, ${svgViewerState.y}px) scale(${svgViewerState.scale})`;
                return;
            }
            svgClampPan();
            canvas.style.transform = `translate(${svgViewerState.x}px, ${svgViewerState.y}px) scale(${svgViewerState.scale})`;
        }

        function svgGetDiagramBounds() {
            const canvas = document.getElementById('vision-svg-canvas') || document.querySelector('#svg-viewer .svg-canvas');
            const svg = canvas ? canvas.querySelector('svg.svg-diagram') : null;
            if (!svg) return null;
            try {
                const bbox = svg.getBBox();
                return { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
            } catch (e) {
                const width = parseFloat(svg.getAttribute('width')) || 0;
                const height = parseFloat(svg.getAttribute('height')) || 0;
                return { x: 0, y: 0, width: width, height: height };
            }
        }

        function svgClampPan() {
            const viewer = document.getElementById('svg-viewer');
            const canvas = document.getElementById('vision-svg-canvas') || document.querySelector('#svg-viewer .svg-canvas');
            const svg = canvas ? canvas.querySelector('svg.svg-diagram') : null;
            if (!viewer || !svg) return;

            const viewerRect = viewer.getBoundingClientRect();
            let bounds;
            try { bounds = svg.getBBox(); } catch (e) {
                bounds = { x: 0, y: 0, width: parseFloat(svg.getAttribute('width')) || viewerRect.width, height: parseFloat(svg.getAttribute('height')) || viewerRect.height };
            }
            if (!bounds || !bounds.width || !bounds.height) return;

            const maxOverflow = 60;
            const scaledWidth = bounds.width * svgViewerState.scale;
            const scaledHeight = bounds.height * svgViewerState.scale;
            const minScreenLeft = maxOverflow - scaledWidth;
            const maxScreenLeft = viewerRect.width - maxOverflow;
            const minScreenTop = maxOverflow - scaledHeight;
            const maxScreenTop = viewerRect.height - maxOverflow;

            const currentScreenLeft = svgViewerState.x + bounds.x * svgViewerState.scale;
            const currentScreenTop = svgViewerState.y + bounds.y * svgViewerState.scale;

            const clampedScreenLeft = Math.max(minScreenLeft, Math.min(maxScreenLeft, currentScreenLeft));
            const clampedScreenTop = Math.max(minScreenTop, Math.min(maxScreenTop, currentScreenTop));

            svgViewerState.x = clampedScreenLeft - bounds.x * svgViewerState.scale;
            svgViewerState.y = clampedScreenTop - bounds.y * svgViewerState.scale;
        }

        function svgZoomIn() { svgZoomAt(viewerCenterPoint(), 1.2); }
        function svgZoomOut() { svgZoomAt(viewerCenterPoint(), 1 / 1.2); }

        function viewerCenterPoint() {
            const viewer = document.getElementById('svg-viewer');
            if (!viewer) return { x: 0, y: 0 };
            const rect = viewer.getBoundingClientRect();
            return { x: rect.width / 2, y: rect.height / 2 };
        }

        function svgZoomAt(point, factor) {
            const newScale = Math.min(SVG_MAX_ZOOM, Math.max(SVG_MIN_ZOOM, svgViewerState.scale * factor));
            svgViewerState.x = point.x - (point.x - svgViewerState.x) * (newScale / svgViewerState.scale);
            svgViewerState.y = point.y - (point.y - svgViewerState.y) * (newScale / svgViewerState.scale);
            svgViewerState.scale = newScale;
            svgClampPan();
            svgApplyTransform();
        }

        function svgResetZoom() {
            svgViewerState.scale = SVG_DEFAULT_ZOOM;
            svgCenterDiagram();
        }

        function svgCenterDiagram(mainClassName = '') {
            const viewer = document.getElementById('svg-viewer');
            const canvas = document.getElementById('vision-svg-canvas') || document.querySelector('#svg-viewer .svg-canvas');
            const svg = canvas ? canvas.querySelector('svg.svg-diagram') : null;
            if (!viewer || !canvas || !svg) return;

            try { svg.getBBox(); } catch (e) {}
            const viewerRect = viewer.getBoundingClientRect();
            let targetX = 0, targetY = 0, targetWidth = 0, targetHeight = 0, foundMain = false;

            if (mainClassName) {
                const allGroups = svg.querySelectorAll('g');
                for (const ent of allGroups) {
                    const textEls = ent.querySelectorAll('text');
                    for (const textEl of textEls) {
                        if (textEl.textContent.trim() === mainClassName) {
                            try {
                                const bbox = ent.getBBox();
                                targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                                foundMain = true;
                                break;
                            } catch (e) {}
                        }
                    }
                    if (foundMain) break;
                }
                if (!foundMain) {
                    const texts = svg.querySelectorAll('text');
                    for (const textEl of texts) {
                        if (textEl.textContent.trim() === mainClassName) {
                            try {
                                const parent = textEl.closest('g') || textEl;
                                const bbox = parent.getBBox();
                                targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                                foundMain = true;
                                break;
                            } catch (e) {}
                        }
                    }
                }
            }

            if (!foundMain) {
                try {
                    const bbox = svg.getBBox();
                    targetX = bbox.x; targetY = bbox.y; targetWidth = bbox.width; targetHeight = bbox.height;
                } catch (e) {
                    targetWidth = parseFloat(svg.getAttribute('width')) || viewerRect.width;
                    targetHeight = parseFloat(svg.getAttribute('height')) || viewerRect.height;
                }
            }

            if (targetWidth <= 0 || targetHeight <= 0) return;

            // Fixed scale like the floating preview window: classes keep the same
            // visual size regardless of diagram dimensions, and we simply center it.
            svgViewerState.scale = SVG_DEFAULT_ZOOM;
            svgViewerState.x = (viewerRect.width / 2) - (targetX + targetWidth / 2) * svgViewerState.scale;
            svgViewerState.y = (viewerRect.height / 2) - (targetY + targetHeight / 2) * svgViewerState.scale;
            svgApplyTransform();
        }

        // Attach SVG viewer events to the Vision panel (dynamically created #svg-viewer)
        function initSvgViewerEvents() {
            const content = document.getElementById('right-pane-content');
            if (!content) return;

            content.addEventListener('wheel', function(e) {
                const viewer = document.getElementById('svg-viewer');
                const canvas = viewer ? viewer.querySelector('.svg-canvas') : null;
                if (!viewer || !canvas) return;
                e.preventDefault();
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                const rect = viewer.getBoundingClientRect();
                svgZoomAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, factor);
            }, { passive: false });

            content.addEventListener('mousedown', function(e) {
                const viewer = document.getElementById('svg-viewer');
                if (!viewer) return;
                if (e.target.closest('.svg-controls')) return;
                svgViewerState.isDragging = true;
                svgViewerState.lastX = e.clientX;
                svgViewerState.lastY = e.clientY;
                viewer.style.cursor = 'grabbing';
            });

            window.addEventListener('mousemove', function(e) {
                const viewer = document.getElementById('svg-viewer');
                if (!svgViewerState.isDragging || !viewer) return;
                const dx = e.clientX - svgViewerState.lastX;
                const dy = e.clientY - svgViewerState.lastY;
                svgViewerState.lastX = e.clientX;
                svgViewerState.lastY = e.clientY;
                svgViewerState.x += dx;
                svgViewerState.y += dy;
                svgClampPan();
                svgApplyTransform();
            });

            window.addEventListener('mouseup', function() {
                const viewer = document.getElementById('svg-viewer');
                if (svgViewerState.isDragging) {
                    svgViewerState.isDragging = false;
                    if (viewer) viewer.style.cursor = '';
                    svgClampPan();
                    svgApplyTransform();
                }
            });
        }

        // Initialize SVG viewer drag / wheel events once, using event delegation for dynamically created viewer
        initSvgViewerEvents();

        // --- VISION IMPORT ---
        function initVisionImport() {
            const dropZone = document.getElementById('vision-drop-zone');
            const fileInput = document.getElementById('vision-file-input');
            if (!dropZone || !fileInput) return;

            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropZone.removeEventListener(eventName, preventDefaults, false);
                dropZone.addEventListener(eventName, preventDefaults, false);
            });

            ['dragenter', 'dragover'].forEach(eventName => {
                dropZone.removeEventListener(eventName, dropZone._addHover, false);
                dropZone.removeEventListener(eventName, dropZone._removeHover, false);
            });

            dropZone._addHover = () => dropZone.classList.add('drag-over');
            dropZone._removeHover = () => dropZone.classList.remove('drag-over');

            ['dragenter', 'dragover'].forEach(eventName => {
                dropZone.addEventListener(eventName, dropZone._addHover, false);
            });

            ['dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, dropZone._removeHover, false);
            });

            dropZone.removeEventListener('drop', dropZone._handleDrop, false);
            dropZone._handleDrop = (e) => {
                const dt = e.dataTransfer;
                const files = dt.files;
                if (files.length) handleVisionFile(files[0]);
            };
            dropZone.addEventListener('drop', dropZone._handleDrop, false);

            // Replace input element to guarantee a fresh change listener after re-render
            const freshInput = fileInput.cloneNode(true);
            fileInput.parentNode.replaceChild(freshInput, fileInput);
            freshInput.addEventListener('change', (e) => {
                if (e.target.files.length) handleVisionFile(e.target.files[0]);
            });
        }

        function handleVisionFile(file) {
            // Move the Vision page wrapper to the top (like search) before showing the viewer.
            const visionWrapper = document.getElementById('vision-page-wrapper');
            if (visionWrapper) {
                visionWrapper.classList.remove('vision-centered');
                visionWrapper.classList.add('vision-top');
                visionWrapper.style.justifyContent = 'flex-start';
            }
            const importContainer = document.getElementById('vision-import-container');
            if (importContainer) importContainer.classList.add('vision-import-hidden');

            // Remove any previously injected SVG viewer before adding a new one.
            const content = document.getElementById('right-pane-content');
            const existingViewer = content.querySelector('#svg-viewer');
            if (existingViewer) existingViewer.remove();

            const tmpl = document.getElementById('vision-viewer-template');
            console.log('[Vision import] template element=', tmpl, 'content=', content ? content.tagName : null);
            if (tmpl) {
                const viewerDiv = tmpl.content.cloneNode(true);
                content.appendChild(viewerDiv);
                console.log('[Vision import] injected viewer template');
            } else {
                console.error('[Vision import] vision-viewer-template not found');
                // Fallback: build the viewer markup directly
                content.innerHTML = `
                    <div id="svg-viewer" class="svg-viewer">
                        <div id="svg-loading" class="absolute inset-0 flex items-center justify-center text-gray-500 z-10">
                            <svg class="animate-spin h-8 w-8 text-gray-400 mb-3" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span class="text-sm font-medium ml-3">Génération de la modélisation...</span>
                        </div>
                        <div class="svg-canvas" id="vision-svg-canvas"></div>
                        <div class="svg-controls">
                            <button class="svg-ctrl-btn" onclick="svgZoomIn()" title="Zoom avant">+</button>
                            <button class="svg-ctrl-btn" onclick="svgZoomOut()" title="Zoom arrière">−</button>
                            <button class="svg-ctrl-btn" onclick="svgResetZoom()" title="Réinitialiser">⟲</button>
                        </div>
                    </div>`;
            }
            showPane('vision');

            let canvas = document.getElementById('vision-svg-canvas');
            let loading = document.getElementById('svg-loading');

            console.log('[Vision import] after showPane, canvas=', canvas, 'loading=', loading);

            if (loading) loading.classList.remove('hidden');
            if (canvas) {
                canvas.innerHTML = '';
                canvas.classList.remove('flex', 'items-center', 'justify-center', 'h-full', 'text-gray-500');
            }
            svgViewerState = { scale: 1, x: 0, y: 0, isDragging: false, lastX: 0, lastY: 0 };

            const formData = new FormData();
            formData.append('file', file);

            fetch('?import=1', { method: 'POST', body: formData })
                .then(r => {
                    console.log('[Vision import] response status', r.status);
                    if (!r.ok) throw new Error(`Import failed (${r.status})`);
                    return r.text();
                })
                .then(svgText => {
                    console.log('[Vision import] received SVG length', svgText.length);
                    const mainClassMatch = svgText.match(/data-main-class="([^"]*)"/);
                    const mainClassName = mainClassMatch ? mainClassMatch[1] : '';
                    svgText = svgText.replace(/style="background:#000000;"/g, 'style="background:#ffffff;"');
                    svgText = svgText.replace(/background:#000000/g, 'background:#ffffff');
                    svgText = svgText.replace(/<svg/, '<svg class="svg-diagram"');

                    if (loading) loading.classList.add('hidden');
                    if (canvas) {
                        canvas.innerHTML = svgText;
                        console.log('[Vision import] SVG injected into canvas');
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => svgCenterDiagram(mainClassName));
                        });
                    } else {
                        console.error('[Vision import] canvas not found after fetch');
                    }
                })
                .catch(err => {
                    console.error('[Vision import] error', err);
                    canvas = document.getElementById('vision-svg-canvas');
                    loading = document.getElementById('svg-loading');
                    if (loading) loading.classList.add('hidden');
                    if (canvas) canvas.innerHTML = `<div class="text-red-500 text-sm p-4 flex items-center justify-center h-full">Erreur d'import : ${err.message}</div>`;
                });
        }

        initVisionImport();

        document.addEventListener('mousemove', (e) => {
            if (!isResizing || !rightPane || !leftPane) return;
            const totalWidth = window.innerWidth;
            let newWidth = totalWidth - e.clientX;
            // Boundaries
            if (newWidth < 300) newWidth = 300; 
            if (totalWidth - newWidth < 400) newWidth = totalWidth - 400; 
            rightPane.style.width = newWidth + 'px';
            leftPane.style.width = (totalWidth - newWidth) + 'px';
            leftPane.style.flex = '0 0 ' + (totalWidth - newWidth) + 'px';
            rightPane.style.flex = '0 0 ' + newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                // Restore transition for close animation
                rightPane.style.transition = '';
                leftPane.style.transition = '';
            }
        });


        // --- CHAT LOGIC ---
        let currentChatDocId = null;
        let chatHistory = [];
        let autoScrollEnabled = true;

        function isNearBottom(container, threshold = 60) {
            return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
        }

        document.getElementById('chat-messages').addEventListener('scroll', function() {
            const wasEnabled = autoScrollEnabled;
            autoScrollEnabled = isNearBottom(this);

            if (autoScrollEnabled && !wasEnabled) {
                const activeLoadingEl = this.querySelector('[id^="loading-"]:last-child');
                const userMsgEl = this.querySelector('.user-msg-anchor:last-of-type');
                if (activeLoadingEl && userMsgEl) {
                    const visibleBlockHeight = (activeLoadingEl.offsetTop + activeLoadingEl.offsetHeight) - userMsgEl.offsetTop;
                    const remaining = Math.max(0, this.clientHeight - visibleBlockHeight - 20);
                    this.style.paddingBottom = remaining + 'px';
                } else {
                    this.style.paddingBottom = '0px';
                }
            }
        });

        (function() {
            const vw = window.innerWidth;
            wrapper.style.maxWidth = (vw <= 1440 ? Math.min(690, vw * 0.82) : 768) + 'px';
        })();

        function applyCentering() {
            if (!IS_CENTERED) {
                wrapper.style.paddingTop = '2rem';
                wrapper.style.paddingBottom = '2rem';
                return;
            }
            const pad = Math.max(48, (window.innerHeight - wrapper.offsetHeight) / 2 - 60);
            wrapper.style.paddingTop = pad + 'px';
            wrapper.style.paddingBottom = pad + 'px';
        }

        function applyVisionCentering() {
            const visionWrapper = document.getElementById('vision-page-wrapper');
            if (!visionWrapper) return;
            const content = document.getElementById('right-pane-content');
            const importContainer = document.getElementById('vision-import-container');
            if (visionWrapper.classList.contains('vision-top')) {
                visionWrapper.style.paddingTop = '0';
                visionWrapper.style.paddingBottom = '0';
                if (importContainer) importContainer.classList.add('vision-import-hidden');
            } else {
                visionWrapper.classList.remove('vision-top');
                if (importContainer) importContainer.classList.remove('vision-import-hidden');
                // Center the wrapper vertically in the available space
                const pad = Math.max(48, (content.clientHeight - visionWrapper.offsetHeight) / 2 - 60);
                visionWrapper.style.paddingTop = pad + 'px';
                visionWrapper.style.paddingBottom = pad + 'px';
            }
        }

        wrapper.style.transition = 'none';
        applyCentering();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                wrapper.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
            });
        });

        let _timerInterval = null;
        function startTimer() {
            const el = document.getElementById('elapsed-timer');
            if (!el) return;
            let s = 0;
            el.textContent = '0s';
            _timerInterval = setInterval(() => { el.textContent = (++s) + 's'; }, 1000);
        }
        function stopTimer() {
            clearInterval(_timerInterval);
            _timerInterval = null;
            const el = document.getElementById('elapsed-timer');
            if (el) el.textContent = '';
        }

        function openChat(docId, docName) {
            currentChatDocId = docId; 
            const win = document.getElementById('chat-window');
            const filenameEl = document.getElementById('chat-filename');
            const wasHidden = win.classList.contains('hidden');
            const decodedName = decodeURIComponent(docName);
            if (filenameEl) filenameEl.textContent = decodedName;

            win.classList.remove('hidden');
            if (wasHidden) {
                const previewWin = document.getElementById('preview-window');
                if (previewWin && !previewWin.classList.contains('hidden')) {
                    centerWindow('chat-window', 30, -30);
                } else {
                    centerWindow('chat-window', 0, 0);
                }
            }
            bringToFront('chat-window');
        }

        function closeChatWindow() {
            const win = document.getElementById('chat-window');
            if (win) win.classList.add('hidden');
        }

        let loadingAnimInterval = null;

        const magicSvgTemplate = `
            <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
            </svg>
        `;

        function scrollToBottomIfNeeded(container) {
            // Handled natively by our padding trick now
        }

        function handleChatSubmit() {
            const input = document.getElementById('ai-chat-input');
            const messagesContainer = document.getElementById('chat-messages');
            const text = input.value.trim();
            if (!text || !currentChatDocId) return;

            document.querySelectorAll('.sparkle-container').forEach(container => {
                container.classList.remove('trigger-magic');
                container.style.transition = 'opacity 0.3s ease, height 0.3s ease, margin 0.3s ease';
                container.style.opacity = '0';
                setTimeout(() => { container.style.display = 'none'; }, 300);
            });

            messagesContainer.insertAdjacentHTML('beforeend', `
                <div class="flex items-end justify-end mb-8 user-msg-anchor">
                    <div class="bg-gray-50 border border-gray-100 text-gray-900 px-5 py-3.5 rounded-[1.5rem] text-sm max-w-[80%] leading-relaxed">
                        ${text}
                    </div>
                </div>
            `);
            const userMsgEl = messagesContainer.lastElementChild;
            input.value = '';

            const loadingId = 'loading-' + Date.now();
            messagesContainer.insertAdjacentHTML('beforeend', `
                <div id="${loadingId}" class="flex flex-col items-start gap-3 mb-8">
                    <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body message-content"></div>
                    <div class="flex items-center gap-2">
                        <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container ai-avatar-wrapper trigger-magic">
                            ${magicSvgTemplate}
                        </div>
                        <span class="thinking-label text-xs font-bold tracking-widest uppercase text-gray-400" style="animation: textPulse 1.5s ease-in-out infinite;">Réflexion...</span>
                    </div>
                </div>
            `);

            requestAnimationFrame(() => {
                const loadingEl = document.getElementById(loadingId);
                const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                messagesContainer.style.paddingBottom = remaining + 'px';

                requestAnimationFrame(() => {
                    userMsgEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });

            const messageContent = document.querySelector(`#${loadingId} .message-content`);
            const loadingAvatar = document.querySelector(`#${loadingId} .ai-avatar-wrapper`);
            const thinkingLabel = document.querySelector(`#${loadingId} .thinking-label`);

            loadingAnimInterval = setInterval(() => {
                if (loadingAvatar) {
                    loadingAvatar.classList.remove('trigger-magic');
                    void loadingAvatar.offsetWidth;
                    loadingAvatar.classList.add('trigger-magic');
                }
            }, 1200);

            const userText = text;
            const historySnapshot = chatHistory.slice();
            let fullResponse = '';
            let displayedText = '';
            let streamBuffer = '';
            let firstChunkReceived = false;

            const typewriterInterval = setInterval(() => {
                if (streamBuffer.length > 0) {
                    const chunkSize = Math.min(1 + Math.floor(Math.random() * 4), streamBuffer.length);
                    displayedText += streamBuffer.slice(0, chunkSize);
                    streamBuffer = streamBuffer.slice(chunkSize);
                    messageContent.innerHTML = marked.parse(displayedText);

                    const loadingEl = document.getElementById(loadingId);
                    if (loadingEl && autoScrollEnabled) {
                        const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                        const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                        messagesContainer.style.paddingBottom = remaining + 'px';
                    }
                }
            }, 20);

            fetch('api/chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    document_id: currentChatDocId,
                    user_message: userText,
                    history: historySnapshot
                })
            }).then(async (response) => {
                if (!response.ok || !response.body) {
                    throw new Error('Erreur serveur ' + response.status);
                }
                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunkText = decoder.decode(value, { stream: true });
                    if (chunkText) {
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            if (thinkingLabel) thinkingLabel.remove();
                        }
                        fullResponse += chunkText;
                        streamBuffer += chunkText;
                    }
                }

                await new Promise(resolve => {
                    const checkDrain = setInterval(() => {
                        if (streamBuffer.length === 0) {
                            clearInterval(checkDrain);
                            resolve();
                        }
                    }, 30);
                });

                clearInterval(typewriterInterval);
                chatHistory.push({ role: 'user', content: userText });
                chatHistory.push({ role: 'assistant', content: fullResponse });
                clearInterval(loadingAnimInterval);

                requestAnimationFrame(() => {
                    const loadingEl = document.getElementById(loadingId);
                    if (loadingEl && autoScrollEnabled) {
                        const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                        const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                        messagesContainer.style.paddingBottom = remaining + 'px';
                    }
                });

            }).catch((error) => {
                console.error('Erreur chat stream:', error);
                clearInterval(typewriterInterval);
                if (thinkingLabel) thinkingLabel.remove();
                messageContent.innerHTML += `<br><em>Erreur : ${error.message}</em>`;
                clearInterval(loadingAnimInterval);
            });
        }

        const executeSearch = async (form) => {
            try {
                const formData = new FormData(form);
                const response = await fetch('?', {
                    method: 'POST',
                    body: formData,
                    headers: { 'fetch-mode': 'ajax' }
                });

                if (response.ok) {
                    const data = await response.json();

                    const resultsContainer = document.getElementById('results-container');
                    resultsContainer.innerHTML = data.results_html;
                    document.getElementById('tags-container').innerHTML = data.tags_html;

                    resultsContainer.classList.remove('results-hiding');
                    resultsContainer.style.display = '';
                    resultsContainer.style.visibility = '';

                    IS_CENTERED = data.is_centered;
                    applyCentering();

                    document.getElementById('search-wrapper').classList.remove('loading');
                    const btn = document.getElementById('submit-btn');
                    btn.classList.remove('loading');
                    btn.disabled = false;
                    btn.style.width = 'auto';
                    btn.innerHTML = `<span class="btn-label">Chercher</span>`;

                    stopTimer();
                    document.getElementById('loading-indicator').classList.remove('visible');

                    document.querySelectorAll('.result-item').forEach((el, i) => {
                        setTimeout(() => { el.classList.add('visible'); }, i * 80);
                    });

                    bindTagEvents();
                } else {
                    throw new Error("Erreur serveur " + response.status);
                }
            } catch (error) {
                console.error("Erreur de requête:", error);
                stopTimer();
                const indicator = document.getElementById('loading-indicator');
                indicator.innerHTML = '<span class="text-sm font-bold tracking-widest uppercase text-red-500">⏳ Délai dépassé (Timeout). Veuillez relancer la recherche.</span>';
                indicator.style.animation = 'none';

                document.getElementById('search-wrapper').classList.remove('loading');
                const btn = document.getElementById('submit-btn');
                btn.classList.remove('loading');
                btn.disabled = false;
                btn.style.width = 'auto';
                btn.innerHTML = `<span class="btn-label">Chercher</span>`;
            }
        };

        document.getElementById('search-form').addEventListener('submit', function(e) {
            e.preventDefault();
            const form = this;
            const resultsContainer = document.getElementById('results-container');
            const hasResults = resultsContainer.innerHTML.trim().length > 0;

            document.body.style.overflow = '';
            wrapper.style.paddingTop = '2rem';
            wrapper.style.paddingBottom = '2rem';

            const triggerSubmit = () => {
                const indicator = document.getElementById('loading-indicator');
                indicator.innerHTML = `<span class="text-xs font-bold tracking-widest uppercase text-gray-400">Recherche en cours</span><span id="elapsed-timer"></span>`;
                indicator.style.animation = '';
                indicator.classList.add('visible');
                startTimer();

                document.getElementById('search-wrapper').classList.add('loading');

                const btn = document.getElementById('submit-btn');
                btn.style.setProperty('--glow-size', '0px');
                btn.disabled = true;

                const ghost = btn.cloneNode(false);
                ghost.style.cssText = 'position:absolute;visibility:hidden;width:auto;pointer-events:none;';
                ghost.innerHTML = `<span class="dot-btn">.</span><span class="dot-btn">.</span><span class="dot-btn">.</span>`;
                document.body.appendChild(ghost);
                const targetWidth = ghost.offsetWidth + 'px';
                document.body.removeChild(ghost);

                btn.style.width = btn.offsetWidth + 'px';
                btn.innerHTML = `<span class="btn-label leaving">Chercher</span>`;

                setTimeout(() => {
                    btn.innerHTML = `<span class="btn-label">
                        <span class="dot-btn">.</span>
                        <span class="dot-btn">.</span>
                        <span class="dot-btn">.</span>
                    </span>`;
                    requestAnimationFrame(() => { btn.style.width = targetWidth; });
                    setTimeout(() => { btn.classList.add('loading'); }, 50);
                    requestAnimationFrame(() => { requestAnimationFrame(() => { executeSearch(form); }); });
                }, 150);
            };

            const fadeOutThenSubmit = () => {
                if (!hasResults) { triggerSubmit(); return; }
                resultsContainer.classList.add('results-hiding');
                resultsContainer.addEventListener('animationend', () => {
                    resultsContainer.style.visibility = 'hidden';
                    resultsContainer.style.display = 'none';
                    triggerSubmit();
                }, { once: true });
            };

            if (hasResults) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                const onScrollEnd = () => {
                    if (window.scrollY <= 5) {
                        window.removeEventListener('scroll', onScrollEnd);
                        clearTimeout(fallback);
                        fadeOutThenSubmit();
                    }
                };
                const fallback = setTimeout(() => {
                    window.removeEventListener('scroll', onScrollEnd);
                    fadeOutThenSubmit();
                }, 600);
                window.addEventListener('scroll', onScrollEnd);
            } else {
                if (IS_CENTERED) {
                    wrapper.addEventListener('transitionend', fadeOutThenSubmit, { once: true });
                } else {
                    fadeOutThenSubmit();
                }
            }
        });

        function bindTitleGlow() {
            document.querySelectorAll('.interactive-title').forEach(title => {
                const glow = title.querySelector('.title-glow');
                if (!glow) return;
                title.addEventListener('mousemove', (e) => {
                    const rect = title.getBoundingClientRect();
                    glow.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                    glow.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
                });
                title.addEventListener('mouseenter', () => { glow.style.setProperty('--glow-size', '55px'); });
                title.addEventListener('mouseleave', () => { glow.style.setProperty('--glow-size', '0px'); });
            });
        }
        bindTitleGlow();

        const submitBtn = document.getElementById('submit-btn');

        if (submitBtn) {
            submitBtn.addEventListener('mousemove', (e) => {
                const rect = submitBtn.getBoundingClientRect();
                submitBtn.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                submitBtn.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
            });
            submitBtn.addEventListener('mouseenter', () => { submitBtn.style.setProperty('--glow-size', '30px'); });
            submitBtn.addEventListener('mouseleave', () => { submitBtn.style.setProperty('--glow-size', '0px'); });
        }

        function bindTagEvents() {
            document.querySelectorAll('.tag-label').forEach(label => {
                const span = label.querySelector('span');
                if (!span) return;
                label.addEventListener('mousemove', (e) => {
                    const rect = span.getBoundingClientRect();
                    span.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                    span.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
                });
                label.addEventListener('mouseenter', () => { span.style.setProperty('--glow-size', '30px'); });
                label.addEventListener('mouseleave', () => { span.style.setProperty('--glow-size', '0px'); });
            });

            document.querySelectorAll('.magic-btn').forEach(btn => {
                btn.addEventListener('mousemove', (e) => {
                    const rect = btn.getBoundingClientRect();
                    btn.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                    btn.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
                });
                btn.addEventListener('mouseenter', () => { btn.style.setProperty('--glow-size', '40px'); });
                btn.addEventListener('mouseleave', () => { btn.style.setProperty('--glow-size', '0px'); });
            });
        }

        bindTagEvents();

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.querySelectorAll('.result-item').forEach((el, i) => {
                    setTimeout(() => { el.classList.add('visible'); }, i * 80);
                });
            });
        });
    </script>
</body>
</html>
"""


@app.api_route("/{path:path}", methods=["GET", "POST"])
async def serve_page(request: Request):

    download_id = request.query_params.get("download")
    if download_id:
        return await fetch_document_file_from_mcp(download_id)

    visualize_id = request.query_params.get("visualize")
    if visualize_id:
        doc_response = await fetch_document_file_from_mcp(visualize_id)
        if not isinstance(doc_response, Response) or doc_response.status_code != 200:
            return doc_response

        try:
            file_bytes = doc_response.body
            disposition = doc_response.headers.get("Content-Disposition", "")
            filename = _extract_filename_from_disposition(disposition)

            from data_model_utils import (
                _detect_file_type,
                generate_visualisation,
                xml_to_json,
                ttl_to_json,
                json_file_to_model,
                sql_to_model,
                text_to_model,
            )
            from io import BytesIO

            kind = _detect_file_type(file_bytes, filename)
            if not kind and filename:
                # Fallback: try to detect from filename suffix even if disposition parsing failed
                import os
                _, ext = os.path.splitext(filename.lower())
                if ext == ".ttl":
                    kind = "ttl"
                elif ext in (".xml", ".xmi"):
                    kind = "xml"
                elif ext in (".json", ".jsonld"):
                    kind = "json"
                elif ext == ".sql":
                    kind = "sql"
                elif ext in (".txt", ".html", ".htm", ".csv"):
                    kind = "text"

            if kind in {"xml", "xmi"}:
                json_data = xml_to_json(BytesIO(file_bytes))
            elif kind == "ttl":
                json_data = ttl_to_json(BytesIO(file_bytes))
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "json":
                json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "sql":
                json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "text":
                json_data = text_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            else:
                return HTMLResponse("<h3>Format non supporté pour la modélisation.</h3>", status_code=400)

            svg_result = generate_visualisation(json_data)

            svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
            svg_text = svg_bytes.decode("utf-8", errors="replace")
            # Normalize background to white for the interactive viewer ( PlantUML sometimes emits #000000 or #FFFFFF )
            svg_text = re.sub(r'style="([^"]*)background:#000000([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
            svg_text = re.sub(r"style='([^']*)background:#000000([^']*)'", r"style='\1background:#ffffff\2'", svg_text, flags=re.IGNORECASE)
            svg_text = re.sub(r'style="([^"]*)background:#FFFFFF([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
            # Ensure a white background even if no style is present
            if "<svg" in svg_text and "background:" not in svg_text:
                svg_text = svg_text.replace("<svg", '<svg style="background:#ffffff;"', 1)

            # Determine the "root" class to center on: first uml:Class whose package is the root package
            main_class_name = ""
            root_pkg_id = ""
            for elem in json_data.get("elements", []):
                if _safe_text(elem.get("type")) == "uml:Package" and not root_pkg_id:
                    root_pkg_id = _safe_text(elem.get("ID"))
            for elem in json_data.get("elements", []):
                if _safe_text(elem.get("type")) == "uml:Class" and _safe_text(elem.get("package")) == root_pkg_id:
                    main_class_name = _safe_text(elem.get("name"))
                    break
            if main_class_name and "<svg" in svg_text:
                # Inject a data attribute on the root SVG so the frontend can center on this class name
                svg_text = svg_text.replace("<svg", f'<svg data-main-class="{_escape_xml_attr(main_class_name)}"', 1)

            return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
        except Exception as e:
            import traceback
            traceback.print_exc()
            return HTMLResponse(f"<h3>Erreur de visualisation : {e}</h3>", status_code=500)

    # --- Vision import endpoint (no MCP upload, just visualize) ---
    import_id = request.query_params.get("import")
    if import_id is not None and request.method == "POST":
        try:
            form = await request.form()
            uploaded = form.get("file")
            if not uploaded or not hasattr(uploaded, "filename"):
                return HTMLResponse("Aucun fichier fourni.", status_code=400)

            file_bytes = await uploaded.read()
            filename = uploaded.filename or "document.txt"

            from data_model_utils import (
                _detect_file_type,
                generate_visualisation,
                xml_to_json,
                ttl_to_json,
                json_file_to_model,
                sql_to_model,
                text_to_model,
            )
            from io import BytesIO

            kind = _detect_file_type(file_bytes, filename)
            if not kind and filename:
                _, ext = os.path.splitext(filename.lower())
                if ext == ".ttl":
                    kind = "ttl"
                elif ext in (".xml", ".xmi"):
                    kind = "xml"
                elif ext in (".json", ".jsonld"):
                    kind = "json"
                elif ext == ".sql":
                    kind = "sql"
                elif ext in (".txt", ".html", ".htm", ".csv"):
                    kind = "text"

            if kind in {"xml", "xmi"}:
                json_data = xml_to_json(BytesIO(file_bytes))
            elif kind == "ttl":
                json_data = ttl_to_json(BytesIO(file_bytes))
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "json":
                json_data = json_file_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "sql":
                json_data = sql_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            elif kind == "text":
                json_data = text_to_model(BytesIO(file_bytes), filename=filename)
                if isinstance(json_data.get("xmi"), dict):
                    json_data = json_data["xmi"]
            else:
                return HTMLResponse("<h3>Format non supporté pour la modélisation.</h3>", status_code=400)

            svg_result = generate_visualisation(json_data)
            svg_bytes = svg_result.getvalue() if hasattr(svg_result, "getvalue") else svg_result
            svg_text = svg_bytes.decode("utf-8", errors="replace")
            svg_text = re.sub(r'style="([^"]*)background:#000000([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
            svg_text = re.sub(r"style='([^']*)background:#000000([^']*)'", r"style='\1background:#ffffff\2'", svg_text, flags=re.IGNORECASE)
            svg_text = re.sub(r'style="([^"]*)background:#FFFFFF([^"]*)"', r'style="\1background:#ffffff\2"', svg_text, flags=re.IGNORECASE)
            if "<svg" in svg_text and "background:" not in svg_text:
                svg_text = svg_text.replace("<svg", '<svg style="background:#ffffff;"', 1)

            main_class_name = ""
            root_pkg_id = ""
            for elem in json_data.get("elements", []):
                if _safe_text(elem.get("type")) == "uml:Package" and not root_pkg_id:
                    root_pkg_id = _safe_text(elem.get("ID"))
            for elem in json_data.get("elements", []):
                if _safe_text(elem.get("type")) == "uml:Class" and _safe_text(elem.get("package")) == root_pkg_id:
                    main_class_name = _safe_text(elem.get("name"))
                    break
            if main_class_name and "<svg" in svg_text:
                svg_text = svg_text.replace("<svg", f'<svg data-main-class="{_escape_xml_attr(main_class_name)}"', 1)

            return Response(content=svg_text.encode("utf-8"), media_type="image/svg+xml")
        except Exception as e:
            import traceback
            traceback.print_exc()
            return HTMLResponse(f"<h3>Erreur d'import : {e}</h3>", status_code=500)

    query = ""
    selected_tags = []

    if request.method == "POST":
        try:
            form_data = await request.form()
            query = str(form_data.get("q", "")).strip()
            selected_tags = form_data.getlist("t")
        except Exception as e:
            print(f"[Erreur form] {e}")

    tags_data = await fetch_tags_from_mcp()

    results_data = []
    if query:
        results_data = await fetch_search_from_mcp(query, selected_tags)

    is_ajax = request.headers.get("fetch-mode") == "ajax"

    if results_data == "TIMEOUT":
        if is_ajax:
            return JSONResponse({"error": "Timeout Backend"}, status_code=504)
        return HTMLResponse("Timeout Backend", status_code=504)

    tags_html = ""
    if not tags_data:
        tags_html = '<span class="text-gray-500 font-medium text-sm">Aucune source disponible.</span>'
    else:
        for t in tags_data:
            tag_name = t.get("tag", t) if isinstance(t, dict) else str(t)
            is_checked = "checked" if tag_name in selected_tags else ""

            tags_html += f"""
            <label class="cursor-pointer select-none tag-label">
                <input type="checkbox" name="t" value="{tag_name}" class="peer hidden" {is_checked}>
                <span class="inline-flex items-center rounded-full font-bold border-2 border-gray-200 text-gray-700 peer-checked:bg-black peer-checked:text-white peer-checked:border-black hover:border-gray-400 transition-colors">
                    <svg class="icon-unchecked w-3.5 h-3.5 mr-1.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                    <svg class="icon-checked w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"></path></svg>
                    {tag_name}
                </span>
            </label>
            """

    results_html = ""
    is_centered_bool = not bool(query)

    if query and not results_data:
        results_html = """
        <div class="text-center py-20 text-black font-bold text-lg">
            <p>Aucun document ne correspond à cette recherche.</p>
        </div>
        """
    elif query and results_data:
        results_html = f'<p id="results-header" class="text-sm font-bold text-gray-500 mb-8 border-b-2 border-gray-200 pb-4">{len(results_data)} RÉSULTAT(S)</p>'

        for i, row in enumerate(results_data):
            if not isinstance(row, (list, tuple)) or len(row) < 6:
                continue

            filename = str(row[0])
            summary = str(row[2])
            chunk0_id = str(row[3])
            score = f"{float(row[4]):.4f}"
            doc_tags = row[5] if isinstance(row[5], list) else []
            document_id = row[6]

            tags_badges = " • ".join(doc_tags) if doc_tags else "Aucun tag"

            preview = summary
            if len(preview) > 600:
                preview = preview[:600] + "..."

            preview = normalize_latex(preview)

            preview_html = markdown.markdown(preview)
            safe_filename = urllib.parse.quote(filename)

            results_html += f"""
            <div class="py-8 border-b border-gray-200 last:border-0 result-item">
                <h3 class="text-xl font-bold mb-3">
                    <a href="{safe_filename}?download={chunk0_id}" target="_blank" class="text-black hover:text-blue-600 hover:underline transition-colors" title="Ouvrir le document">
                        {filename}
                    </a>
                </h3>
                <div class="text-base text-gray-800 font-medium leading-relaxed mb-4 markdown-body">
                    {preview_html}
                </div>

                <div class="flex items-end justify-between">
                    <div class="flex flex-wrap gap-4 text-sm font-bold text-gray-500">
                        <span title="Score de pertinence">Score: {score}</span>
                        <span>Source: {tags_badges}</span>
                        <span class="font-mono text-xs mt-0.5" title="{document_id}">ID: {str(document_id)[:8]}...</span>
                    </div>

                    <div class="flex gap-2">
                        <!-- Preview Button (Eye Icon) -->
                        <button onclick="openPreviewWindow('{chunk0_id}', '{document_id}', '{safe_filename}')" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-500 hover:text-black focus:outline-none transition-colors" title="Aperçu rapide">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </button>

                        <!-- Chat Button (Sparkle Icon) -->
                        <button onclick="openChat('{document_id}', '{safe_filename}')" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-400 hover:text-black focus:outline-none" title="Analyser avec l'IA">
                            <svg class="magic-svg w-5 h-5" viewBox="0 0 24 24">
                                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
            """

    if is_ajax:
        return JSONResponse({
            "results_html": results_html,
            "tags_html": tags_html,
            "is_centered": is_centered_bool
        })

    final_page = HTML_TEMPLATE.replace("{{query_value}}", query.replace('"', '&quot;'))
    final_page = final_page.replace("{{tags_html}}", tags_html)
    final_page = final_page.replace("{{results_html}}", results_html)
    final_page = final_page.replace("{{is_centered}}", "true" if is_centered_bool else "false")

    return HTMLResponse(content=final_page)


if __name__ == "__main__":
    import uvicorn
    print("=" * 60, flush=True)
    print("Serveur Web SSR (Multi-instances) démarré (Port 8000)", flush=True)
    print("=" * 60, flush=True)
    uvicorn.run("web_app:app", host="0.0.0.0", port=8000, workers=4)
