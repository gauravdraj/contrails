const http = require("http");
const https = require("https");

const PORT = 8891;
const OPENSKY_USER = process.env.OPENSKY_USER || "grocker-api-client";
const OPENSKY_PASS = process.env.OPENSKY_SECRET || "0dgNIsU2btQ7RufxggxfwTl8KpQeGxUz";

const trackCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };
}

function proxyOpenSky(path) {
  const auth = Buffer.from(`${OPENSKY_USER}:${OPENSKY_PASS}`).toString("base64");
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://opensky-network.org/api${path}`,
      { headers: { Authorization: `Basic ${auth}`, "User-Agent": "contrails/1.0" }, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/track") {
    const hex = (url.searchParams.get("hex") || "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      res.writeHead(400, corsHeaders());
      return res.end(JSON.stringify({ error: "invalid hex" }));
    }

    const cached = trackCache.get(hex);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.writeHead(200, corsHeaders());
      return res.end(cached.body);
    }

    try {
      const r = await proxyOpenSky(`/tracks/all?icao24=${hex}&time=0`);
      if (r.status === 200) {
        trackCache.set(hex, { body: r.body, ts: Date.now() });
        res.writeHead(200, corsHeaders());
        return res.end(r.body);
      }
      res.writeHead(r.status, corsHeaders());
      return res.end(r.body || JSON.stringify({ error: `opensky ${r.status}` }));
    } catch (e) {
      res.writeHead(502, corsHeaders());
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, corsHeaders());
    return res.end(JSON.stringify({ ok: true, cached: trackCache.size }));
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: "not found" }));
});

const BIND = process.env.BIND || "0.0.0.0";
server.listen(PORT, BIND, () => {
  console.log(`OpenSky proxy listening on http://${BIND}:${PORT}`);
  console.log("Endpoints: GET /track?hex=ICAO24  GET /health");
});
