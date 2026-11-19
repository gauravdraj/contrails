import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { handleFlight, resolveFlight, milestoneFor, foldWatchLines, watchBody, makeWatchUrl } from "./flight.js";
import { selectFlightRow, airportFor } from "./sp-api.js";
import { fixtures, installFixtures, fixtureDeps } from "../test-fixtures/sp-api/helpers.js";
import cases from "../test-fixtures/sp-api/watch-cases.json" with { type: "json" };

const now = fixtures.epochMs, until = Math.floor(now / 1000) + 86400;
const flightUrl = (suffix = "") => new URL("https://worker.test/flight/BA305" + suffix);
const watchUrl = (extra = "") => flightUrl(`/watch?airport=LHR&eta=10&until=${until}${extra}`);
function evidence({ row = {}, plane = {}, eta = 9, lookupError = false, scheduleStatus = "ok", boardError = false } = {}) {
  const schedule = { arrivals: [{ ...fixtures.liveInbound.row, ...row }], departures: [] };
  return { ...fixtureDeps(), loadSchedule: async () => ({ status: scheduleStatus, complete: true, data: schedule }),
    loadLookup: async () => lookupError ? { status: "error", data: null } : { status: "ok", data: {
      now, ac: plane === null ? [] : [{ ...fixtures.liveInbound.lookup.ac[0], ...plane }],
    } },
    getBoard: async () => {
      if (boardError) throw new Error("traffic failed");
      return { sources: { traffic: "ok", schedule: "ok" }, arrivals: [{ hex: "400804", callsign: "BAW305", etaMin: eta, runway: "27R", sequence: 3 }] };
    },
  };
}

test("flight HTTP uses real schedule, lookup and cached board; no search with airport", async t => {
  const { ctx, cache, calls } = installFixtures(t);
  const response = await worker.fetch(new Request(flightUrl("?airport=LHR")), {}, ctx);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  const f = await response.json();
  assert.deepEqual([f.ident, f.flight, f.callsign, f.airline, f.origin, f.destination, f.type, f.size],
    ["BA305", "BA305", "BAW305", "British Airways", "CDG", "LHR", "A319", "narrowbody"]);
  assert.equal(f.phase, "approach"); assert.equal(f.etaSource, "board"); assert.equal(f.runway, "27R"); assert.equal(f.sequence, 3);
  assert.equal(f.milestone.rank, 2); assert.equal(f.actualArr, null); assert.equal(f.estDep, null);
  assert.equal(f.delayMin, -31); assert.match(f.schedArr, /Z$/);
  assert.equal(f.position.ground, false); assert.ok(f.position.ageSec < 60);
  assert.match(f.watchUrl, /^https:\/\/worker.test\/flight\/BA305\/watch\?airport=LHR&eta=10&until=\d+$/);
  assert.equal(calls.filter(url => url.includes("/v1/search/web/find")).length, 0);
  await ctx.flush();
  assert.ok(cache.puts.some(p => p.key === "https://adsb-lookup/callsign/BAW305" && p.ttl === 5));
  assert.ok(cache.puts.some(p => p.key === "https://board-cache/LHR" && p.ttl === 20));
});

test("flight without airport uses one exact search, then shared schedule and lookup caches", async t => {
  const { ctx, cache, calls } = installFixtures(t);
  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(new Request(flightUrl()), {}, ctx);
    assert.equal(response.status, 200); assert.equal((await response.json()).flight, "BA305"); await ctx.flush();
  }
  assert.equal(calls.filter(url => url.includes("/v1/search/web/find")).length, 1);
  assert.ok(cache.puts.some(p => p.key === "https://fr24-search-cache/BA305" && p.ttl === 300));
});

test("captured UA837 begins results do not select UA8375 codeshares", async t => {
  installFixtures(t);
  const deps = { ...evidence({ plane: null }), loadSearch: async () => ({ status: "ok", data: fixtures.ua837Search }),
    loadSchedule: async () => ({ status: "ok", complete: true, data: { arrivals: [], departures: [] } }) };
  const result = await resolveFlight("UA837", {}, {}, null, deps);
  assert.equal(result.data.flight, "UA837"); assert.equal(result.data.callsign, "UAL837");
  deps.loadSearch = async () => ({ status: "ok", data: { results: fixtures.ua837Search.results.filter(r => r.detail?.flight !== "UA837") } });
  assert.equal((await resolveFlight("UA837", {}, {}, null, deps)).status, 404);
});

