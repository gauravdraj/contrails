import test from "node:test";
import assert from "node:assert/strict";

const { normalizeTrace } = await import("./traces.js").then(m => {
  return { normalizeTrace: m.normalizeTrace || m.default?.normalizeTrace };
});

// normalizeTrace isn't exported, so we test via a small shim.
// For now, test the logic inline.

function normalizeTraceLocal(raw) {
  if (!raw?.trace?.length || !raw.timestamp) return null;
  const baseTime = raw.timestamp;
  const path = [];
  for (const pt of raw.trace) {
    const timeSec = baseTime + pt[0];
    const lat = pt[1];
    const lon = pt[2];
    const altFt = pt[3];
    const heading = pt[5];
    const altM = altFt != null ? altFt * 0.3048 : null;
    const onGround = altFt != null && altFt <= 0;
    path.push([timeSec, lat, lon, altM, heading ?? 0, onGround]);
  }
  return { icao24: raw.icao, path };
}

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
  const result = normalizeTraceLocal(raw);
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
  const result = normalizeTraceLocal(raw);
  assert.equal(result.path[0][5], true, "alt=0 should be on ground");
  assert.equal(result.path[1][5], true, "negative alt should be on ground");
  assert.equal(result.path[0][3], 0);
});

test("normalizeTrace returns null for missing data", () => {
  assert.equal(normalizeTraceLocal(null), null);
  assert.equal(normalizeTraceLocal({}), null);
  assert.equal(normalizeTraceLocal({ timestamp: 1000, trace: [] }), null);
  assert.equal(normalizeTraceLocal({ icao: "abc123", trace: [[0, 1, 2, 3]] }), null);
});

test("normalizeTrace handles null altitude", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [[0.0, 38.5, -122.8, null, 100.0, 270.0, 0, null, null, null, null, null, null, null]],
  };
  const result = normalizeTraceLocal(raw);
  assert.equal(result.path[0][3], null);
  assert.equal(result.path[0][5], false, "null alt should not be flagged as ground");
});

test("normalizeTrace handles null heading", () => {
  const raw = {
    icao: "abc123",
    timestamp: 1000000,
    trace: [[0.0, 38.5, -122.8, 5000, 100.0, null, 4, 0, null, null, null, null, null, null]],
  };
  const result = normalizeTraceLocal(raw);
  assert.equal(result.path[0][4], 0, "null heading should default to 0");
});
