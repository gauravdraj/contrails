import * as providers from "./providers.js";
import test from "node:test";
test.beforeEach(() => providers._providerHealth?.clear());
import assert from "node:assert/strict";

import handler from "./index.js";
import { fr24CheckBackoff, fr24ResetBackoff } from "./fr24-backoff.js";

test("unknown route returns JSON 404 with CORS headers", async () => {
  const request = new Request("https://worker.test/nonexistent");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");

  const body = await response.json();
  assert.deepEqual(body, { error: "Not found" });
});

test("OPTIONS returns 200 with CORS headers", async () => {
  const request = new Request("https://worker.test/anything", { method: "OPTIONS" });
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
});

test("schedule rejects invalid airport code with 400", async () => {
  const request = new Request("https://worker.test/schedule/!!!");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid airport code");
});

test("fr24search rejects invalid query with 400", async () => {
  const request = new Request("https://worker.test/fr24search/a!b");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid query");
});

test("datis rejects invalid airport code with 400", async () => {
  const request = new Request("https://worker.test/datis/12!");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid airport code");
});

test("datis normalizes IATA to ICAO and returns ATIS JSON", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  let fetchedUrl = "";
  let waitUntilCalled = false;

  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return new Response(JSON.stringify([{
      airport: "KSFO",
      type: "combined",
      code: "Y",
      datis: "DEPG RWYS 28L, 28R.",
      time: "0656",
      updatedAt: "2026-06-05T07:04:21Z"
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });

  const response = await handler.fetch(new Request("https://worker.test/datis/SFO"), {}, {
    waitUntil: () => { waitUntilCalled = true; }
  });

  assert.equal(response.status, 200);
  assert.equal(fetchedUrl, "https://atis.info/api/KSFO");
  assert.equal(waitUntilCalled, true);
  assert.deepEqual(await response.json(), {
    airport: "KSFO",
    type: "combined",
    code: "Y",
    datis: "DEPG RWYS 28L, 28R.",
    time: "0656",
    updatedAt: "2026-06-05T07:04:21Z",
    source: "datis"
  });
});

test("photo rejects invalid hex with 400", async () => {
  const request = new Request("https://worker.test/photo/ZZZZZZ");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid hex");
});

test("track rejects invalid hex with 400", async () => {
  const request = new Request("https://worker.test/track/ZZZZZZ");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Invalid hex");
});

test("routeset rejects GET with 405", async () => {
  const request = new Request("https://worker.test/routeset");
  const response = await handler.fetch(request, {}, {});

  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(body.error, "POST required");
});

test("schedule page-2 rate limit triggers backoff", async (t) => {
  const mockCache = { match: async () => null, put: async () => {} };
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  globalThis.caches = { default: mockCache };

  const schedulePayload = {
    result: {
      response: {
        airport: {
          pluginData: {
            details: { name: "Test Airport" },
            schedule: { arrivals: { data: [] }, departures: { data: [] } },
          },
        },
      },
    },
  };

  let fetchCallCount = 0;
  globalThis.fetch = async (url) => {
    fetchCallCount++;
    if (typeof url === "string" && url.includes("page=2")) {
      return new Response("", { status: 429 });
    }
    return new Response(JSON.stringify(schedulePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });

  const request = new Request("https://worker.test/schedule/LAX");
  const response = await handler.fetch(request, {}, { waitUntil: () => {} });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.iata, "LAX");

  const request2 = new Request("https://worker.test/schedule/JFK");
  const response2 = await handler.fetch(request2, {}, { waitUntil: () => {} });
  assert.equal(response2.status, 503);
  const body2 = await response2.json();
  assert.equal(body2.error, "FR24 temporarily unavailable");
});

test("adsb proxy rejects paths outside the lookup allowlist", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  for (const path of ["/adsb/v2/mil", "/adsb/point/37/-122/25", "/adsb/hex/a1b2c3/extra"]) {
    const response = await handler.fetch(new Request("https://worker.test" + path), {}, {});
    assert.equal(response.status, 404, path);
  }
  const badHex = await handler.fetch(new Request("https://worker.test/adsb/hex/zzzzzz"), {}, {});
  assert.equal(badHex.status, 400);
  const badCallsign = await handler.fetch(new Request("https://worker.test/adsb/callsign/UAL-1"), {}, {});
  assert.equal(badCallsign.status, 400);
});

