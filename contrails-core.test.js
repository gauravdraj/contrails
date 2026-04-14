const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("./contrails-core.js");

test("haversineKm returns zero for identical points", () => {
  assert.equal(core.haversineKm(51.5, -0.12, 51.5, -0.12), 0);
});

test("bearingDegrees points east for increasing longitude", () => {
  assert.ok(Math.abs(core.bearingDegrees(0, 0, 0, 1) - 90) < 0.5);
});

test("cardinalDir rounds to the nearest compass label", () => {
  assert.equal(core.cardinalDir(5), "N");
  assert.equal(core.cardinalDir(89), "E");
  assert.equal(core.cardinalDir(225), "SW");
});

test("parseCoordinate accepts valid values and rejects invalid ones", () => {
  assert.equal(core.parseCoordinate("37.7749", -90, 90), 37.7749);
  assert.equal(core.parseCoordinate("-122.4194", -180, 180), -122.4194);
  assert.equal(core.parseCoordinate("hello", -90, 90), null);
  assert.equal(core.parseCoordinate("181", -180, 180), null);
});

test("normalizeAircraftHex accepts valid transponder hex and rejects invalid input", () => {
  assert.equal(core.normalizeAircraftHex("4CA87C"), "4ca87c");
  assert.equal(core.normalizeAircraftHex(" 4ca87c "), "4ca87c");
  assert.equal(core.normalizeAircraftHex("SWA123"), null);
  assert.equal(core.normalizeAircraftHex("12345"), null);
});

test("normalizeSearchText compacts user-facing search input", () => {
  assert.equal(core.normalizeSearchText(" wn 1234 "), "WN1234");
  assert.equal(core.normalizeSearchText("SWA-1234"), "SWA1234");
  assert.equal(core.normalizeSearchText(null), "");
});

test("callsignVariants includes common IATA aliases for typeahead matching", () => {
  assert.deepEqual(core.callsignVariants("SWA1234"), ["SWA1234", "WN1234"]);
  assert.deepEqual(core.callsignVariants("DAL55"), ["DAL55", "DL55"]);
  assert.deepEqual(core.callsignVariants("N123AB"), ["N123AB"]);
});

test("formatDistanceMiles converts kilometers into readable miles", () => {
  assert.equal(core.formatDistanceMiles(1.60934), "1");
  assert.equal(core.formatDistanceMiles(8), "5");
  assert.equal(core.formatDistanceMiles(5), "3.1");
});

test("formatSpeedMph rounds knots to miles per hour", () => {
  assert.equal(core.formatSpeedMph(100), "115");
  assert.equal(core.formatSpeedMph(250), "288");
  assert.equal(core.formatSpeedMph(null), "");
});

test("normalizeFlightQuery supports ICAO callsigns, hex ids, and common IATA airline aliases", () => {
  assert.deepEqual(core.normalizeFlightQuery("swa1234"), {
    type: "callsign",
    display: "SWA1234",
    value: "SWA1234",
    variants: ["SWA1234"]
  });

  assert.deepEqual(core.normalizeFlightQuery("WN 1234"), {
    type: "callsign",
    display: "WN1234",
    value: "SWA1234",
    variants: ["SWA1234", "WN1234"]
  });

  assert.deepEqual(core.normalizeFlightQuery("4ca87c"), {
    type: "hex",
    display: "4CA87C",
    value: "4ca87c",
    variants: ["4ca87c"]
  });

  assert.equal(core.normalizeFlightQuery("12"), null);
});

test("buildViewportFetchSpec clamps fetch distance into configured bounds", () => {
  const spec = core.buildViewportFetchSpec({
    lat: 0,
    lng: 0
  }, {
    northEast: { lat: 1, lng: 1 },
    northWest: { lat: 1, lng: -1 },
    southEast: { lat: -1, lng: 1 },
    southWest: { lat: -1, lng: -1 }
  }, {
    minKm: 18,
    maxKm: 460,
    pad: 1.22,
    wideViewKm: 220,
    zoom: 9
  });

  assert.ok(spec.fetchKm >= 18);
  assert.ok(spec.fetchKm <= 460);
  assert.equal(spec.zoom, 9);
});

