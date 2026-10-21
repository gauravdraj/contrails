// Local dev without wrangler: serves the frontend on :8766 and runs the real
// Worker module (worker/src/index.js) under Node on :8791. app.js targets :8791
// whenever it is served from localhost. `wrangler dev` would be the usual choice,
// but its workerd runtime can't start on the Pi's 39-bit address-space kernel.
//
// Optional env: ADSB_RELAY_URL / ADSB_RELAY_KEY enable the relay tier.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_FILE, buildBundle } from "./build-bundle.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATIC_PORT = Number(process.env.STATIC_PORT || 8766);
const WORKER_PORT = Number(process.env.WORKER_PORT || 8791);
// Stand-in for Cloudflare's request.cf so /geo answers locally.
const LOCAL_CF = { latitude: "51.5074", longitude: "-0.1278", city: "London", country: "GB" };

const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const hit = store.get(typeof req === "string" ? req : req.url);
      if (!hit) return undefined;
      if (hit.expires < Date.now()) {
        store.delete(hit.key);
        return undefined;
      }
      return hit.response.clone();
    },
    async put(req, response) {
      const key = typeof req === "string" ? req : req.url;
      const maxAge = /s-maxage=(\d+)/.exec(response.headers.get("Cache-Control") || "");
      store.set(key, { key, response: response.clone(), expires: Date.now() + (maxAge ? Number(maxAge[1]) : 60) * 1000 });
    },
    async delete(req) {
      return store.delete(typeof req === "string" ? req : req.url);
    },
  },
};

const { default: worker } = await import("../worker/src/index.js");

const env = {
  ADSB_RELAY_URL: process.env.ADSB_RELAY_URL,
  ADSB_RELAY_KEY: process.env.ADSB_RELAY_KEY,
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

http.createServer(async (req, res) => {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const request = new Request(`http://localhost:${WORKER_PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body,
    });
    Object.defineProperty(request, "cf", { value: LOCAL_CF });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: String(err && err.message || err) }));
  }
}).listen(WORKER_PORT, () => console.log(`Worker:   http://localhost:${WORKER_PORT}`));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

http.createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  // Built fresh each time so edits to js/*.js show up on reload without rerunning the bundler.
  if (path === "/" + BUNDLE_FILE) {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(await buildBundle());
    return;
  }
  const file = normalize(join(ROOT, path === "/" ? "index.html" : path));
  if (!file.startsWith(ROOT) || file.includes(`${ROOT}worker`) || file.includes("/.")) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(STATIC_PORT, () => console.log(`Frontend: http://localhost:${STATIC_PORT}/?lat=51.5074&lng=-0.1278`));
