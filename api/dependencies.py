import base64
import os
import re
import urllib.parse
from io import BytesIO

import markdown
from dotenv import load_dotenv
from fastapi import Response
from openai import AsyncOpenAI

from data_model_utils import (
    _detect_file_type,
    generate_visualisation,
    json_file_to_model,
    sql_to_model,
    text_to_model,
    ttl_to_json,
    xml_to_json,
)

load_dotenv()

_LLM_API_KEY = os.getenv("LLM_API_KEY", "not-needed")
_URL_API = os.getenv("URL_LLM_API", "")
_LLM_MODEL = os.getenv("LLM_MODEL", "")

llm_client = AsyncOpenAI(base_url=_URL_API, api_key=_LLM_API_KEY)


def safe_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def escape_xml_attr(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def extract_filename_from_disposition(header: str) -> str:
    if not header:
        return ""
    match = re.search(r"filename\*=([^'\"]*)''([^;]+)", header, re.IGNORECASE)
    if match:
        return urllib.parse.unquote(match.group(2).strip('"'))
    match = re.search(r'filename=["\']?([^";]+)', header, re.IGNORECASE)
    if match:
        return match.group(1).strip('"')
    return ""


def normalize_preview(text: str) -> str:
    # Latex shortcuts
    latex_map = {
        r'\\rightarrow': '→', r'\\leftarrow': '←', r'\\leftrightarrow': '↔',
        r'\\Rightarrow': '⇒', r'\\Leftarrow': '⇐', r'\\Leftrightarrow': '⇔',
        r'\\leq': '≤', r'\\geq': '≥', r'\\neq': '≠', r'\\approx': '≈',
        r'\\in': '∈', r'\\notin': '∉', r'\\subset': '⊂', r'\\cup': '∪', r'\\cap': '∩',
        r'\\forall': '∀', r'\\exists': '∃', r'\\land': '∧', r'\\lor': '∨',
        r'\\infty': '∞', r'\\pm': '±', r'\\times': '×', r'\\cdot': '·',
        r'\\alpha': 'α', r'\\beta': 'β', r'\\gamma': 'γ', r'\\delta': 'δ',
        r'\\lambda': 'λ', r'\\mu': 'μ', r'\\pi': 'π', r'\\sigma': 'σ',
        r'\\ldots': '…',
    }
    for latex, uni in latex_map.items():
        text = text.replace(f'${latex}$', uni)
        text = text.replace(latex, uni)
    text = re.sub(r'\$([^$]{1,60})\$', r'\1', text)
    return text


def render_results(results_data: list, query: str = "") -> dict:
    tags_html = ""
    results_html = ""
    is_centered_bool = not bool(query)

    if query and not results_data:
        results_html = """
        <div class="text-center py-20 text-black font-bold text-lg">
            <p>Aucun document ne correspond à cette recherche.</p>
        </div>
        """
    elif query and results_data:
            results_html = f'<p id="results-header" class="font-bold text-gray-500 mb-8 border-b-2 border-gray-200 pb-4">{len(results_data)} RÉSULTAT(S)</p>'
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
            preview = normalize_preview(preview)
            preview_html = markdown.markdown(preview)
            safe_filename = urllib.parse.quote(filename)
            import os as _os
            _, ext = _os.path.splitext(filename.lower())
            is_pdf = ext == ".pdf"
            preview_button = "" if is_pdf else f"""<button data-action="preview" data-doc-id="{chunk0_id}" data-document-id="{document_id}" data-name="{safe_filename}" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-500 hover:text-black focus:outline-none transition-colors" title="Aperçu rapide">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </button>"""
            results_html += f"""
            <div class="py-8 border-b border-gray-200 last:border-0 result-item">
                <h3 class="font-bold mb-3">
                    <a href="{safe_filename}?download={chunk0_id}" target="_blank" class="text-black hover:text-blue-600 hover:underline transition-colors" title="Ouvrir le document">
                        {filename}
                    </a>
                </h3>
                <div class="text-gray-800 font-medium leading-relaxed mb-4 markdown-body">
                    {preview_html}
                </div>
                <div class="flex items-end justify-between">
                    <div class="flex flex-wrap gap-4 font-bold text-gray-500">
                        <span title="Score de pertinence">Score: {score}</span>
                        <span>Source: {tags_badges}</span>
                        <span class="font-mono text-xs mt-0.5" title="{document_id}">ID: {str(document_id)[:8]}...</span>
                    </div>
                    <div class="flex gap-2">
                        {preview_button}
                        <button data-action="chat" data-document-id="{document_id}" data-name="{safe_filename}" class="magic-btn flex items-center justify-center p-1.5 rounded-full bg-gray-100 hover:bg-white text-gray-400 hover:text-black focus:outline-none" title="Analyser avec l'IA">
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
    return {"results_html": results_html, "is_centered": is_centered_bool}


def generate_svg_for_bytes(file_bytes: bytes, filename: str) -> str:
    import re as _re
    kind = _detect_file_type(file_bytes, filename)
    if not kind and filename:
        import os as _os
        _, ext = _os.path.splitext(filename.lower())
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
        raise ValueError("Format non supporté pour la modélisation.")

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
        if safe_text(elem.get("type")) == "uml:Package" and not root_pkg_id:
            root_pkg_id = safe_text(elem.get("ID"))
    for elem in json_data.get("elements", []):
        if safe_text(elem.get("type")) == "uml:Class" and safe_text(elem.get("package")) == root_pkg_id:
            main_class_name = safe_text(elem.get("name"))
            break
    if main_class_name and "<svg" in svg_text:
        svg_text = svg_text.replace("<svg", f'<svg data-main-class="{escape_xml_attr(main_class_name)}"', 1)
    return svg_text
