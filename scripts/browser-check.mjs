// Real browser checks, no npm dependencies. Requires Node >=22 (global WebSocket) and Chrome/Chromium.
//   node scripts/browser-check.mjs                         # boot, WebGL, board, outage/recovery, SW
//   CHROME="/path/to/chrome" node scripts/browser-check.mjs # override automatic Chrome discovery
//   node scripts/browser-check.mjs --perf [--aircraft 1500] # 30 s of natural polls; JSON on stdout
//   node scripts/browser-check.mjs --self-test              # pure fixture helpers, no browser required
//
// Serves fresh working-tree sources in memory and checks committed app.bundle.js for drift. Requires free
// 127.0.0.1:8791; never contacts the real Worker. External page requests use CDP Fetch fixtures. A loopback
// deny-all proxy also blocks Chrome background traffic and workers whose CDP target lacks Fetch support.
// Empty glyph PBFs deliberately omit text shapes; the real plane icons, layers, board and polling run.
// No console.error/exception allowlist. SW registration/activation are checked; cache/offline behavior is
// outside this test (a fresh profile and SW cache writes can vary across headless builds).
// Outage uses the existing fetchAircraft() twice, then the real retry timer for recovery; no production hooks.
// Perf wraps processAircraft() externally: processingMs is synchronous CPU work; fetchAndProcessMs adds the
// mock fetch. Natural five-second polls build real history/trails. Perf uses the real GPU (Metal on macOS,
// Chrome's default elsewhere) because SwiftShader frame/long-task numbers measure the software rasterizer, not
// the app; --swiftshader opts back in. The JSON records the WebGL renderer. Compare medians of >=3 runs on an
// otherwise idle machine. No performance pass/fail thresholds.

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BUNDLE_FILE, buildBundle } from "./build-bundle.mjs";
import {
  VIEW, aircraftFixture, routeFixture, scheduleFixture, externalFixture, percentile, testFixtures,
} from "./browser-fixtures.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const perf = args.includes("--perf");
let aircraftCount = perf ? 1500 : 12;
for (let i = 0; i < args.length; i++) {
  if (["--perf", "--self-test"].includes(args[i])) continue;
  if (args[i] !== "--aircraft" || !/^\d+$/.test(args[i + 1] || "")) throw new Error("Usage: browser-check.mjs [--perf] [--aircraft N] [--self-test]");
  aircraftCount = Number(args[++i]);
}
if (!Number.isSafeInteger(aircraftCount) || aircraftCount < 1 || aircraftCount > 10000) throw new Error("--aircraft must be 1..10000");
const report = (message) => (perf ? console.error : console.log)(message);
const errors = [], unexpectedRequests = [], networkFixtures = new Map(), workerRequests = new Map();
const mock = { offline: false, failed: 0, traffic: 0, startedAt: 0 };
let browser, cdp, profile, staticServer, workerServer, watchdog;
let chromeStderr = "", chromeFailure = null, stopping = false;

async function check(name, action) {
  try {
    const detail = await action();
    report("PASS " + name + (detail ? ": " + detail : ""));
  } catch (error) {
    report("FAIL " + name + ": " + error.message);
    throw error;
  }
}

async function until(name, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (chromeFailure) throw new Error(chromeFailure);
    const value = await predicate();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + name);
}

async function findChrome() {
  const names = process.env.CHROME ? [process.env.CHROME] : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const name of names) {
    const paths = name.includes(sep) ? [resolve(name)] : (process.env.PATH || "").split(delimiter).map(dir => join(dir, name));
    for (const path of paths) {
      try { await access(path, constants.X_OK); return path; } catch {}
    }
  }
  throw new Error("Chrome not found. Set CHROME to a Chrome/Chromium executable (Node >=22 required).");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address().port); });
  });
}

const CORS = {
  "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type", "Cache-Control": "no-store", "Content-Type": "application/json",
};
function json(res, status, data) { res.writeHead(status, CORS).end(JSON.stringify(data)); }

