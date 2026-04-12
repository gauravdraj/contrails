const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 8891;
const OPENSKY_USER = process.env.OPENSKY_USER;
const OPENSKY_PASS = process.env.OPENSKY_SECRET;
if (!OPENSKY_USER || !OPENSKY_PASS) {
  console.error("Set OPENSKY_USER and OPENSKY_SECRET environment variables");
  process.exit(1);
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://gauravdraj.github.io").split(",");
const trackCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

const rateWindow = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;

function clientIP(req) {
  return req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
}

function isRateLimited(ip) {
  const now = Date.now();
  let bucket = rateWindow.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateWindow.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count > RATE_LIMIT;
}

function corsHeaders(req) {
  const origin = req ? req.headers.origin : ALLOWED_ORIGINS[0];
  const allowed = ALLOWED_ORIGINS.includes(origin) || origin === "http://localhost:8080";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
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
  const hdrs = corsHeaders(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, hdrs);
    return res.end();
  }

  const ip = clientIP(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, hdrs);
    return res.end(JSON.stringify({ error: "rate limited" }));
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/track") {
    const hex = (url.searchParams.get("hex") || "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      res.writeHead(400, hdrs);
      return res.end(JSON.stringify({ error: "invalid hex" }));
    }

    const cached = trackCache.get(hex);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      res.writeHead(200, hdrs);
      return res.end(cached.body);
    }

    try {
      const r = await proxyOpenSky(`/tracks/all?icao24=${hex}&time=0`);
      if (r.status === 200) {
        trackCache.set(hex, { body: r.body, ts: Date.now() });
        res.writeHead(200, hdrs);
        return res.end(r.body);
      }
      res.writeHead(r.status, hdrs);
      return res.end(r.body || JSON.stringify({ error: `opensky ${r.status}` }));
    } catch (e) {
      res.writeHead(502, hdrs);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === "/health") {
    res.writeHead(200, hdrs);
    return res.end(JSON.stringify({ ok: true, cached: trackCache.size }));
  }

  res.writeHead(404, hdrs);
  res.end(JSON.stringify({ error: "not found" }));
});

const BIND = process.env.BIND || "0.0.0.0";
server.listen(PORT, BIND, () => {
  console.log(`OpenSky proxy listening on http://${BIND}:${PORT}`);
  console.log("Endpoints: GET /track?hex=ICAO24  GET /health");
});
