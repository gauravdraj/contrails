#!/usr/bin/env python3
"""Dev server: serves static files and proxies adsb.lol API to avoid CORS."""

import gzip
import http.server
import io
import json
import os
import time
import urllib.request
import urllib.parse

PORT = 8766
ADSB_API = "https://api.adsb.lol/v2"
ADSB_ROUTE_API = "https://api.adsb.lol/api/0"

COMPRESSIBLE = {".html", ".json", ".js", ".css", ".svg"}
MIN_COMPRESS = 1024

_gz_cache = {}

try:
    from FlightRadar24 import FlightRadar24API
    _HAS_FR24 = True
except ImportError:
    _HAS_FR24 = False

_fr24_cache = {}
_FR24_TTL = 120


def _extract_fr24_flights(data, direction):
    flights = []
    for item in data:
        f = item.get("flight", {})
        ident = f.get("identification") or {}
        status = f.get("status") or {}
        ac = f.get("aircraft") or {}
        airline = f.get("airline") or {}
        ap = f.get("airport") or {}
        t = f.get("time") or {}
        gen = ((status.get("generic") or {}).get("status") or {})
        entry = {
            "flight": (ident.get("number") or {}).get("default", ""),
            "callsign": ident.get("callsign", ""),
            "airline": airline.get("short") or airline.get("name") or "",
            "ac_code": ((ac.get("model") or {}).get("code") or ""),
            "ac_name": ((ac.get("model") or {}).get("text") or ""),
            "reg": ac.get("registration", ""),
            "status": status.get("text", ""),
            "color": gen.get("color", ""),
            "sched_dep": (t.get("scheduled") or {}).get("departure"),
            "sched_arr": (t.get("scheduled") or {}).get("arrival"),
            "est_dep": (t.get("estimated") or {}).get("departure"),
            "est_arr": (t.get("estimated") or {}).get("arrival"),
            "actual_dep": (t.get("real") or {}).get("departure"),
            "actual_arr": (t.get("real") or {}).get("arrival"),
            "live": status.get("live", False),
        }
        if direction == "arrival":
            origin = ap.get("origin") or {}
            entry["from_iata"] = ((origin.get("code") or {}).get("iata") or "")
            entry["from_name"] = origin.get("name", "")
        else:
            dest = ap.get("destination") or {}
            entry["to_iata"] = ((dest.get("code") or {}).get("iata") or "")
            entry["to_name"] = dest.get("name", "")
        flights.append(entry)
    return flights


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/adsb/"):
            self.proxy_adsb()
        elif self.path.startswith("/api/fr24/schedule/"):
            self._serve_fr24()
        elif "gzip" in self.headers.get("Accept-Encoding", ""):
            self._serve_gzipped()
        else:
            super().do_GET()

    def _serve_gzipped(self):
        path = self.translate_path(self.path)
        _, ext = os.path.splitext(path)
        if ext not in COMPRESSIBLE or not os.path.isfile(path):
            super().do_GET()
            return
        try:
            mtime = os.path.getmtime(path)
            cached = _gz_cache.get(path)
            if cached and cached[0] == mtime:
                gz_data = cached[1]
            else:
                with open(path, "rb") as f:
                    raw = f.read()
                if len(raw) < MIN_COMPRESS:
                    super().do_GET()
                    return
                buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                    gz.write(raw)
                gz_data = buf.getvalue()
                _gz_cache[path] = (mtime, gz_data)

            ctype = self.guess_type(path)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(gz_data)))
            self.end_headers()
            self.wfile.write(gz_data)
        except Exception:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/adsb-route/"):
            self.proxy_route()
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def proxy_adsb(self):
        rest = self.path[len("/api/adsb"):]
        url = f"{ADSB_API}{rest}"
        self._proxy(url)

    def proxy_route(self):
        rest = self.path[len("/api/adsb-route"):]
        url = f"{ADSB_ROUTE_API}{rest}"
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        self._proxy(url, method="POST", body=body)

    def _proxy(self, url, method="GET", body=None):
        try:
            req = urllib.request.Request(
                url, data=body, method=method,
                headers={"User-Agent": "contrails/1.0", "Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _serve_fr24(self):
        if not _HAS_FR24:
            self._json_resp(501, {"error": "FlightRadar24 not installed"})
            return
        iata = self.path.rsplit("/", 1)[-1].upper()
        now = time.time()
        cached = _fr24_cache.get(iata)
        if cached and now - cached[0] < _FR24_TTL:
            self._json_resp(200, cached[1])
            return
        try:
            fr = FlightRadar24API()
            raw = fr.get_airport_details(iata)
            plugin = raw.get("airport", {}).get("pluginData", {})
            sched = plugin.get("schedule", {})
            detail = plugin.get("details", {})
            result = {
                "iata": iata,
                "name": detail.get("name", iata),
                "arrivals": _extract_fr24_flights(
                    sched.get("arrivals", {}).get("data", []), "arrival"),
                "departures": _extract_fr24_flights(
                    sched.get("departures", {}).get("data", []), "departure"),
            }
            _fr24_cache[iata] = (now, result)
            self._json_resp(200, result)
        except Exception as e:
            self._json_resp(502, {"error": str(e)})

    def _json_resp(self, code, data):
        payload = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        path = str(args[0]) if args else ""
        if "/api/" in path:
            print(f"  [proxy] {path}")


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    print(f"Open: http://localhost:{PORT}/?lat=51.5074&lng=-0.1278")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