function scheduleRaw(arrFlights) {
  return {
    result: {
      response: {
        airport: {
          pluginData: {
            details: { name: "Test Airport" },
            schedule: {
              arrivals: { data: arrFlights.map((n) => ({ flight: { identification: { number: { default: n } } } })) },
              departures: { data: [] },
            },
          },
        },
      },
    },
  };
}

function recordingCtx() {
  const pending = [];
  return { waitUntil(p) { pending.push(p); }, pending };
}

test("adsb grid and lookup cache writes are handed to ctx.waitUntil", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const puts = [];
  globalThis.caches = { default: { match: async () => null, put: async (key) => { puts.push(key.url); } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ ac: [], now: Date.now() }), { status: 200 });
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const ctx1 = recordingCtx();
  const grid = await handler.fetch(new Request("https://worker.test/adsb/lat/37.6/lon/-122.4/dist/50"), {}, ctx1);
  assert.equal(grid.status, 200);
  assert.equal(ctx1.pending.length, 1, "grid cache.put should go through waitUntil");
  await Promise.all(ctx1.pending);

  const ctx2 = recordingCtx();
  const lookup = await handler.fetch(new Request("https://worker.test/adsb/hex/a1b2c3"), {}, ctx2);
  assert.equal(lookup.status, 200);
  assert.equal(ctx2.pending.length, 1, "lookup cache.put should go through waitUntil");
  await Promise.all(ctx2.pending);
  assert.equal(puts.length, 2);
});

test("schedule and photo use canonical cache keys (query string / hex case ignored)", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const keys = [];
  globalThis.caches = { default: { match: async (key) => { keys.push(key.url); return null; }, put: async () => {}, delete: async () => true } };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("planespotters")) return new Response(JSON.stringify({ photos: [] }), { status: 200 });
    return new Response(JSON.stringify(scheduleRaw([])), { status: 200 });
  };
  fr24ResetBackoff();
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; fr24ResetBackoff(); });

  await handler.fetch(new Request("https://worker.test/schedule/SFO?x=1"), {}, recordingCtx());
  await handler.fetch(new Request("https://worker.test/schedule/sfo?x=2"), {}, recordingCtx());
  await handler.fetch(new Request("https://worker.test/photo/A1B2C3?x=1"), {}, recordingCtx());
  await handler.fetch(new Request("https://worker.test/photo/a1b2c3"), {}, recordingCtx());
  const scheduleKeys = keys.filter((k) => /schedule/.test(k));
  const photoKeys = keys.filter((k) => /photo/.test(k));
  assert.equal(new Set(scheduleKeys).size, 1, "schedule keys: " + scheduleKeys.join(", "));
  assert.equal(new Set(photoKeys).size, 1, "photo keys: " + photoKeys.join(", "));
  assert.ok(!scheduleKeys[0].includes("?") && !photoKeys[0].includes("?"));
});

test("schedule keeps page 1 when optional page 2 fails (network error or bad JSON)", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => true } };
  let page2;
  globalThis.fetch = async (url) => {
    if (String(url).includes("page=2")) return page2();
    return new Response(JSON.stringify(scheduleRaw(["UA1", "UA2"])), { status: 200 });
  };
  fr24ResetBackoff();
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; fr24ResetBackoff(); });

  page2 = async () => { throw new TypeError("network down"); };
  let response = await handler.fetch(new Request("https://worker.test/schedule/SFO"), {}, recordingCtx());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).arrivals.length, 2);

  page2 = async () => new Response("<html>oops</html>", { status: 200 });
  response = await handler.fetch(new Request("https://worker.test/schedule/SFO"), {}, recordingCtx());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).arrivals.length, 2);
});

test("adsb grid rejects out-of-range lat and non-positive dist with 400", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const path of [
    "/adsb/lat/91/lon/0/dist/50",
    "/adsb/lat/-90.5/lon/0/dist/50",
    "/adsb/lat/0/lon/0/dist/0",
    "/adsb/lat/0/lon/0/dist/-5",
  ]) {
    const response = await handler.fetch(new Request("https://worker.test" + path), {}, {});
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  }
});

