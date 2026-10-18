import httpx
import time
import json
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware


# ── TOKEN BUCKET ──────────────────────────────────────────────────────────────
# Each API key gets its own bucket.
# Max 10 tokens, refills at 2 tokens per minute.
# Every request to /review costs 1 token.

MAX_TOKENS = 10
REFILL_RATE = 2        # tokens per minute
REFILL_INTERVAL = 60   # seconds

# { api_key: { "tokens": float, "last_refill": float } }
buckets: dict = {}


def get_bucket(api_key: str) -> dict:
    now = time.time()
    if api_key not in buckets:
        buckets[api_key] = {"tokens": MAX_TOKENS, "last_refill": now}

    bucket = buckets[api_key]

    # Refill tokens based on time passed
    elapsed = now - bucket["last_refill"]
    refill = (elapsed / REFILL_INTERVAL) * REFILL_RATE
    bucket["tokens"] = min(MAX_TOKENS, bucket["tokens"] + refill)
    bucket["last_refill"] = now

    return bucket


def consume_token(api_key: str) -> bool:
    """Returns True if token consumed, False if bucket is empty."""
    bucket = get_bucket(api_key)
    if bucket["tokens"] >= 1:
        bucket["tokens"] -= 1
        return True
    return False


# ── KEY VALIDATION CACHE ──────────────────────────────────────────────────────
# Validate each key once, cache result for 10 minutes.
# So we never hit OpenRouter just to check a key during a review.

KEY_CACHE_TTL = 600  # 10 minutes
# { api_key: { "valid": bool, "message": str, "timestamp": float } }
key_cache: dict = {}


async def validate_key(api_key: str) -> tuple[bool, str]:
    now = time.time()

    # Return cached result if still fresh
    if api_key in key_cache:
        cached = key_cache[api_key]
        if now - cached["timestamp"] < KEY_CACHE_TTL:
            return cached["valid"], cached["message"]

    # Make a minimal test call to OpenRouter
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "liquid/lfm-2.5-2.6b:free",
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 1
                },
                timeout=15.0
            )

        if response.status_code == 401:
            result = (False, "Invalid API key")
        elif response.status_code == 402:
            result = (False, "No credits on this API key")
        elif response.status_code >= 500:
            result = (False, "OpenRouter is temporarily unavailable — try again shortly")
        else:
            result = (True, "OK")

    except httpx.TimeoutException:
        return False, "Connection timed out — check your internet connection"
    except httpx.RequestError:
        return False, "Could not reach OpenRouter — check your internet connection"

    # Cache the result
    key_cache[api_key] = {
        "valid": result[0],
        "message": result[1],
        "timestamp": now
    }

    return result


# ── MIDDLEWARE CLASS ───────────────────────────────────────────────────────────

class CodeSentinelMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):

        # Let OPTIONS requests pass through for CORS preflight
        if request.method == "OPTIONS":
            return await call_next(request)

        # Only apply to /review endpoint
        if request.url.path != "/review":
            return await call_next(request)

        # Read and parse body
        try:
            body = await request.body()
            data = json.loads(body)
            api_key = data.get("api_key", "").strip()
        except Exception:
            return JSONResponse(
                status_code=400,
                content={"detail": "Invalid request body"}
            )

        if not api_key:
            return JSONResponse(
                status_code=400,
                content={"detail": "API key is required"}
            )

        # Step 1 — Validate the key (cached after first call)
        valid, message = await validate_key(api_key)
        if not valid:
            return JSONResponse(
                status_code=400,
                content={"detail": message}
            )

        # Step 2 — Check token bucket
        if not consume_token(api_key):
            bucket = get_bucket(api_key)
            wait_time = round(REFILL_INTERVAL / REFILL_RATE, 1)
            return JSONResponse(
                status_code=429,
                content={
                    "detail": f"Rate limit reached — you have {bucket['tokens']:.1f} tokens left. Refills every {wait_time}s."
                }
            )

        # Step 3 — Attach parsed body back so endpoint can read it
        # (Starlette consumes the body stream, we need to restore it)
        async def receive():
            return {"type": "http.request", "body": body}

        request._receive = receive

        # All good — pass to endpoint
        response = await call_next(request)
        return response