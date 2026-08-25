"""API key storage and verification.

Keys are generated with secrets.token_urlsafe and only their SHA-256 hash is
stored in the SQLite user database. The plain key is shown to the user exactly
once upon creation.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from api.services.user_store import _get_conn as get_connection


@dataclass
class ApiKey:
    id: int
    user_id: int
    key_hash: str
    name: Optional[str]
    created_at: datetime
    last_used_at: Optional[datetime]
    revoked_at: Optional[datetime]


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def init_api_keys_table() -> None:
    conn = get_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key_hash TEXT NOT NULL,
            name TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_used_at TIMESTAMP,
            revoked_at TIMESTAMP,
            UNIQUE(user_id, key_hash)
        )
        """
    )
    conn.commit()
    conn.close()


def create_api_key(user_id: int, name: Optional[str] = None) -> tuple[str, ApiKey]:
    """Generate a new API key, store its hash, and return the plain key + record."""
    init_api_keys_table()
    plain_key = "sk_" + secrets.token_urlsafe(32)
    key_hash = _hash_key(plain_key)

    conn = get_connection()
    cur = conn.execute(
        """
        INSERT INTO api_keys (user_id, key_hash, name)
        VALUES (?, ?, ?)
        """,
        (user_id, key_hash, name),
    )
    key_id = cur.lastrowid
    conn.commit()

    row = conn.execute(
        "SELECT id, user_id, key_hash, name, created_at, last_used_at, revoked_at FROM api_keys WHERE id = ?",
        (key_id,),
    ).fetchone()
    conn.close()

    return plain_key, _row_to_api_key(row)


def list_api_keys(user_id: int) -> list[ApiKey]:
    init_api_keys_table()
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT id, user_id, key_hash, name, created_at, last_used_at, revoked_at
        FROM api_keys
        WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
        """,
        (user_id,),
    ).fetchall()
    conn.close()
    return [_row_to_api_key(row) for row in rows]


def revoke_api_key(user_id: int, key_id: int) -> bool:
    init_api_keys_table()
    conn = get_connection()
    cur = conn.execute(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        (datetime.now(timezone.utc), key_id, user_id),
    )
    conn.commit()
    updated = cur.rowcount > 0
    conn.close()
    return updated


def verify_api_key(key: str) -> Optional[ApiKey]:
    """Verify a plain API key and return the associated record if valid."""
    init_api_keys_table()
    if not key:
        return None
    key_hash = _hash_key(key)
    conn = get_connection()
    rows = conn.execute(
        """
        SELECT id, user_id, key_hash, name, created_at, last_used_at, revoked_at
        FROM api_keys
        WHERE revoked_at IS NULL
        """
    ).fetchall()
    conn.close()

    for row in rows:
        if hmac.compare_digest(row["key_hash"], key_hash):
            api_key = _row_to_api_key(row)
            _touch_last_used(api_key.id)
            return api_key
    return None


def _touch_last_used(key_id: int) -> None:
    conn = get_connection()
    conn.execute(
        "UPDATE api_keys SET last_used_at = ? WHERE id = ?",
        (datetime.now(timezone.utc), key_id),
    )
    conn.commit()
    conn.close()


def _row_to_api_key(row) -> ApiKey:
    return ApiKey(
        id=row["id"],
        user_id=row["user_id"],
        key_hash=row["key_hash"],
        name=row["name"],
        created_at=_parse_dt(row["created_at"]),
        last_used_at=_parse_dt(row["last_used_at"]),
        revoked_at=_parse_dt(row["revoked_at"]),
    )


def _parse_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None
