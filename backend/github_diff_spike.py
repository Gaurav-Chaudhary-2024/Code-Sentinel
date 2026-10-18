"""
github_diff_spike.py
GitHub PR diff fetcher for CodeSentinel.
Currently a spike — not wired into the main review flow yet.
Future use: fetch PR diff → pass to /review endpoint as code.

Usage (standalone test):
    python github_diff_spike.py https://github.com/owner/repo/pull/123
"""

import os
import re
import sys
import httpx


def parse_pr_url(url: str) -> tuple[str, str, int]:
    """
    Extract owner, repo, pr_number from a GitHub PR URL.
    Supports:
        https://github.com/owner/repo/pull/123
        https://github.com/owner/repo/pull/123/files
    Returns: (owner, repo, pr_number)
    Raises: ValueError if URL doesn't match expected format.
    """
    pattern = r"https://github\.com/([^/]+)/([^/]+)/pull/(\d+)"
    match = re.search(pattern, url.strip())
    if not match:
        raise ValueError(f"Could not parse GitHub PR URL: {url!r}")
    owner, repo, pr_number = match.group(1), match.group(2), int(match.group(3))
    return owner, repo, pr_number


async def fetch_pr_diff(owner: str, repo: str, pr_number: int) -> str:
    """
    Fetch the unified diff for a GitHub PR.
    Uses GITHUB_TOKEN env var if set (avoids rate limits on public repos,
    required for private repos).
    Returns: raw unified diff as a string.
    """
    token = os.getenv("GITHUB_TOKEN")
    headers = {
        "Accept": "application/vnd.github.v3.diff",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers=headers)

        if response.status_code == 404:
            raise ValueError(f"PR #{pr_number} not found in {owner}/{repo} (or repo is private)")
        if response.status_code == 403:
            raise PermissionError(
                "GitHub rate limit hit or auth required. Set GITHUB_TOKEN in .env"
            )
        response.raise_for_status()
        return response.text


async def fetch_pr_metadata(owner: str, repo: str, pr_number: int) -> dict:
    """
    Fetch PR metadata: title, state, changed files count, additions, deletions.
    """
    token = os.getenv("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github.v3+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()

    return {
        "title": data.get("title", ""),
        "state": data.get("state", ""),
        "changed_files": data.get("changed_files", 0),
        "additions": data.get("additions", 0),
        "deletions": data.get("deletions", 0),
        "base_branch": data.get("base", {}).get("ref", ""),
        "head_branch": data.get("head", {}).get("ref", ""),
    }


# ── Standalone test ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import asyncio

    async def main():
        if len(sys.argv) < 2:
            print("Usage: python github_diff_spike.py <github-pr-url>")
            sys.exit(1)

        pr_url = sys.argv[1]
        try:
            owner, repo, pr_num = parse_pr_url(pr_url)
            print(f"Parsed: owner={owner}, repo={repo}, pr={pr_num}")

            metadata = await fetch_pr_metadata(owner, repo, pr_num)
            print(f"\nPR: {metadata['title']}")
            print(f"State: {metadata['state']}")
            print(f"Files changed: {metadata['changed_files']} (+{metadata['additions']} -{metadata['deletions']})")

            diff = await fetch_pr_diff(owner, repo, pr_num)
            print(f"\nDiff preview (first 500 chars):\n{diff[:500]}")

        except (ValueError, PermissionError) as e:
            print(f"Error: {e}")
            sys.exit(1)

    asyncio.run(main())