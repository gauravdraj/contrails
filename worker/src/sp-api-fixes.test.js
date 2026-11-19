import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { resolveFlight, handleFlight } from "./flight.js";
import { loadSchedule, loadSearch, loadLookup } from "./loaders.js";
import { handleMcp } from "./mcp.js";
import { fixtures, fixtureDeps, installFixtures, rawSchedule } from "../test-fixtures/sp-api/helpers.js";

const now = fixtures.epochMs;
const live = fixtures.liveInbound.lookup.ac[0];
const ground = { ...live, lat: 51.471, lon: -0.46, alt_baro: "ground", seen_pos: 0 };
const wrong = { ...ground, hex: "abcdef", r: "G-WRONG" };
const watchUrl = (airport = true) => new URL(`https://worker.test/flight/BA305/watch?until=${Math.floor(now / 1000) + 3600}${airport ? "&airport=LHR" : ""}`);
const completeSchedule = rows => ({ status: "ok", complete: true, data: { arrivals: rows, departures: [] } });
function flightDeps(planes, row = fixtures.liveInbound.row) {
  return { ...fixtureDeps(), loadSchedule: async () => completeSchedule(row ? [row] : []),
    loadLookup: async () => ({ status: "ok", data: { now, ac: planes } }),
    getBoard: async () => ({ sources: { traffic: "ok", schedule: "ok" }, arrivals: [
      { hex: "abcdef", callsign: "BAW305", etaMin: 1 },
      { hex: live.hex, callsign: "BAW305", etaMin: 9 },
    ] }),
  };
}
const rpc = (method, id = 1, params) => ({ jsonrpc: "2.0", method, id, ...(params ? { params } : {}) });
const mcpRequest = (message, version) => new Request("https://worker.test/mcp", { method: "POST",
  headers: { "Content-Type": "application/json", ...(version === undefined ? {} : { "Mcp-Protocol-Version": version }) },
  body: typeof message === "string" ? message : JSON.stringify(message) });
async function tool(name, deps, args = { iata: "LHR" }) {
  return (await (await handleMcp(mcpRequest(rpc("tools/call", 1, { name, arguments: args })), {}, null, deps)).json()).result;
}

test("identity: schedule registration selects the tracked aircraft and its board ETA", async t => {
  installFixtures(t);
  for (const planes of [[wrong, live], [live, wrong]]) {
    const deps = flightDeps(planes);
    const resolved = await resolveFlight("BA305", { airport: "LHR" }, {}, null, deps);
    assert.equal(resolved.data.registration, "G-EUPD");
    assert.equal(resolved.data.position.ground, false);
    assert.equal(resolved.data.etaMin, 9, "another hex cannot supply the board ETA");
    const watch = await handleFlight(watchUrl(), {}, null, deps);
    assert.equal(await watch.text(), "contrails-watch v1 | BA305 | 2/3 within-10");
  }
});

test("identity: contradicting or unidentified lookup rows cannot prove departure or landing", async t => {
  installFixtures(t);
  for (const plane of [wrong, { ...wrong, alt_baro: 5000 }, { ...ground, r: null }]) {
    const resolved = await resolveFlight("BA305", { airport: "LHR" }, {}, null,
      flightDeps([plane], { ...fixtures.liveInbound.row, actual_dep: null }));
    assert.equal(resolved.data.position, null);
    assert.equal(resolved.data.milestone.rank, 0);
  }
});

for (const identity of [{ reg: "G-EUPD" }, { hex: live.hex.toUpperCase() }]) {
  test("identity: FR24 " + Object.keys(identity)[0] + " rejects a different ground aircraft", async t => {
    installFixtures(t);
    const deps = flightDeps([wrong, live], null);
    deps.loadSearch = async () => ({ status: "ok", data: { results: [
      { type: "live", detail: { flight: "BA305", callsign: "BAW305", schd_to: "LHR", ...identity } },
    ] } });
    const watch = await handleFlight(watchUrl(false), {}, null, deps);
    assert.equal(await watch.text(), "contrails-watch v1 | BA305 | 2/3 within-10");
  });
}

