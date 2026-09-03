"""Shared database paths for SQLite persistence.

Centralising DB_DIR avoids circular imports between stores that each need
only the path or a connection to the same database file.
"""

from pathlib import Path

DB_DIR = Path(__file__).resolve().parent.parent.parent / "data"
DB_PATH = DB_DIR / "users.db"
