import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import core from "../../contrails-core.js";
import runwayData from "../../runways.json" with { type: "json" };
import airportData from "../../airports.json" with { type: "json" };
import { createBoardRuntime } from "./board-runtime.generated.js";
import { buildBoardRuntime, RUNTIME_FILE, SOURCES } from "../build-board-runtime.mjs";
import { fixtures } from "../test-fixtures/sp-api/helpers.js";

const root = new URL("../../", import.meta.url);
test("generated board runtime is current", async () => {
  assert.equal(await readFile(new URL(RUNTIME_FILE, root), "utf8"), await buildBoardRuntime(),
    "Run node worker/build-board-runtime.mjs");
});

for (const iata of ["SFO", "LHR"]) {
  test(`strict generated board matches unmodified sloppy scripts at ${iata}`, async t => {
    t.mock.method(Date, "now", () => fixtures.epochMs);
    const context = vm.createContext({ core, runwayData, airportData,
      posHistory: {}, routeCache: {}, scheduleDataCache: {}, extraState: {}, aircraft: [], feedClockOffsetMs: null,
      SCHEDULE_CACHE_TTL: 300000, FETCH_TIMEOUT_MS: 25000,
      window: { localStorage: { getItem() { return null; }, setItem() {} } }, document: { addEventListener() {}, hidden: false },
      isPrivate: core.isPrivateAircraft, console,
    });
    // vm has its own Date constructor. Stubbing the host Date alone misses it.
    vm.runInContext(`Date.now = () => ${fixtures.epochMs};`, context);
    const appCore = await readFile(new URL("js/app-core.js", root), "utf8");
    const bindings = appCore.split("\n").filter(line => /^const \w+ = core\.\w+;$/.test(line)).join("\n");
    vm.runInContext(bindings, context);
    for (const source of SOURCES) vm.runInContext(await readFile(new URL(source, root), "utf8"), context, { filename: source });
    const strict = createBoardRuntime({ core, runwayData, airportData });
    const fixture = fixtures.airports[iata];
    const airport = airportData.find(row => row[0] === iata);
    const build = runtime => {
      const snapshot = runtime.buildAircraftSnapshot(structuredClone(fixture.traffic.ac), { includeProximity: false, positionNow: fixture.traffic.now });
      const schedule = structuredClone(fixture.schedule);
      runtime.scheduleDataCache[iata] = { data: schedule, ts: fixtures.epochMs };
      const matched = runtime.applyAirportScheduleMatches(iata, schedule, snapshot.aircraft);
      assert.ok(matched > 0);
      return runtime.buildLiveScheduleData(iata, airport[1], airport[2], snapshot.aircraft, core.parseDatisActiveRunways(fixture.datis?.datis));
    };
    const sloppyBoard = build(context), strictBoard = build(strict);
    // Normalize realm prototypes, preserving all values and row order.
    assert.deepEqual(JSON.parse(JSON.stringify(strictBoard)), JSON.parse(JSON.stringify(sloppyBoard)));
    assert.ok(strictBoard.arrivals.length + strictBoard.departures.length > 0);
    assert.deepEqual(build(createBoardRuntime({ core, runwayData, airportData })), strictBoard, "fresh factory has no memory");
  });
}
