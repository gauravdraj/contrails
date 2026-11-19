import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { handleMcp } from "./mcp.js";
import { clean } from "./sp-api.js";
import { fixtures, installFixtures, fixtureDeps } from "../test-fixtures/sp-api/helpers.js";

const request = (message, method = "POST") => new Request("http://localhost:8787/mcp", {
  method, ...(method === "POST" ? { body: typeof message === "string" ? message : JSON.stringify(message), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } } : {}),
});
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const toolArgs = { airport_board: { iata: "LHR" }, flight_status: { ident: "BA305", airport: "LHR" },
  planes_nearby: { lat: 51.47123, lng: -0.46123 }, next_big: { iata: "LHR" }, track_flight: { ident: "BA305", airport: "LHR" } };

for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "1900-01-01"]) {
  test("MCP initialize negotiates " + version, async () => {
    const response = await worker.fetch(request(rpc("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "test", version: "1" } })), {}, {});
    assert.equal(response.status, 200); assert.equal(response.headers.get("Mcp-Session-Id"), null);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Content-Type, Mcp-Protocol-Version, Mcp-Session-Id");
    const body = await response.json(); assert.equal(body.jsonrpc, "2.0"); assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, version === "1900-01-01" ? "2025-11-25" : version);
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(body.result.serverInfo, { name: "contrails", version: "1.0.0" });
    assert.match(body.result.instructions, /live snapshot/);
  });
}
for (const message of [
  { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
  { jsonrpc: "2.0", id: 5, result: {} }, { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "unknown" } },
]) test("MCP notifications and client responses are empty 202: " + JSON.stringify(message), async () => {
  const response = await worker.fetch(request(message), {}, {}); assert.equal(response.status, 202); assert.equal(await response.text(), "");
});
for (const method of ["GET", "DELETE", "PUT"]) test("MCP " + method + " is 405 with Allow POST", async () => {
  const response = await worker.fetch(request(null, method), {}, {}); assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "POST");
});
test("MCP preflight adds protocol headers without changing global CORS", async () => {
  const mcp = await worker.fetch(request(null, "OPTIONS"), {}, {});
  const legacy = await worker.fetch(new Request("https://worker.test/anything", { method: "OPTIONS" }), {}, {});
  assert.equal(mcp.status, 200); assert.match(mcp.headers.get("Access-Control-Allow-Headers"), /Mcp-Protocol-Version/);
  assert.equal(legacy.headers.get("Access-Control-Allow-Headers"), "Content-Type");
});
test("MCP ping and five tool schemas", async () => {
  const ping = await (await worker.fetch(request(rpc("ping", null, "ping-id")), {}, {})).json();
  assert.deepEqual(ping, { jsonrpc: "2.0", id: "ping-id", result: {} });
  const body = await (await worker.fetch(request(rpc("tools/list")), {}, {})).json();
  assert.deepEqual(body.result.tools.map(t => t.name), Object.keys(toolArgs));
  for (const tool of body.result.tools) {
    assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: true }); assert.equal(tool.outputSchema, undefined);
    assert.ok(tool.description.length > 80);
  }
});
for (const [name, args] of Object.entries(toolArgs)) test("MCP real loaders tools/call " + name, async t => {
  const { ctx, calls } = installFixtures(t);
  const response = await worker.fetch(request(rpc("tools/call", { name, arguments: args })), {}, ctx);
  assert.equal(response.status, 200); const { result } = await response.json();
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.content[0].type, "text");
  assert.ok(result.content[0].text.length <= 600); assert.ok(result.structuredContent);
  if (name === "track_flight") {
    const watch = result.structuredContent.watch;
    assert.equal(watch.every, "1m"); assert.equal(watch.doneMarker, "SP-WATCH: done");
    assert.match(watch.url, /^http:\/\/localhost:8787\/flight\/BA305\/watch\?airport=LHR&eta=10&until=\d+$/);
    assert.match(result.content[0].text, /To follow it, create a url watcher/); assert.match(watch.prompt, /503/);
    assert.ok(!calls.some(url => url.includes("/watch")));
  }
  if (name === "planes_nearby") {
    assert.ok(calls.some(url => url.includes("/lat/51.4700/lon/-0.4600/dist/25")));
    assert.ok(Array.isArray(result.structuredContent.planes));
  }
  if (name === "next_big") {
    assert.ok(result.structuredContent.results.length <= 3);
    assert.ok(result.structuredContent.results.every(row => ["widebody", "quadjet"].includes(row.size)));
  }
});