test("schedule choice prefers live then nearest arrival across directions", () => {
  const base = { flight: "BA 305", callsign: "BAW305", sched_arr: now / 1000 };
  const live = { ...base, live: true, est_arr: now / 1000 + 100 };
  const farther = { ...live, est_arr: now / 1000 + 1000 };
  assert.equal(selectFlightRow({ arrivals: [base, farther], departures: [live] }, ["BA305"], now).row, live);
});

test("hex resolves its transponder callsign against an airport schedule", async t => {
  installFixtures(t);
  const result = await resolveFlight("400804", { airport: "LHR" }, {}, null, evidence());
  assert.equal(result.data.flight, "BA305"); assert.equal(result.data.destination, "LHR");
});

for (const [path, status] of [
  ["/flight/!!!", 400], ["/flight/%ZZ", 400], ["/flight/BA305?airport=ZZZ", 404], ["/flight/BA305?airport=LH", 400],
  ["/flight/BA305?eta=4", 400], ["/flight/BA305?eta=31", 400], ["/flight/BA305?eta=5.5", 400],
  ["/flight/BA305/watch?airport=LHR", 400], ["/flight/BA305/watch?until=abc", 400],
  [`/flight/BA305/watch?until=${until + 86401}`, 400],
]) test("flight validation " + path, async t => {
  const { calls, ctx } = installFixtures(t);
  const response = await worker.fetch(new Request("https://worker.test" + path), {}, ctx);
  assert.equal(response.status, status); assert.equal(calls.length, 0); assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});

test("not found is 404, source failure is 503; a clean unknown watch waits", async t => {
  installFixtures(t);
  const deps = { ...evidence({ plane: null }), loadSchedule: async () => ({ status: "ok", complete: true, data: { arrivals: [], departures: [] } }) };
  assert.equal((await handleFlight(flightUrl("?airport=LHR"), {}, null, deps)).status, 404);
  let watch = await handleFlight(watchUrl(), {}, null, deps);
  assert.equal(watch.status, 200); assert.equal(await watch.text(), "contrails-watch v1 | BA305 | 0/3 waiting");
  deps.loadSchedule = async () => ({ status: "backoff", data: null });
  assert.equal((await handleFlight(flightUrl("?airport=LHR"), {}, null, deps)).status, 503);
  watch = await handleFlight(watchUrl(), {}, null, deps);
  assert.equal(watch.status, 503); assert.equal(await watch.text(), "contrails-watch unavailable");
});

test("schedule ETA only when live; stale positions cannot prove departure or landing", async t => {
  installFixtures(t);
  let result = await resolveFlight("BA305", { airport: "LHR" }, {}, null, evidence({ plane: { lat: 50, lon: 2 } }));
  assert.equal(result.data.etaSource, "schedule"); assert.equal(result.data.phase, "airborne");
  result = await resolveFlight("BA305", { airport: "LHR" }, {}, null, evidence({ plane: { seen_pos: 61 }, row: { live: false, actual_dep: null } }));
  assert.equal(result.data.etaMin, null); assert.equal(result.data.milestone.rank, 0); assert.match(result.data.notes.join(), /stale/);
  result = await resolveFlight("BA305", { airport: "LHR" }, {}, null, evidence({ plane: null, row: { live: false, actual_dep: null, est_arr: null } }));
  assert.equal(result.data.position, null); assert.equal(result.data.etaSource, null);
  assert.equal(result.data.phase, "scheduled");
});

test("schedule departure or live status supplies the phase out of coverage without raising the watch rank", async t => {
  installFixtures(t);
  for (const plane of [null, { seen_pos: 61 }, { seen_pos: null }]) {
    for (const [row, phase, rank, name] of [
      [{ live: false }, "airborne", 1, "departed"],
      [{ actual_dep: null }, "airborne", 0, "waiting"],
      [{ live: false, actual_dep: null }, "scheduled", 0, "waiting"],
      [{ actual_arr: now / 1000 }, "landed", 3, "landed"],
      [{ status: "Cancelled" }, "cancelled", 1, "cancelled"],
      [{ status: "Diverted" }, "diverted", 1, "diverted"],
    ]) {
      const deps = evidence({ plane, row });
      const response = await handleFlight(flightUrl("?airport=LHR"), {}, null, deps);
      assert.equal(response.status, 200);
      const flight = await response.json();
      assert.equal(flight.phase, phase);
      assert.deepEqual(flight.milestone, { rank, name, delayed30: false });
      const watch = await handleFlight(watchUrl(), {}, null, deps);
      assert.equal(watch.status, 200);
      assert.equal(await watch.text(), watchBody("BA305", flight.milestone));
    }
  }
});

