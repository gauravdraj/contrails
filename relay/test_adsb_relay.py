"""Tests for adsb_relay.py. Stdlib only, no network beyond a loopback test server.

Run: python3 -m unittest discover -s relay -p 'test_*.py'
"""

import contextlib
import gzip
import http.client
import importlib.util
import io
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("adsb_relay", os.path.join(_HERE, "adsb_relay.py"))
relay = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(relay)

KEY = "test-key"
VALID = json.dumps({"ac": [{"hex": "abc123"}], "now": 1}).encode()
FR24_URL = "https://api.flightradar24.com/common/v1/airport.json?code=SFO&plugin[]=schedule"


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class RelayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), relay.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        relay.RELAY_KEY = KEY
        relay._cache.clear()
        if hasattr(relay, "_inflight"):
            relay._inflight.clear()
        self.calls = []
        self.calls_lock = threading.Lock()

    def get(self, path, key=KEY, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("GET", path, skip_accept_encoding=True)
            if key is not None:
                conn.putheader("X-Relay-Key", key)
            for name, value in (headers or {}).items():
                conn.putheader(name, value)
            conn.endheaders()
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read()
        finally:
            conn.close()

    def fake_fetch(self, bodies, delays=None):
        """Patch _fetch_one: url prefix -> body (bytes) or exception."""
        delays = delays or {}

        def fetch(url):
            with self.calls_lock:
                self.calls.append(url)
            for prefix, delay in delays.items():
                if url.startswith(prefix):
                    time.sleep(delay)
            for prefix, body in bodies.items():
                if url.startswith(prefix):
                    if isinstance(body, Exception):
                        raise body
                    return body
            raise AssertionError("unexpected url " + url)

        return mock.patch.object(relay, "_fetch_one", fetch)


class AuthTest(RelayTest):
    def test_missing_key_403(self):
        self.assertEqual(self.get("/adsb/hex/abc123", key=None)[0], 403)

    def test_wrong_key_403(self):
        self.assertEqual(self.get("/adsb/hex/abc123", key="nope")[0], 403)

    def test_non_ascii_key_403_no_exception(self):
        # http.client sends latin-1; the server decodes it to a non-ASCII str.
        status, _, body = self.get("/adsb/hex/abc123", key="tést-key")
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body), {"error": "forbidden"})

    def test_unset_relay_key_403(self):
        relay.RELAY_KEY = ""
        self.assertEqual(self.get("/adsb/hex/abc123", key="")[0], 403)

    def test_good_key_200(self):
        with self.fake_fetch({"https://": VALID}):
            status, _, body = self.get("/adsb/hex/abc123")
        self.assertEqual((status, body), (200, VALID))


class CoordTest(RelayTest):
    def test_out_of_range_rejected_without_upstream(self):
        with self.fake_fetch({"https://": VALID}):
            for path in (
                "/adsb/lat/999/lon/0/dist/25",
                "/adsb/lat/-90.5/lon/0/dist/25",
                "/adsb/lat/0/lon/180.01/dist/25",
                "/adsb/lat/0/lon/-999/dist/25",
                "/adsb/lat/0/lon/0/dist/0",
                "/adsb/lat/0/lon/0/dist/251",
            ):
                self.assertEqual(self.get(path)[0], 404, path)
        self.assertEqual(self.calls, [])

    def test_in_range_accepted(self):
        with self.fake_fetch({"https://": VALID}):
            for path in (
                "/adsb/lat/37.62/lon/-122.38/dist/25",
                "/adsb/lat/-90/lon/180/dist/250",
                "/adsb/lat/90.00/lon/-180.00/dist/1",
            ):
                self.assertEqual(self.get(path)[0], 200, path)


class CacheTest(RelayTest):
    def test_expired_entries_evicted_on_insert(self):
        relay._cache["/hex/dead00"] = (time.monotonic() - 100, b"x" * 10)
        with self.fake_fetch({"https://": VALID}):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)
        self.assertNotIn("/hex/dead00", relay._cache)
        self.assertIn("/hex/abc123", relay._cache)

    def test_total_bytes_capped_oldest_first(self):
        big = json.dumps({"ac": [], "pad": "x" * 400}).encode()
        with mock.patch.object(relay, "CACHE_MAX_BYTES", len(big) * 2 + 10), \
                self.fake_fetch({"https://": big}):
            for hexid in ("aaaaa1", "aaaaa2", "aaaaa3"):
                self.assertEqual(self.get("/adsb/hex/" + hexid)[0], 200)
        self.assertEqual(list(relay._cache), ["/hex/aaaaa2", "/hex/aaaaa3"])
        self.assertLessEqual(sum(len(b) for _, b in relay._cache.values()), len(big) * 2 + 10)

    def test_ttl_starts_at_insert_not_before_fetch(self):
        # Fetch slower than the TTL: the entry must still be fresh right after.
        with mock.patch.object(relay, "CACHE_TTL_S", 1.0), \
                self.fake_fetch({"https://": VALID}, delays={"https://": 1.3}):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)
            first = len(self.calls)
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)
        self.assertEqual(len(self.calls), first, "second request should be a cache hit")


