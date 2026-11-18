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
import queue
import re
import sys
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
PATH_RE = re.compile(
    r"^/adsb(/lat/(-?\d{1,3}(?:\.\d+)?)/lon/(-?\d{1,3}(?:\.\d+)?)/dist/(\d{1,3}))$"
)
LOOKUP_RE = re.compile(r"^/adsb(/hex/[0-9a-f]{6}|/callsign/[A-Z0-9]{2,8})$")
# Used with fullmatch (re.match + "$" also accepted a trailing newline).
FR24_RE = re.compile(
    r"https://(?:api\.flightradar24\.com/common/v1/airport\.json"
    r"|www\.flightradar24\.com/v1/search/web/find)\?[A-Za-z0-9_.,%&=\[\]-]{1,400}"
)
FR24_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)
CACHE_TTL_S = 3
TIMEOUT_S = 5
# Overall bound on one upstream race and on each upstream fetch; urlopen's
# timeout is per socket op, so a trickling body needs its own deadline.
RACE_DEADLINE_S = 2 * TIMEOUT_S
READ_CHUNK_BYTES = 64 * 1024
GZIP_MIN_BYTES = 1024
# adsb.fi rejects a dist above 250 NM; the Worker clamps to the same range.
MAX_DIST_NM = 250
MAX_BODY_BYTES = 8 * 1024 * 1024
CACHE_MAX_BYTES = 32 * 1024 * 1024
UPSTREAM_SLOTS = 8

RELAY_KEY = os.environ.get("RELAY_KEY", "")
# Insertion-ordered, so the first key is the oldest entry.
_cache: dict[str, tuple[float, bytes]] = {}
_cache_lock = threading.Lock()
# Single-flight: at most one upstream fetch per cache key at a time.
_inflight: dict = {}
_inflight_lock = threading.Lock()
# Bounds concurrent upstream work (adsb races and /fr24 fetches).
_upstream_slots = threading.BoundedSemaphore(UPSTREAM_SLOTS)


class Busy(Exception):
    """All upstream slots are in use."""


class _Flight:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.body = None
        self.error = None


def _log(msg: str) -> None:
    print("contrails-relay: " + msg, file=sys.stderr, flush=True)


def _read_capped(resp, deadline: float) -> bytes:
    # read1 does at most one socket read (each bounded by the socket timeout),
    # so checking the monotonic deadline between chunks bounds the whole read:
    # a trickling loser exits by deadline + TIMEOUT_S and frees its slot.
    read = getattr(resp, "read1", resp.read)
    chunks, size = [], 0
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError("upstream read deadline exceeded")
        chunk = read(READ_CHUNK_BYTES)
        if not chunk:
            return b"".join(chunks)
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise ValueError(f"upstream body over {MAX_BODY_BYTES} bytes")
        chunks.append(chunk)


def _check_payload(body: bytes) -> None:
    # Same shape the Worker accepts (providers.js isValidPayload): an object
    # with an `ac` list. Anything else (e.g. {"error":...}) must not win.
    try:
        ok = isinstance(json.loads(body).get("ac"), list)
    except (ValueError, AttributeError):
        ok = False
    if not ok:
        raise ValueError("invalid upstream payload")


def _fetch_one(url: str) -> bytes:
    deadline = time.monotonic() + RACE_DEADLINE_S
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        return _read_capped(resp, deadline)


def fetch_upstream(path: str, upstreams: tuple[str, ...], on_done=None) -> bytes:
    # adsb.lol swings between ~0.8s and 5s+, so trying upstreams one after
    # another can outlast the Worker's 6s relay timeout. Race them instead.
    # on_done, if given, runs exactly once, after the LAST racer exits (losers
    # keep reading after a winner returns), so a slot it frees bounds them too.
    results: queue.Queue = queue.Queue()
    pending = [len(upstreams)]
    pending_lock = threading.Lock()

    def finish() -> None:
        with pending_lock:
            pending[0] -= 1
            last = pending[0] == 0
        if last and on_done is not None:
            on_done()

    def worker(base: str) -> None:
        try:
            body = _fetch_one(base + path)
            _check_payload(body)
            results.put((True, body))
        except Exception as err:  # noqa: BLE001 - any failure just loses the race
            results.put((False, err))
        finally:
            finish()

    for base in upstreams:
        try:
            threading.Thread(target=worker, args=(base,), daemon=True).start()
        except RuntimeError as err:  # can't start a thread: counts as a lost racer
            results.put((False, err))
            finish()
    deadline = time.monotonic() + RACE_DEADLINE_S
    last_err = None
    for _ in upstreams:
        try:
            ok, value = results.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError(f"all upstreams failed: timed out ({last_err})") from None
        if ok:
            return value
        last_err = value
    raise RuntimeError(f"all upstreams failed: {last_err}")


def _cache_get(key: str):
    with _cache_lock:
        hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL_S:
        return hit[1]
    return None


def _cache_put(key: str, body: bytes) -> None:
    # Timestamp at insertion so a slow fetch isn't cached already expired.
    now = time.monotonic()
    with _cache_lock:
        _cache.pop(key, None)
        for k in [k for k, (ts, _) in _cache.items() if now - ts >= CACHE_TTL_S]:
            del _cache[k]
        if len(body) > CACHE_MAX_BYTES:
            return
        total = sum(len(b) for _, b in _cache.values())
        while _cache and total + len(body) > CACHE_MAX_BYTES:
            total -= len(_cache.pop(next(iter(_cache)))[1])
        _cache[key] = (now, body)


