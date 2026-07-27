"""File-backed store for user model JSON files and their index."""

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from api.services.user_store import DB_DIR


MODELS_DIR = DB_DIR / "models"


def _safe_username(username: str) -> str:
    if not username:
        raise ValueError("username_required")
    normalized = re.sub(r"[^a-zA-Z0-9_\-]", "_", username)
    if normalized in (".", ".."):
        raise ValueError("invalid_username")
    return normalized


def _user_dir(username: str) -> Path:
    safe = _safe_username(username)
    user_dir = MODELS_DIR / safe
    user_dir.mkdir(parents=True, exist_ok=True)
    return user_dir


def _index_path(username: str) -> Path:
    return _user_dir(username) / "index.json"


def _model_path(username: str, model_id: str) -> Path:
    return _user_dir(username) / f"{model_id}.json"


def _load_index(username: str) -> dict:
    index_file = _index_path(username)
    if not index_file.exists():
        return {"models": {}}
    try:
        with open(index_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"models": {}}


def _save_index(username: str, index: dict):
    with open(_index_path(username), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, ensure_ascii=False)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_user_store(username: str):
    _user_dir(username)


def list_models(username: str) -> list[dict]:
    index = _load_index(username)
    models = index.get("models", {})
    return sorted(
        [{
            "id": mid,
            "name": meta.get("name", ""),
            "source_format": meta.get("source_format", ""),
            "created_at": meta.get("created_at", ""),
            "updated_at": meta.get("updated_at", ""),
        } for mid, meta in models.items()],
        key=lambda m: m["updated_at"] or m["created_at"],
        reverse=True,
    )


def get_model(username: str, model_id: str) -> Optional[dict]:
    path = _model_path(username, model_id)
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_model(
    username: str,
    model_data: dict,
    name: str,
    model_id: Optional[str] = None,
    source_format: str = "unknown",
) -> dict:
    index = _load_index(username)
    if model_id:
        if model_id not in index.get("models", {}):
            raise ValueError("model_not_found")
    else:
        model_id = str(uuid.uuid4())
    path = _model_path(username, model_id)
    payload = {
        "id": model_id,
        "name": name,
        "source_format": source_format,
        "data": model_data,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    if index.get("models", {}).get(model_id, {}).get("created_at"):
        payload["created_at"] = index["models"][model_id]["created_at"]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    index.setdefault("models", {})[model_id] = {
        "name": name,
        "source_format": source_format,
        "created_at": payload["created_at"],
        "updated_at": payload["updated_at"],
    }
    _save_index(username, index)
    return payload


def rename_model(username: str, model_id: str, new_name: str) -> dict:
    index = _load_index(username)
    meta = index.get("models", {}).get(model_id)
    if not meta:
        raise ValueError("model_not_found")
    meta["name"] = new_name
    meta["updated_at"] = _now_iso()
    _save_index(username, index)
    model = get_model(username, model_id)
    if model:
        model["name"] = new_name
        model["updated_at"] = meta["updated_at"]
        with open(_model_path(username, model_id), "w", encoding="utf-8") as f:
            json.dump(model, f, indent=2, ensure_ascii=False)
    return meta


def delete_model(username: str, model_id: str) -> None:
    index = _load_index(username)
    if model_id in index.get("models", {}):
        del index["models"][model_id]
        _save_index(username, index)
    path = _model_path(username, model_id)
    if path.exists():
        path.unlink()
