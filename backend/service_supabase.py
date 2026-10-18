"""
CodeSentinel — service_supabase.py
User profile helpers using Supabase Auth user_id (not hashed API key).
All functions take user_id (uuid string) from the verified JWT.
"""

import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
_key         = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY", "")

if not SUPABASE_URL or not _key:
    raise EnvironmentError("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")

supabase: Client = create_client(SUPABASE_URL, _key)


# ── Patterns ───────────────────────────────────────────────────────────────────

async def get_top_patterns(user_id: str, limit: int = 5) -> list[str]:
    """Return the user's most frequent issue patterns as plain strings."""
    res = (
        supabase.table("patterns")
        .select("pattern")
        .eq("user_id", user_id)
        .order("count", desc=True)
        .limit(limit)
        .execute()
    )
    return [r["pattern"] for r in (res.data or [])]


async def upsert_patterns(user_id: str, issues: list) -> None:
    """
    For each issue from a review, increment its count in the patterns table
    (or insert with count=1 if new). Non-fatal — caller wraps in try/except.
    """
    for issue in issues:
        title    = (issue.get("title") or "").strip()
        severity = (issue.get("severity") or "info").lower()
        if not title:
            continue

        existing = (
            supabase.table("patterns")
            .select("id, count")
            .eq("user_id", user_id)
            .eq("pattern", title)
            .limit(1)
            .execute()
        )

        if existing.data:
            supabase.table("patterns").update({
                "count":      existing.data[0]["count"] + 1,
                "updated_at": "now()",
            }).eq("id", existing.data[0]["id"]).execute()
        else:
            supabase.table("patterns").insert({
                "user_id":  user_id,
                "pattern":  title,
                "severity": severity,
                "count":    1,
            }).execute()


async def clear_patterns(user_id: str) -> None:
    """Delete all patterns for this user."""
    supabase.table("patterns").delete().eq("user_id", user_id).execute()


# ── Review stats ───────────────────────────────────────────────────────────────

async def increment_stats(user_id: str, issues_count: int, cache_hit: bool = False) -> None:
    """Increment review_total, issues_found, and optionally cache_hits."""
    existing = (
        supabase.table("review_stats")
        .select("reviews_total, issues_found, cache_hits")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )

    if existing.data:
        row = existing.data[0]
        supabase.table("review_stats").update({
            "reviews_total": row["reviews_total"] + 1,
            "issues_found":  row["issues_found"]  + issues_count,
            "cache_hits":    row["cache_hits"]     + (1 if cache_hit else 0),
        }).eq("user_id", user_id).execute()
    else:
        supabase.table("review_stats").insert({
            "user_id":       user_id,
            "reviews_total": 1,
            "issues_found":  issues_count,
            "cache_hits":    1 if cache_hit else 0,
            "cache_size_kb": 0,
        }).execute()


async def get_stats(user_id: str) -> dict:
    """Return the stats row for this user, or defaults if none exists."""
    res = (
        supabase.table("review_stats")
        .select("*")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if res.data:
        return res.data[0]
    return {
        "reviews_total": 0,
        "issues_found":  0,
        "cache_hits":    0,
        "cache_size_kb": 0,
    }


# ── API key management ─────────────────────────────────────────────────────────

async def get_active_keys(user_id: str) -> list[dict]:
    """Return all active API key rows for this user, ordered by priority."""
    res = (
        supabase.table("api_keys")
        .select("id, key_hash, key_preview, label, priority, is_active")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .order("priority", desc=False)
        .execute()
    )
    return res.data or []


async def mark_key_inactive(key_id: str) -> None:
    """Mark a key as inactive (quota exhausted)."""
    supabase.table("api_keys").update({"is_active": False}).eq("id", key_id).execute()


async def mark_key_active(key_id: str) -> None:
    """Re-activate a key."""
    supabase.table("api_keys").update({"is_active": True}).eq("id", key_id).execute()


# ── Account deletion ───────────────────────────────────────────────────────────

async def delete_user_data(user_id: str) -> None:
    """
    Delete all rows owned by this user.
    The FK ON DELETE CASCADE in the schema handles this automatically,
    but we call it explicitly for certainty.
    """
    supabase.table("api_keys").delete().eq("user_id",     user_id).execute()
    supabase.table("patterns").delete().eq("user_id",     user_id).execute()
    supabase.table("review_stats").delete().eq("user_id", user_id).execute()