for (const row of cases.groundEvidence) test("watch evidence: " + row.name, () => {
  const milestone = milestoneFor({ row: {}, position: row, destination: airportFor("LHR"), etaMin: 0 }, 10);
  assert.equal(milestone.rank, row.rank);
  if (!row.ground) assert.notEqual(milestone.name, "landed");
});

test("disappearance, zero ETA and a text-only landing never prove landed", () => {
  for (const row of [{}, { live: true, est_arr: now / 1000 - 1 }, { actual_dep: now / 1000 - 3600, status: "Landed" }]) {
    const milestone = milestoneFor({ row, position: null, destination: airportFor("LHR"), etaMin: 0 }, 10);
    assert.notEqual(milestone.rank, 3); assert.notEqual(milestone.name, "landed");
  }
});

for (const [name, options, expected] of [
  ["actual departure", { plane: null }, "1/3 departed"],
  ["ground at destination", { plane: { lat: 51.471, lon: -0.46, alt_baro: "ground" } }, "3/3 landed\nSP-WATCH: done"],
  ["actual arrival despite lookup error", { row: { actual_arr: now / 1000 }, lookupError: true }, "3/3 landed\nSP-WATCH: done"],
  ["cancelled despite lookup error", { row: { status: "Cancelled" }, lookupError: true }, "cancelled\nSP-WATCH: done"],
  ["diverted despite schedule error", { row: { status: "Diverted to LGW" }, scheduleStatus: "error" }, "diverted\nSP-WATCH: done"],
]) test("watch terminal/evidence: " + name, async t => {
  installFixtures(t);
  const response = await handleFlight(watchUrl(), {}, null, evidence(options));
  assert.equal(response.status, 200); assert.equal(await response.text(), "contrails-watch v1 | BA305 | " + expected);
});

for (const options of [{ lookupError: true }, { scheduleStatus: "error" }, { scheduleStatus: "backoff" }, { boardError: true }]) {
  test("watch refuses lower rank after source error " + JSON.stringify(options), async t => {
    installFixtures(t);
    const response = await handleFlight(watchUrl(), {}, null, evidence(options));
    assert.equal(response.status, 503); assert.equal(await response.text(), "contrails-watch unavailable");
  });
}

test("search backoff with otherwise live evidence is a 503 watch", async t => {
  installFixtures(t);
  const deps = evidence(); deps.loadSearch = async () => ({ status: "backoff", data: null });
  const response = await handleFlight(flightUrl(`/watch?until=${until}`), {}, null, deps);
  assert.equal(response.status, 503);
});

test("expired watch is terminal without any upstream work", async t => {
  const { calls, ctx } = installFixtures(t);
  const response = await worker.fetch(new Request(flightUrl(`/watch?until=${Math.floor(now / 1000) - 1}`)), {}, ctx);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await response.text(), "contrails-watch v1 | BA305 | expired\nSP-WATCH: done"); assert.equal(calls.length, 0);
});

test("watch real loaders integration is uncached text, stable for changing positions and ETA", async t => {
  const { ctx, cache } = installFixtures(t);
  const response = await worker.fetch(new Request(watchUrl()), {}, ctx);
  assert.equal(response.status, 200); assert.match(response.headers.get("Content-Type"), /^text\/plain/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await response.text(), "contrails-watch v1 | BA305 | 2/3 within-10");
  const first = await (await handleFlight(watchUrl(), {}, null, evidence({ eta: 9 }))).text();
  const second = await (await handleFlight(watchUrl(), {}, null, evidence({ eta: 6, plane: { lat: 51.48, lon: -0.25, flight: "BAW305 " } }))).text();
  assert.equal(first, second);
  const spaced = new URL(watchUrl()); spaced.pathname = "/flight/ba%20305/watch";
  assert.equal(await (await handleFlight(spaced, {}, null, evidence())).text(), "contrails-watch v1 | BA 305 | 2/3 within-10");
  assert.ok(cache.puts.every(p => !/watch|milestone/.test(p.key)));
});

