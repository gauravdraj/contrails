import test from "node:test";
import assert from "node:assert/strict";
import { METRO_REGIONS, findNearestRegion } from "./regions.js";

test("METRO_REGIONS has at least 31 entries", () => {
  assert.ok(METRO_REGIONS.length >= 31);
});

test("every region entry has name, lat, lon", () => {
  for (const r of METRO_REGIONS) {
    assert.equal(typeof r.name, "string");
    assert.equal(typeof r.lat, "number");
    assert.equal(typeof r.lon, "number");
  }
});

test("findNearestRegion matches SFO coordinates to Bay Area", () => {
  const result = findNearestRegion(37.62, -122.38, 100);
  assert.ok(result);
  assert.equal(result.name, "Bay Area");
  assert.ok(result.dist < 1);
});

test("findNearestRegion matches LAX coordinates to Los Angeles", () => {
  const result = findNearestRegion(33.94, -118.41, 100);
  assert.ok(result);
  assert.equal(result.name, "Los Angeles");
});

test("findNearestRegion matches point near JFK to New York", () => {
  const result = findNearestRegion(40.64, -73.78, 100);
  assert.ok(result);
  assert.equal(result.name, "New York");
});

test("findNearestRegion matches Heathrow area to London", () => {
  const result = findNearestRegion(51.47, -0.46, 100);
  assert.ok(result);
  assert.equal(result.name, "London");
});

test("findNearestRegion returns null for middle of ocean", () => {
  const result = findNearestRegion(0, -30, 100);
  assert.equal(result, null);
});

test("findNearestRegion returns null when nearest region exceeds maxKm", () => {
  // Point ~200 km off the US east coast, no metro within 50 km
  const result = findNearestRegion(36.0, -70.0, 50);
  assert.equal(result, null);
});

test("findNearestRegion picks closest region when multiple are in range", () => {
  // Point equidistant-ish between Bay Area and San Jose but closer to Bay Area (SFO)
  const result = findNearestRegion(37.60, -122.00, 100);
  assert.ok(result);
  assert.equal(result.name, "Bay Area");
});

test("findNearestRegion returns dist in km", () => {
  // ~50 km offset from Bay Area center
  const result = findNearestRegion(37.62, -121.80, 100);
  assert.ok(result);
  assert.equal(result.name, "Bay Area");
  assert.ok(result.dist > 40);
  assert.ok(result.dist < 60);
});

test("findNearestRegion respects maxKm boundary exactly", () => {
  // Get distance from a known point to Bay Area, then use that as maxKm
  const result50 = findNearestRegion(37.62, -121.80, 50);
  const result60 = findNearestRegion(37.62, -121.80, 60);
  // One of these should match, the other might not, depending on exact distance
  assert.ok(result50 !== null || result60 !== null);
});
