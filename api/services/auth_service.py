"""Authentication helpers: password hashing and signed session cookies."""

import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional


def _load_session_secret() -> str:
    secret = os.getenv("SESSION_SECRET", "")
    if secret:
        return secret
    # Fallback to a stable secret stored in the project data directory
    secret_file = Path(__file__).resolve().parent.parent.parent / "data" / ".session_secret"
    secret_file.parent.mkdir(parents=True, exist_ok=True)
    if secret_file.exists():
        return secret_file.read_text().strip()
    secret = secrets.token_urlsafe(32)
    secret_file.write_text(secret)
    return secret


SESSION_SECRET = _load_session_secret()
SESSION_COOKIE = "harmonia_session"
SESSION_MAX_AGE_DAYS = 7


def _now() -> int:
    return int(time.time())


def _serialize(data: dict) -> str:
    return base64url_encode(json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def base64url_encode(value: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def base64url_decode(value: str) -> bytes:
    import base64
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str, salt: Optional[bytes] = None) -> tuple[bytes, bytes]:
    """PBKDF2-HMAC-SHA256 with a unique random salt."""
    if salt is None:
        salt = secrets.token_bytes(32)
    if isinstance(password, str):
        password = password.encode("utf-8")
    digest = hashlib.pbkdf2_hmac("sha256", password, salt, 200_000)
    return salt, digest


def verify_password(password: str, salt: bytes, digest: bytes) -> bool:
    _, expected = hash_password(password, salt)
    return hmac.compare_digest(digest, expected)


def _sign(value: str) -> str:
    sig = hmac.new(SESSION_SECRET.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).digest()
    return base64url_encode(sig)


def create_session(username: str, max_age_days: int = SESSION_MAX_AGE_DAYS) -> str:
    """Return a signed session cookie value."""
    payload = {
        "u": username,
        "iat": _now(),
        "exp": _now() + int(timedelta(days=max_age_days).total_seconds()),
    }
    data = _serialize(payload)
    return f"{data}.{_sign(data)}"


def decode_session(cookie_value: str) -> Optional[str]:
    """Verify a signed session cookie and return the username, or None."""
    if not cookie_value or "." not in cookie_value:
        return None
    data, sig = cookie_value.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(data)):
        return None
    try:
        payload = json.loads(base64url_decode(data).decode("utf-8"))
    except Exception:
        return None
    exp = payload.get("exp")
    if not exp or _now() > exp:
        return None
    return payload.get("u")


def get_session_cookie(request) -> Optional[str]:
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    return decode_session(raw)
