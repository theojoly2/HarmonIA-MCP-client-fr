"""SQLite persistence for users."""

import os
import sqlite3
from typing import Optional

from api.services.auth_service import hash_password
from api.services.db import DB_DIR, DB_PATH


def _get_conn() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = _get_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash BLOB NOT NULL,
            salt BLOB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    conn.close()
    from api.services.search_history_store import init_search_history_db
    init_search_history_db()
    from api.services.usage_store import init_usage_table
    init_usage_table()


def create_user(username: str, password: str) -> dict:
    salt, pwd_hash = hash_password(password)
    conn = _get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)",
            (username, pwd_hash, salt),
        )
        conn.commit()
        return {"id": cur.lastrowid, "username": username}
    except sqlite3.IntegrityError:
        raise ValueError("username_exists")
    finally:
        conn.close()


def get_user_by_username(username: str) -> Optional[dict]:
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, username, password_hash, salt, created_at FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)


def user_exists(username: str) -> bool:
    return get_user_by_username(username) is not None


def update_user_password(user_id: int, password: str) -> None:
    salt, pwd_hash = hash_password(password)
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
        (pwd_hash, salt, user_id),
    )
    conn.commit()
    conn.close()


def get_user_by_id(user_id: int) -> Optional[dict]:
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, username, password_hash, salt, created_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return dict(row)