test("buildViewPolicy suppresses labels and routes for busy wide views", () => {
  const policy = core.buildViewPolicy({
    zoom: 8.5,
    fetchKm: 260,
    visibleCount: 120,
    labelsEnabled: true
  }, {
    wideViewKm: 220,
    routeFetchMaxKm: 220,
    routeFetchMinZoom: 9.25,
    labelMinZoom: 9.5,
    labelMaxVisiblePlanes: 90
  });

  assert.equal(policy.wideView, true);
  assert.equal(policy.allowRoutes, false);
  assert.equal(policy.showLabels, false);
});

test("computePlaybackDelayMs clamps the adaptive playback delay", () => {
  assert.equal(core.computePlaybackDelayMs(3000, 0, { minMs: 2200, maxMs: 4500, safetyMs: 250 }), 3250);
  assert.equal(core.computePlaybackDelayMs(500, 0, { minMs: 2200, maxMs: 4500, safetyMs: 250 }), 2200);
  assert.equal(core.computePlaybackDelayMs(5000, 1000, { minMs: 2200, maxMs: 4500, safetyMs: 250 }), 4500);
});

test("interpolateTimedPose returns a midpoint between known fixes", () => {
  const pose = core.interpolateTimedPose(
    { lat: 10, lng: 20, ts: 1000 },
    { lat: 14, lng: 28, ts: 3000 },
    2000
  );

  assert.equal(pose.lat, 12);
  assert.equal(pose.lng, 24);
  assert.equal(pose.ts, 2000);
});

test("interpolatePlaybackPose interpolates between buffered future fixes", () => {
  const pose = core.interpolatePlaybackPose([
    { lat: 0, lng: 0, ts: 1000 },
    { lat: 1, lng: 1, ts: 2000 },
    { lat: 2, lng: 2, ts: 3000 }
  ], 2500, { maxExtrapolationMs: 700 });

  assert.equal(pose.mode, "interpolate");
  assert.equal(pose.lat, 1.5);
  assert.equal(pose.lng, 1.5);
  assert.equal(pose.ts, 2500);
});

test("interpolatePlaybackPose holds at the first point before playback reaches the buffer", () => {
  const pose = core.interpolatePlaybackPose([
    { lat: 5, lng: 6, ts: 3000 },
    { lat: 6, lng: 7, ts: 4000 }
  ], 2500, { maxExtrapolationMs: 700 });

  assert.equal(pose.mode, "hold");
  assert.equal(pose.lat, 5);
  assert.equal(pose.lng, 6);
  assert.equal(pose.ts, 3000);
});

test("interpolatePlaybackPose uses short extrapolation before holding", () => {
  const pose = core.interpolatePlaybackPose([
    { lat: 0, lng: 0, ts: 1000, spdMs: 250, trackDeg: 90 }
  ], 1400, { maxExtrapolationMs: 700 });

  assert.equal(pose.mode, "extrapolate");
  assert.equal(pose.usedExtrapolationMs, 400);
  assert.ok(pose.lng > 0);
});

test("interpolatePlaybackPose holds once the extrapolation cap is exceeded", () => {
  const pose = core.interpolatePlaybackPose([
    { lat: 3, lng: 4, ts: 1000, spdMs: 250, trackDeg: 90 }
  ], 2200, { maxExtrapolationMs: 700 });

  assert.equal(pose.mode, "extrapolate");
  assert.equal(pose.usedExtrapolationMs, 700);

  const held = core.interpolatePlaybackPose([
    { lat: 3, lng: 4, ts: 1000 }
  ], 2200, { maxExtrapolationMs: 700 });
  assert.equal(held.mode, "hold");
  assert.equal(held.ts, 1000);
});

