"""Shared model naming utilities.

Backend and frontend often need to convert between:
- stored name : a unique technical name, e.g. "MyModel__20260903120000000000"
- display name: the human-readable part, e.g. "MyModel"

Keeping this logic in one place avoids subtle bugs when renaming,
exporting, or rendering model names in the UI.
"""

from __future__ import annotations

import re
from datetime import datetime


def display_name_from_stored(stored_name: str) -> str:
    """Return the human-readable part of a stored model name.

    Examples:
        >>> display_name_from_stored("MyModel__20260903120000000000")
        'MyModel'
        >>> display_name_from_stored("MyModel")
        'MyModel'
        >>> display_name_from_stored("")
        'Generated'
    """
    if not stored_name:
        return "Generated"
    if "__" in stored_name:
        return stored_name.rsplit("__", 1)[0]
    return stored_name


def unique_model_name(name: str) -> str:
    """Append a timestamp suffix to keep stored names unique per user."""
    base = re.sub(r"[^a-zA-Z0-9_.\-]", "_", name.strip() or "model").strip("_")
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    return f"{base}__{timestamp}"


def safe_filename(name: str) -> str:
    """Remove path separators and control characters from a display name."""
    return re.sub(r'[^\w\s\-\.]', "_", name).strip() or "model"


def model_name_from_filename(filename: str) -> str:
    """Derive a clean model base name from an uploaded file name."""
    import os as _os

    base = filename or "imported_model"
    base = _os.path.splitext(base)[0]
    base = base.strip() or "imported_model"
    base = re.sub(r"[^a-zA-Z0-9_\-]", "_", base)
    return base
