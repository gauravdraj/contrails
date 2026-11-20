import test from "node:test";
import assert from "node:assert/strict";
import { __nearbyTest } from "./nearby.js";
import { handleMcp } from "./mcp.js";

const { buildPass, comparePasses } = __nearbyTest;
const HOME = [37.4111, -122.0811];

function offset([lat, lng], bearing, km) {
  const rad = bearing * Math.PI / 180;
  return [lat + km * Math.cos(rad) / 111.32, lng + km * Math.sin(rad) / (111.32 * Math.cos(lat * Math.PI / 180))];
}
function snapshot(bearing, km, extra) {
  const [lat, lon] = offset(HOME, bearing, km);
  return { hex: "a1ca5f", lat, lon, seen_pos: 0, ...extra };
}

test("a plane flying away was placed at its closest approach about a minute ago", () => {
  const pass = buildPass(...HOME, snapshot(76, 5.19, { flight: "SWA3396 ", t: "B737", r: "N214WN", alt_baro: 1575, gs: 180, track: 80, baro_rate: -768 }), 240);
  assert.ok(pass.closest.offsetSec <= -45 && pass.closest.offsetSec >= -65, String(pass.closest.offsetSec));
  assert.ok(pass.closest.miles < 0.7, String(pass.closest.miles));
  assert.ok(pass.closest.altFt > 2000 && pass.closest.altFt < 2600, String(pass.closest.altFt));
  assert.equal(pass.callsign, "SWA3396");
  assert.equal(pass.airline, "Southwest");
});

test("an approaching plane gets a future closest approach and sorts after passed ones", () => {
  const passed = buildPass(...HOME, snapshot(76, 5.19, { alt_baro: 1575, gs: 180, track: 80 }), 240);
  const ahead = buildPass(...HOME, snapshot(266, 8, { flight: "TZP26", alt_baro: 4325, gs: 232, track: 65, baro_rate: -1216 }), 240);
  assert.ok(ahead.closest.offsetSec > 0);
  assert.deepEqual([ahead, passed].sort(comparePasses), [passed, ahead]);
});

test("a departure is never placed below ground before its takeoff", () => {
  const pass = buildPass(...HOME, snapshot(90, 3, { alt_baro: 600, gs: 160, track: 90, baro_rate: 2400 }), 240);
  assert.ok(pass.closest.altFt >= 100, String(pass.closest.altFt));
  assert.ok(pass.closest.offsetSec >= -15, String(pass.closest.offsetSec));
});

test("far, stale, grounded and headingless planes are not passes", () => {
  assert.equal(buildPass(...HOME, snapshot(0, 40, { alt_baro: 30000, gs: 450, track: 90 }), 240), null);
  assert.equal(buildPass(...HOME, snapshot(0, 1, { alt_baro: 2000, gs: 150, track: 90, seen_pos: 120 }), 240), null);
  assert.equal(buildPass(...HOME, snapshot(0, 1, { alt_baro: "ground", gs: 10, track: 90 }), 240), null);
  assert.equal(buildPass(...HOME, snapshot(0, 1, { alt_baro: 2000 }), 240), null);
});

const call = (args, deps) => handleMcp(new Request("http://localhost:8787/mcp", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plane_just_passed", arguments: args } }) }), {}, null, deps);

test("plane_just_passed returns the photo src without the Planespotters page link", async () => {
  let seen;
  const pass = { callsign: "SWA3396", icao24: "a1ca5f", type: "B737", registration: "N214WN", name: "Southwest 3396", priv: false,
    routeLine: "SNA → SJC", closest: { offsetSec: -60, slantKm: 0.8, miles: 0.5, altFt: 2300, direction: "E" } };
  const src = "https://t.plnspttrs.net/29556/1942391_2dac26237a_280.jpg";
  const response = await call({ lat: 37.41111, lng: -122.08111 }, {
    findRecentPasses: async (lat, lng, minutes) => { seen = [lat, lng, minutes]; return [pass]; },
    photoFor: async () => ({ src, photographer: "M Kramer", link: "https://www.planespotters.net/photo/1942391" }),
  });
  const { result } = await response.json();
  assert.equal(result.isError, false);
  assert.deepEqual(seen, [37.41, -122.08, 4]);
  assert.equal(result.content[0].text, "Closest approaches, estimated from current heading.\n" +
    `1. Southwest 3396, B737, N214WN, SNA to SJC, passed about 1 min ago, 0.5 mi E at 2300 ft, photo ${src} by M Kramer.`);
  assert.deepEqual(result.structuredContent.planes[0].photo, { src, photographer: "M Kramer" });
  assert.ok(!JSON.stringify(result).includes("planespotters.net/photo"));
});

test("plane_just_passed reports an empty window and private planes without registration", async () => {
  const empty = await (await call({ lat: 37.4, lng: -122 }, { findRecentPasses: async () => [], photoFor: async () => null })).json();
  assert.match(empty.result.content[0].text, /No aircraft passed close by/);
  const priv = { callsign: null, icao24: "abc123", type: "C172", registration: "N12345", name: "abc123", priv: true, routeLine: null,
    closest: { offsetSec: 30, slantKm: 1, miles: 0.6, altFt: 700, direction: "N" } };
  const body = await (await call({ lat: 37.4, lng: -122, minutes: 2 }, { findRecentPasses: async () => [priv], photoFor: async () => null })).json();
  assert.equal(body.result.content[0].text.split("\n")[1], "1. abc123, C172, passing in about 1 min, 0.6 mi N at 700 ft, no photo.");
});
