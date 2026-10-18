"""
CodeSentinel — cache.py
SQLite-backed review result cache, keyed by SHA-256 of the code string.
TTL: 24 hours. Thread-safe via WAL mode.
"""

import hashlib
import json
import os
import sqlite3
import time

_DB_PATH  = os.getenv("CACHE_DB", "cache.db")
_TTL_SECS = int(os.getenv("CACHE_TTL_SECONDS", str(24 * 60 * 60)))  # 24h default


def _conn() -> sqlite3.Connection:
    """Return a connection with WAL journal mode for safe concurrent access."""
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""
        CREATE TABLE IF NOT EXISTS review_cache (
            code_hash  TEXT PRIMARY KEY,
            result     TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    c.commit()
    return c


def _hash(code: str) -> str:
    return hashlib.sha256(code.strip().encode("utf-8")).hexdigest()


def get_cached_result(code: str) -> dict | None:
    """Return cached result dict if it exists and hasn't expired, else None."""
    key = _hash(code)
    with _conn() as c:
        row = c.execute(
            "SELECT result, created_at FROM review_cache WHERE code_hash = ?", (key,)
        ).fetchone()
    if not row:
        return None
    result_str, created_at = row
    if time.time() - created_at > _TTL_SECS:
        # Expired — delete lazily
        with _conn() as c:
            c.execute("DELETE FROM review_cache WHERE code_hash = ?", (key,))
        return None
    return json.loads(result_str)


def set_cached_result(code: str, result: dict) -> None:
    """Store a result in the cache."""
    key = _hash(code)
    with _conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO review_cache (code_hash, result, created_at) VALUES (?, ?, ?)",
            (key, json.dumps(result), time.time()),
        )


def clear_all_cache() -> None:
    """Delete all cached entries."""
    with _conn() as c:
        c.execute("DELETE FROM review_cache")


def cleanup_expired() -> int:
    """Remove all expired entries. Returns number deleted."""
    cutoff = time.time() - _TTL_SECS
    with _conn() as c:
        cur = c.execute("DELETE FROM review_cache WHERE created_at < ?", (cutoff,))
        return cur.rowcount


def get_cache_stats() -> dict:
    """Return cache size info."""
    with _conn() as c:
        total    = c.execute("SELECT COUNT(*) FROM review_cache").fetchone()[0]
        db_bytes = os.path.getsize(_DB_PATH) if os.path.exists(_DB_PATH) else 0
    return {
        "entries":     total,
        "size_kb":     round(db_bytes / 1024, 1),
        "ttl_hours":   _TTL_SECS // 3600,
    }