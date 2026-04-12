import test from "node:test";
import assert from "node:assert/strict";

import {
  nearestAirport,
  convergenceScore,
  extractOriginDest,
  detectPhase,
  mergeRoutes,
  formatRouteLabel,
} from "./opensky.js";

// --- nearestAirport ---

test("nearestAirport matches SAN from known coordinates", () => {
  const result = nearestAirport(32.7307, -117.1781, 8);
  assert.equal(result.iata, "SAN");
  assert.ok(result.dist < 2);
});

test("nearestAirport matches BOS from track first point", () => {
  const result = nearestAirport(42.3615, -71.0007, 8);
  assert.equal(result.iata, "BOS");
  assert.ok(result.dist < 1);
});

test("nearestAirport matches JFK from arrival point", () => {
  const result = nearestAirport(40.6345, -73.7633, 8);
  assert.equal(result.iata, "JFK");
  assert.ok(result.dist < 2);
});

test("nearestAirport returns null when no airport within range", () => {
  const result = nearestAirport(0, 0, 8);
  assert.equal(result, null);
});

// --- convergenceScore ---

test("convergenceScore returns high score for converging path", () => {
  const tail = [
    [0, 37.0, -122.0, 3000, 0, false],
    [1, 37.1, -122.1, 2500, 0, false],
    [2, 37.2, -122.15, 2000, 0, false],
    [3, 37.3, -122.2, 1500, 0, false],
    [4, 37.4, -122.25, 1000, 0, false],
    [5, 37.5, -122.3, 500, 0, false],
    [6, 37.55, -122.33, 300, 0, false],
    [7, 37.59, -122.36, 100, 0, false],
  ];
  const score = convergenceScore(tail, 37.62, -122.375);
  assert.ok(score > 0, "score should be positive for converging path");
});

test("convergenceScore returns 0 for diverging path far from airport", () => {
  const tail = [
    [0, 36.0, -120.0, 5000, 0, false],
    [1, 35.9, -119.9, 5500, 0, false],
    [2, 35.8, -119.8, 6000, 0, false],
    [3, 35.7, -119.7, 6500, 0, false],
    [4, 35.6, -119.6, 7000, 0, false],
  ];
  const score = convergenceScore(tail, 37.62, -122.375);
  assert.equal(score, 0);
});

test("convergenceScore resolves SFO vs OAK correctly", () => {
  const tail = [
    [0, 37.3, -122.0, 3000, 280, false],
    [1, 37.35, -122.05, 2500, 280, false],
    [2, 37.4, -122.1, 2000, 280, false],
    [3, 37.45, -122.15, 1500, 280, false],
    [4, 37.5, -122.2, 1000, 280, false],
    [5, 37.55, -122.25, 500, 280, false],
    [6, 37.58, -122.3, 300, 280, false],
    [7, 37.60, -122.35, 100, 280, false],
    [8, 37.615, -122.37, 0, 280, false],
  ];
  const sfoScore = convergenceScore(tail, 37.62, -122.375);
  const oakScore = convergenceScore(tail, 37.72, -122.221);
  assert.ok(sfoScore > oakScore, `SFO (${sfoScore}) should beat OAK (${oakScore})`);
});

test("convergenceScore handles approach pattern with close pass then diverging", () => {
  const tail = [
    [0, 37.4, -122.1, 2000, 280, false],
    [1, 37.45, -122.15, 1500, 280, false],
    [2, 37.5, -122.2, 1000, 280, false],
    [3, 37.55, -122.25, 500, 280, false],
    [4, 37.58, -122.3, 300, 280, false],
    [5, 37.61, -122.37, 100, 280, false],
    [6, 37.62, -122.38, 50, 280, false],
    [7, 37.60, -122.35, 300, 280, false],
    [8, 37.55, -122.30, 800, 280, false],
    [9, 37.50, -122.26, 1500, 280, false],
  ];
  const sfoScore = convergenceScore(tail, 37.62, -122.375);
  const oakScore = convergenceScore(tail, 37.72, -122.221);
  assert.ok(sfoScore > oakScore, `SFO (${sfoScore}) should beat OAK (${oakScore}) even with diverging tail`);
  assert.ok(sfoScore > 0, "close pass should produce positive score");
});

// --- extractOriginDest ---

test("extractOriginDest finds origin from low-altitude first point", () => {
  const track = {
    path: [
      [1000, 32.7307, -117.1781, 0, 280, false],
      [1010, 32.74, -117.19, 300, 280, false],
      [1020, 32.75, -117.20, 600, 280, false],
      [1030, 32.77, -117.22, 900, 280, false],
      [1040, 32.80, -117.25, 1500, 280, false],
    ],
  };
  const { origin } = extractOriginDest(track);
  assert.equal(origin.iata, "SAN");
});

