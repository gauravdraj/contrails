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

test("angleDiffDeg returns 0 for identical angles", () => {
  assert.equal(core.angleDiffDeg(90, 90), 0);
  assert.equal(core.angleDiffDeg(0, 0), 0);
  assert.equal(core.angleDiffDeg(359, 359), 0);
});

test("angleDiffDeg returns 180 for opposite headings", () => {
  assert.equal(core.angleDiffDeg(0, 180), 180);
  assert.equal(core.angleDiffDeg(180, 0), 180);
  assert.equal(core.angleDiffDeg(90, 270), 180);
});

test("angleDiffDeg handles wraparound correctly", () => {
  assert.equal(core.angleDiffDeg(350, 10), 20);
  assert.equal(core.angleDiffDeg(10, 350), 20);
  assert.equal(core.angleDiffDeg(1, 359), 2);
});

test("angleDiffDeg normalizes negative inputs", () => {
  assert.equal(core.angleDiffDeg(-10, 10), 20);
  assert.equal(core.angleDiffDeg(10, -10), 20);
  assert.equal(core.angleDiffDeg(-90, -270), 180);
});

test("angleDiffDeg handles large values beyond 360", () => {
  assert.equal(core.angleDiffDeg(370, 10), 0);
  assert.equal(core.angleDiffDeg(720, 0), 0);
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

test("scoreArrivalCandidate ETA reflects altitude for high non-descending dest-confirmed aircraft", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 10000, vRate: 0, distKm: 2, spdKts: 200,
    destinationMatch: true, confidence: "high"
  });

  assert.ok(result.etaMin >= 6, "etaMin should be at least 6 (was " + result.etaMin + ")");
  assert.ok(result.etaMin <= 8, "etaMin should be at most 8 (was " + result.etaMin + ")");
  assert.equal(result.eligible, true);
});

test("scoreArrivalCandidate nominal profile for far cruise with destination match", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 35000, vRate: 0, distKm: 300, spdKts: 450, destinationMatch: true
  });

  assert.ok(result.etaMin >= 25, "etaMin should be at least 25 (was " + result.etaMin + ")");
  assert.ok(result.etaMin <= 40, "etaMin should be at most 40 (was " + result.etaMin + ")");
});

test("scoreArrivalCandidate altitude floor clamps fast-descent proximity candidate", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 6000, vRate: -40, distKm: 8, spdKts: 200
  });

  assert.ok(result.etaMin >= 4, "altitude floor should clamp etaMin to at least 4 (was " + result.etaMin + ")");
  assert.ok(result.etaMin <= 8, "etaMin should be at most 8 (was " + result.etaMin + ")");
});

test("scoreArrivalCandidate altitude floor clamps overhead cruiser without destination match", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 30000, vRate: 0, distKm: 3, spdKts: 400
  });

  assert.ok(result.etaMin >= 20, "altitude floor should clamp etaMin to at least 20 (was " + result.etaMin + ")");
});

test("scoreArrivalCandidate destination-confirmed near nominal descent point uses cruise+descent ETA", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 6000, vRate: -12, distKm: 36, spdKts: 250, destinationMatch: true
  });

  assert.ok(result.etaMin > 4, "etaMin should be greater than 4 (was " + result.etaMin + ")");
  assert.ok(result.etaMin < 6, "etaMin should be less than 6 (was " + result.etaMin + ")");
});

test("scoreArrivalCandidate relaxed thresholds: 8000 ft / 20 km descending without destinationMatch is eligible", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 8000, vRate: -18, distKm: 20, spdKts: 200
  });
  assert.equal(result.eligible, true);
});

test("scoreArrivalCandidate relaxed thresholds: 10000 ft / 25 km descending without destinationMatch is eligible", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 10000, vRate: -10, distKm: 25, spdKts: 250
  });
  assert.equal(result.eligible, true);
});

test("scoreArrivalCandidate relaxed thresholds: 10001 ft descending without destinationMatch is ineligible", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 10001, vRate: -18, distKm: 20, spdKts: 200
  });
  assert.equal(result.eligible, false);
});

test("scoreArrivalCandidate relaxed thresholds: 8000 ft not descending without destinationMatch is ineligible", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 8000, vRate: 0, distKm: 20, spdKts: 200
  });
  assert.equal(result.eligible, false);
});

test("scoreArrivalCandidate relaxed thresholds: 26 km descending without destinationMatch is ineligible", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 8000, vRate: -10, distKm: 26, spdKts: 200
  });
  assert.equal(result.eligible, false);
});

