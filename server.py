#!/usr/bin/env python3
"""Dev server: serves static files and proxies adsb.lol API to avoid CORS."""

import http.server
import json
import re
import time
import urllib.parse
import urllib.request

PORT = 8766
ADSB_API = "https://api.adsb.lol/v2"
ADSB_ROUTE_API = "https://api.adsb.lol/api/0"
PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos"
OPENSKY_API = "https://opensky-network.org/api"
FR24_API = "https://api.flightradar24.com/common/v1"
FR24_CACHE_TTL = 300
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}
PROXY_HEADERS = {
    "User-Agent": "contrails/1.0",
    "Content-Type": "application/json",
}
FR24_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)",
}
SCHEDULE_CACHE = {}
LOCAL_GEO = {
    "lat": 51.5074,
    "lng": -0.1278,
    "label": "local dev default area",
    "source": "local-dev-default",
    "approximate": False,
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/adsb/"):
            self._proxy_adsb(self.path[len("/api/adsb"):])
        elif self.path == "/api/geo":
            self._send_json(LOCAL_GEO)
        elif self.path.startswith("/api/fr24/schedule/"):
            self._handle_schedule()
        elif self.path.startswith("/api/fr24/search/"):
            self._handle_fr24_search()
        elif self.path.startswith("/api/photo/"):
            hex_id = self.path[len("/api/photo/"):]
            self._proxy(f"{PLANESPOTTERS_API}/hex/{hex_id}")
        elif self.path.startswith("/api/track/"):
            hex_id = self.path[len("/api/track/"):]
            self._proxy(f"{OPENSKY_API}/tracks/all?icao24={hex_id}&time=0")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/adsb-route/"):
            rest = self.path[len("/api/adsb-route"):]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
            self._proxy(f"{ADSB_ROUTE_API}{rest}", method="POST", body=body)
        elif self.path == "/api/routeset":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
            self._proxy(f"{ADSB_ROUTE_API}/routeset", method="POST", body=body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()

    def _proxy_adsb(self, path):
        """Proxy ADS-B requests, normalizing grid responses to match
        the Worker's output shape (adds source field)."""
        url = ADSB_API + path
        try:
            req = urllib.request.Request(
                url, method="GET", headers=PROXY_HEADERS,
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
        except Exception as e:
            self._send_json({"error": str(e)}, status=502)
            return

        is_grid = "/lat/" in path and "/lon/" in path and "/dist/" in path
        if is_grid:
            try:
                data = json.loads(raw)
                data.setdefault("source", "primary")
                data.setdefault("ctime", data.get("now", time.time()))
                self._send_json(data)
            except (json.JSONDecodeError, ValueError):
                self._send_bytes(raw)
        else:
            self._send_bytes(raw)

    def _proxy(self, url, method="GET", body=None):
        try:
            req = urllib.request.Request(
                url, data=body, method=method,
                headers=PROXY_HEADERS,
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
            self._send_bytes(data)
        except Exception as e:
            self._send_json({"error": str(e)}, status=502)

    def _send_bytes(self, payload, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for key, value in CORS_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _send_json(self, payload, status=200):
        self._send_bytes(json.dumps(payload).encode(), status=status)

    def _handle_schedule(self):
        iata = self.path.split("/api/fr24/schedule/", 1)[-1].split("?", 1)[0].upper()
        if not iata:
            self._send_json({"error": "Missing airport code"}, status=400)
            return

        cached = SCHEDULE_CACHE.get(iata)
        now = time.time()
        if cached and cached["expires_at"] > now:
            self._send_json(cached["payload"])
            return

        try:
            query = urllib.parse.urlencode({
                "code": iata,
                "plugin[]": ["schedule", "details"],
                "limit": 100,
                "page": 1
            }, doseq=True)
            req = urllib.request.Request(
                f"{FR24_API}/airport.json?{query}",
                headers=FR24_HEADERS,
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                raw = json.loads(resp.read().decode())

            payload = build_schedule_payload(raw, iata)
            SCHEDULE_CACHE[iata] = {
                "expires_at": now + FR24_CACHE_TTL,
                "payload": payload,
            }
            self._send_json(payload)
        except Exception as e:
            self._send_json({"error": str(e)}, status=502)

    def _handle_fr24_search(self):
        query = self.path.split("/api/fr24/search/", 1)[-1].split("?", 1)[0]
        if not query or not re.fullmatch(r'[A-Za-z0-9]{2,10}', query):
            self._send_json({"error": "Invalid query"}, status=400)
            return

        cached = SCHEDULE_CACHE.get(f"search:{query}")
        now = time.time()
        if cached and cached["expires_at"] > now:
            self._send_json(cached["payload"])
            return

        try:
            search_url = f"https://www.flightradar24.com/v1/search/web/find?query={urllib.parse.quote(query)}&limit=8"
            req = urllib.request.Request(search_url, headers=FR24_HEADERS)
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode())

            SCHEDULE_CACHE[f"search:{query}"] = {
                "expires_at": now + FR24_CACHE_TTL,
                "payload": data,
            }
            self._send_json(data)
        except Exception as e:
            self._send_json({"error": str(e)}, status=502)

    def log_message(self, format, *args):
        path = str(args[0]) if args else ""
        if "/api/" in path:
            print(f"  [proxy] {path}")


def extract_flights(data, direction):
    rows = []
    for item in data:
        flight = item.get("flight", {})
        ident = flight.get("identification", {})
        status = flight.get("status", {})
        aircraft = flight.get("aircraft", {})
        airline = flight.get("airline", {})
        airport = flight.get("airport", {})
        timing = flight.get("time", {})
        generic = (status.get("generic") or {}).get("status") or {}

        code = airline.get("code") or {}

        row = {
            "flight": (ident.get("number") or {}).get("default", ""),
            "callsign": ident.get("callsign", ""),
            "airline": airline.get("short") or airline.get("name") or "",
            "airline_iata": code.get("iata") or "",
            "airline_icao": code.get("icao") or "",
            "ac_code": (aircraft.get("model") or {}).get("code", ""),
            "ac_name": (aircraft.get("model") or {}).get("text", ""),
            "reg": aircraft.get("registration", ""),
            "status": status.get("text", ""),
            "color": generic.get("color", ""),
            "sched_dep": (timing.get("scheduled") or {}).get("departure"),
            "sched_arr": (timing.get("scheduled") or {}).get("arrival"),
            "est_dep": (timing.get("estimated") or {}).get("departure"),
            "est_arr": (timing.get("estimated") or {}).get("arrival"),
            "actual_dep": (timing.get("real") or {}).get("departure"),
            "actual_arr": (timing.get("real") or {}).get("arrival"),
            "live": status.get("live", False),
        }

        if direction == "arrival":
            origin = airport.get("origin") or {}
            row["from_iata"] = ((origin.get("code") or {}).get("iata")) or ""
            row["from_name"] = origin.get("name") or ""
        else:
            dest = airport.get("destination") or {}
            row["to_iata"] = ((dest.get("code") or {}).get("iata")) or ""
            row["to_name"] = dest.get("name") or ""

        rows.append(row)
    return rows


def build_schedule_payload(raw, iata):
    plugin = raw.get("result", {}).get("response", {}).get("airport", {}).get("pluginData", {})
    schedule = plugin.get("schedule", {})
    detail = plugin.get("details", {})
    return {
        "iata": iata,
        "name": detail.get("name") or iata,
        "arrivals": extract_flights(schedule.get("arrivals", {}).get("data", []), "arrival"),
        "departures": extract_flights(schedule.get("departures", {}).get("data", []), "departure"),
    }


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    print(f"Open: http://localhost:{PORT}/?lat=51.5074&lng=-0.1278")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
