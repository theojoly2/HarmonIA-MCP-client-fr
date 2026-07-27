import asyncio
import base64
from typing import Any, Optional

from fastmcp import Client

MCP_SERVER_URL = "http://127.0.0.1:8001/mcp"


async def fetch_tags() -> list:
    print("[Python] Récupération des tags...", flush=True)
    try:
        async with Client(MCP_SERVER_URL) as client:
            res = await asyncio.wait_for(client.call_tool("get_available_tags", {}), timeout=10.0)
            data = res.structured_content
            if isinstance(data, dict):
                if "tags" in data:
                    return data["tags"]
                if "result" in data and isinstance(data["result"], dict):
                    return data["result"].get("tags", [])
                if "result" in data and isinstance(data["result"], list):
                    return data["result"]
            if isinstance(data, list):
                return data
            return []
    except Exception as e:
        print(f"[Erreur Python] Tags : {e}", flush=True)
        return []


async def fetch_search(query: str, tags: list, limit: int = 20) -> Any:
    print(f"[Python] Recherche en cours: '{query}' | Filtres: {tags}", flush=True)
    try:
        async with Client(MCP_SERVER_URL) as client:
            args = {"search_terms": query, "limit": limit}
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
                    except Exception:
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


async def fetch_document_context(document_id: str, query: str) -> str:
    try:
        async with Client(MCP_SERVER_URL) as client:
            res = await asyncio.wait_for(
                client.call_tool("retrieve_document_context", {"document_id": document_id, "query": query}),
                timeout=30.0
            )
            if isinstance(res.structured_content, dict) and "result" in res.structured_content:
                return res.structured_content["result"]
            return str(res.structured_content)
    except Exception as e:
        print(f"[!] Erreur contexte document : {e}")
        return ""


async def fetch_document_file(document_id: str) -> dict:
    try:
        async with Client(MCP_SERVER_URL) as client:
            res = await asyncio.wait_for(
                client.call_tool("get_document_file", {"document_id": document_id}),
                timeout=15.0
            )
            data = res.structured_content
            if isinstance(data, dict) and "result" in data:
                data = data["result"]
            if isinstance(data, dict) and data.get("success"):
                return data
            else:
                err = data.get("error") if isinstance(data, dict) else "Document introuvable"
                return {"success": False, "error": err}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _mcp_call_tool(tool_name: str, args: dict, timeout: float = 15.0) -> Any:
    async with Client(MCP_SERVER_URL) as client:
        res = await asyncio.wait_for(client.call_tool(tool_name, args), timeout=timeout)
        data = getattr(res, "structured_content", None)
        if data is None:
            text = "".join(getattr(c, "text", str(c)) for c in (res.content or []))
            if text:
                data = json.loads(text)
        return data


async def upload_model_mcp(user: str, name: str, model: dict[str, Any]) -> dict[str, Any]:
    try:
        data = await _mcp_call_tool("upload_model", {"user": user, "name": name, "model": model}, timeout=60.0)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(data["error"])
        return data
    except Exception as e:
        print(f"[MCP upload_model] {e}", flush=True)
        raise


async def get_model_mcp(user: str, name: str) -> Optional[dict[str, Any]]:
    try:
        data = await _mcp_call_tool("get_model", {"user": user, "name": name}, timeout=15.0)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(data["error"])
        if not data:
            return None
        return data
    except Exception as e:
        print(f"[MCP get_model] {e}", flush=True)
        raise


async def touch_model_mcp(user: str, name: str) -> None:
    try:
        await _mcp_call_tool("touch_model", {"user": user, "name": name}, timeout=10.0)
    except Exception as e:
        print(f"[MCP touch_model] {e}", flush=True)
        raise


async def list_models_mcp(user: str) -> list[dict[str, Any]]:
    try:
        data = await _mcp_call_tool("list_models", {"user": user}, timeout=10.0)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(data["error"])
        if isinstance(data, dict) and "models" in data:
            return data["models"]
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        print(f"[MCP list_models] {e}", flush=True)
        raise


async def rename_model_mcp(user: str, old_name: str, new_name: str) -> dict[str, Any]:
    try:
        data = await _mcp_call_tool(
            "rename_model", {"user": user, "old_name": old_name, "new_name": new_name}, timeout=15.0
        )
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(data["error"])
        return data
    except Exception as e:
        print(f"[MCP rename_model] {e}", flush=True)
        raise


async def delete_model_mcp(user: str, name: str) -> None:
    try:
        data = await _mcp_call_tool("delete_model", {"user": user, "name": name}, timeout=10.0)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(data["error"])
    except Exception as e:
        print(f"[MCP delete_model] {e}", flush=True)
        raise