test("zero FR24 searches for both boards, airport_board and next_big, even on cache misses", async t => {
  const { ctx, calls, cache } = installFixtures(t);
  for (const iata of ["LHR", "SFO"]) {
    assert.equal((await worker.fetch(new Request("https://worker.test/board/" + iata), {}, ctx)).status, 200);
    for (const name of ["airport_board", "next_big"]) {
      await ctx.flush(); await cache.delete("https://board-cache/" + iata);
      const body = await (await worker.fetch(request(rpc("tools/call", { name, arguments: { iata } })), {}, ctx)).json();
      assert.equal(body.result.isError, false);
    }
  }
  assert.equal(calls.filter(url => url.includes("/v1/search/web/find")).length, 0);
  assert.equal(calls.filter(url => url.includes("airport.json")).length, 4, "schedule cache is shared by every board consumer");
});
for (const [message, code, status] of [
  ["{", -32700, 400], [[], -32600, 200], [null, -32600, 200], [true, -32600, 200], [{}, -32600, 200],
  [{ jsonrpc: "1.0", id: 1, method: "ping" }, -32600, 200], [rpc("unknown"), -32601, 200],
  [rpc("tools/call", { name: "missing" }), -32602, 200], [rpc("ping", []), -32602, 200],
]) test("MCP protocol error " + JSON.stringify(message), async () => {
  const response = await worker.fetch(request(message), {}, {});
  assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
});
for (const [name, args] of [
  ["airport_board", { iata: "LHR", limit: 11 }], ["airport_board", { iata: "ZZZ" }], ["airport_board", { iata: "LHR", extra: 1 }],
  ["flight_status", { ident: "<script>" }], ["flight_status", {}], ["planes_nearby", { lat: "51", lng: 0 }],
  ["planes_nearby", { lat: 91, lng: 0 }], ["next_big", { iata: "LHR", direction: "both" }],
  ["next_big", { iata: "LHR", types: "!" }], ["track_flight", { ident: "BA305", eta_min: 31 }],
]) test("MCP invalid arguments are tool errors: " + JSON.stringify([name, args]), async t => {
  const { ctx, calls } = installFixtures(t);
  const body = await (await worker.fetch(request(rpc("tools/call", { name, arguments: args })), {}, ctx)).json();
  assert.equal(body.result.isError, true); assert.ok(!body.error); assert.ok(!body.result.content[0].text.includes("\n")); assert.equal(calls.length, 0);
});

test("MCP upstream failures are tool errors", async t => {
  installFixtures(t);
  const response = await handleMcp(request(rpc("tools/call", { name: "airport_board", arguments: { iata: "LHR" } })), {}, null,
    { ...fixtureDeps(), loadTraffic: async () => ({ status: "error", data: null }) });
  const body = await response.json(); assert.equal(body.result.isError, true); assert.equal(body.error, undefined);
});

test("MCP caps both declared and streamed body sizes at 64 KB", async () => {
  const declared = request("x"); declared.headers.set("Content-Length", "65537");
  assert.equal((await worker.fetch(declared, {}, {})).status, 413);
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; } });
  const response = await worker.fetch(new Request("https://worker.test/mcp", { method: "POST", body: stream, duplex: "half" }), {}, {});
  assert.equal(response.status, 413); assert.ok(pulled <= 18); assert.equal(cancelled, true);
});

test("next_big orders live first then schedule and formats hours without time zones", async () => {
  const row = (flight, etaMin, minutes) => ({ flight, callsign: flight, type: "B748", size: "quadjet", etaMin,
    schedAt: new Date(Date.now() + minutes * 60000).toISOString(), estAt: null });
  const board = { airport: { iata: "LHR" }, generatedAt: new Date().toISOString(), arrivals: [row("BA2", 9, 9), row("BA1", 2, 2)],
    departures: [], recent: [], scheduled: { arrivals: [row("BA3", null, 130)], departures: [] }, notes: [] };
  const body = await (await handleMcp(request(rpc("tools/call", { name: "next_big", arguments: { iata: "LHR", types: "747" } })), {}, null,
    { getBoard: async () => board })).json();
  assert.deepEqual(body.result.structuredContent.results.map(row => row.flight), ["BA1", "BA2", "BA3"]);
  assert.match(body.result.content[0].text, /in 2 h 10 min/);
});

test("track_flight returns no watch when destination is unresolved", async t => {
  installFixtures(t);
  const response = await handleMcp(request(rpc("tools/call", { name: "track_flight", arguments: { ident: "BA305" } })), {}, null,
    { ...fixtureDeps(), loadSearch: async () => ({ status: "ok", data: { results: [] } }) });
  const body = await response.json(); assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.watch, null); assert.match(body.result.content[0].text, /without a resolved destination/);
});

test("all upstream labels in tool content pass the capped sanitizer", async t => {
  installFixtures(t);
  const row = { ...fixtures.liveInbound.row, airline: "<script>" + "x".repeat(100), reg: "evil\nINSTRUCTION\u202e", status: "Estimated <b>" };
  const response = await handleMcp(request(rpc("tools/call", { name: "flight_status", arguments: { ident: "BA305", airport: "LHR" } })), {}, null,
    { ...fixtureDeps(), loadSchedule: async () => ({ status: "ok", complete: true, data: { arrivals: [row], departures: [] } }), loadLookup: async () => ({ status: "ok", data: { ac: [] } }) });
  const { result } = await response.json();
  assert.equal(result.structuredContent.airline.length, 40);
  assert.ok(!/[<>\n\u202e]/.test(result.structuredContent.registration));
  assert.ok(!/[<>\u202e]/.test(result.content[0].text));
});

