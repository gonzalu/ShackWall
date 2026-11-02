"""One polite HTTP client for every data source.

Every request names ShackWall in its User-Agent. A response the server says
is good for a while (Cache-Control: max-age) is reused until then without
asking at all. After that, the request is sent as a conditional one with the ETag and Last-Modified the
server gave last time. A provider whose data hasn't changed answers with an
empty 304 and we reuse what we already have. Each source decides how often it
asks; this module only makes sure that asking costs the provider as little as
possible.
"""
import logging
import re
import time

import httpx

from . import config

log = logging.getLogger("shackwall.fetch")

_client: httpx.AsyncClient | None = None
# url -> {"etag", "last_modified", "body", "fresh_until"}
_cache: dict[str, dict] = {}


def client():
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"User-Agent": config.user_agent()},
            timeout=httpx.Timeout(10.0),
            follow_redirects=True,
        )
    return _client


async def close():
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def get_text(url):
    """The body at url, revalidated rather than re-downloaded when possible.

    Raises on a network error or an HTTP error status, so the caller's loop can
    keep its last good data and record what went wrong.
    """
    headers = {}
    hit = _cache.get(url)
    if hit and time.time() < hit["fresh_until"]:
        return hit["body"]
    if hit:
        if hit["etag"]:
            headers["If-None-Match"] = hit["etag"]
        if hit["last_modified"]:
            headers["If-Modified-Since"] = hit["last_modified"]
    r = await client().get(url, headers=headers)
    if r.status_code == 304 and hit:
        hit["fresh_until"] = _fresh_until(r)
        return hit["body"]
    r.raise_for_status()
    _cache[url] = {
        "etag": r.headers.get("etag"),
        "last_modified": r.headers.get("last-modified"),
        "body": r.text,
        "fresh_until": _fresh_until(r),
    }
    return r.text


def _fresh_until(response):
    cc = response.headers.get("cache-control", "")
    if "no-cache" in cc or "no-store" in cc:
        return 0
    m = re.search(r"(?<!s-)max-age=(\d+)", cc)
    return time.time() + int(m.group(1)) if m else 0