async function handleWorker(req, res) {
  const path = new URL(req.url, "http://127.0.0.1:8791").pathname;
  workerRequests.set(req.method + " " + path, (workerRequests.get(req.method + " " + path) || 0) + 1);
  if (req.method === "OPTIONS") { res.writeHead(204, CORS).end(); return; }
  const now = Date.now();
  if (/^\/adsb\/lat\/-?[\d.]+\/lon\/-?[\d.]+\/dist\/\d+$/.test(path)) {
    mock.traffic++;
    if (mock.offline) { mock.failed++; json(res, 503, { error: "Fixture traffic outage" }); return; }
    if (!mock.startedAt) mock.startedAt = now;
    json(res, 200, { ac: aircraftFixture(aircraftCount, Math.floor((now - mock.startedAt) / 5000)), now, source: "primary" });
  } else if (path === "/geo") {
    json(res, 200, { lat: VIEW.lat, lng: VIEW.lng, city: "London", country: "GB" });
  } else if (path === "/routeset" && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { planes } = JSON.parse(Buffer.concat(chunks));
    assert.ok(Array.isArray(planes) && planes.length > 0 && planes.length <= 20, "Invalid /routeset contract");
    assert.ok(planes.every(p => typeof p.callsign === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lng)));
    json(res, 200, routeFixture(planes));
  } else if (/^\/schedule\/[A-Z]{3}$/.test(path)) {
    json(res, 200, scheduleFixture(path.split("/").pop(), aircraftCount, now));
  } else if (/^\/datis\/[A-Z]{3}$/.test(path)) {
    json(res, 200, { datis: "LANDING RUNWAY 27R. DEPARTING RUNWAY 27L.", source: "datis" });
  } else if (/^\/(photo|aircraft|track)\/[a-f0-9]{6}$/.test(path)) {
    json(res, 200, null); // A successful lookup with no photo/metadata/extended trace is a valid Worker answer.
  } else if (/^\/fr24search\/[A-Za-z0-9]+$/.test(path)) {
    json(res, 200, { results: [] });
  } else {
    unexpectedRequests.push("Worker " + req.method + " " + path);
    json(res, 404, { error: "Unmocked Worker endpoint" });
  }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
async function serveStatic(req, res, bundle) {
  // This server doubles as a deny-all forward proxy for Chrome background traffic (including CONNECT).
  if (/^https?:\/\//.test(req.url)) { res.writeHead(502).end("External network disabled"); return; }
  const path = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  const file = resolve(ROOT, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(ROOT + sep) || path.split("/").some(p => p.startsWith(".")) || path.startsWith("/worker/")) {
    res.writeHead(404).end(); return;
  }
  try {
    const body = path === "/" + BUNDLE_FILE ? bundle : await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
  } catch {
    unexpectedRequests.push("Static " + path);
    res.writeHead(404).end("Not found");
  }
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(pending.method + ": " + message.error.message), { code: message.error.code }));
        else pending.resolve(message.result);
      } else {
        for (const fn of this.listeners.get(message.method) || []) {
          Promise.resolve().then(() => fn(message.params, message.sessionId)).catch(error => {
            if (!stopping) errors.push("CDP " + message.method + ": " + error.message);
          });
        }
      }
    });
    socket.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Chrome disconnected: " + p.method)); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    const client = new CDP(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("DevTools WebSocket connection timed out")); }, 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cannot connect to DevTools WebSocket")); }, { once: true });
    });
    return client;
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP timed out: " + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

async function intercept({ requestId, request, resourceType }, sessionId) {
  const url = new URL(request.url);
  if (url.hostname === "127.0.0.1" && [String(staticServer.address().port), "8791"].includes(url.port)) {
    await cdp.send("Fetch.continueRequest", { requestId }, sessionId);
    return;
  }
  const fixture = externalFixture(request.url, resourceType);
  if (!fixture) {
    unexpectedRequests.push(request.url);
    await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
    return;
  }
  networkFixtures.set(url.hostname, (networkFixtures.get(url.hostname) || 0) + 1);
  await cdp.send("Fetch.fulfillRequest", {
    requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: fixture.type }, { name: "Access-Control-Allow-Origin", value: "*" }],
    body: Buffer.from(fixture.body).toString("base64"),
  }, sessionId);
}