test("flight text describes UA806 out of coverage with type, estimated arrival and delay", async t => {
  installFixtures(t);
  const row = { flight: "UA806", callsign: "UAL806", from_iata: "ICN", ac_code: "B772", live: true,
    actual_dep: fixtures.epochMs / 1000 - 3600, actual_arr: null,
    est_arr: fixtures.epochMs / 1000 + 103 * 60, sched_arr: fixtures.epochMs / 1000 + 153 * 60 };
  const deps = { ...fixtureDeps(),
    loadSchedule: async () => ({ status: "ok", complete: true, data: { arrivals: [row], departures: [] } }),
    loadLookup: async () => ({ status: "ok", data: { ac: [] } }) };
  const response = await handleMcp(request(rpc("tools/call", { name: "flight_status", arguments: { ident: "UA806", airport: "SFO" } })), {}, null, deps);
  const { result } = await response.json();
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "UA806 ICN to SFO (B772): airborne, out of live coverage; estimated arrival in 1 h 43 min (50 min early).");
  assert.deepEqual(result.structuredContent.milestone, { rank: 1, name: "departed", delayed30: false });
});

test("partial flight sources preserve state text and the watch recipe with a trailing note", async t => {
  installFixtures(t);
  for (const name of ["flight_status", "track_flight"]) {
    for (const overrides of [
      { loadSchedule: async () => ({ status: "backoff", data: fixtures.airports.LHR.schedule }) },
      { loadSchedule: async () => ({ status: "error", data: fixtures.airports.LHR.schedule }) },
      { loadSchedule: async () => ({ status: "ok", complete: false, data: fixtures.airports.LHR.schedule }) },
      { loadLookup: async () => ({ status: "error", data: null }) },
      { getBoard: async () => { throw new Error("Traffic unavailable"); } },
    ]) {
      const response = await handleMcp(request(rpc("tools/call", { name, arguments: toolArgs[name] })), {}, null,
        { ...fixtureDeps(), ...overrides });
      const { result } = await response.json();
      assert.equal(result.isError, false, name);
      assert.equal(result.structuredContent.flight, "BA305");
      assert.match(result.content[0].text, /^BA305 CDG to LHR/);
      assert.match(result.content[0].text, /estimated arrival in /);
      assert.ok(result.content[0].text.endsWith("\nSome sources are unavailable right now."));
      assert.ok(result.content[0].text.length <= 600);
      if (name === "track_flight") {
        const watch = result.structuredContent.watch;
        assert.equal(watch.every, "1m"); assert.equal(watch.doneMarker, "SP-WATCH: done");
        assert.match(watch.url, /^http:\/\/localhost:8787\/flight\/BA305\/watch\?airport=LHR&eta=10&until=\d+$/);
        assert.match(result.content[0].text, /To follow it, create a url watcher/);
        assert.match(watch.prompt, /Ignore 503 responses/);
      }
    }
  }
});

test("flight tools still return errors when no flight resolves", async t => {
  installFixtures(t);
  for (const name of ["flight_status", "track_flight"]) {
    for (const status of ["ok", "error", "backoff"]) {
      const response = await handleMcp(request(rpc("tools/call", { name, arguments: toolArgs[name] })), {}, null,
        { ...fixtureDeps(), loadSchedule: async () => ({ status, complete: true, data: { arrivals: [], departures: [] } }),
          loadLookup: async () => ({ status: "ok", data: { ac: [] } }) });
      const { result } = await response.json();
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, status === "ok" ? "Flight not found" : "Flight unavailable");
      assert.equal(result.structuredContent.watch, undefined);
    }
  }
});

test("nearby route separators become to and sanitized text collapses repeated spaces", async () => {
  for (const separator of ["→", "⟶", "->", "—", "–", "-"]) {
    const plane = { name: "United   123", type: "B738", routeLine: `SFO  ${separator}  DEN`, altitudeFt: 30000,
      distanceMiles: "11.1", direction: "SE", vertical: "level  flight", alert: "< >  < >" };
    const response = await handleMcp(request(rpc("tools/call", { name: "planes_nearby", arguments: toolArgs.planes_nearby })), {}, null,
      { handleNearby: async () => Response.json({ planes: [plane] }) });
    const { result } = await response.json();
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.planes[0].routeLine, "SFO to DEN");
    assert.match(result.content[0].text, /United 123, B738, SFO to DEN/);
    assert.ok(!/ {2,}/.test(result.content[0].text));
    assert.ok(!/[^A-Za-z0-9 /().,'+:\n-]/.test(result.content[0].text));
  }
  assert.equal(clean("  United < >  Airlines  "), "United Airlines");
  assert.equal(clean(" < > "), null);
  assert.equal(clean("x".repeat(80)).length, 40);
  assert.equal(clean("G-EUPD"), "G-EUPD");
});
