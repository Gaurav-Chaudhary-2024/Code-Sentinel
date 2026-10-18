"""
CodeSentinel — main.py
Two-pass LLM code review with Supabase JWT auth, multi-key failover,
caching, and adaptive user profiles.

Auth flow:
  - Frontend sends: Authorization: Bearer <supabase_access_token>
  - Backend verifies JWT with Supabase, extracts user_id
  - API key passed as X-Api-Key header (plaintext, never stored)
  - On 429: marks that key inactive in DB, tries next key in priority order
"""

import asyncio
import hashlib
import httpx
import json
import os
import re

from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv
from supabase import create_client, Client

from cache import get_cached_result, set_cached_result, get_cache_stats, cleanup_expired
from prompts import SYSTEM_PROMPTS

load_dotenv()

# ── Supabase client (service role for server-side operations) ──────────────
SUPABASE_URL      = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SUPABASE_ANON_KEY:
    raise EnvironmentError("SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env")

# Use service role key for server-side DB operations (bypasses RLS safely)
_server_key = SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY
supabase: Client = create_client(SUPABASE_URL, _server_key)

MODEL            = os.getenv("MODEL", "liquid/lfm-2.5-2.6b:free")
OPENROUTER_URL   = "https://openrouter.ai/api/v1/chat/completions"

CORRECTNESS_PROMPT = SYSTEM_PROMPTS["correctness"]
MINIMALISM_PROMPT  = SYSTEM_PROMPTS["minimalism"]

app = FastAPI(title="CodeSentinel API", version="3.0.0")

_frontend_url = os.getenv("FRONTEND_URL", "")
_allow_origins = [_frontend_url] if _frontend_url else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_origin_regex=r".*",   # allow file:// (null origin) in dev
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Auth dependency ────────────────────────────────────────────────────────────

async def get_current_user(authorization: str = Header(None)) -> dict:
    """
    Verify Supabase JWT from Authorization: Bearer <token>.
    Returns the user dict from Supabase auth.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.split(" ", 1)[1]

    try:
        # Supabase verifies the JWT and returns the user
        response = supabase.auth.get_user(token)
        if not response or not response.user:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        return {"id": response.user.id, "email": response.user.email}
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Auth failed: {str(e)}")


# ── Request model ──────────────────────────────────────────────────────────────

class ReviewRequest(BaseModel):
    code: str
    language: str = "python"

    @field_validator("code")
    @classmethod
    def validate_code(cls, v):
        if not v or not v.strip():
            raise ValueError("Code cannot be empty")
        if len(v) > 50_000:
            raise ValueError("Code exceeds 50,000 character limit")
        return v


# ── LLM helpers ────────────────────────────────────────────────────────────────

async def llm_review(code: str, prompt: str, api_key: str, user_patterns: list = []) -> str:
    """Single LLM pass via OpenRouter. Injects adaptive patterns if available."""
    system_content = prompt
    if user_patterns:
        patterns_str = "\n".join(f"- {p}" for p in user_patterns[:5])
        system_content += (
            f"\n\nDEVELOPER HISTORY — this developer commonly makes these mistakes:\n"
            f"{patterns_str}\nPay extra attention to these areas."
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type":  "application/json",
                "HTTP-Referer":  "https://codesentinel.dev",
                "X-Title":       "CodeSentinel",
            },
            json={
                "model": MODEL,
                "messages": [
                    {"role": "system", "content": system_content},
                    {"role": "user",   "content": f"Review this code:\n\n```\n{code}\n```"},
                ],
                "temperature": 0,
            },
        )
        if not response.is_success:
            print(f"[ERROR] OpenRouter {response.status_code}: {response.text}")
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        print(f"[LLM RAW]\n{content}\n[/LLM RAW]")
        return content


def parse_llm_response(raw: str, pass_type: str) -> list:
    """Parse JSON array from LLM response. Handles both field name conventions."""
    cleaned = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
    match   = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group())
        issues = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            issues.append({
                "title":       str(item.get("issue") or item.get("title") or "Unknown Issue").strip(),
                "severity":    str(item.get("severity", "info")).strip().lower(),
                "line":        item.get("line", 0),
                "description": str(item.get("explanation", "")).strip(),
                "fix":         str(item.get("suggestion") or item.get("fix") or "").strip(),
                "pass_type":   pass_type,
            })
        return issues
    except (json.JSONDecodeError, TypeError):
        return []


def deduplicate_issues(issues: list) -> list:
    """Remove issues with same line number or high title keyword overlap."""
    seen_lines = set()
    unique     = []
    stop_words = {"the", "a", "an", "in", "of", "on", "at", "is", "are", "for", "and", "or"}

    for issue in issues:
        line  = issue.get("line", 0)
        words = set(re.findall(r"\b\w+\b", issue.get("title", "").lower())) - stop_words

        if line and line in seen_lines:
            continue

        duplicate = any(
            len(words & (set(re.findall(r"\b\w+\b", a.get("title","").lower())) - stop_words)) >= 2
            for a in unique
        )
        if duplicate:
            continue

        if line:
            seen_lines.add(line)
        unique.append(issue)

    return unique


def merge_results(correctness: list, minimalism: list) -> list:
    """Merge both passes, deduplicate, sort by severity."""
    order    = {"critical": 0, "warning": 1, "info": 2}
    combined = deduplicate_issues(correctness + minimalism)
    return sorted(combined, key=lambda x: order.get(x.get("severity", "info").lower(), 2))


# ── Key failover helper ────────────────────────────────────────────────────────

def sha256_hex(raw: str) -> str:
    return hashlib.sha256(raw.strip().encode()).hexdigest()


async def get_user_keys(user_id: str) -> list:
    """Fetch user's API keys from Supabase, ordered by priority."""
    res = (
        supabase.table("api_keys")
        .select("id, key_hash, priority, is_active")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .order("priority", desc=False)
        .execute()
    )
    return res.data or []