class RaceTest(RelayTest):
    LOL = "https://api.adsb.lol"
    FI = "https://opendata.adsb.fi"

    def test_invalid_fast_200_loses_to_valid_slower(self):
        bodies = {self.LOL: b'{"error":"rate limited"}', self.FI: VALID}
        with self.fake_fetch(bodies, delays={self.FI: 0.2}):
            status, _, body = self.get("/adsb/hex/abc123")
        self.assertEqual((status, body), (200, VALID))
        self.assertEqual(relay._cache["/hex/abc123"][1], VALID)

    def test_all_invalid_is_502_and_not_cached(self):
        bodies = {self.LOL: b'{"error":"x"}', self.FI: b"<html>nope</html>"}
        with self.fake_fetch(bodies):
            status, _, body = self.get("/adsb/hex/abc123")
        self.assertEqual(status, 502)
        self.assertIn("error", json.loads(body))
        self.assertEqual(relay._cache, {})

    def test_ac_must_be_a_list(self):
        bodies = {self.LOL: b'{"ac":null}', self.FI: b"[1,2]"}
        with self.fake_fetch(bodies):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 502)
        self.assertEqual(relay._cache, {})


class SingleFlightTest(RelayTest):
    N = 6

    def run_concurrent(self, path):
        results = [None] * self.N

        def one(i):
            results[i] = self.get(path)

        threads = [threading.Thread(target=one, args=(i,)) for i in range(self.N)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        return results

    def test_concurrent_identical_misses_share_one_fetch(self):
        with self.fake_fetch({"https://": VALID}, delays={"https://": 0.5}):
            results = self.run_concurrent("/adsb/hex/abc123")
        self.assertEqual([r[0] for r in results], [200] * self.N)
        self.assertTrue(all(r[2] == VALID for r in results))
        # One race = one call per upstream, not N races.
        self.assertEqual(len(self.calls), len(relay.LOOKUP_UPSTREAMS))

    def test_leader_failure_reaches_followers_as_502(self):
        err = urllib.error.URLError("boom")
        buf = io.StringIO()
        with self.fake_fetch({"https://": err}, delays={"https://": 1.5}), contextlib.redirect_stderr(buf):
            start = time.monotonic()
            results = self.run_concurrent("/adsb/hex/abc123")
        self.assertEqual([r[0] for r in results], [502] * self.N)
        self.assertEqual(len(buf.getvalue().splitlines()), 1, "one log line per shared failure")
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(len(self.calls), len(relay.LOOKUP_UPSTREAMS))
        self.assertEqual(relay._inflight, {})
        # Slot released: a later request still reaches upstream.
        with self.fake_fetch({"https://": VALID}):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)

    def test_slot_held_until_losing_racer_exits(self):
        slots = threading.BoundedSemaphore(1)
        bodies = {RaceTest.LOL: VALID, RaceTest.FI: VALID}
        with mock.patch.object(relay, "_upstream_slots", slots), \
                self.fake_fetch(bodies, delays={RaceTest.FI: 1.0}):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)
            # The adsb.fi loser is still reading: no slot for a new miss.
            self.assertEqual(self.get("/adsb/hex/abc124")[0], 503)
            time.sleep(1.3)
            self.assertEqual(self.get("/adsb/hex/abc124")[0], 200)

    def test_slots_exhausted_returns_503_fast(self):
        with mock.patch.object(relay, "_upstream_slots", threading.BoundedSemaphore(1)):
            relay._upstream_slots.acquire()
            with self.fake_fetch({"https://": VALID}):
                self.assertEqual(self.get("/adsb/hex/abc123")[0], 503)
                self.assertEqual(self.get("/fr24?u=" + urllib.request.quote(FR24_URL, safe=""))[0], 503)
            self.assertEqual(self.calls, [])
            # Cache hits need no slot.
            relay._cache["/hex/abc123"] = (time.monotonic(), VALID)
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)