test("interpolatePlaybackPose advances monotonically as display time increases", () => {
  const samples = [
    { lat: 0, lng: 0, ts: 1000 },
    { lat: 2, lng: 2, ts: 3000 }
  ];
  const first = core.interpolatePlaybackPose(samples, 1500, { maxExtrapolationMs: 700 });
  const second = core.interpolatePlaybackPose(samples, 2500, { maxExtrapolationMs: 700 });

  assert.ok(second.ts > first.ts);
  assert.ok(second.lat > first.lat);
  assert.ok(second.lng > first.lng);
});

test("slantKm at cruise altitude directly overhead", () => {
  const result = core.slantKm(0, 35000);
  assert.ok(Math.abs(result - 10.668) < 0.01);
});

test("slantKm barely changes for nearby low-altitude aircraft", () => {
  const result = core.slantKm(5, 2000);
  assert.ok(Math.abs(result - 5.04) < 0.01);
});

test("slantKm equals ground distance when altitude is zero", () => {
  assert.equal(core.slantKm(10, 0), 10);
});

test("slantKm returns null when ground distance is null", () => {
  assert.equal(core.slantKm(null, 1000), null);
});

test("elevationDeg is near 90 for a plane directly overhead", () => {
  const result = core.elevationDeg(0.001, 35000);
  assert.ok(result > 89);
});

test("elevationDeg at 10 km ground distance and cruise altitude", () => {
  const result = core.elevationDeg(10, 35000);
  assert.ok(Math.abs(result - 46.7) < 1);
});

test("elevationDeg returns null when inputs are missing", () => {
  assert.equal(core.elevationDeg(null, 1000), null);
  assert.equal(core.elevationDeg(5, null), null);
});

test("scoreArrivalCandidate favors low descending arrivals over nearby cruisers", () => {
  const lowArrival = core.scoreArrivalCandidate({
    altFt: 3000,
    vRate: -20,
    distKm: 10,
    spdKts: 160
  });
  const overheadCruiser = core.scoreArrivalCandidate({
    altFt: 35000,
    vRate: 0,
    distKm: 5,
    spdKts: 450
  });

  assert.ok(lowArrival.score < overheadCruiser.score);
});

test("scoreArrivalCandidate rewards lower aircraft at the same distance", () => {
  const low = core.scoreArrivalCandidate({
    altFt: 4000,
    vRate: -18,
    distKm: 12,
    spdKts: 170
  });
  const high = core.scoreArrivalCandidate({
    altFt: 12000,
    vRate: -18,
    distKm: 12,
    spdKts: 170
  });

  assert.ok(low.score < high.score);
});

test("scoreArrivalCandidate rewards descent over level flight", () => {
  const descending = core.scoreArrivalCandidate({
    altFt: 5000,
    vRate: -18,
    distKm: 8,
    spdKts: 170
  });
  const level = core.scoreArrivalCandidate({
    altFt: 5000,
    vRate: 0,
    distKm: 8,
    spdKts: 170
  });

  assert.ok(descending.score < level.score);
});

test("scoreArrivalCandidate keeps ETA descent-led for descending traffic", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 6000,
    vRate: -20,
    distKm: 2,
    spdKts: 300
  });

  assert.ok(candidate.etaMin > 3);
});

test("scoreArrivalCandidate handles missing vertical rate and zero speed", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 4500,
    vRate: null,
    distKm: 9,
    spdKts: 0
  });

  assert.ok(Number.isFinite(candidate.score));
  assert.ok(Number.isFinite(candidate.etaMin));
  assert.ok(candidate.score > 0);
  assert.ok(candidate.etaMin > 0);
});