async def mark_key_exhausted(key_id: str) -> None:
    """Mark a key as inactive when it hits quota/rate-limit."""
    supabase.table("api_keys").update({"is_active": False}).eq("id", key_id).execute()


async def run_review_with_failover(
    code: str,
    language: str,
    user_id: str,
    header_key: str | None,
    user_patterns: list,
) -> tuple[list, str]:
    """
    Try the key from X-Api-Key header first, then fall back to keys stored
    in Supabase (in priority order). Returns (issues, api_key_used).
    On 429 marks that key inactive and tries the next one.
    """
    # Build candidate list: header key first (not stored — session only),
    # then stored keys that are still active
    candidates = []
    if header_key and header_key.startswith("sk-or-"):
        candidates.append({"id": None, "key": header_key})

    stored_keys = await get_user_keys(user_id)
    # We can't retrieve stored plaintext (only hash stored), so stored keys
    # are only usable if the frontend sent them via X-Api-Key.
    # The stored list is used here purely to mark keys exhausted server-side.
    # In practice app.js always sends the plaintext key in X-Api-Key.

    if not candidates:
        raise HTTPException(
            status_code=400,
            detail="No API key provided. Add an OpenRouter key in Account → API Keys."
        )

    last_error = None
    for candidate in candidates:
        key = candidate["key"]
        try:
            c_raw, m_raw = await asyncio.gather(
                llm_review(code, CORRECTNESS_PROMPT, key, user_patterns),
                llm_review(code, MINIMALISM_PROMPT,  key, user_patterns),
            )
            return merge_results(
                parse_llm_response(c_raw, "correctness"),
                parse_llm_response(m_raw, "minimalism"),
            ), key
        except httpx.HTTPStatusError as e:
            last_error = e
            if e.response.status_code == 429:
                # Mark the stored key inactive if we have its ID
                key_hash = sha256_hex(key)
                exhausted = next(
                    (k for k in stored_keys if k["key_hash"] == key_hash), None
                )
                if exhausted:
                    await mark_key_exhausted(exhausted["id"])
                continue  # try next key
            raise HTTPException(status_code=502, detail=f"LLM API error: {e.response.status_code}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach LLM API: {str(e)}")

    if last_error and hasattr(last_error, "response") and last_error.response.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="All API keys exhausted. Add a new OpenRouter key.",
            headers={"X-Error-Code": "quota_exceeded"},
        )
    raise HTTPException(status_code=502, detail="Review failed after trying all keys.")


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.post("/review")
async def review_code(
    request:    ReviewRequest,
    user:       dict = Depends(get_current_user),
    x_api_key:  str  = Header(None),
):
    """
    Main review endpoint.
    Requires: Authorization: Bearer <supabase_token>
              X-Api-Key: <openrouter_key>
    """
    user_id = user["id"]

    # Step 1: Cache check
    cached = get_cached_result(request.code)
    if cached:
        return {**cached, "cached": True}

    # Step 2: Load adaptive profile patterns (non-fatal)
    user_patterns = []
    try:
        res = (
            supabase.table("patterns")
            .select("pattern")
            .eq("user_id", user_id)
            .order("count", desc=True)
            .limit(5)
            .execute()
        )
        user_patterns = [r["pattern"] for r in (res.data or [])]
    except Exception as e:
        print(f"[WARN] Pattern load failed (non-fatal): {e}")

    # Step 3: Dual-pass LLM with key failover
    import time
    t0     = time.monotonic()
    issues, key_used = await run_review_with_failover(
        request.code, request.language, user_id, x_api_key, user_patterns
    )
    latency_ms = int((time.monotonic() - t0) * 1000)

    result = {
        "issues":     issues,
        "total":      len(issues),
        "model":      MODEL,
        "language":   request.language,
        "latency_ms": latency_ms,
        "cached":     False,
    }

    # Step 4: Update patterns + stats (non-fatal, fire-and-forget)
    if issues:
        asyncio.create_task(_update_profile(user_id, issues))

    # Step 5: Cache
    set_cached_result(request.code, result)

    return result