def fetch_cached(path: str, upstreams: tuple[str, ...]) -> bytes:
    """Cached, single-flight upstream fetch. Raises Busy or RuntimeError."""
    with _inflight_lock:
        body = _cache_get(path)
        if body is not None:
            return body
        flight = _inflight.get(path)
        leader = flight is None
        if leader:
            if not _upstream_slots.acquire(blocking=False):
                raise Busy()
            flight = _Flight()
            _inflight[path] = flight
    if not leader:
        if not flight.done.wait(RACE_DEADLINE_S + 1):
            raise RuntimeError("all upstreams failed: timed out waiting for shared fetch")
        if flight.error is not None:
            raise RuntimeError(str(flight.error))
        return flight.body
    try:
        # The slot is freed by fetch_upstream once every racer has exited.
        body = fetch_upstream(path, upstreams, on_done=_upstream_slots.release)
        _cache_put(path, body)
        flight.body = body
        return body
    except Exception as err:  # noqa: BLE001 - followers get the same 502
        flight.error = err if isinstance(err, RuntimeError) else RuntimeError(str(err))
        # Logged once by the leader, not once per waiting request.
        _log(f"upstream failure {path}: {flight.error}")
        raise flight.error from None
    finally:
        with _inflight_lock:
            _inflight.pop(path, None)
        flight.done.set()


def _coords_ok(m) -> bool:
    lat, lon, dist = float(m.group(2)), float(m.group(3)), int(m.group(4))
    return -90 <= lat <= 90 and -180 <= lon <= 180 and 0 < dist <= MAX_DIST_NM


def _accepts_gzip(header: str) -> bool:
    for part in header.split(","):
        name, _, params = part.partition(";")
        if name.strip().lower() != "gzip":
            continue
        q = 1.0
        for param in params.split(";"):
            pname, _, pval = param.partition("=")
            if pname.strip().lower() == "q":
                try:
                    q = float(pval.strip())
                except ValueError:
                    q = 0.0
        return q > 0
    return False


class _AllowlistRedirectHandler(urllib.request.HTTPRedirectHandler):
    # Only follow redirects that stay on the FR24 allowlist; anything else
    # surfaces as an HTTPError 3xx, which _relay_fr24 maps to 502.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not FR24_RE.fullmatch(newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_fr24_opener = urllib.request.build_opener(_AllowlistRedirectHandler)


class Handler(BaseHTTPRequestHandler):
    server_version = "contrails-relay"
    # Socket timeout so a half-sent request can't pin a thread forever.
    timeout = 10

    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        # Funnel egress is slow enough that an uncompressed FR24 airport board
        # (~800 KB) can blow past the Worker's relay timeout.
        gzip_ok = _accepts_gzip(self.headers.get("Accept-Encoding", ""))
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

    def _key_ok(self) -> bool:
        if not RELAY_KEY:
            return False
        try:
            # http.server decodes headers as latin-1; compare bytes so a
            # non-ASCII key can't raise TypeError in compare_digest.
            got = self.headers.get("X-Relay-Key", "").encode("latin-1")
            return hmac.compare_digest(got, RELAY_KEY.encode("utf-8"))
        except (UnicodeError, TypeError):
            return False

    def do_GET(self) -> None:
        if self.path == "/healthz":
            return self._send(200, b"ok", "text/plain")
        if not self._key_ok():
            return self._send(403, b'{"error":"forbidden"}')
        if self.path.startswith("/fr24?"):
            return self._relay_fr24()
        m = PATH_RE.match(self.path)
        upstreams = TRAFFIC_UPSTREAMS
        if m and not _coords_ok(m):
            m = None
        elif not m:
            m = LOOKUP_RE.match(self.path)
            upstreams = LOOKUP_UPSTREAMS
        if not m:
            return self._send(404, b'{"error":"not found"}')
        path = m.group(1)
        try:
            body = fetch_cached(path, upstreams)
        except Busy:
            _log(f"busy, rejected {path}")
            return self._send(503, b'{"error":"busy"}')
        except RuntimeError as err:
            return self._send(502, json.dumps({"error": str(err)}).encode())
        self._send(200, body)

    def _relay_fr24(self) -> None:
        target = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("u", [""])[0]
        if not FR24_RE.fullmatch(target):
            return self._send(404, b'{"error":"not found"}')
        if not _upstream_slots.acquire(blocking=False):
            _log("busy, rejected fr24")
            return self._send(503, b'{"error":"busy"}')
        req = urllib.request.Request(target, headers={"User-Agent": FR24_USER_AGENT})
        deadline = time.monotonic() + RACE_DEADLINE_S
        try:
            with _fr24_opener.open(req, timeout=TIMEOUT_S) as resp:
                body = _read_capped(resp, deadline)
        except urllib.error.HTTPError as err:
            _log(f"fr24 upstream {err.code}: {target}")
            if 300 <= err.code < 400:
                return self._send(502, json.dumps({"error": f"upstream redirect {err.code}"}).encode())
            return self._send(err.code, json.dumps({"error": f"upstream {err.code}"}).encode())
        except Exception as err:  # noqa: BLE001 - IncompleteRead, resets, ssl, InvalidURL, oversize
            _log(f"fr24 upstream failure {target}: {err!r}")
            return self._send(502, json.dumps({"error": str(err)}).encode())
        finally:
            _upstream_slots.release()
        self._send(200, body)

    def log_message(self, fmt, *args) -> None:
        # Per-request access logs stay off; failures and startup go via _log.
        pass


def main() -> None:
    if not RELAY_KEY:
        print("contrails-relay: RELAY_KEY is required (set it in the EnvironmentFile)", file=sys.stderr)
        sys.exit(1)
    port = int(os.environ.get("RELAY_PORT", "8089"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    _log(f"listening on 127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