test("scoreArrivalCandidate penalizes climbing aircraft", () => {
  const descending = core.scoreArrivalCandidate({
    altFt: 4500,
    vRate: -15,
    distKm: 6,
    spdKts: 160
  });
  const climbing = core.scoreArrivalCandidate({
    altFt: 4500,
    vRate: 15,
    distKm: 6,
    spdKts: 160
  });

  assert.ok(descending.score < climbing.score);
});

test("scoreArrivalCandidate rejects climbing aircraft even with destination match", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 2500,
    vRate: 12,
    distKm: 5,
    spdKts: 160,
    destinationMatch: true,
    confidence: "high",
    phase: "departing"
  });

  assert.equal(candidate.eligible, false);
});

test("scoreArrivalCandidate rejects aircraft that originated at the selected airport", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 1800,
    vRate: -10,
    distKm: 4,
    spdKts: 130,
    destinationMatch: true,
    originMatch: true,
    confidence: "high",
    phase: "arriving"
  });

  assert.equal(candidate.eligible, false);
});

test("scoreArrivalCandidate rejects fallback private traffic without strong destination evidence", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 1500,
    vRate: -12,
    distKm: 6,
    spdKts: 120,
    private: true
  });

  assert.equal(candidate.eligible, false);
});

test("scoreArrivalCandidate keeps high-confidence destination-matched arrivals eligible", () => {
  const candidate = core.scoreArrivalCandidate({
    altFt: 2200,
    vRate: -12,
    distKm: 7,
    spdKts: 150,
    destinationMatch: true,
    confidence: "high",
    phase: "arriving"
  });

  assert.equal(candidate.eligible, true);
});

test("scoreArrivalCandidate multi-candidate ordering: short-final < approach < descending-inbound < overhead-level", () => {
  var shortFinal = core.scoreArrivalCandidate({
    altFt: 3500, vRate: -10, distKm: 10, spdKts: 160, destinationMatch: true
  });
  var approach = core.scoreArrivalCandidate({
    altFt: 5000, vRate: -10, distKm: 18, spdKts: 200, destinationMatch: true
  });
  var descendingInbound = core.scoreArrivalCandidate({
    altFt: 8000, vRate: -10, distKm: 30, spdKts: 280, destinationMatch: true
  });
  var overheadLevel = core.scoreArrivalCandidate({
    altFt: 15000, vRate: 0, distKm: 10, spdKts: 350, destinationMatch: true
  });

  assert.ok(shortFinal.score < approach.score, "short-final should beat approach");
  assert.ok(approach.score < descendingInbound.score, "approach should beat descending-inbound");
  assert.ok(descendingInbound.score < overheadLevel.score, "descending-inbound should beat overhead-level");
});

test("scoreArrivalCandidate steeper descent scores better at same altitude and distance", () => {
  var steep = core.scoreArrivalCandidate({
    altFt: 5000, vRate: -25, distKm: 10, spdKts: 200, destinationMatch: true
  });
  var shallow = core.scoreArrivalCandidate({
    altFt: 5000, vRate: -8, distKm: 10, spdKts: 200, destinationMatch: true
  });

  assert.ok(steep.score < shallow.score, "steeper descent should score better");
});

test("scoreArrivalCandidate lower altitude scores better at same descent rate and distance", () => {
  var low = core.scoreArrivalCandidate({
    altFt: 1500, vRate: -15, distKm: 10, spdKts: 180, destinationMatch: true
  });
  var high = core.scoreArrivalCandidate({
    altFt: 5500, vRate: -15, distKm: 10, spdKts: 180, destinationMatch: true
  });

  assert.ok(low.score < high.score, "lower altitude should score better");
});

test("scoreArrivalCandidate handles empty input gracefully", () => {
  var result = core.scoreArrivalCandidate({});

  assert.ok(Number.isFinite(result.score), "score should be finite");
  assert.ok(Number.isFinite(result.etaMin), "etaMin should be finite");
  assert.strictEqual(typeof result.eligible, "boolean", "eligible should be a boolean");
});
