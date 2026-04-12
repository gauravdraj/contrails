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

const backoff = { until: 0, delay: 10_000 };
const BACKOFF_MAX = 600_000;

function isBackedOff() {
  return Date.now() < backoff.until;
}

function triggerBackoff(retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) {
    const ms = retryAfterSec * 1000;
    backoff.delay = ms;
    backoff.until = Date.now() + ms;
  } else {
    backoff.delay = Math.min(backoff.delay * 2, BACKOFF_MAX);
    backoff.until = Date.now() + backoff.delay;
  }
  const resumeAt = new Date(backoff.until).toISOString();
  console.log(`OpenSky 429 — backing off ${Math.round(backoff.delay / 1000)}s (resume ~${resumeAt})`);
}

function resetBackoff() {
  backoff.delay = 10_000;
  backoff.until = 0;
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
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
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

    if (isBackedOff()) {
      const retry = Math.ceil((backoff.until - Date.now()) / 1000);
      res.writeHead(503, { ...hdrs, "Retry-After": String(retry) });
      return res.end(JSON.stringify({ error: "opensky rate limited", retryAfter: retry }));
    }

    try {
      const r = await proxyOpenSky(`/tracks/all?icao24=${hex}&time=0`);
      if (r.status === 200) {
        resetBackoff();
        trackCache.set(hex, { body: r.body, ts: Date.now() });
        res.writeHead(200, hdrs);
        return res.end(r.body);
      }
      if (r.status === 429) {
        const retryAfterSec = parseInt(r.headers["x-rate-limit-retry-after-seconds"], 10) || 0;
        triggerBackoff(retryAfterSec);
        const clientRetry = Math.ceil((backoff.until - Date.now()) / 1000);
        res.writeHead(503, { ...hdrs, "Retry-After": String(clientRetry) });
        return res.end(JSON.stringify({ error: "opensky rate limited", retryAfter: clientRetry }));
      }
      res.writeHead(r.status, hdrs);
      return res.end(r.body || JSON.stringify({ error: `opensky ${r.status}` }));
    } catch (e) {
      res.writeHead(502, hdrs);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (url.pathname === "/health") {
    const backedOff = isBackedOff();
    const retryIn = backedOff ? Math.ceil((backoff.until - Date.now()) / 1000) : 0;
    res.writeHead(200, hdrs);
    return res.end(JSON.stringify({
      ok: !backedOff,
      cached: trackCache.size,
      rateLimited: backedOff,
      ...(backedOff && { retryInSeconds: retryIn, resumesAt: new Date(backoff.until).toISOString() }),
    }));
  }

  res.writeHead(404, hdrs);
  res.end(JSON.stringify({ error: "not found" }));
});

const BIND = process.env.BIND || "0.0.0.0";
server.listen(PORT, BIND, () => {
  console.log(`OpenSky proxy listening on http://${BIND}:${PORT}`);
  console.log("Endpoints: GET /track?hex=ICAO24  GET /health");
});
