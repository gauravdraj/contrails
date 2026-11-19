import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { getBoard, handleBoard, boardOptions, filterBoard, recentState, scheduledRows } from "./board.js";
import { fixtures, installFixtures, fixtureDeps } from "../test-fixtures/sp-api/helpers.js";

for (const iata of ["SFO", "LHR"]) {
  test(`${iata} board HTTP contract through real shared loaders`, async t => {
    const { calls, cache, ctx } = installFixtures(t);
    const response = await worker.fetch(new Request(`https://worker.test/board/${iata}`), {}, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Cache-Control"), "s-maxage=20");
    const body = await response.json();
    assert.equal(body.schemaVersion, 1); assert.equal(body.kind, "snapshot"); assert.equal(body.airport.iata, iata);
    assert.equal(body.generatedAt, new Date(fixtures.epochMs).toISOString());
    assert.match(body.mapUrl, /^https:\/\/gauravdraj.github.io\/contrails\/\?lat=/);
    assert.deepEqual(body.capabilities, { history: false, goAroundDetection: false, runwayMemory: false });
    assert.equal(body.sources.traffic, "ok"); assert.equal(body.sources.schedule, "ok");
    assert.equal(body.sources.datis, iata === "SFO" ? "ok" : "none");
    for (const row of body.arrivals) {
      for (const key of ["callsign", "flight", "airline", "type", "size", "origin", "etaMin", "etaAt", "runway", "runwayAssumed", "sequence", "altFt", "distKm", "delayMin", "hex"]) assert.ok(key in row, key);
      assert.equal(Date.parse(row.etaAt), fixtures.epochMs + row.etaMin * 60000);
      assert.equal(row.etaMin, Math.round(row.etaMin * 10) / 10);
    }
    for (const row of body.recent) assert.ok(["over-runway", "landed", "taxiing-in", "parked"].includes(row.state));
    const live = [...body.arrivals, ...body.recent, ...body.departures];
    for (const dir of ["arrivals", "departures"]) {
      assert.ok(body[dir].length <= 10);
      const rows = body.scheduled[dir];
      assert.ok(rows.every(row => !live.some(item => (row.callsign && item.callsign === row.callsign) || (row.flight && item.flight === row.flight))));
      const times = rows.map(row => Date.parse(row.estAt || row.schedAt));
      assert.deepEqual(times, [...times].sort((a, b) => a - b));
    }
    await ctx.flush();
    assert.ok(cache.puts.some(p => p.key === `https://board-cache/${iata}` && p.ttl === 20));
    assert.ok(cache.puts.some(p => p.key === `https://schedule-cache/${iata}` && p.ttl === 300));
    assert.ok(cache.puts.some(p => p.key.startsWith("https://adsb-grid/") && p.key.endsWith("/dist/75") && p.ttl === 3));
    assert.equal(calls.filter(url => url.includes("/v1/search/web/find")).length, 0);
    assert.equal(calls.filter(url => url.includes("airport.json")).length, 2);
    if (iata === "LHR") assert.ok(!calls.some(url => url.includes("atis.info")));
  });
}

test("filters happen after whole-board cache, with types overriding size", async t => {
  const { ctx, calls } = installFixtures(t);
  const all = await (await worker.fetch(new Request("https://worker.test/board/LHR?limit=20"), {}, ctx)).json();
  await ctx.flush();
  const count = calls.length;
  const big = await (await worker.fetch(new Request("https://worker.test/board/lhr?dir=arrivals&size=big&limit=2"), {}, ctx)).json();
  assert.deepEqual(big.arrivals, all.arrivals.filter(row => ["quadjet", "widebody"].includes(row.size)).slice(0, 2));
  assert.deepEqual(big.departures, []); assert.deepEqual(big.scheduled.departures, []);
  const typed = await (await worker.fetch(new Request("https://worker.test/board/LHR?size=big&types=A319&limit=20"), {}, ctx)).json();
  assert.ok(typed.arrivals.length > 0);
  assert.ok(typed.arrivals.every(row => row.type === "A319"));
  assert.equal(calls.length, count);
  assert.deepEqual(boardOptions(new URLSearchParams("types=A380,747,A350,777,B748,MD11,A388")).prefixes,
    ["A38", "B74", "A35", "B77", "B748", "MD11", "A388"]);
});

test("concurrent board misses share a build, subsequent requests share grid and schedule caches with PWA", async t => {
  const { ctx, calls, cache } = installFixtures(t);
  const boards = await Promise.all(Array.from({ length: 12 }, () => getBoard("LHR", {}, ctx)));
  assert.ok(boards.every(board => JSON.stringify(board) === JSON.stringify(boards[0])));
  assert.equal(calls.filter(url => url.includes("/lat/")).length, 1);
  assert.equal(calls.filter(url => url.includes("airport.json")).length, 2);
  assert.equal(cache.puts.filter(p => p.key === "https://board-cache/LHR").length, 1);
  await ctx.flush();
  const before = calls.length;
  for (const path of ["/schedule/LHR", "/adsb/lat/51.471/lon/-0.46/dist/65"]) assert.equal((await worker.fetch(new Request("https://worker.test" + path), {}, ctx)).status, 200);
  assert.equal(calls.length, before);
});

test("board TTL expires at 20 seconds and starts with fresh runtime state", async t => {
  const { ctx, cache } = installFixtures(t);
  const deps = fixtureDeps();
  let trafficLoads = 0;
  const original = deps.loadTraffic;
  deps.loadTraffic = async (...args) => { trafficLoads++; return original(...args); };
  const first = await getBoard("LHR", {}, ctx, deps);
  t.mock.method(Date, "now", () => fixtures.epochMs + 19999);
  assert.equal((await getBoard("LHR", {}, ctx, deps)).generatedAt, first.generatedAt);
  assert.equal(trafficLoads, 1);
  t.mock.method(Date, "now", () => fixtures.epochMs + 20001);
  const second = await getBoard("LHR", {}, ctx, deps);
  assert.equal(trafficLoads, 2); assert.notEqual(second.generatedAt, first.generatedAt);
  assert.equal(cache.puts.filter(p => p.key === "https://board-cache/LHR").length, 2);
});

for (const [path, status] of [
  ["/board/ZZZ", 404], ["/board/LH", 400], ["/board/%ZZ", 400], ["/board/LHR?dir=sideways", 400],
  ["/board/LHR?limit=0", 400], ["/board/LHR?limit=21", 400], ["/board/LHR?limit=1.5", 400],
  ["/board/LHR?size=huge", 400], ["/board/LHR?types=", 400], ["/board/LHR?types=A380,<script>", 400],
  ["/board/LHR?types=AA,BB,CC,DD,EE,FF,GG,HH,II", 400],
]) test("board validation " + path, async t => {
  const { calls, ctx } = installFixtures(t);
  const response = await worker.fetch(new Request("https://worker.test" + path), {}, ctx);
  assert.equal(response.status, status); assert.ok((await response.json()).error); assert.equal(calls.length, 0);
});

for (const source of ["loadSchedule", "loadDatis", "loadTraffic"]) {
  test("board source failure: " + source, async t => {
    installFixtures(t);
    const response = await handleBoard(new URL("https://worker.test/board/SFO"), {}, null,
      { ...fixtureDeps("SFO"), [source]: async () => { throw new Error("offline"); } });
    assert.equal(response.status, source === "loadTraffic" ? 502 : 200);
    const body = await response.json();
    if (response.ok) {
      assert.equal(body.sources[source === "loadSchedule" ? "schedule" : "datis"], "error");
      assert.ok(body.notes.some(note => /unavailable/.test(note)));
    }
  });
}

test("backoff still builds an unrouted board and flags schedule", async t => {
  installFixtures(t);
  const body = await getBoard("LHR", {}, null, { ...fixtureDeps(), loadSchedule: async () => ({ status: "backoff", data: null }) });
  assert.equal(body.sources.schedule, "backoff");
  assert.ok(body.notes.some(note => /rate limited/.test(note)));
  assert.ok(body.arrivals.every(row => row.origin === null && row.flight === null && row.airline === null && row.delayMin === null));
});

test("recent states require ground evidence; airborne under 500 ft is over-runway", () => {
  assert.equal(recentState({ landed: true, altFt: 50 }, { ground: false }), "over-runway");
  assert.equal(recentState({ landed: true }, { ground: true }), "landed");
  assert.equal(recentState({ taxiingIn: true }, { ground: true }), "taxiing-in");
  assert.equal(recentState({ taxiingIn: true, parked: true }, { ground: true }), "parked");
});

test("upcoming rows exclude actual events, terminal statuses, duplicates, live variants and out-of-window times", () => {
  const now = fixtures.epochMs, base = { flight: "BA1", callsign: "BAW1", ac_code: "B748", sched_arr: now / 1000 + 60 };
  const rows = [base, { ...base }, { ...base, flight: "BA2", callsign: "BAW2", actual_arr: now / 1000 },
    { ...base, flight: "BA3", status: "Cancelled" }, { ...base, flight: "BA4", sched_arr: now / 1000 + 7 * 3600 },
    { ...base, flight: "BA5", sched_arr: now / 1000 - 1 }];
  assert.equal(scheduledRows({ arrivals: rows }, "arrivals", [], now).length, 1);
  assert.equal(scheduledRows({ arrivals: rows }, "arrivals", [{ callsign: "BAW1" }], now).length, 0);
  const cargo = filterBoard({ arrivals: [{ type: "B748", size: "quadjet" }, { type: "MD11", size: "widebody" }], recent: [], departures: [], scheduled: { arrivals: [], departures: [] } }, { size: "big" });
  assert.equal(cargo.arrivals.length, 2);
});

test("real board labels a fresh airborne aircraft over the arrival runway without claiming landing", async t => {
  installFixtures(t);
  const traffic = structuredClone(fixtures.liveInbound.lookup);
  Object.assign(traffic.ac[0], { lat: 51.4775, lon: -0.459, alt_baro: 200, gs: 140, track: 270, baro_rate: -600 });
  const board = await getBoard("LHR", {}, null, { ...fixtureDeps(), loadTraffic: async () => ({ status: "ok", data: traffic }) });
  const recent = board.recent.find(row => row.callsign === "BAW305");
  assert.ok(recent, JSON.stringify(board)); assert.equal(recent.state, "over-runway");
});

test("board source failure releases the in-flight computation so a retry can succeed", async t => {
  installFixtures(t);
  await assert.rejects(getBoard("LHR", {}, null, { ...fixtureDeps(), loadTraffic: async () => ({ status: "error", data: null }) }), /Traffic data unavailable/);
  assert.equal((await getBoard("LHR", {}, null, fixtureDeps())).sources.traffic, "ok");
});
