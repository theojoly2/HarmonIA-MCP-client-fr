"""Shared text/slug helpers."""

from __future__ import annotations

import re


def _slugify_session_name(text: str) -> str:
    """Convert a user message into a short URL-safe session slug."""
    slug = (
        text.lower()
        .strip()
        .replace("'", " ")
        .replace("-", " ")
        .replace("_", " ")
        .replace(".", " ")
    )
    slug = re.sub(r"[^a-z0-9\s]", "", slug)
    slug = re.sub(r"\s+", "_", slug)
    slug = slug[:40]
    if not slug:
        slug = "session"
    return slug