// Observe the app's own call, including rejections its .catch() would otherwise hide. Do not register for it.
function observeRegistration() {
  window.__browserCheckSW = { attempts: 0, registered: false, errors: [] };
  if (!navigator.serviceWorker) return;
  const original = navigator.serviceWorker.register;
  navigator.serviceWorker.register = function(...args) {
    window.__browserCheckSW.attempts++;
    try {
      return original.apply(this, args).then(registration => {
        window.__browserCheckSW.registered = true;
        return registration;
      }, error => { window.__browserCheckSW.errors.push(String(error)); throw error; });
    } catch (error) { window.__browserCheckSW.errors.push(String(error)); throw error; }
  };
}

function startMeasurements() {
  const state = window.__browserCheckPerf = { start: performance.now(), frames: [], longTasks: [], polls: [], running: true };
  let previous;
  function frame(now) {
    if (!state.running) return;
    if (previous != null) state.frames.push(now - previous);
    previous = now;
    state.frameId = requestAnimationFrame(frame);
  }
  state.frameId = requestAnimationFrame(frame);
  state.observer = new PerformanceObserver(list => {
    for (const task of list.getEntries()) state.longTasks.push(task.duration);
  });
  state.observer.observe({ type: "longtask" });
  const originalProcess = processAircraft;
  const originalFetch = fetchAircraft;
  let activePoll = null;
  processAircraft = function(...args) {
    const poll = activePoll;
    const started = performance.now();
    try { return originalProcess.apply(this, args); }
    finally {
      if (poll) {
        poll.processingMs = performance.now() - started;
        poll.aircraft = args[0].length;
      }
    }
  };
  fetchAircraft = async function(...args) {
    const poll = { index: state.polls.length + 1, started: performance.now(), processingMs: null };
    state.polls.push(poll);
    activePoll = poll;
    try { return await originalFetch.apply(this, args); }
    finally { poll.fetchAndProcessMs = performance.now() - poll.started; activePoll = null; }
  };
  state.restore = () => { processAircraft = originalProcess; fetchAircraft = originalFetch; };
}

async function runPerf() {
  await cdp.evaluate("(" + startMeasurements.toString() + ")()");
  report("Measuring 30 seconds of natural polling and animation…");
  await delay(30000);
  // Read heap before the diagnostic feature query allocates its returned GeoJSON objects.
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage"); // main isolate only (not MapLibre's workers)
  const renderer = await cdp.evaluate(`(() => { const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : "none"; })()`);
  if (/swiftshader/i.test(renderer)) process.stderr.write("WARNING: SwiftShader renderer; frame/long-task numbers measure software rasterization, not the app\n");
  const data = await cdp.evaluate(`(() => {
    const s = window.__browserCheckPerf;
    s.running = false;
    cancelAnimationFrame(s.frameId);
    for (const task of s.observer.takeRecords()) s.longTasks.push(task.duration);
    s.observer.disconnect(); s.restore();
    return { durationMs: performance.now() - s.start, frames: s.frames, longTasks: s.longTasks,
      polls: s.polls.map(({started, ...p}) => ({ ...p, offsetMs: started - s.start })),
      histories: Object.values(posHistory).filter(h => h.length > 1).length,
      maxHistoryPoints: Math.max(0, ...Object.values(posHistory).map(h => h.length)),
      renderedTrailFeatures: map.queryRenderedFeatures({ layers: ['trails'] }).length };
  })()`);
  const version = await cdp.send("Browser.getVersion");
  console.log(JSON.stringify({
    mode: "perf", aircraft: aircraftCount, durationMs: data.durationMs, viewport: VIEW,
    chrome: version.product, renderer, platform: process.platform, node: process.version,
    polls: data.polls, frames: data.frames.length, frameMs: { p50: percentile(data.frames, 0.5), p95: percentile(data.frames, 0.95) },
    longTasks: { count: data.longTasks.length, totalMs: data.longTasks.reduce((a, b) => a + b, 0) },
    jsHeapUsedBytes: heap.usedSize, jsHeapTotalBytes: heap.totalSize,
    histories: data.histories, maxHistoryPoints: data.maxHistoryPoints, renderedTrailFeatures: data.renderedTrailFeatures,
  }, null, 2));
}

