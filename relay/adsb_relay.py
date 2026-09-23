#!/usr/bin/env python3
"""Key-gated ADS-B relay for the Contrails Worker.

adsb.lol and adsb.fi throttle/deny Cloudflare's shared egress IPs, so the Worker
falls back to this relay, which runs on a residential connection and fetches the
same readsb-style payload. Only GET /adsb/lat/<lat>/lon/<lon>/dist/<nm> is served.

Env: RELAY_KEY (required), RELAY_PORT (default 8089).
"""

import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAMS = ("https://api.adsb.lol/v2", "https://opendata.adsb.fi/api/v3")
USER_AGENT = "contrails/1.0 (+https://gauravdraj.github.io/contrails/)"
PATH_RE = re.compile(r"^/adsb(/lat/-?\d{1,3}(?:\.\d+)?/lon/-?\d{1,3}(?:\.\d+)?/dist/\d{1,3})$")
CACHE_TTL_S = 3
TIMEOUT_S = 5

RELAY_KEY = os.environ.get("RELAY_KEY", "")
_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()


def fetch_upstream(path: str) -> bytes:
    last_err = None
    for base in UPSTREAMS:
        req = urllib.request.Request(base + path, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError) as err:
            last_err = err
    raise RuntimeError(f"all upstreams failed: {last_err}")


class Handler(BaseHTTPRequestHandler):
    server_version = "contrails-relay"

    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._send(200, b"ok", "text/plain")
        key = self.headers.get("X-Relay-Key", "")
        if not RELAY_KEY or not hmac.compare_digest(key, RELAY_KEY):
            return self._send(403, b'{"error":"forbidden"}')
        m = PATH_RE.match(self.path)
        if not m:
            return self._send(404, b'{"error":"not found"}')
        path = m.group(1)
        now = time.monotonic()
        with _cache_lock:
            hit = _cache.get(path)
        if hit and now - hit[0] < CACHE_TTL_S:
            return self._send(200, hit[1])
        try:
            body = fetch_upstream(path)
        except RuntimeError as err:
            return self._send(502, json.dumps({"error": str(err)}).encode())
        with _cache_lock:
            if len(_cache) > 500:
                _cache.clear()
            _cache[path] = (now, body)
        self._send(200, body)

    def log_message(self, fmt, *args) -> None:
        pass


def main() -> None:
    if not RELAY_KEY:
        raise SystemExit("RELAY_KEY is required")
    port = int(os.environ.get("RELAY_PORT", "8089"))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
