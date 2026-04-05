#!/usr/bin/env python3
"""Dev server: serves static files and proxies adsb.lol API to avoid CORS."""

import http.server
import json
import time
import urllib.parse
import urllib.request

PORT = 8766
ADSB_API = "https://api.adsb.lol/v2"
ADSB_ROUTE_API = "https://api.adsb.lol/api/0"
FR24_API = "https://api.flightradar24.com/common/v1"
FR24_CACHE_TTL = 120
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
            self._proxy(f"{ADSB_API}{self.path[len('/api/adsb'):]}")
        elif self.path == "/api/geo":
            self._send_json(LOCAL_GEO)
        elif self.path.startswith("/api/fr24/schedule/"):
            self._handle_schedule()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/adsb-route/"):
            rest = self.path[len("/api/adsb-route"):]
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length) if length else b""
            self._proxy(f"{ADSB_ROUTE_API}{rest}", method="POST", body=body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _proxy(self, url, method="GET", body=None):
        try:
            req = urllib.request.Request(
                url, data=body, method=method,
                headers={"User-Agent": "contrails/1.0", "Content-Type": "application/json"},
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

    def _send_json(self, payload, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

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
                headers={"User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)"},
            )
            with urllib.request.urlopen(req, timeout=12) as resp:
                raw = json.loads(resp.read().decode())

            plugin = raw.get("result", {}).get("response", {}).get("airport", {}).get("pluginData", {})
            sched = plugin.get("schedule", {})
            detail = plugin.get("details", {})
            payload = {
                "iata": iata,
                "name": detail.get("name") or iata,
                "arrivals": extract_flights(sched.get("arrivals", {}).get("data", []), "arrival"),
                "departures": extract_flights(sched.get("departures", {}).get("data", []), "departure"),
            }
            SCHEDULE_CACHE[iata] = {
                "expires_at": now + FR24_CACHE_TTL,
                "payload": payload,
            }
            self._send_json(payload)
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

        row = {
            "flight": (ident.get("number") or {}).get("default", ""),
            "callsign": ident.get("callsign", ""),
            "airline": airline.get("short") or airline.get("name") or "",
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


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    print(f"Open: http://localhost:{PORT}/?lat=51.5074&lng=-0.1278")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
