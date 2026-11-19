import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { loadSchedule } from "./loaders.js";
import { fr24ResetBackoff } from "./fr24-backoff.js";
import golden from "../test-fixtures/sp-api/legacy-responses.json" with { type: "json" };
import { installFixtures, rawSchedule, fixtures } from "../test-fixtures/sp-api/helpers.js";

// Captured by executing the original index.js with these exact upstream fixtures
// before extraction, including error branches. Compare bytes, not parsed objects.
for (const expected of golden) {
  test("legacy wire contract: " + expected.name, async t => {
    const { ctx, cache } = installFixtures(t);
    if (expected.mode !== "ok") globalThis.fetch = async () => new Response("", { status: expected.mode === "backoff" ? 429 : 500 });
    const response = await worker.fetch(new Request("https://worker.test" + expected.path), {}, ctx);
    await ctx.flush();
    assert.equal(response.status, expected.status);
    assert.deepEqual(Object.fromEntries(response.headers), expected.headers);
    assert.equal(await response.text(), expected.body);
    assert.deepEqual(cache.puts, expected.puts);
  });
}
test("legacy cache hits preserve the exact body and cached headers", async t => {
  const { ctx, cache, calls } = installFixtures(t);
  const entries = [
    ["/adsb/lat/51.471/lon/-0.46/dist/65", "https://adsb-grid/lat/51.45/lon/-0.45/dist/75"],
    ["/adsb/callsign/BAW305", "https://adsb-lookup/callsign/BAW305"],
    ["/schedule/lhr?ignored=yes", "https://schedule-cache/LHR"],
    ["/datis/sfo", "https://datis-cache/KSFO"],
  ];
  for (const [path, key] of entries) {
    const body = '{ "test": true }\n';
    await cache.put(new Request(key), new Response(body, { headers: { "Cache-Control": "s-maxage=300", "X-Cached": "preserved" } }));
    const response = await worker.fetch(new Request("https://worker.test" + path), {}, ctx);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("X-Cached"), "preserved");
  }
  assert.equal(calls.length, 0);
});
for (const failure of ["network", "invalid-json", "http", "backoff"]) {
  test("schedule partial page health survives cache: " + failure, async t => {
    const { ctx, cache } = installFixtures(t);
    globalThis.fetch = async url => {
      if (String(url).includes("page=1")) return Response.json(rawSchedule(fixtures.airports.LHR.schedule));
      if (failure === "network") throw new Error("offline");
      return new Response(failure === "invalid-json" ? "oops" : "", { status: failure === "backoff" ? 429 : failure === "http" ? 500 : 200 });
    };
    const first = await loadSchedule("LHR", ctx);
    assert.equal(first.response.status, 200, "PWA still gets page 1");
    assert.equal(first.status, failure === "backoff" ? "backoff" : "error");
    await ctx.flush();
    fr24ResetBackoff();
    const second = await loadSchedule("LHR", ctx);
    assert.equal(second.status, first.status);
    assert.deepEqual(second.data, first.data);
    assert.ok(cache.puts.some(row => row.key === "https://schedule-cache/LHR" && row.ttl === 300));
  });
}

test("obsolete schedule-health cache failures cannot affect the atomic response", async t => {
  const { ctx, cache } = installFixtures(t);
  const expected = golden.find(row => row.name === "schedule");
  const remove = cache.delete.bind(cache);
  cache.delete = async key => {
    if (key.url === "https://schedule-status/LHR") throw new Error("cache failure");
    return remove(key);
  };
  let response = await worker.fetch(new Request("https://worker.test/schedule/LHR"), {}, ctx);
  assert.equal(response.status, 200); assert.equal(await response.text(), expected.body); await ctx.flush();
  const match = cache.match.bind(cache);
  cache.match = async key => {
    if (key.url === "https://schedule-status/LHR") throw new Error("cache failure");
    return match(key);
  };
  const result = await loadSchedule("LHR", ctx);
  assert.equal(result.status, "ok");
  assert.equal(result.complete, true);
  assert.ok(!cache.matches.includes("https://schedule-status/LHR"));
  response = result.response; assert.equal(response.status, 200); assert.equal(await response.text(), expected.body);
});