test("extractOriginDest returns null origin when all points are high altitude", () => {
  const track = {
    path: [
      [1000, 37.5, -122.0, 10000, 280, false],
      [1010, 37.6, -122.1, 9500, 280, false],
    ],
  };
  const { origin } = extractOriginDest(track);
  assert.equal(origin, null);
});

test("extractOriginDest returns null destination when all points are high altitude", () => {
  const pts = [];
  for (let i = 0; i < 15; i++) {
    pts.push([1000 + i * 60, 35 + i * 0.2, -120 + i * 0.1, 10000 - i * 50, 280, false]);
  }
  const { destination } = extractOriginDest({ path: pts });
  assert.equal(destination, null);
});

test("extractOriginDest returns null for empty/missing path", () => {
  assert.deepEqual(extractOriginDest(null), { origin: null, destination: null });
  assert.deepEqual(extractOriginDest({ path: [] }), { origin: null, destination: null });
});

// --- detectPhase ---

test("detectPhase identifies landing aircraft", () => {
  assert.equal(detectPhase(3000, -800, false), "arriving");
});

test("detectPhase identifies departing aircraft", () => {
  assert.equal(detectPhase(5000, 1500, false), "departing");
});

test("detectPhase identifies cruising aircraft", () => {
  assert.equal(detectPhase(35000, 0, false), "cruising");
});

test("detectPhase identifies landed aircraft", () => {
  assert.equal(detectPhase(null, null, true), "landed");
});

test("detectPhase treats high-altitude descent as cruising", () => {
  assert.equal(detectPhase(25000, -500, false), "cruising");
});

// --- mergeRoutes ---

test("mergeRoutes prefers track origin over ADSBDB", () => {
  const track = {
    path: [
      [0, 32.7307, -117.1781, 0, 0, false],
      [1, 32.74, -117.19, 500, 0, false],
    ],
  };
  const adsbdb = {
    origin: { iata: "BWI", name: "Baltimore" },
    destination: { iata: "BNA", name: "Nashville" },
    airline: "Southwest Airlines",
  };
  const result = mergeRoutes(track, adsbdb);
  assert.equal(result.origin.iata, "SAN");
  assert.equal(result.destination, null);
  assert.equal(result.originSource, "track");
  assert.equal(result.airline, "Southwest Airlines");
});

test("mergeRoutes keeps ADSBDB destination when origins match", () => {
  const track = {
    path: [
      [0, 42.3615, -71.0007, -304, 0, false],
      [1, 42.37, -71.01, 300, 0, false],
    ],
  };
  const adsbdb = {
    origin: { iata: "BOS", name: "Boston" },
    destination: { iata: "SFO", name: "San Francisco" },
    airline: "United Airlines",
  };
  const result = mergeRoutes(track, adsbdb);
  assert.equal(result.origin.iata, "BOS");
  assert.equal(result.destination.iata, "SFO");
  assert.equal(result.originSource, "track");
});

test("mergeRoutes falls back to ADSBDB when no track", () => {
  const adsbdb = {
    origin: { iata: "ORD", name: "Chicago" },
    destination: { iata: "LAX", name: "Los Angeles" },
    airline: "American Airlines",
  };
  const result = mergeRoutes(null, adsbdb);
  assert.equal(result.origin.iata, "ORD");
  assert.equal(result.destination.iata, "LAX");
  assert.equal(result.originSource, "route");
});

test("mergeRoutes returns null when neither source has data", () => {
  assert.equal(mergeRoutes(null, null), null);
});

// --- formatRouteLabel ---

test("formatRouteLabel departing with both airports", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, { iata: "SJC" }, "departing"),
    "departed SAN for SJC",
  );
});

test("formatRouteLabel departing with origin only", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, null, "departing"),
    "departed SAN",
  );
});

test("formatRouteLabel arriving with both airports", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, { iata: "SJC" }, "arriving"),
    "landing at SJC from SAN",
  );
});

test("formatRouteLabel cruising with both airports", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, { iata: "SJC" }, "cruising"),
    "SAN \u2192 SJC",
  );
});

test("formatRouteLabel cruising with origin only", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, null, "cruising"),
    "from SAN",
  );
});

test("formatRouteLabel landed with both", () => {
  assert.equal(
    formatRouteLabel({ iata: "SAN" }, { iata: "SJC" }, "landed"),
    "arrived at SJC from SAN",
  );
});

test("formatRouteLabel returns empty when no airports", () => {
  assert.equal(formatRouteLabel(null, null, "cruising"), "");
});