// Functional checks (and CI) use SwiftShader for a deterministic headless WebGL; perf uses the real GPU.
function glFlags() {
  if (!perf || args.includes("--swiftshader")) return ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  return process.platform === "darwin" ? ["--use-angle=metal"] : [];
}

async function cleanup() {
  stopping = true;
  // Keep a short hard stop armed through teardown so a stuck close can't hang the process.
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { process.stderr.write("cleanup timed out\n"); process.exit(1); }, 15000);
  watchdog.unref();
  if (browser && browser.exitCode == null && browser.signalCode == null) {
    browser.kill("SIGTERM");
    await Promise.race([new Promise(resolve => browser.once("exit", resolve)), delay(1500)]);
    if (browser.exitCode == null && browser.signalCode == null) browser.kill("SIGKILL");
  }
  cdp?.socket.close();
  for (const server of [staticServer, workerServer]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    .catch(error => report("WARN profile cleanup: " + error.message));
}

async function main() {
  if (args.includes("--self-test")) { testFixtures(); return; }
  assert.equal(typeof WebSocket, "function", "Node >=22 with global WebSocket is required");
  const bundle = await buildBundle();
  await check("bundle drift", async () => {
    assert.ok(await readFile(join(ROOT, BUNDLE_FILE), "utf8") === bundle, "app.bundle.js is stale; run node scripts/build-bundle.mjs");
  });
  workerServer = http.createServer((req, res) => {
    handleWorker(req, res).catch(error => { errors.push("Mock Worker: " + error.message); json(res, 500, { error: error.message }); });
  });
  try { await listen(workerServer, 8791); }
  catch (error) { throw new Error("Mock Worker requires free 127.0.0.1:8791: " + error.message); }
  staticServer = http.createServer((req, res) => {
    serveStatic(req, res, bundle).catch(error => { errors.push("Static server: " + error.message); res.writeHead(500).end(); });
  });
  staticServer.on("connect", (_req, socket) => {
    // Chrome may reset a speculative proxy connection after receiving the denial.
    socket.on("error", () => {});
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(staticServer, 0);
  const origin = "http://127.0.0.1:" + port;
  profile = await mkdtemp(join(tmpdir(), "contrails-browser-check-"));
  await check("Chrome launch", async () => {
    browser = spawn(await findChrome(), [
      "--headless=new", "--no-sandbox", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--user-data-dir=" + profile, ...glFlags(), "--ignore-gpu-blocklist",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-domain-reliability",
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps", "--disable-extensions",
      "--disable-quic", "--dns-prefetch-disable", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--proxy-server=" + origin, "--proxy-bypass-list=127.0.0.1", "--disable-dev-shm-usage",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--window-size=" + VIEW.width + "," + VIEW.height, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    browser.stderr.on("data", chunk => { chromeStderr = (chromeStderr + chunk).slice(-16000); });
    browser.once("error", error => { chromeFailure = "Chrome launch failed: " + error.message; });
    browser.once("exit", (code, signal) => { if (!stopping) chromeFailure = "Chrome exited (" + (signal || code) + "): " + chromeStderr; });
    const devtoolsPort = await until("Chrome DevToolsActivePort (sandbox may prohibit launching Chrome)", async () => {
      const file = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
      return Number(file.split("\n")[0]) || Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(chromeStderr)?.[1]);
    }, 15000);
    const target = await until("DevTools page target", async () => {
      const response = await fetch("http://127.0.0.1:" + devtoolsPort + "/json", { signal: AbortSignal.timeout(2000) });
      return (await response.json()).find(target => target.type === "page");
    });
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
  });
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }, session) => {
    errors.push((session ? "Worker " : "Page ") + (exceptionDetails.exception?.description || exceptionDetails.text));
  });
  cdp.on("Runtime.consoleAPICalled", ({ type, args }, session) => {
    if (type === "error" || (type === "warning" && !/^Background location unavailable/.test(String(args[0]?.value)))) errors.push((session ? "Worker " : "Page ") + args.map(a => a.description || a.value || a.type).join(" "));
  });
  cdp.on("ServiceWorker.workerErrorReported", ({ errorMessage }) => {
    errors.push("Service worker: " + errorMessage.errorMessage + " at " + errorMessage.sourceURL + ":" + errorMessage.lineNumber);
  });
  cdp.on("Fetch.requestPaused", intercept);
  cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
    try {
      await cdp.send("Runtime.enable", {}, sessionId);
      // Chrome exposes Fetch on pages, but some worker targets omit it. Their egress is still blocked by
      // the deny-all proxy; MapLibre's glyph/style requests are sent through the intercepted page target.
      try {
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http*", requestStage: "Request" }] }, sessionId);
      } catch (error) {
        if (error.code !== -32601 || !["worker", "service_worker"].includes(targetInfo.type)) throw error;
      }
    } finally { await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId); }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("ServiceWorker.enable");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http*", requestStage: "Request" }] });
  // Pausing a service worker before startup can hold register() indefinitely. Observe it with the
  // ServiceWorker domain instead; the deny-all proxy covers any request outside its local app shell.
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "service_worker", exclude: true }, {}] });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "denied", origin });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + observeRegistration.toString() + ")()" });
  const navigation = await cdp.send("Page.navigate", { url: origin + "/?lat=" + VIEW.lat + "&lng=" + VIEW.lng + "&zoom=" + VIEW.zoom });
  assert.ok(!navigation.errorText, "Navigation failed: " + navigation.errorText);
  await check("map canvas has WebGL", async () => {
    // Before the classic script runs, window.map is the named DOM element #map, not the map instance.
    await until("app bundle execution", () => cdp.evaluate("typeof initMap === 'function' && document.readyState !== 'loading'"));
    const state = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('#map canvas');
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return { map: !!map, canvas: !!canvas, context: !!gl, lost: gl ? gl.isContextLost() : true };
    })()`);
    assert.ok(state.map && state.canvas && state.context && !state.lost,
      "Headless WebGL unavailable: " + JSON.stringify(state) + ". Chrome flags: " + glFlags().join(" ") + " --ignore-gpu-blocklist");
  });
  const summary = "document.querySelector('#controls-toggle #controls-compact-summary').textContent";
  await check("boots with fixture count", async () => {
    await until(aircraftCount + " planes in view", () => cdp.evaluate(summary + " === " + JSON.stringify(aircraftCount + " planes in view")));
    assert.equal(await cdp.evaluate("aircraft.filter(a => mapViewBounds().contains(a.lat, a.lng)).length"), aircraftCount);
    return aircraftCount + " planes in view";
  });
  await check("planes actually rendered", async () => {
    const count = await until("all fixture planes in the rendered planes layer", () => cdp.evaluate(`(() => {
      if (!mapReady || !map.getLayer('planes')) return false;
      const features = map.queryRenderedFeatures({ layers: ['planes'] });
      const unique = new Set(features.map(f => f.properties.hex)).size;
      return unique >= ${aircraftCount} && unique;
    })()`));
    assert.ok(networkFixtures.has("basemaps.cartocdn.com"), "Local basemap style was never requested");
    return count + " unique rendered aircraft";
  });
  await check("service worker registration", async () => {
    await until("app's SW registration and activation", () => cdp.evaluate(`(async () => {
      if (__browserCheckSW.errors.length) throw new Error(__browserCheckSW.errors.join('; '));
      const registration = await navigator.serviceWorker.getRegistration();
      return __browserCheckSW.attempts > 0 && __browserCheckSW.registered && registration?.active?.state === 'activated';
    })()`));
    return "app registered and activated sw.js; caching assertions skipped";
  });
  if (perf) {
    await runPerf();
  } else {
    await check("airport marker opens landings board", async () => {
      await until("Heathrow marker", () => cdp.evaluate("!!airportMarkers.LHR"));
      await cdp.evaluate("airportMarkers.LHR.marker.getElement().querySelector('.airport-label').click()");
      const landings = await until("visible Heathrow landing rows", () => cdp.evaluate(`(() => {
        const card = document.querySelector('.sched-card[data-sched-iata="LHR"][data-sched-dir="arrivals"]');
        if (!card || !card.getBoundingClientRect().height) return false;
        const count = Number(card.querySelector('[data-dir="arrivals"] .sched-toggle-count')?.textContent);
        return count > 0 && card.querySelector('.sched-next-clickable[data-hex]') && count;
      })()`));
      await until("airport's Worker requests", async () => {
        return workerRequests.has("GET /datis/LHR") && workerRequests.has("GET /schedule/LHR") && workerRequests.has("POST /routeset");
      });
      await until("board refresh completed", () => cdp.evaluate("(() => { const e = _airportPopupCache.LHR; return !!(e && e.ts && !e.loading && !e.stale && !e.error); })()"));
      // Close through the DOM before testing the main feed so board polling cannot affect its failure count.
      await cdp.evaluate(`(document.querySelector('.airport-schedule-popup .maplibregl-popup-close-button') ||
        document.getElementById('airport-panel-close')).click()`);
      await until("airport board closed", () => cdp.evaluate("!_activeAirportPopup"));
      return landings + " landings";
    });
    await check("outage shown at failure threshold", async () => {
      await until("settled traffic request", () => cdp.evaluate("clearMapFetchTimer(); clearTimeout(moveEndDebounceTimer); moveEndDebounceTimer = null; clearRefreshTimer(); !fetchAbortController && !map.isMoving()"));
      mock.offline = true;
      await cdp.evaluate("fetchAircraft({ source: 'poll' })");
      assert.equal(await cdp.evaluate("trafficFailStreak"), 1, "First failing poll did not reach the app");
      assert.equal(await cdp.evaluate(summary), aircraftCount + " planes in view", "Outage shown before the failure threshold");
      await cdp.evaluate("fetchAircraft({ source: 'poll' })");
      assert.equal(await cdp.evaluate("trafficFailStreak"), 2);
      assert.equal(await cdp.evaluate(summary), "Feed offline · retrying");
      assert.ok(mock.failed >= 2);
      await cdp.evaluate("window.__browserCheckDocument = 'same-document'");
      return "two real HTTP 503 polls";
    });
    await check("scheduled retry recovers without reload", async () => {
      mock.offline = false;
      // Keep the real backoff timer (10 s here): catches polling that never reschedules after failure.
      await until("healthy summary after scheduled retry", () => cdp.evaluate(summary + " === " + JSON.stringify(aircraftCount + " planes in view")), 18000);
      assert.equal(await cdp.evaluate("trafficFailStreak"), 0);
      assert.equal(await cdp.evaluate("window.__browserCheckDocument"), "same-document");
    });
  }
  await check("app requests local or fulfilled by fixtures", async () => {
    assert.deepEqual(unexpectedRequests, []);
    return mock.traffic + " traffic requests; external fixtures: " + JSON.stringify(Object.fromEntries(networkFixtures));
  });
  await check("no console errors or exceptions", async () => { assert.deepEqual(errors, []); });
}

if (!args.includes("--self-test")) {
  watchdog = setTimeout(() => {
    report("FAIL browser check exceeded 110 seconds");
    cleanup().finally(() => process.exit(1));
  }, 110000);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup().finally(() => process.exit(1)); });
}
try { await main(); }
catch (error) {
  process.exitCode = 1;
  report("FAIL browser check: " + error.message);
  if (cdp && !chromeFailure) {
    const state = await cdp.evaluate(`(async () => ({ url: location.href, ready: document.readyState,
      summary: document.querySelector('#controls-compact-summary')?.textContent,
      sw: window.__browserCheckSW,
      registration: await navigator.serviceWorker?.getRegistration().then(r => r && ({
        installing: r.installing?.state, waiting: r.waiting?.state, active: r.active?.state })),
      body: document.body?.innerText.slice(0, 500) }))()`).catch(() => null);
    report("Page state: " + JSON.stringify(state));
  }
  if (errors.length) report("Browser errors: " + JSON.stringify(errors));
  if (unexpectedRequests.length) report("Unmocked requests: " + JSON.stringify(unexpectedRequests));
  if (chromeFailure) report(chromeFailure);
}
finally { await cleanup(); }