class Fr24Test(RelayTest):
    def fr24(self, target):
        return self.get("/fr24?u=" + urllib.request.quote(target, safe=""))

    def patch_open(self, result):
        opened = []

        def fake_open(director, req, data=None, timeout=None):
            opened.append(req.full_url)
            if isinstance(result, BaseException):
                raise result
            return FakeResp(result)

        # OpenerDirector.open backs both urllib.request.urlopen and custom openers.
        return opened, mock.patch.object(urllib.request.OpenerDirector, "open", fake_open)

    def test_ok(self):
        opened, patch = self.patch_open(b'{"result":1}')
        with patch:
            status, _, body = self.fr24(FR24_URL)
        self.assertEqual((status, body), (200, b'{"result":1}'))
        self.assertEqual(opened, [FR24_URL])

    def test_trailing_newline_rejected(self):
        opened, patch = self.patch_open(b"{}")
        with patch:
            self.assertEqual(self.fr24(FR24_URL + "\n")[0], 404)
        self.assertEqual(opened, [])

    def test_off_allowlist_rejected(self):
        opened, patch = self.patch_open(b"{}")
        with patch:
            self.assertEqual(self.fr24("https://evil.example/common/v1/airport.json?code=SFO")[0], 404)
        self.assertEqual(opened, [])

    def test_read_exceptions_are_502(self):
        for exc in (
            http.client.IncompleteRead(b"partial"),
            ConnectionResetError("reset"),
            http.client.InvalidURL("bad"),
            OSError("ssl-ish"),
        ):
            _, patch = self.patch_open(exc)
            with patch:
                status, _, body = self.fr24(FR24_URL)
            self.assertEqual(status, 502, repr(exc))
            self.assertIn("error", json.loads(body))

    def test_upstream_http_error_passthrough(self):
        err = urllib.error.HTTPError(FR24_URL, 429, "Too Many", {}, None)
        self.addCleanup(err.close)
        _, patch = self.patch_open(err)
        with patch:
            self.assertEqual(self.fr24(FR24_URL)[0], 429)

    def test_oversize_body_is_502(self):
        _, patch = self.patch_open(b"x" * 2000)
        with patch, mock.patch.object(relay, "MAX_BODY_BYTES", 1000):
            self.assertEqual(self.fr24(FR24_URL)[0], 502)

    def test_redirect_off_allowlist_not_followed(self):
        handler = relay._AllowlistRedirectHandler()
        req = urllib.request.Request(FR24_URL)
        self.assertIsNone(handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/x"))
        followed = handler.redirect_request(
            req, None, 302, "Found", {}, "https://www.flightradar24.com/v1/search/web/find?query=UA1")
        self.assertIsNotNone(followed)

    def test_blocked_redirect_maps_to_502(self):
        err = urllib.error.HTTPError(FR24_URL, 302, "Found", {}, None)
        self.addCleanup(err.close)
        _, patch = self.patch_open(err)
        with patch:
            self.assertEqual(self.fr24(FR24_URL)[0], 502)


class SizeCapTest(unittest.TestCase):
    def test_fetch_one_rejects_oversize(self):
        with mock.patch.object(relay, "MAX_BODY_BYTES", 100), \
                mock.patch.object(urllib.request, "urlopen", lambda req, timeout=None: FakeResp(b"x" * 101)):
            with self.assertRaises(Exception):
                relay._fetch_one("https://api.adsb.lol/v2/hex/abc123")

    def test_fetch_one_accepts_at_cap(self):
        with mock.patch.object(relay, "MAX_BODY_BYTES", 100), \
                mock.patch.object(urllib.request, "urlopen", lambda req, timeout=None: FakeResp(b"x" * 100)):
            self.assertEqual(len(relay._fetch_one("https://api.adsb.lol/v2/hex/abc123")), 100)


class GzipTest(RelayTest):
    BIG = json.dumps({"ac": [{"hex": "abc123", "pad": "x" * 4000}]}).encode()

    def encoding_for(self, accept):
        relay._cache.clear()
        with self.fake_fetch({"https://": self.BIG}):
            status, headers, body = self.get("/adsb/hex/abc123", headers={"Accept-Encoding": accept})
        self.assertEqual(status, 200)
        enc = headers.get("Content-Encoding")
        self.assertEqual(gzip.decompress(body) if enc == "gzip" else body, self.BIG)
        return enc

    def test_q_zero_refuses_gzip(self):
        self.assertIsNone(self.encoding_for("gzip;q=0"))
        self.assertIsNone(self.encoding_for("br, gzip; q=0.0"))

    def test_gzip_still_used(self):
        for accept in ("gzip", "gzip, deflate, br", "br, gzip", "GZIP", "gzip;q=0.5", "deflate, gzip;q=1"):
            self.assertEqual(self.encoding_for(accept), "gzip", accept)

    def test_no_gzip(self):
        self.assertIsNone(self.encoding_for("br"))


class MiscTest(RelayTest):
    def test_handler_has_socket_timeout(self):
        self.assertEqual(relay.Handler.timeout, 10)

    def test_upstream_failure_logs_one_line_without_key(self):
        err = urllib.error.URLError("boom")
        buf = io.StringIO()
        with self.fake_fetch({"https://": err}), contextlib.redirect_stderr(buf):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 502)
        lines = [ln for ln in buf.getvalue().splitlines() if ln]
        self.assertEqual(len(lines), 1, lines)
        self.assertNotIn(KEY, buf.getvalue())

    def test_successful_request_not_logged(self):
        buf = io.StringIO()
        with self.fake_fetch({"https://": VALID}), contextlib.redirect_stderr(buf):
            self.assertEqual(self.get("/adsb/hex/abc123")[0], 200)
        self.assertEqual(buf.getvalue(), "")

    def test_main_exits_nonzero_without_key(self):
        relay.RELAY_KEY = ""
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf), self.assertRaises(SystemExit) as cm:
            relay.main()
        self.assertNotIn(cm.exception.code, (0, None))


if __name__ == "__main__":
    unittest.main()
