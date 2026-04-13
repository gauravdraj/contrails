import test from "node:test";
import assert from "node:assert/strict";

import handler from "./index.js";

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
