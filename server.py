#!/usr/bin/env python3
"""Dev server: serves static files and proxies adsb.lol API to avoid CORS."""

import http.server
import json
import urllib.request

PORT = 8766
ADSB_API = "https://api.adsb.lol/v2"
ADSB_ROUTE_API = "https://api.adsb.lol/api/0"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/adsb/"):
            self._proxy(f"{ADSB_API}{self.path[len('/api/adsb'):]}")
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

    def log_message(self, format, *args):
        path = str(args[0]) if args else ""
        if "/api/" in path:
            print(f"  [proxy] {path}")


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    print(f"Open: http://localhost:{PORT}/?lat=51.5074&lng=-0.1278")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
