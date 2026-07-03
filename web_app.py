import asyncio
import base64
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
_LLM_API_KEY = os.getenv("LLM_API_KEY", "")
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


def normalize_latex(text: str) -> str:
    for latex, uni in LATEX_TO_UNICODE.items():
        text = text.replace(f'${latex}$', uni)
        text = text.replace(latex, uni)
    import re
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
        html, body { height: 100%; scrollbar-gutter: stable; }

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

        .user-msg-anchor {
            scroll-margin-top: 2px;
        }

        .magic-btn {
            position: relative;
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(0,0,0,0.1) 0%, transparent 100%);
            transition: background-color 0.2s, transform 0.1s, --glow-size 0.25s ease;
        }
        .magic-btn:active { transform: scale(0.95); }

        .sparkle-main {
            transform-origin: center;
            transform-box: fill-box;
            fill: currentColor;
        }

        .sparkle-orbit-path {
            transform-origin: 12px 12px;
            transform-box: view-box;
            fill: currentColor;
        }

        .magic-btn:hover .sparkle-main,
        .trigger-magic .sparkle-main {
            animation: sparkleCenterPulse 0.8s ease-in-out forwards, magicColor 0.8s linear forwards;
        }
        
        .magic-btn:hover .sparkle-orbit-path,
        .trigger-magic .sparkle-orbit-path {
            animation: sparkleOrbit 0.8s ease-in-out forwards, magicColor 0.8s linear forwards;
        }

        .magic-svg {
            overflow: visible;
        }

        #submit-btn .btn-label { display: inline-block; animation: btnIn 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        #submit-btn .btn-label.leaving { animation: btnOut 0.15s ease-in forwards; }

        h1 a { font-size: clamp(1.25rem, 2.5vw, 2.25rem); }

        .interactive-title { display: inline-block; position: relative; text-decoration: none; cursor: pointer; }

        .title-glow {
            display: inline-block;
            background-color: #111827;
            background-image: radial-gradient(circle var(--glow-size) at var(--mouse-x) var(--mouse-y), rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 100%);
            background-repeat: no-repeat;
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            color: transparent;
            transition: --glow-size 0.3s ease;
        }

        .chat-send-btn {
            background-image: radial-gradient(circle var(--glow-size, 0px) at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(255,255,255,0.5) 0%, transparent 100%);
        }

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

        #elapsed-timer {
            font-family: monospace;
            font-size: 0.8rem;
            color: #9ca3af;
            min-width: 2.5ch;
        }

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
            background-color: #f3f4f6;
            padding: 0.75rem 1rem;
            border-radius: 0.5rem;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: anywhere;
            margin-top: 0.5rem;
            margin-bottom: 0.75rem;
            font-size: 0.85em;
        }

        .markdown-body pre code {
            background-color: transparent;
            padding: 0;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: anywhere;
        }
            </style>