var SFO_RUNWAYS = [
  [37.609,-122.382,0,37.6272,-122.37,0,"SFO 01L/19R"],
  [37.6068,-122.381,0,37.6278,-122.367,0,"SFO 01R/19L"],
  [37.6287,-122.393,0,37.6135,-122.357,0,"SFO 10L/28R"],
  [37.6253,-122.391,0,37.6117,-122.358,0,"SFO 10R/28L"]
];

var BWI_RUNWAYS = [
  [39.1669,-76.6714,0,39.1807,-76.6598,0,"BWI 04/22"],
  [39.1747,-76.6896,0,39.1726,-76.6527,0,"BWI 10/28"],
  [39.1874,-76.6635,0,39.1762,-76.6532,0,"BWI 15L/33R"],
  [39.1854,-76.682,0,39.1642,-76.6624,0,"BWI 15R/33L"]
];

// --- pointOnRunway ---

test("pointOnRunway: aircraft on runway centerline midpoint → onRunway true", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var lengthM = core.haversineKm(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon) * 1000;
  var mid = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, bearing, lengthM / 2);
  var result = core.pointOnRunway(mid[0], mid[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, true);
  assert.equal(result.pastEnd, false);
  assert.ok(result.distFromThresholdKm > 0);
});

test("pointOnRunway: aircraft 100m off to the side → onRunway false", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var lengthM = core.haversineKm(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon) * 1000;
  var mid = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, bearing, lengthM / 2);
  var offside = core.projectLatLng(mid[0], mid[1], bearing + 90, 100);
  var result = core.pointOnRunway(offside[0], offside[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, false, "100m lateral offset exceeds 60m tolerance");
});

test("pointOnRunway: aircraft 200m past far end → onRunway true, pastEnd true", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var past = core.projectLatLng(rwy.farEndLat, rwy.farEndLon, bearing, 200);
  var result = core.pointOnRunway(past[0], past[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, true, "200m past end is within 300m buffer");
  assert.equal(result.pastEnd, true);
});

test("pointOnRunway: aircraft 500m past far end → onRunway false", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var past = core.projectLatLng(rwy.farEndLat, rwy.farEndLon, bearing, 500);
  var result = core.pointOnRunway(past[0], past[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, false, "500m past end exceeds 300m buffer");
});

test("pointOnRunway: aircraft 100m before threshold → onRunway true", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var before = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, (bearing + 180) % 360, 100);
  var result = core.pointOnRunway(before[0], before[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, true, "100m before threshold is within 300m buffer");
  assert.ok(result.distFromThresholdKm < 0, "distFromThresholdKm should be negative");
});

test("pointOnRunway: aircraft 500m before threshold → onRunway false", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var before = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, (bearing + 180) % 360, 500);
  var result = core.pointOnRunway(before[0], before[1], rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  assert.equal(result.onRunway, false, "500m before threshold exceeds 300m buffer");
});

// --- findFlightStartIndex ---

function mkPt(timeSec, onGround) {
  return [timeSec, 40.0, -74.0, 3000, 90, onGround ? 1 : 0];
}

// --- matchRunwayDesignator ---

test("matchRunwayDesignator: 28L matches SFO 10R/28L with correct threshold", () => {
  var result = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  assert.ok(result, "should find a match");
  assert.equal(result.entry[6], "SFO 10R/28L");
  assert.equal(result.designator, "28L");
  var farBearing = core.bearingDegrees(result.thresholdLat, result.thresholdLon, result.farEndLat, result.farEndLon);
  assert.ok(core.angleDiffDeg(farBearing, 280) < 30, "bearing from threshold to far end should be ~280");
});

test("matchRunwayDesignator: 10R matches same entry but returns opposite threshold", () => {
  var r28L = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var r10R = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "10R");
  assert.ok(r10R, "should find a match");
  assert.equal(r10R.entry[6], "SFO 10R/28L");
  assert.equal(r10R.designator, "10R");
  assert.equal(r10R.thresholdLat, r28L.farEndLat);
  assert.equal(r10R.thresholdLon, r28L.farEndLon);
  var farBearing = core.bearingDegrees(r10R.thresholdLat, r10R.thresholdLon, r10R.farEndLat, r10R.farEndLon);
  assert.ok(core.angleDiffDeg(farBearing, 100) < 30, "bearing from threshold to far end should be ~100");
});

test("matchRunwayDesignator: 01L matches SFO 01L/19R (leading-zero designator)", () => {
  var result = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "01L");
  assert.ok(result, "should find a match");
  assert.equal(result.entry[6], "SFO 01L/19R");
  assert.equal(result.designator, "1L");
  var farBearing = core.bearingDegrees(result.thresholdLat, result.thresholdLon, result.farEndLat, result.farEndLon);
  assert.ok(core.angleDiffDeg(farBearing, 10) < 30, "bearing from threshold to far end should be ~10");
});

