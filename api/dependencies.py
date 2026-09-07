"""Global shared dependencies.

This module intentionally keeps only cross-cutting infrastructure:
- LLM client configuration
- Environment variables
- Small text/URL utilities

Presentation logic (HTML rendering, Markdown) has been moved to the frontend
or to app-specific services to keep the backend decoupled from the UI.
"""

import os
import re
import urllib.parse

from dotenv import load_dotenv
from openai import AsyncOpenAI

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


def generate_svg_for_bytes(file_bytes: bytes, filename: str) -> str:
    """Delegate SVG generation to the model gateway.

    Kept here for backward compatibility with existing routers; new code
    should import directly from api.gateways.model_gateway.
    """
    from api.gateways.model_gateway import generate_svg_for_bytes as _gateway_generate

    return _gateway_generate(file_bytes, filename)
