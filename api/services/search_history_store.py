"""SQLite persistence for user search history."""

from datetime import datetime
from typing import Optional

import sqlite3

from api.services.db import DB_DIR, DB_PATH


def _get_conn() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cur.fetchone() is not None


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cur.fetchall())


def init_search_history_db():
    conn = _get_conn()
    if not _table_exists(conn, "search_history"):
        conn.execute(
            """
            CREATE TABLE search_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                query TEXT NOT NULL,
                tags TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_opened_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            )
            """
        )
    elif not _column_exists(conn, "search_history", "last_opened_at"):
        conn.execute("ALTER TABLE search_history ADD COLUMN last_opened_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)")
        conn.execute(
            "UPDATE search_history SET last_opened_at = strftime('%s', 'now') * 1000 WHERE last_opened_at IS NULL"
        )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_search_history_username ON search_history(username)"
    )
    conn.commit()
    conn.close()


def save_search(username: str, query: str, tags: list[str]) -> dict:
    conn = _get_conn()
    cur = conn.execute(
        "INSERT INTO search_history (username, query, tags, last_opened_at) VALUES (?, ?, ?, strftime('%s', 'now') * 1000)",
        (username, query.strip(), ",".join(tags or [])),
    )
    inserted_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        "SELECT id, username, query, tags, created_at, last_opened_at FROM search_history WHERE id = ?",
        (inserted_id,),
    ).fetchone()
    conn.close()
    item = dict(row)
    if isinstance(item.get("last_opened_at"), str):
        try:
            item["last_opened_at"] = int(datetime.fromisoformat(item["last_opened_at"]).timestamp() * 1000)
        except Exception:
            import time
            item["last_opened_at"] = int(time.time() * 1000)
    return item


def list_searches(username: str, limit: int = 200) -> list[dict]:
    import time
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT id, username, query, tags, created_at, last_opened_at
        FROM search_history
        WHERE username = ?
        ORDER BY last_opened_at DESC, created_at DESC
        LIMIT ?
        """,
        (username, limit),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        item = dict(r)
        lo = item.get("last_opened_at")
        if isinstance(lo, str):
            try:
                dt = datetime.fromisoformat(lo)
                item["last_opened_at"] = int(dt.timestamp() * 1000)
            except Exception:
                item["last_opened_at"] = int(time.time() * 1000)
        elif lo is None:
            item["last_opened_at"] = int(time.time() * 1000)
        out.append(item)
    return out


def touch_search(username: str, search_id: int) -> dict | None:
    import time
    conn = _get_conn()
    conn.execute(
        "UPDATE search_history SET last_opened_at = strftime('%s', 'now') * 1000 WHERE id = ? AND username = ?",
        (search_id, username),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id, username, query, tags, created_at, last_opened_at FROM search_history WHERE id = ?",
        (search_id,),
    ).fetchone()
    conn.close()
    item = dict(row) if row else None
    if item and isinstance(item.get("last_opened_at"), str):
        try:
            item["last_opened_at"] = int(datetime.fromisoformat(item["last_opened_at"]).timestamp() * 1000)
        except Exception:
            item["last_opened_at"] = int(time.time() * 1000)
    return item


def delete_search(username: str, search_id: int) -> None:
    conn = _get_conn()
    conn.execute(
        "DELETE FROM search_history WHERE id = ? AND username = ?",
        (search_id, username),
    )
    conn.commit()
    conn.close()