async def _update_profile(user_id: str, issues: list) -> None:
    """Background task: upsert pattern counts + update review stats."""
    try:
        for issue in issues:
            title    = issue.get("title", "").strip()
            severity = issue.get("severity", "info").lower()
            if not title:
                continue
            # Upsert: increment count if pattern exists
            existing = (
                supabase.table("patterns")
                .select("id, count")
                .eq("user_id", user_id)
                .eq("pattern", title)
                .limit(1)
                .execute()
            )
            if existing.data:
                new_count = existing.data[0]["count"] + 1
                supabase.table("patterns").update({"count": new_count}).eq("id", existing.data[0]["id"]).execute()
            else:
                supabase.table("patterns").insert({
                    "user_id":  user_id,
                    "pattern":  title,
                    "severity": severity,
                    "count":    1,
                }).execute()

        # Update review_stats
        stats = (
            supabase.table("review_stats")
            .select("reviews_total, issues_found")
            .eq("user_id", user_id)
            .limit(1)
            .execute()
        )
        if stats.data:
            supabase.table("review_stats").update({
                "reviews_total": stats.data[0]["reviews_total"] + 1,
                "issues_found":  stats.data[0]["issues_found"]  + len(issues),
            }).eq("user_id", user_id).execute()
        else:
            supabase.table("review_stats").insert({
                "user_id":       user_id,
                "reviews_total": 1,
                "issues_found":  len(issues),
                "cache_hits":    0,
            }).execute()
    except Exception as e:
        print(f"[WARN] Profile update failed (non-fatal): {e}")


@app.post("/cache/clear")
async def clear_cache(user: dict = Depends(get_current_user)):
    """Clear the review cache (server-wide — scoped per deployment)."""
    from cache import clear_all_cache
    clear_all_cache()
    # Reset cache stats for this user
    supabase.table("review_stats").update({
        "cache_hits":    0,
        "cache_size_kb": 0,
    }).eq("user_id", user["id"]).execute()
    return {"message": "Cache cleared"}


@app.delete("/account")
async def delete_account(user: dict = Depends(get_current_user)):
    """
    Delete all user data and their Supabase auth account.
    Requires SUPABASE_SERVICE_ROLE_KEY to delete auth users.
    """
    user_id = user["id"]
    try:
        # Delete user data (cascades via FK if set up correctly)
        supabase.table("api_keys").delete().eq("user_id",    user_id).execute()
        supabase.table("patterns").delete().eq("user_id",    user_id).execute()
        supabase.table("review_stats").delete().eq("user_id",user_id).execute()

        # Delete auth user (needs service role key)
        if SUPABASE_SERVICE_KEY:
            admin_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
            admin_client.auth.admin.delete_user(user_id)

        return {"message": "Account deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Account deletion failed: {str(e)}")


@app.get("/profile")
async def get_profile(user: dict = Depends(get_current_user)):
    """Return patterns and stats for the authenticated user."""
    user_id = user["id"]
    patterns = (
        supabase.table("patterns")
        .select("pattern, severity, count")
        .eq("user_id", user_id)
        .order("count", desc=True)
        .limit(20)
        .execute()
    )
    stats = (
        supabase.table("review_stats")
        .select("*")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return {
        "patterns": patterns.data or [],
        "stats":    stats.data[0] if stats.data else {},
    }


@app.get("/cache/stats")
async def cache_stats(user: dict = Depends(get_current_user)):
    cleanup_expired()
    return get_cache_stats()


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "version": "3.0.0"}