test("identity: an airborne lookup row supplies identity when the schedule has none", async t => {
  installFixtures(t);
  const deps = flightDeps([wrong, live], { ...fixtures.liveInbound.row, reg: null });
  const resolved = await resolveFlight("BA305", { airport: "LHR" }, {}, null, deps);
  assert.equal(resolved.data.position.ground, false);
  assert.equal(resolved.data.milestone.rank, 2);
});

test("identity: an airborne match supplies hex even when registration is already known", async t => {
  installFixtures(t);
  const deps = flightDeps([{ ...wrong, r: live.r }, live]);
  const resolved = await resolveFlight("BA305", { airport: "LHR" }, {}, null, deps);
  assert.equal(resolved.data.position.ground, false);
  assert.equal(resolved.data.milestone.rank, 2);
});

test("identity: unknown ground identity still needs freshness and destination proximity", async t => {
  installFixtures(t);
  for (const [plane, rank] of [[ground, 3], [{ ...ground, seen_pos: 61 }, 0], [{ ...ground, lat: 50 }, 0]]) {
    const resolved = await resolveFlight("BA305", { airport: "LHR" }, {}, null,
      flightDeps([plane], { ...fixtures.liveInbound.row, reg: null, actual_dep: null }));
    assert.equal(resolved.data.milestone.rank, rank);
  }
});

test("schedule health is atomic even when a delayed partial write overwrites a complete response", async t => {
  const { cache, ctx } = installFixtures(t);
  const upstream = globalThis.fetch, put = cache.put.bind(cache);
  let partial = true, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { started = resolve; });
  globalThis.fetch = (url, options) => partial && String(url).includes("page=2") ?
    Promise.resolve(new Response("", { status: 500 })) : upstream(url, options);
  let hold = true;
  cache.put = async (key, response) => {
    if (key.url === "https://schedule-cache/LHR" && hold) { hold = false; started(); await gate; }
    return put(key, response);
  };
  const first = await loadSchedule("LHR", ctx);
  await blocked;
  partial = false;
  const second = await loadSchedule("LHR", null);
  release(); await ctx.flush();
  const cached = await loadSchedule("LHR", null);
  assert.equal(first.status, "error"); assert.equal(second.status, "ok");
  assert.deepEqual(cached.data, first.data);
  assert.equal(cached.status, "error");
  assert.equal(cached.complete, false);
  assert.equal(cached.response.headers.get("X-Contrails-Schedule-Complete"), "0");
  assert.ok(!cache.puts.some(entry => entry.key.includes("schedule-status")));
});

test("schedule completeness stays in the cached response and never leaks through legacy HTTP", async t => {
  const { cache, ctx } = installFixtures(t);
  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(new Request("https://worker.test/schedule/LHR"), {}, ctx);
    assert.equal(response.status, 200);
    assert.ok([...response.headers.keys()].every(key => !key.startsWith("x-contrails-schedule-")));
    await ctx.flush();
  }
  const stored = await cache.match(new Request("https://schedule-cache/LHR"));
  assert.equal(stored.headers.get("X-Contrails-Schedule-Complete"), "1");
  // An immutable cache hit with partial health must retain all public bytes/headers.
  const body = '{ "arrivals": [], "departures": [] }\n';
  await cache.put(new Request("https://schedule-cache/LHR"), new Response(body, { headers: {
    "Cache-Control": "s-maxage=300", "X-Cached": "preserved", "X-Contrails-Schedule-Complete": "0", "X-Contrails-Schedule-Status": "backoff",
  } }));
  const partial = await worker.fetch(new Request("https://worker.test/schedule/LHR"), {}, ctx);
  assert.equal(partial.status, 200); assert.equal(await partial.text(), body);
  assert.equal(partial.headers.get("X-Cached"), "preserved");
  assert.ok([...partial.headers.keys()].every(key => !key.startsWith("x-contrails-schedule-")));
});