test("reference fold handles ETA and delay flapping, failures, landed and regressions", async t => {
  installFixtures(t);
  let state = { rank: 1, delayed: false, done: false }, fires = [];
  for (const eta of cases.etaFlap) {
    const body = await (await handleFlight(watchUrl(), {}, null, evidence({ eta }))).text();
    const folded = foldWatchLines(state, body); state = folded.state; fires.push(folded.fire);
  }
  assert.deepEqual(fires, [false, true, false, false]);
  fires = [];
  for (const delay of cases.delayFlap) {
    const body = await (await handleFlight(watchUrl(), {}, null, evidence({ row: { est_arr: fixtures.liveInbound.row.sched_arr + delay * 60 } }))).text();
    const folded = foldWatchLines(state, body); state = folded.state; fires.push(folded.fire);
  }
  assert.deepEqual(fires, [true, false, false]);
  for (const body of ["contrails-watch unavailable", watchBody("BA305", { rank: 1, name: "departed", delayed30: false }), "contrails-watch unavailable"]) {
    const folded = foldWatchLines(state, body); assert.equal(folded.fire, false); state = folded.state;
  }
  const landed = watchBody("BA305", { rank: 3, name: "landed", delayed30: false });
  let folded = foldWatchLines(state, landed); assert.equal(folded.fire, true); assert.equal(folded.state.done, true); state = folded.state;
  for (const body of [landed, "contrails-watch unavailable", watchBody("BA305", { rank: 0, name: "waiting" }), watchBody("BA305", { name: "cancelled", delayed30: true })]) {
    folded = foldWatchLines(state, body); assert.equal(folded.fire, false); assert.deepEqual(folded.state, state);
  }
  assert.equal(foldWatchLines(null, watchBody("BA305", { rank: 0, name: "waiting" })).fire, false);
  assert.equal(foldWatchLines(null, watchBody("BA305", { name: "expired" })).fire, true);
});

test("delayed-30 uses departure before departing, arrival afterward, without rounding up", () => {
  const row = { est_dep: 3600, sched_dep: 1800, est_arr: 6000, sched_arr: 6000 };
  assert.equal(milestoneFor({ row }, 10).delayed30, true);
  assert.equal(milestoneFor({ row: { ...row, est_dep: 3599 } }, 10).delayed30, false);
  assert.equal(milestoneFor({ row: { ...row, actual_dep: 3500 } }, 10).delayed30, false);
});

test("watch URL expiry uses estimated or scheduled arrival plus 3h, capped at 24h", () => {
  for (const [flight, expected] of [
    [{ estArr: new Date(now + 3600000).toISOString() }, now + 4 * 3600000],
    [{ schedArr: new Date(now + 3600000).toISOString() }, now + 4 * 3600000],
    [{}, now + 3 * 3600000], [{ estArr: new Date(now + 48 * 3600000).toISOString() }, now + 24 * 3600000],
  ]) assert.equal(Number(new URL(makeWatchUrl("http://localhost:8787", "BA305", "LHR", 5, flight, now)).searchParams.get("until")), Math.floor(expected / 1000));
});

test("a position just over 60 seconds old stays stale before display rounding", async t => {
  installFixtures(t);
  const result = await resolveFlight("BA305", { airport: "LHR" }, {}, null,
    evidence({ plane: { seen_pos: 60.01 }, row: { actual_dep: null } }));
  assert.equal(result.data.milestone.rank, 0);
  assert.match(result.data.notes.join(), /stale/);
});

test("invalid actual timestamps cannot create milestone evidence", () => {
  for (const value of [-1, "yesterday", Infinity]) {
    const m = milestoneFor({ row: { actual_dep: value, actual_arr: value } }, 10);
    assert.equal(m.rank, 0);
  }
});

test("hex without an airport still tries the one cached search then hex lookup", async t => {
  installFixtures(t); let searches = 0, lookups = 0;
  const deps = evidence();
  deps.loadSearch = async () => { searches++; return { status: "ok", data: { results: [] } }; };
  const lookup = deps.loadLookup;
  deps.loadLookup = async (kind, value) => { assert.equal(kind, "hex"); assert.equal(value, "400804"); lookups++; return lookup(); };
  const resolved = await resolveFlight("400804", {}, {}, null, deps);
  assert.equal(resolved.data.callsign, "BAW305"); assert.equal(searches, 1); assert.equal(lookups, 1);
});

test("real schedule page failure remains a 503 watch on subsequent cached reads", async t => {
  const { ctx } = installFixtures(t);
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes("airport.json") && String(url).includes("page=2") ?
    new Response("", { status: 500 }) : upstream(url, options);
  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(new Request(watchUrl()), {}, ctx);
    assert.equal(response.status, 503); assert.equal(await response.text(), "contrails-watch unavailable");
    await ctx.flush();
  }
});

test("valid past Unix seconds, including epoch zero, produce expired", async t => {
  const { calls, ctx } = installFixtures(t);
  for (const until of ["0", "-1"]) {
    const response = await worker.fetch(new Request(flightUrl("/watch?until=" + until)), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "contrails-watch v1 | BA305 | expired\nSP-WATCH: done");
  }
  assert.equal(calls.length, 0);
});