</head>
<body class="bg-white text-gray-900 font-sans antialiased selection:bg-gray-300">

    <div class="px-4 sm:px-6" id="page-wrapper">

        <h1 class="font-bold tracking-tight text-center text-black mb-5 sm:mb-8">
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

        <div id="results-container" class="mt-4">
            {{results_html}}
        </div>

    </div>

    <div id="chat-modal" class="fixed inset-0 z-50 hidden bg-white/40 backdrop-blur-md flex items-center justify-center opacity-0 transition-opacity duration-300 p-4 sm:p-8">
        <div class="bg-white border border-gray-100 w-full max-w-3xl h-[85vh] sm:h-[80vh] rounded-[2.5rem] shadow-2xl flex flex-col transform scale-95 transition-transform duration-300" id="chat-modal-content">

            <div class="px-8 py-5 border-b border-gray-50 flex items-center justify-between">
                <div>
                    <h3 class="font-bold text-gray-900 leading-tight">Assistant Sémantique</h3>
                    <p class="text-xs text-gray-400 font-medium truncate max-w-[200px] sm:max-w-sm" id="chat-modal-filename">Chargement...</p>
                </div>
                <button onclick="closeChat()" class="magic-btn text-gray-300 hover:text-black hover:bg-gray-50 p-2.5 rounded-full transition-colors focus:outline-none">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>

            <!-- Zone de messages -->
            <div class="flex-1 overflow-y-auto p-8" id="chat-messages">
                <!-- Message IA de bienvenue -->
                <div class="flex flex-col items-start gap-3 mb-8">
                    <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">
                        <p>Je prépare l'analyse de ce document. Quelle est votre question spécifique ?</p>
                    </div>
                    <!-- L'étincelle en dessous, à gauche -->
                    <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container">
                        <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                            <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                            <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                            <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                        </svg>
                    </div>
                </div>
            </div>

            <div class="p-6 pt-2">
                <form id="ai-chat-form" onsubmit="event.preventDefault(); handleChatSubmit();" class="relative flex items-center">
                    <input type="text" id="ai-chat-input" placeholder="Interrogez le modèle..." 
                        class="w-full bg-gray-50 border border-gray-100 rounded-[2rem] pl-6 pr-14 py-4 text-sm font-medium focus:outline-none focus:bg-white focus:border-gray-300 focus:shadow-sm transition-all" autocomplete="off">
                    <button type="submit" class="magic-btn chat-send-btn absolute right-2 text-white bg-black hover:bg-gray-800 rounded-full w-10 h-10 flex items-center justify-center transition-colors">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 19V5M5 12l7-7 7 7"></path></svg>
                    </button>
                </form>
            </div>
        </div>
    </div>

    <script>
        const wrapper = document.getElementById('page-wrapper');
        let IS_CENTERED = {{is_centered}};

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
                if (activeLoadingEl) {
                    const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                    const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
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
                document.body.style.overflow = '';
                return;
            }
            document.body.style.overflow = 'hidden';
            const pad = Math.max(48, (window.innerHeight - wrapper.offsetHeight) / 2 - 60);
            wrapper.style.paddingTop = pad + 'px';
            wrapper.style.paddingBottom = pad + 'px';
        }

        wrapper.style.transition = 'none';
        applyCentering();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                wrapper.style.transition = 'padding-top 0.55s cubic-bezier(0.4, 0, 0.2, 1), padding-bottom 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
            });
        });

        // ── Compteur global ──
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

        // ── Fonctions Fenêtre Modale (Chat) ──
        function openChat(docId, docName) {
            currentChatDocId = docId; // On sauvegarde l'ID
            chatHistory = [];         // On vide l'historique
            document.querySelectorAll('.chat-spacer').forEach(el => el.remove());
            document.getElementById('chat-messages').innerHTML = `
                <div class="flex flex-col items-start gap-3 mb-8">
                    <div class="text-sm text-gray-800 leading-relaxed w-full markdown-body">
                        <p>Je prépare l'analyse de ce document. Quelle est votre question spécifique ?</p>
                    </div>
                    <div class="text-gray-900 flex-shrink-0 w-5 h-5 flex items-center justify-center sparkle-container">
                        ${magicSvgTemplate}
                    </div>
                </div>`;

            const modal = document.getElementById('chat-modal');
            const content = document.getElementById('chat-modal-content');

            const decodedName = decodeURIComponent(docName);
            document.getElementById('chat-modal-filename').textContent = decodedName;

            modal.classList.remove('hidden');
            void modal.offsetWidth; 
            modal.classList.remove('opacity-0');
            content.classList.remove('scale-95');
            document.body.style.overflow = 'hidden';
        }

        function closeChat() {
            const modal = document.getElementById('chat-modal');
            const content = document.getElementById('chat-modal-content');

            modal.classList.add('opacity-0');
            content.classList.add('scale-95');

            setTimeout(() => {
                modal.classList.add('hidden');
                document.body.style.overflow = '';
            }, 300);
        }

        document.getElementById('chat-modal').addEventListener('click', function(e) {
            if (e.target === this) closeChat();
        });

        // ── Logique du Chatbot (Envoi & Animation Stream avec Étincelle en bas) ──
        let loadingAnimInterval = null;

        const magicSvgTemplate = `
            <svg class="w-5 h-5 overflow-visible ai-sparkle-icon" viewBox="0 0 24 24">
                <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
            </svg>
        `;

        function scrollToBottomIfNeeded(container) {
            // if (autoScrollEnabled) {
                // const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
                // if (distanceFromBottom > 2) {
                    // container.scrollTop = container.scrollHeight;
                // }
            // }
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

            // 1. Message Utilisateur
            messagesContainer.insertAdjacentHTML('beforeend', `
                <div class="flex items-end justify-end mb-8 user-msg-anchor">
                    <div class="bg-gray-50 border border-gray-100 text-gray-900 px-5 py-3.5 rounded-[1.5rem] text-sm max-w-[80%] leading-relaxed">
                        ${text}
                    </div>
                </div>
            `);
            const userMsgEl = messagesContainer.lastElementChild;
            input.value = '';

            // 2. Préparation du conteneur IA + indicateur "Réflexion..."
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
                    scrollToBottomIfNeeded(messagesContainer);

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

                requestAnimationFrame(() => {
                    const loadingEl = document.getElementById(loadingId);
                    if (loadingEl && autoScrollEnabled) {
                        const visibleBlockHeight = (loadingEl.offsetTop + loadingEl.offsetHeight) - userMsgEl.offsetTop;
                        const remaining = Math.max(0, messagesContainer.clientHeight - visibleBlockHeight - 20);
                        messagesContainer.style.paddingBottom = remaining + 'px';
                    }
                });
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

                const resultsContainer = document.getElementById('results-container');
                if (resultsContainer) {
                    resultsContainer.classList.remove('results-hiding');
                    resultsContainer.style.display = '';
                    resultsContainer.style.visibility = '';
                }
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

        const interactiveTitle = document.querySelector('.interactive-title');
        const titleGlow = document.querySelector('.title-glow');
        const submitBtn = document.getElementById('submit-btn');

        if (interactiveTitle && titleGlow) {
            interactiveTitle.addEventListener('mousemove', (e) => {
                const rect = interactiveTitle.getBoundingClientRect();
                titleGlow.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                titleGlow.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
            });
            interactiveTitle.addEventListener('mouseenter', () => { titleGlow.style.setProperty('--glow-size', '55px'); });
            interactiveTitle.addEventListener('mouseleave', () => { titleGlow.style.setProperty('--glow-size', '0px'); });
        }

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


@app.post("/api/chat/stream")
async def stream_chat_response(request: ChatMessageRequest):
    async def rag_stream_generator():
        try:
            # 1. Construire la requête de recherche avec un peu de contexte
            search_query = request.user_message
            if request.history:
                recent_context = " ".join([msg["content"] for msg in request.history[-2:]])
                search_query = f"Contexte récent: {recent_context} | Question: {request.user_message}"

            # 2. Demander le contexte au serveur MCP !
            print(f"[Chat] Demande de contexte au MCP pour le doc: {request.document_id}...")
            async with Client(MCP_SERVER_URL) as mcp_client:
                res = await asyncio.wait_for(
                    mcp_client.call_tool("retrieve_document_context", {
                        "document_id": request.document_id,
                        "query": search_query
                    }),
                    timeout=30.0
                )

                # Selon comment ton MCP renvoie le texte, on le récupère ici :
                context_text = ""
                if isinstance(res.structured_content, dict) and "result" in res.structured_content:
                    context_text = res.structured_content["result"]
                else:
                    context_text = str(res.structured_content)
            # 3. Préparer le prompt pour le LLM
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

            # 5. Renvoyer les mots un par un à la page Web
            async for chunk in response_stream:
                if len(chunk.choices) > 0:
                    token = chunk.choices[0].delta.content
                    if token:
                        yield token

        except Exception as e:
            print(f"[!] Erreur Chat Stream: {e}")
            yield f"\n\n*[Erreur de génération : {str(e)}]*"

    # Retourne une réponse qui reste ouverte (Server-Sent Events allégé)
    return StreamingResponse(
        rag_stream_generator(),
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@app.api_route("/{path:path}", methods=["GET", "POST"])
async def serve_page(request: Request):

    download_id = request.query_params.get("download")
    if download_id:
        return await fetch_document_file_from_mcp(download_id)

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

                    <button onclick="openChat('{document_id}', '{safe_filename}')" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-400 hover:text-black focus:outline-none" title="Analyser avec l'IA">
                        <svg class="magic-svg w-5 h-5" viewBox="0 0 24 24">
                            <path class="sparkle-main" d="M12 2L14.8 9.2L22 12L14.8 14.8L12 22L9.2 14.8L2 12L9.2 9.2L12 2Z"></path>
                            <path class="sparkle-orbit-path" d="M5.5 2.5L6.34 5.16L9 6L6.34 6.84L5.5 9.5L4.66 6.84L2 6L4.66 5.16L5.5 2.5Z"></path>
                            <path class="sparkle-orbit-path" d="M19.5 15.5L20.34 18.16L23 19L20.34 19.84L19.5 22.5L18.66 19.84L16 19L18.66 18.16L19.5 15.5Z"></path>
                        </svg>
                    </button>
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
