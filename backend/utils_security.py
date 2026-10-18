"""
utils_security.py
Security utilities for CodeSentinel.
Hashes API keys before storing in Supabase — never store raw keys.
"""

import hashlib


def hash_api_key(api_key: str) -> str:
    """SHA-256 hash of the API key for safe storage in Supabase."""
    return hashlib.sha256(api_key.strip().encode("utf-8")).hexdigest()