test("old schedule cache entries remain usable for boards but cannot prove watch absence", async t => {
  const { cache, ctx } = installFixtures(t);
  await cache.put(new Request("https://schedule-cache/LHR"), Response.json({ arrivals: [], departures: [] },
    { headers: { "Cache-Control": "s-maxage=300" } }));
  await cache.put(new Request("https://adsb-lookup/callsign/BAW305"), Response.json({ ac: [] },
    { headers: { "Cache-Control": "s-maxage=5" } }));
  const loaded = await loadSchedule("LHR", ctx);
  assert.equal(loaded.status, "ok");
  const board = await worker.fetch(new Request("https://worker.test/board/LHR"), {}, ctx);
  assert.equal(board.status, 200); assert.equal((await board.json()).sources.schedule, "ok");
  const watch = await worker.fetch(new Request(watchUrl()), {}, ctx);
  assert.equal(watch.status, 503); assert.equal(await watch.text(), "contrails-watch unavailable");
  assert.equal(loaded.complete, null);
});

for (const [source, key, loader, invalid] of [
  ["schedule", "https://schedule-cache/LHR", ctx => loadSchedule("LHR", ctx), { arrivals: [], departures: {} }],
  ["search", "https://fr24-search-cache/BA305", ctx => loadSearch("BA305", ctx), { results: {} }],
  ["lookup", "https://adsb-lookup/callsign/BAW305", ctx => loadLookup("callsign", "BAW305", ctx), { ac: {} }],
]) test("error-shaped " + source + " cache payloads are errors and cannot yield waiting", async t => {
  const { cache, ctx } = installFixtures(t);
  for (const data of [{ error: "temporarily unavailable" }, invalid, null]) {
    await cache.put(new Request(key), Response.json(data, { headers: { "Cache-Control": "s-maxage=300", "X-Contrails-Schedule-Complete": "1" } }));
    const loaded = await loader(ctx);
    assert.equal(loaded.status, "error");
    // Other consulted sources are valid and empty, so only this malformed source can cause 503.
    if (source !== "schedule") await cache.put(new Request("https://schedule-cache/LHR"), Response.json({ arrivals: [], departures: [] },
      { headers: { "Cache-Control": "s-maxage=300", "X-Contrails-Schedule-Complete": "1" } }));
    if (source !== "lookup") await cache.put(new Request("https://adsb-lookup/callsign/BAW305"), Response.json({ ac: [] },
      { headers: { "Cache-Control": "s-maxage=5" } }));
    const watch = await worker.fetch(new Request(watchUrl(source !== "search")), {}, ctx);
    assert.equal(watch.status, 503); assert.equal(await watch.text(), "contrails-watch unavailable");
  }
});

for (const source of ["schedule page 1", "schedule page 2", "search"]) {
  test("HTTP 200 error-shaped " + source + " is unavailable, not an empty successful watch", async t => {
    const { ctx } = installFixtures(t);
    globalThis.fetch = async url => {
      const text = String(url);
      if (source === "search" && text.includes("/v1/search/")) return Response.json({ error: "temporarily unavailable" });
      if (source.startsWith("schedule") && text.includes("page=" + source.at(-1))) return Response.json({ error: "temporarily unavailable" });
      if (text.includes("airport.json")) return Response.json(rawSchedule({ arrivals: [], departures: [] }));
      return Response.json({ ac: [], now });
    };
    for (let i = 0; i < 2; i++) {
      const watch = await worker.fetch(new Request(watchUrl(source !== "search")), {}, ctx);
      assert.equal(watch.status, 503); assert.equal(await watch.text(), "contrails-watch unavailable");
      await ctx.flush();
    }
  });
}

test("watch absence requires complete healthy sources; terminal evidence survives unknown completeness", async t => {
  installFixtures(t);
  for (const complete of [false, null, true]) {
    const deps = flightDeps([], null);
    deps.loadSchedule = async () => ({ ...completeSchedule([]), complete });
    const watch = await handleFlight(watchUrl(), {}, null, deps);
    assert.equal(watch.status, complete === true ? 200 : 503);
    deps.loadSchedule = async () => ({ ...completeSchedule([{ ...fixtures.liveInbound.row, actual_arr: now / 1000 }]), complete });
    const terminal = await handleFlight(watchUrl(), {}, null, deps);
    assert.equal(terminal.status, 200); assert.match(await terminal.text(), /3\/3 landed\nSP-WATCH: done$/);
  }
});

