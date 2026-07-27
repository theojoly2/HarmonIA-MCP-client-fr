"""SQLite persistence for user search history."""

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import sqlite3

from api.services.user_store import DB_DIR


DB_PATH = DB_DIR / "users.db"


def _get_conn() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_search_history_db():
    conn = _get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS search_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            query TEXT NOT NULL,
            tags TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_search_history_username ON search_history(username)"
    )
    conn.commit()
    conn.close()


def save_search(username: str, query: str, tags: list[str]) -> dict:
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO search_history (username, query, tags) VALUES (?, ?, ?)",
        (username, query.strip(), ",".join(tags or [])),
    )
    inserted_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        "SELECT id, username, query, tags, created_at FROM search_history WHERE id = ?",
        (inserted_id,),
    ).fetchone()
    conn.close()
    return dict(row)


def list_searches(username: str, limit: int = 200) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT id, username, query, tags, created_at
        FROM search_history
        WHERE username = ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (username, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_search(username: str, search_id: int) -> None:
    conn = _get_conn()
    conn.execute(
        "DELETE FROM search_history WHERE id = ? AND username = ?",
        (search_id, username),
    )
    conn.commit()
    conn.close()