test("matchRunwayDesignator: returns null for unmatched designator", () => {
  assert.equal(core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "36L"), null);
  assert.equal(core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "09"), null);
});

test("matchRunwayDesignator: returns null for null/empty entries", () => {
  assert.equal(core.matchRunwayDesignator(null, "SFO", "28L"), null);
  assert.equal(core.matchRunwayDesignator(undefined, "SFO", "28L"), null);
  assert.equal(core.matchRunwayDesignator([], "SFO", "28L"), null);
});

test("matchRunwayDesignator: non-suffixed designator 04 matches BWI 04/22", () => {
  var result = core.matchRunwayDesignator(BWI_RUNWAYS, "BWI", "04");
  assert.ok(result, "should find a match");
  assert.equal(result.entry[6], "BWI 04/22");
  assert.equal(result.designator, "4");
  var farBearing = core.bearingDegrees(result.thresholdLat, result.thresholdLon, result.farEndLat, result.farEndLon);
  assert.ok(core.angleDiffDeg(farBearing, 40) < 30, "bearing from threshold to far end should be ~40");
});

test("matchRunwayDesignator: case-insensitive designator", () => {
  var result = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28l");
  assert.ok(result, "should match lowercase designator");
  assert.equal(result.entry[6], "SFO 10R/28L");
});

test("matchRunwayDesignator: IATA mismatch returns null", () => {
  assert.equal(core.matchRunwayDesignator(SFO_RUNWAYS, "LAX", "28L"), null);
});

// --- findFlightStartIndex ---

test("findFlightStartIndex returns 0 for null/empty path", () => {
  assert.equal(core.findFlightStartIndex(null), 0);
  assert.equal(core.findFlightStartIndex(undefined), 0);
  assert.equal(core.findFlightStartIndex([]), 0);
});

test("findFlightStartIndex returns 0 for continuous airborne flight with no gaps", () => {
  var path = [mkPt(100, false), mkPt(200, false), mkPt(300, false), mkPt(400, false)];
  assert.equal(core.findFlightStartIndex(path), 0);
});

test("findFlightStartIndex returns first airborne index after on-ground segment", () => {
  var path = [
    mkPt(100, false), mkPt(200, false),
    mkPt(300, true), mkPt(400, true),
    mkPt(500, false), mkPt(600, false)
  ];
  assert.equal(core.findFlightStartIndex(path), 4);
});

test("findFlightStartIndex detects >30-min time gap with no ground points", () => {
  var path = [
    mkPt(1000, false), mkPt(1100, false),
    mkPt(5000, false), mkPt(5100, false)
  ];
  assert.equal(core.findFlightStartIndex(path), 2);
});

test("findFlightStartIndex uses more recent of two boundary types", () => {
  var path = [
    mkPt(100, false),
    mkPt(200, true), mkPt(300, true),
    mkPt(400, false),
    mkPt(3000, false), mkPt(3100, false)
  ];
  assert.equal(core.findFlightStartIndex(path), 4);
});

test("findFlightStartIndex returns 0 when all points are on-ground", () => {
  var path = [mkPt(100, true), mkPt(200, true), mkPt(300, true)];
  assert.equal(core.findFlightStartIndex(path), 0);
});

test("findFlightStartIndex preserves single flight ending on-ground (just-landed)", () => {
  var path = [mkPt(100, false), mkPt(200, false), mkPt(300, true), mkPt(400, true)];
  assert.equal(core.findFlightStartIndex(path), 0);
});

test("findFlightStartIndex handles two flights with turnaround, current flight landed", () => {
  var path = [
    mkPt(100, false),
    mkPt(200, true), mkPt(300, true),
    mkPt(400, false), mkPt(500, false),
    mkPt(600, true)
  ];
  assert.equal(core.findFlightStartIndex(path), 3);
});

test("findFlightStartIndex ignores time gap within trailing ground segment", () => {
  var path = [
    mkPt(100, false), mkPt(200, false),
    mkPt(300, true), mkPt(5000, true)
  ];
  assert.equal(core.findFlightStartIndex(path), 0);
});

function callsigns(rows) {
  return rows.map(function(row) { return row.callsign; });
}

function inboundArrival(callsign, input) {
  var scored = core.scoreArrivalCandidate(input);
  return {
    callsign: callsign,
    arrivalScore: scored.score,
    etaMin: scored.etaMin,
    distKm: input.distKm,
    altFt: input.altFt,
    proximity: !!input.proximity
  };
}