test("MCP rejects unsupported supplied protocol versions except initialize", async () => {
  for (const message of [rpc("ping", 0), rpc("tools/list", "list-id"), { jsonrpc: "2.0", method: "notifications/initialized" }, "{"]) {
    const response = await worker.fetch(mcpRequest(message, "1900-01-01"), {}, {});
    assert.equal(response.status, 400);
    const body = await response.json(); assert.ok(body.error); assert.equal(body.id, typeof message === "object" ? message.id ?? null : null);
  }
  for (const version of [undefined, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
    const response = await worker.fetch(mcpRequest(rpc("ping", 0), version), {}, {});
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, {});
  }
  const initialized = await worker.fetch(mcpRequest(rpc("initialize", 1, { protocolVersion: "1900-01-01" }), "1900-01-01"), {}, {});
  assert.equal(initialized.status, 200); assert.equal((await initialized.json()).result.protocolVersion, "2025-11-25");
});

test("MCP request ids must be strings or finite integers", async () => {
  for (const id of ["null", "1.5", "1e400", "-1e400", "true", "{}", "[]"]) {
    const body = await (await worker.fetch(mcpRequest(`{"jsonrpc":"2.0","method":"ping","id":${id}}`), {}, {})).json();
    assert.deepEqual(body, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  for (const id of [0, -7, 42, "", "ping-id"]) {
    const body = await (await worker.fetch(mcpRequest(rpc("ping", id)), {}, {})).json();
    assert.deepEqual(body, { jsonrpc: "2.0", id, result: {} });
  }
  const clientResponse = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }), {}, {});
  assert.equal(clientResponse.status, 202); assert.equal(await clientResponse.text(), "");
});

for (const name of ["airport_board", "next_big"]) {
  test("MCP " + name + " preserves live rows and appends partial-source notes", async () => {
    const row = { flight: "BA305", type: "B789", size: "widebody", origin: "CDG", etaMin: 9 };
    const board = { airport: { iata: "LHR" }, arrivals: [row], departures: [], recent: [],
      scheduled: { arrivals: [], departures: [] }, notes: [] };
    for (const sources of [
      { traffic: "ok", schedule: "backoff", datis: "none" },
      { traffic: "ok", schedule: "error", datis: "none" },
      { traffic: "ok", schedule: "ok", datis: "error" },
    ]) {
      const result = await tool(name, { getBoard: async () => ({ ...board, sources }) });
      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /BA305 B789 from CDG in 9 min/);
      assert.match(result.content[0].text, sources.datis === "error" ? /D-ATIS unavailable[^\n]*\.$/ : /Schedule unavailable[^\n]*\.$/);
    }
    const failed = await tool(name, { getBoard: async () => ({ ...board, sources: { traffic: "error", schedule: "ok", datis: "none" } }) });
    assert.equal(failed.isError, true);
  });
}

test("MCP planes_nearby text includes route, altitude, distance, direction, vertical and alert for up to five planes", async () => {
  const plane = { name: "FedEx 1874", callsign: "FDX1874", type: "B763", routeLine: "departed OAK for LAS",
    altitudeFt: 4525, distance: "11.1 mi ↑4° SE", distanceMiles: "11.1", direction: "SE", vertical: "climbing", alert: "Emergency" };
  const result = await tool("planes_nearby", { handleNearby: async () => Response.json({ planes: Array.from({ length: 6 }, () => plane) }) }, { lat: 37, lng: -122 });
  assert.equal(result.isError, false);
  const text = result.content[0].text;
  assert.ok(text.length <= 600); assert.equal(result.structuredContent.planes.length, 5);
  const lines = text.split("\n").slice(1);
  assert.equal(lines.length, 5);
  for (const line of lines) {
    for (const value of ["FedEx 1874", "B763", "departed OAK for LAS", "4525 ft", "11.1 mi", "SE", "climbing", "Emergency"]) assert.ok(line.includes(value), value + " in " + line);
  }
  const hostile = { ...plane, name: "<x>\n" + "A".repeat(80), routeLine: "<b>\u202edeparted OAK for LAS", alert: "Emergency\n<script>" };
  const sanitized = await tool("planes_nearby", { handleNearby: async () => Response.json({ planes: [hostile] }) }, { lat: 37, lng: -122 });
  assert.ok(!/[^A-Za-z0-9 /().,'+:\n-]/.test(sanitized.content[0].text));
  assert.ok(sanitized.structuredContent.planes[0].name.length <= 40);
});
