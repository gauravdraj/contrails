#!/usr/bin/env python3
"""Key-gated ADS-B relay for the Contrails Worker.

adsb.lol and adsb.fi throttle/deny Cloudflare's shared egress IPs, so the Worker
falls back to this relay, which runs on a residential connection and fetches the
same readsb-style payload. Serves GET /adsb/lat/<lat>/lon/<lon>/dist/<nm>,
/adsb/hex/<hex>, /adsb/callsign/<callsign>, and /fr24?u=<url> for the two
allowlisted FlightRadar24 endpoints.

Env: RELAY_KEY (required), RELAY_PORT (default 8089).
"""

import gzip
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TRAFFIC_UPSTREAMS = ("https://api.adsb.lol/v2", "https://opendata.adsb.fi/api/v3")
# adsb.fi only serves hex/callsign lookups on v2.
LOOKUP_UPSTREAMS = ("https://api.adsb.lol/v2", "https://opendata.adsb.fi/api/v2")
USER_AGENT = "contrails/1.0 (+https://gauravdraj.github.io/contrails/)"
PATH_RE = re.compile(r"^/adsb(/lat/-?\d{1,3}(?:\.\d+)?/lon/-?\d{1,3}(?:\.\d+)?/dist/\d{1,3})$")
LOOKUP_RE = re.compile(r"^/adsb(/hex/[0-9a-f]{6}|/callsign/[A-Z0-9]{2,8})$")
FR24_RE = re.compile(
    r"^https://(?:api\.flightradar24\.com/common/v1/airport\.json"
    r"|www\.flightradar24\.com/v1/search/web/find)\?[A-Za-z0-9_.,%&=\[\]-]{1,400}$"
)
FR24_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)
CACHE_TTL_S = 3
TIMEOUT_S = 5
GZIP_MIN_BYTES = 1024

RELAY_KEY = os.environ.get("RELAY_KEY", "")
_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()


def fetch_upstream(path: str, upstreams: tuple[str, ...]) -> bytes:
    last_err = None
    for base in upstreams:
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
        # Funnel egress is slow enough that an uncompressed FR24 airport board
        # (~800 KB) can blow past the Worker's relay timeout.
        gzip_ok = "gzip" in self.headers.get("Accept-Encoding", "")
        if gzip_ok and len(body) > GZIP_MIN_BYTES:
            body = gzip.compress(body, compresslevel=5)
        else:
            gzip_ok = False
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if gzip_ok:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._send(200, b"ok", "text/plain")
        key = self.headers.get("X-Relay-Key", "")
        if not RELAY_KEY or not hmac.compare_digest(key, RELAY_KEY):
            return self._send(403, b'{"error":"forbidden"}')
        if self.path.startswith("/fr24?"):
            return self._relay_fr24()
        m = PATH_RE.match(self.path)
        upstreams = TRAFFIC_UPSTREAMS
        if not m:
            m = LOOKUP_RE.match(self.path)
            upstreams = LOOKUP_UPSTREAMS
        if not m:
            return self._send(404, b'{"error":"not found"}')
        path = m.group(1)
        now = time.monotonic()
        with _cache_lock:
            hit = _cache.get(path)
        if hit and now - hit[0] < CACHE_TTL_S:
            return self._send(200, hit[1])
        try:
            body = fetch_upstream(path, upstreams)
        except RuntimeError as err:
            return self._send(502, json.dumps({"error": str(err)}).encode())
        with _cache_lock:
            if len(_cache) > 500:
                _cache.clear()
            _cache[path] = (now, body)
        self._send(200, body)

    def _relay_fr24(self) -> None:
        target = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("u", [""])[0]
        if not FR24_RE.match(target):
            return self._send(404, b'{"error":"not found"}')
        req = urllib.request.Request(target, headers={"User-Agent": FR24_USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                body = resp.read()
        except urllib.error.HTTPError as err:
            return self._send(err.code, json.dumps({"error": f"upstream {err.code}"}).encode())
        except (urllib.error.URLError, TimeoutError) as err:
            return self._send(502, json.dumps({"error": str(err)}).encode())
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