test("adsb grid wraps unwrapped longitudes and clamps dist to 250 NM (old clients keep working)", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const upstream = [];
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response(JSON.stringify({ ac: [], now: Date.now() }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const wrapped = await handler.fetch(new Request("https://worker.test/adsb/lat/10/lon/-190/dist/50"), {}, recordingCtx());
  assert.equal(wrapped.status, 200);
  assert.match(upstream.at(-1), /\/lat\/10\.00\/lon\/170\.00\/dist\/50$/);

  const wide = await handler.fetch(new Request("https://worker.test/adsb/lat/37.6/lon/-122.4/dist/274"), {}, recordingCtx());
  assert.equal(wide.status, 200);
  assert.match(upstream.at(-1), /\/dist\/250$/);
});

test("adsb lookup with a malformed %-escape returns 400 with CORS, not a throw", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await handler.fetch(new Request("https://worker.test/adsb/callsign/UAL%E0%A4%A"), {}, {});
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("routeset drops planes whose callsign is not 2-8 letters/digits", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({
      response: { flightroute: { origin: { iata_code: "SFO", name: "SFO" }, destination: { iata_code: "LAX", name: "LAX" } } },
    }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const response = await handler.fetch(new Request("https://worker.test/routeset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planes: [{ callsign: "../aircraft/a1b2c3" }, { callsign: "UAL1" }] }),
  }), {}, recordingCtx());
  assert.equal(response.status, 200);
  const routes = await response.json();
  assert.deepEqual(routes.map((r) => r.callsign), ["UAL1"]);
  assert.ok(fetched.every((u) => !u.includes("..") && !u.includes("aircraft")), fetched.join(", "));
});

test("routeset rejects bodies over 64 KB before parsing", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const big = JSON.stringify({ planes: [{ callsign: "UAL1", pad: "x".repeat(70 * 1024) }] });
  const response = await handler.fetch(new Request("https://worker.test/routeset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: big,
  }), {}, recordingCtx());
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("routeset stops reading a streamed body without Content-Length once it passes 64 KB", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("upstream must not be called"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(4096).fill(32);
  const body = new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled > 1000) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://worker.test/routeset", { method: "POST", body, duplex: "half" });
  assert.equal(request.headers.get("Content-Length"), null);
  const response = await handler.fetch(request, {}, recordingCtx());
  assert.equal(response.status, 413);
  assert.ok(pulled <= 20, `should stop after ~17 x 4 KB chunks, pulled ${pulled}`);
  assert.equal(cancelled, true);
});

test("schedule success that began before a fresh 429 does not clear that backoff", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => true } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("code=SFO")) {
      await gate;
      return new Response(JSON.stringify(scheduleRaw([])), { status: 200 });
    }
    return new Response("", { status: 429 });
  };
  fr24ResetBackoff();
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; fr24ResetBackoff(); });

  const slow = handler.fetch(new Request("https://worker.test/schedule/SFO"), {}, recordingCtx());
  await new Promise((resolve) => setTimeout(resolve, 1));
  const limited = await handler.fetch(new Request("https://worker.test/schedule/JFK"), {}, recordingCtx());
  assert.equal(limited.status, 503);
  release();
  assert.equal((await slow).status, 200);
  assert.equal(await fr24CheckBackoff(), true, "stale success must not clear the new backoff");
});

test("route passthrough is gone", async () => {
  const response = await handler.fetch(new Request("https://worker.test/route/callsign/UAL1"), {}, {});
  assert.equal(response.status, 404);
});

test('v247 routeset: forwards current aircraft state to reject a stale callsign leg', async (t) => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  t.after(() => { globalThis.caches = previousCaches; });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ response: { flightroute: {
    origin: { iata_code: 'SYD', name: 'Sydney' }, destination: { iata_code: 'LAX', name: 'Los Angeles' }
  } } })));
  const response = await handler.fetch(new Request('https://worker.test/routeset', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planes: [
      { callsign: 'UAL3911', lat: 37.60, lng: -122.30, altFt: 1500, vRate: -700, track: 280 },
      { callsign: 'UAL1', lat: 33.94, lng: -118.41, ground: true, altFt: 0 }
    ] }) }), {}, recordingCtx());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map(r => r.callsign), ['UAL1']);
});
