import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTrace } from "./traces.js";

test("normalizeTrace converts readsb trace to OpenSky format", () => {
  const raw = {
    icao: "a19c4b",
    timestamp: 1776109350.855,
    trace: [
      [0.0, 38.51, -122.81, 125, 71.7, 337.0, 5, 512, null, "adsb_icao", 175, 512, null, null],
      [60.0, 38.52, -122.82, 2500, 100.0, 340.0, 4, 64, null, "adsb_icao", 2500, 64, null, null],
      [120.0, 38.53, -122.83, 5000, 120.0, 350.0, 4, 0, null, "adsb_icao", 5100, 0, null, null],
    ],
  };
  const result = normalizeTrace(raw);
  assert.equal(result.icao24, "a19c4b");
  assert.equal(result.path.length, 3);

  const p0 = result.path[0];
  assert.equal(p0[0], 1776109350.855);
  assert.equal(p0[1], 38.51);
  assert.equal(p0[2], -122.81);
  assert.ok(Math.abs(p0[3] - 125 * 0.3048) < 0.01, "altitude should be meters");
  assert.equal(p0[4], 337.0);
  assert.equal(p0[5], false);

  const p1 = result.path[1];
  assert.equal(p1[0], 1776109350.855 + 60.0);
  assert.ok(Math.abs(p1[3] - 2500 * 0.3048) < 0.01);
});

test("normalizeTrace handles ground aircraft (alt <= 0)", () => {
  const raw = {
    icao: "a00001",
    timestamp: 1000000,
    trace: [
      [0.0, 40.0, -74.0, 0, 10.0, 90.0, 5, 0, null, "adsb_icao", 0, 0, null, null],
      [10.0, 40.0, -74.0, -50, 5.0, 90.0, 5, 0, null, "adsb_icao", 0, 0, null, null],
    ],
  };
  const result = normalizeTrace(raw);
  assert.equal(result.path[0][5], true, "alt=0 should be on ground");
  assert.equal(result.path[1][5], true, "negative alt should be on ground");
  assert.equal(result.path[0][3], 0);
});

test("normalizeTrace returns null for missing data", () => {
  assert.equal(normalizeTrace(null), null);
  assert.equal(normalizeTrace({}), null);
  assert.equal(normalizeTrace({ timestamp: 1000, trace: [] }), null);
  assert.equal(normalizeTrace({ icao: "abc123", trace: [[0, 1, 2, 3]] }), null);
});

test("normalizeTrace handles null altitude", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [[0.0, 38.5, -122.8, null, 100.0, 270.0, 0, null, null, null, null, null, null, null]],
  };
  const result = normalizeTrace(raw);
  assert.equal(result.path[0][3], null);
  assert.equal(result.path[0][5], false, "null alt should not be flagged as ground");
});

test("normalizeTrace handles null heading", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [[0.0, 38.5, -122.8, 5000, 100.0, null, 4, 0, null, null, null, null, null, null]],
  };
  const result = normalizeTrace(raw);
  assert.equal(result.path[0][4], 0, "null heading should default to 0");
});

test("normalizeTrace treats readsb \"ground\" altitude as on-ground at 0 m", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [
      [0.0, 37.6, -122.4, "ground", 12.0, 280.0, 0, null, null, "adsb_icao", null, null, null, null],
      [30.0, 37.61, -122.41, 400, 140.0, 280.0, 0, 1500, null, "adsb_icao", 425, 1500, null, null],
    ],
  };
  const result = normalizeTrace(raw);
  assert.equal(result.path[0][5], true, "\"ground\" should set onGround");
  assert.equal(result.path[0][3], 0, "\"ground\" altitude should be 0 m, not NaN");
  assert.equal(result.path[1][5], false);
});

test("normalizeTrace maps non-numeric altitude to unknown (null), not NaN", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [
      [0.0, 37.6, -122.4, "bogus", 12.0, 280.0],
      [10.0, 37.6, -122.4, "12000", 12.0, 280.0],
      [20.0, 37.6, -122.4, NaN, 12.0, 280.0],
    ],
  };
  const result = normalizeTrace(raw);
  for (const pt of result.path) {
    assert.equal(pt[3], null);
    assert.equal(pt[5], false);
  }
});
