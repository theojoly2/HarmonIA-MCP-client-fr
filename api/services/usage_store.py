"""SQLite persistence for per-user LLM token usage."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

DB_DIR = Path(__file__).resolve().parent.parent.parent / "data"
DB_PATH = DB_DIR / "users.db"


def _get_conn() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_usage_table():
    """Create the usage table and required indexes if they don't exist."""
    conn = _get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            endpoint TEXT,
            model TEXT,
            source TEXT DEFAULT 'tiktoken',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_username_created ON usage(username, created_at)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_endpoint ON usage(endpoint)"
    )
    conn.commit()
    conn.close()


def record_usage(
    username: str,
    prompt_tokens: int,
    completion_tokens: int,
    endpoint: Optional[str] = None,
    model: Optional[str] = None,
    source: Optional[str] = "tiktoken",
) -> None:
    """Persist one usage record for a user."""
    total = prompt_tokens + completion_tokens
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO usage (username, prompt_tokens, completion_tokens, total_tokens, endpoint, model, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (username, prompt_tokens, completion_tokens, total, endpoint, model, source),
    )
    conn.commit()
    conn.close()


def _start_of_week() -> datetime:
    """Return Monday 00:00 of the current week (locale-aware, starts on Monday)."""
    now = datetime.now()
    return (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_month() -> datetime:
    """Return first day of current month at 00:00."""
    now = datetime.now()
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _start_of_day() -> datetime:
    """Return today at 00:00."""
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)


def _to_sqlite(dt: datetime) -> str:
    """Format a datetime as SQLite text (YYYY-MM-DD HH:MM:SS)."""
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def get_usage(
    username: str,
    scale: str = "day",
) -> dict[str, int | bool]:
    """Return aggregated token usage for a user over a given time scale.

    Scales:
    - "day": today from midnight to now
    - "week": current week (Monday 00:00) to now
    - "month": current calendar month to now
    - "total": since account creation / first recorded usage

    Returns:
        {
            "prompt_tokens": int,
            "completion_tokens": int,
            "total_tokens": int,
            "has_estimate": bool,
            "scale": str,
        }
    """
    scale = (scale or "day").lower()
    if scale == "day":
        start = _start_of_day()
    elif scale == "week":
        start = _start_of_week()
    elif scale == "month":
        start = _start_of_month()
    elif scale == "total":
        start = datetime.min.replace(year=1, month=1, day=1)
    else:
        start = _start_of_day()

    conn = _get_conn()
    row = conn.execute(
        """
        SELECT
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN source != 'usage' THEN total_tokens ELSE 0 END), 0) AS estimated_tokens
        FROM usage
        WHERE username = ? AND created_at >= ?
        """,
        (username, _to_sqlite(start)),
    ).fetchone()
    conn.close()

    has_estimate = bool(row["estimated_tokens"] and row["estimated_tokens"] > 0)
    return {
        "prompt_tokens": int(row["prompt_tokens"] or 0),
        "completion_tokens": int(row["completion_tokens"] or 0),
        "total_tokens": int(row["total_tokens"] or 0),
        "has_estimate": has_estimate,
        "scale": scale,
    }
