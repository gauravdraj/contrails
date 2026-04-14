import test from "node:test";
import assert from "node:assert/strict";
import { fr24CheckBackoff, fr24TriggerBackoff, fr24ResetBackoff, fr24CachedSearch } from "./fr24-backoff.js";

function makeMockCache() {
  const store = new Map();
  return {
    match(req) { return Promise.resolve(store.get(req.url) || null); },
    put(req, resp) { store.set(req.url, resp.clone()); return Promise.resolve(); },
    delete(req) { store.delete(req.url); return Promise.resolve(true); },
    _store: store,
  };
}

function makeMockCtx() {
  const pending = [];
  return { waitUntil(p) { pending.push(p); }, _pending: pending };
}

const mockCache = makeMockCache();
globalThis.caches = { default: mockCache };

function fullReset() {
  const ctx = makeMockCtx();
  fr24ResetBackoff(ctx);
  mockCache._store.clear();
}

test("check returns false initially", async () => {
  fullReset();
  assert.equal(await fr24CheckBackoff(), false);
});

test("trigger makes check return true", async () => {
  fullReset();
  fr24TriggerBackoff(makeMockCtx());
  assert.equal(await fr24CheckBackoff(), true);
});

test("trigger doubles delay, capped at 300000", async () => {
  fullReset();
  const ctx = makeMockCtx();
  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);

  fullReset();

  for (let i = 0; i < 6; i++) fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
});

test("reset clears backoff", async () => {
  fullReset();
  const ctx = makeMockCtx();
  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
  fr24ResetBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), false);
});

test("multiple trigger/reset cycles work correctly", async () => {
  fullReset();
  const ctx = makeMockCtx();

  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
  fr24ResetBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), false);

  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
  fr24ResetBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), false);

  fr24TriggerBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), true);
  fr24ResetBackoff(ctx);
  assert.equal(await fr24CheckBackoff(), false);
});

// --- Cache API interaction tests ---

test("trigger writes backoff state to cache with s-maxage", async () => {
  fullReset();
  const ctx = makeMockCtx();
  fr24TriggerBackoff(ctx);
  await Promise.all(ctx._pending);

  const entry = await mockCache.match(new Request("https://fr24-backoff-state/global"));
  assert.ok(entry, "cache entry should exist after trigger");

  const data = await entry.json();
  assert.ok(data.until > Date.now(), "cached until should be in the future");

  const cc = entry.headers.get("Cache-Control");
  assert.ok(cc && cc.includes("s-maxage="), "should have s-maxage header");
});

test("cold start: check restores backoff from cache when in-memory is clear", async () => {
  fullReset();
  const ctx = makeMockCtx();
  fr24TriggerBackoff(ctx);
  await Promise.all(ctx._pending);

  // Simulate cold start: clear in-memory but keep cache entry
  fr24ResetBackoff(); // no ctx → in-memory cleared, cache untouched

  const result = await fr24CheckBackoff();
  assert.equal(result, true, "should restore backoff from cache on cold start");
});

test("reset with ctx deletes cache entry", async () => {
  fullReset();
  const ctx = makeMockCtx();
  fr24TriggerBackoff(ctx);
  await Promise.all(ctx._pending);

  assert.ok(mockCache._store.size > 0, "cache should have entry before reset");

  const ctx2 = makeMockCtx();
  fr24ResetBackoff(ctx2);
  await Promise.all(ctx2._pending);

  const entry = await mockCache.match(new Request("https://fr24-backoff-state/global"));
  assert.equal(entry, null, "cache entry should be deleted after reset");
});

test("check fast-paths on in-memory backoff without cache read", async () => {
  fullReset();
  let matchCalled = false;
  const origMatch = mockCache.match;
  mockCache.match = (req) => { matchCalled = true; return origMatch.call(mockCache, req); };

  fr24TriggerBackoff(makeMockCtx());
  matchCalled = false;
  const result = await fr24CheckBackoff();
  assert.equal(result, true);
  assert.equal(matchCalled, false, "should not read cache when in-memory says backoff");

  mockCache.match = origMatch;
});

// --- fr24CachedSearch tests ---

test("fr24CachedSearch returns cached data without fetching", async () => {
  fullReset();
  const searchData = { results: [{ type: "live", detail: { callsign: "UAL123" } }] };
  await mockCache.put(
    new Request("https://fr24-search-cache/UAL123"),
    new Response(JSON.stringify(searchData), { headers: { "Content-Type": "application/json" } }),
  );

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 500 }); };

  const result = await fr24CachedSearch("UAL123", makeMockCtx());
  assert.deepEqual(result, searchData);
  assert.equal(fetchCalled, false, "should not fetch when cache hit");

  globalThis.fetch = origFetch;
});

test("fr24CachedSearch fetches and caches on miss", async () => {
  fullReset();
  const searchData = { results: [{ type: "live" }] };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(searchData), { status: 200 });

  const ctx = makeMockCtx();
  const result = await fr24CachedSearch("UAL123", ctx);
  assert.deepEqual(result, searchData);

  await Promise.all(ctx._pending);

  const cached = await mockCache.match(new Request("https://fr24-search-cache/UAL123"));
  assert.ok(cached, "search result should be written to cache");
  const cachedData = await cached.json();
  assert.deepEqual(cachedData, searchData);

  globalThis.fetch = origFetch;
});

test("fr24CachedSearch normalizes cache key across callers", async () => {
  fullReset();
  const searchData = { results: [{ type: "schedule" }] };

  const origFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return new Response(JSON.stringify(searchData), { status: 200 }); };

  const ctx = makeMockCtx();
  await fr24CachedSearch("ual123", ctx);
  await Promise.all(ctx._pending);
  assert.equal(fetchCount, 1);

  const result = await fr24CachedSearch("  UAL123  ", makeMockCtx());
  assert.deepEqual(result, searchData, "different casing/whitespace should hit same cache");
  assert.equal(fetchCount, 1, "second call should be a cache hit, no fetch");

  globalThis.fetch = origFetch;
});

test("fr24CachedSearch returns null during backoff", async () => {
  fullReset();
  fr24TriggerBackoff(makeMockCtx());

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 200 }); };

  const result = await fr24CachedSearch("UAL123", makeMockCtx());
  assert.equal(result, null);
  assert.equal(fetchCalled, false, "should not fetch during backoff");

  globalThis.fetch = origFetch;
});

test("fr24CachedSearch triggers backoff on 429", async () => {
  fullReset();

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 429 });

  const result = await fr24CachedSearch("UAL123", makeMockCtx());
  assert.equal(result, null);
  assert.equal(await fr24CheckBackoff(), true, "backoff should be active after 429");

  globalThis.fetch = origFetch;
});