test("airport arrival rows: inbound next landing summary stays short-final", () => {
  var shortFinal = inboundArrival("UAL100", {
    altFt: 3500, vRate: -10, distKm: 10, spdKts: 160, destinationMatch: true
  });
  var approach = inboundArrival("DAL200", {
    altFt: 5000, vRate: -10, distKm: 18, spdKts: 200, destinationMatch: true
  });
  var descendingInbound = inboundArrival("AAL300", {
    altFt: 8000, vRate: -10, distKm: 30, spdKts: 280, destinationMatch: true
  });

  var rows = core.sortAirportArrivalRows([], [], [descendingInbound, approach, shortFinal]);
  var next = core.getAirportNextRow({ arrivals: rows }, "arrivals");

  assert.deepEqual(callsigns(rows), ["UAL100", "DAL200", "AAL300"]);
  assert.equal(next.callsign, "UAL100", "top next landing summary row should be the short-final aircraft");
});

test("airport arrival rows: landed and taxiing-in aircraft stay ahead of airborne arrivals", () => {
  var landedFartherDownRunway = {
    callsign: "SWA202",
    landed: true,
    distKm: 0.8,
    arrivalScore: 0,
    _rolloutDist: 1.2
  };
  var mostRecentTouchdown = {
    callsign: "ASA101",
    landed: true,
    distKm: 1.1,
    arrivalScore: 0,
    _rolloutDist: 0.2
  };
  var taxiingIn = {
    callsign: "JBU303",
    taxiingIn: true,
    distKm: 0.1,
    arrivalScore: 0
  };
  var airborneShortFinal = {
    callsign: "DAL404",
    distKm: 2,
    arrivalScore: 0.01,
    etaMin: 1
  };

  var rows = core.sortAirportArrivalRows(
    [landedFartherDownRunway, mostRecentTouchdown],
    [taxiingIn],
    [airborneShortFinal]
  );
  var next = core.getAirportNextRow({ arrivals: rows }, "arrivals");

  assert.deepEqual(callsigns(rows), ["ASA101", "SWA202", "JBU303", "DAL404"]);
  assert.equal(next.callsign, "ASA101", "top next landing summary row should stay the most recent landed aircraft");
  assert.equal("_rolloutDist" in next, false, "internal rollout distance should not leak to display rows");
});

test("airport departure rows: runway rolling beats holding and taxiing for next takeoff", () => {
  var rows = core.sortAirportDepartureRows([
    {
      callsign: "HOLD1",
      status: "Holding",
      runwayDistKm: 0.05,
      speedKts: 0,
      distKm: 0.4
    },
    {
      callsign: "TAXI1",
      status: "Taxiing",
      runwayDistKm: 0.02,
      speedKts: 12,
      distKm: 0.3
    },
    {
      callsign: "ROLL1",
      status: "Departing",
      runwayDistKm: 0.7,
      speedKts: 35,
      distKm: 0.8
    }
  ], { activeRunways: true });
  var next = core.getAirportNextRow({ departures: rows }, "departures");

  assert.deepEqual(callsigns(rows), ["ROLL1", "HOLD1", "TAXI1"]);
  assert.equal(next.callsign, "ROLL1", "top next takeoff summary row should be the rolling runway aircraft");
});

test("airport departure rows: climbing origin match beats parked aircraft near runway", () => {
  var rows = core.sortAirportDepartureRows([
    {
      callsign: "PARK1",
      status: "Parked",
      runwayDistKm: 0.1,
      speedKts: 0,
      distKm: 0.3
    },
    {
      callsign: "CLIMB1",
      status: "Climbing",
      runwayDistKm: 1.6,
      speedKts: 165,
      distKm: 4.2,
      originMatch: true,
      hasDest: true
    },
    {
      callsign: "TAXI1",
      status: "Taxiing",
      runwayDistKm: 0.2,
      speedKts: 12,
      distKm: 0.6,
      originMatch: true
    }
  ], { activeRunways: false });

  assert.deepEqual(callsigns(rows), ["CLIMB1", "TAXI1", "PARK1"]);
});

test("airport departure status helper explains signal confidence without ETA", () => {
  assert.deepEqual(core.describeAirportDepartureStatus({
    callsign: "ROLL1",
    status: "Departing",
    speedKts: 42,
    activeRunway: true,
    onRunway: true,
    runwayDistKm: 0.5
  }, { activeRunways: true }), {
    label: "Rolling",
    confidence: "high",
    sortOrder: 0,
    activeRunway: true,
    onRunway: true,
    nearRunway: true,
    routeOrigin: false
  });

  assert.deepEqual(core.describeAirportDepartureStatus({
    callsign: "TAXI1",
    status: "Taxiing",
    speedKts: 14,
    runwayDistKm: 0.8,
    originMatch: true
  }), {
    label: "Taxiing near runway",
    confidence: "medium",
    sortOrder: 3,
    activeRunway: false,
    onRunway: false,
    nearRunway: true,
    routeOrigin: true
  });
});
