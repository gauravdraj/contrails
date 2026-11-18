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

test("sizeClass classifies aircraft types into silhouette buckets", () => {
  assert.equal(core.sizeClass("A388", null), "quadjet");
  assert.equal(core.sizeClass("B744", null), "quadjet");
  assert.equal(core.sizeClass("B77W", null), "widebody");
  assert.equal(core.sizeClass("A333", null), "widebody");
  assert.equal(core.sizeClass("B738", null), "narrowbody");
  assert.equal(core.sizeClass("A21N", null), "narrowbody");
  assert.equal(core.sizeClass("CRJ9", null), "bizjet");
  assert.equal(core.sizeClass("GLF6", null), "bizjet");
  assert.equal(core.sizeClass("C172", null), "light");
  assert.equal(core.sizeClass("DH8D", null), "turboprop");
  assert.equal(core.sizeClass("EC35", null), "heli");
});

test("sizeClass falls back to category, then light, when type is unknown", () => {
  assert.equal(core.sizeClass(null, "A5"), "widebody");
  assert.equal(core.sizeClass(null, "A3"), "narrowbody");
  assert.equal(core.sizeClass(null, null), "light");
  assert.equal(core.sizeClass("ZZZZ", "A5"), "widebody");
  assert.equal(core.sizeClass("ZZZZ", null), "light");
});

test("sizeFromCategory maps ADS-B emitter categories", () => {
  assert.equal(core.sizeFromCategory("A1"), "light");
  assert.equal(core.sizeFromCategory("A3"), "narrowbody");
  assert.equal(core.sizeFromCategory("A5"), "widebody");
  assert.equal(core.sizeFromCategory("A7"), "heli");
  assert.equal(core.sizeFromCategory("Z9"), null);
  assert.equal(core.sizeFromCategory(null), null);
});

test("isLikelyPrivateClass flags small airframes as likely private", () => {
  assert.equal(core.isLikelyPrivateClass("C172", null), true);
  assert.equal(core.isLikelyPrivateClass("GLF6", null), true);
  assert.equal(core.isLikelyPrivateClass("DH8D", null), true);
  assert.equal(core.isLikelyPrivateClass("B738", null), false);
  assert.equal(core.isLikelyPrivateClass("A388", null), false);
});

test("dimColor desaturates and lightens an HSL string, ignoring malformed input", () => {
  assert.equal(core.dimColor("hsl(120,100%,50%)"), "hsl(120,40%,55%)");
  assert.equal(core.dimColor("not-a-color"), "not-a-color");
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

test("scoreArrivalCandidate destination-confirmed 36 km out accounts for slowing on approach and final", () => {
  var result = core.scoreArrivalCandidate({
    altFt: 6000, vRate: -12, distKm: 36, spdKts: 250, destinationMatch: true
  });

  // 21 km at 220 kts + 15 km at 150 kts = 6.3 min (constant 250 kts would say 4.7).
  assert.ok(result.etaMin > 5.5, "etaMin should be greater than 5.5 (was " + result.etaMin + ")");
  assert.ok(result.etaMin < 7.5, "etaMin should be less than 7.5 (was " + result.etaMin + ")");
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

test("findFlightStartIndex retains the last ground point before the airborne segment", () => {
  var path = [
    mkPt(100, false), mkPt(200, false),
    mkPt(300, true), mkPt(400, true),
    mkPt(500, false), mkPt(600, false)
  ];
  assert.equal(core.findFlightStartIndex(path), 3);
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
  assert.equal(core.findFlightStartIndex(path), 2);
});

test("findFlightStartIndex honors time gap within trailing ground segment", () => {
  var path = [
    mkPt(100, false), mkPt(200, false),
    mkPt(300, true), mkPt(5000, true)
  ];
  assert.equal(core.findFlightStartIndex(path), 3);
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

test("airport inbound rows: soonest ETA first, so the next landing is the short-final plane", () => {
  var shortFinal = inboundArrival("UAL100", {
    altFt: 3500, vRate: -10, distKm: 10, spdKts: 160, destinationMatch: true
  });
  var approach = inboundArrival("DAL200", {
    altFt: 5000, vRate: -10, distKm: 18, spdKts: 200, destinationMatch: true
  });
  var descendingInbound = inboundArrival("AAL300", {
    altFt: 8000, vRate: -10, distKm: 30, spdKts: 280, destinationMatch: true
  });

  var rows = core.sortAirportInboundRows([descendingInbound, approach, shortFinal]);
  var next = core.getAirportNextRow({ arrivals: rows }, "arrivals");

  assert.deepEqual(callsigns(rows), ["UAL100", "DAL200", "AAL300"]);
  assert.equal(next.callsign, "UAL100", "top next landing summary row should be the short-final aircraft");
});

test("airport inbound rows: ETA order wins over the arrival score", () => {
  var rows = core.sortAirportInboundRows([
    { callsign: "SIX", etaMin: 6, arrivalScore: 1, distKm: 30 },
    { callsign: "THREE", etaMin: 3, arrivalScore: 9, distKm: 12 },
    { callsign: "NONE", etaMin: null, arrivalScore: 0, distKm: 5 }
  ]);
  assert.deepEqual(callsigns(rows), ["THREE", "SIX", "NONE"]);
});

test("airport inbound rows: planes already on the Landed tab are left off", () => {
  var rows = core.sortAirportInboundRows(
    [{ hex: "a1b2c3", callsign: "UAL100", etaMin: 0.5 }, { callsign: "DAL200", etaMin: 4 }],
    { exclude: [{ hex: "A1B2C3", callsign: "UAL100", landed: true }] }
  );
  assert.deepEqual(callsigns(rows), ["DAL200"]);
});

test("airport landed rows: runway rollout first, then taxiing in, then parked", () => {
  var landedFartherDownRunway = { callsign: "SWA202", landed: true, distKm: 0.8, _rolloutDist: 1.2 };
  var mostRecentTouchdown = { callsign: "ASA101", landed: true, distKm: 1.1, _rolloutDist: 0.2 };
  var taxiingIn = { callsign: "JBU303", taxiingIn: true, distKm: 0.4 };
  var parked = { callsign: "UAL505", taxiingIn: true, parked: true, distKm: 0.1 };

  var rows = core.sortAirportLandedRows([landedFartherDownRunway, mostRecentTouchdown], [parked, taxiingIn]);
  var next = core.getAirportNextRow({ landed: rows }, "landed");

  assert.deepEqual(callsigns(rows), ["ASA101", "SWA202", "JBU303", "UAL505"]);
  assert.equal(next.callsign, "ASA101", "the summary card shows the most recent touchdown");
  assert.equal("_rolloutDist" in next, false, "internal rollout distance should not leak to display rows");
});

test("airport landed rows: suppress duplicate aircraft across landed buckets", () => {
  var landed = { hex: "A1B2C3", callsign: "UAL100", landed: true, distKm: 0.4, _rolloutDist: 0.2 };
  var taxiingDuplicate = { hex: "a1b2c3", callsign: "UAL100", taxiingIn: true, distKm: 0.8 };
  var other = { hex: "d4e5f6", callsign: "DAL200", taxiingIn: true, distKm: 1.2 };

  var rows = core.sortAirportLandedRows([landed], [taxiingDuplicate, other]);
  assert.deepEqual(callsigns(rows), ["UAL100", "DAL200"]);
  assert.equal(rows[0].landed, true, "duplicate suppression should keep the runway row");
});

test("coverage circles: a wide view gets several lattice circles, nearest to the center first", () => {
  var bounds = core.viewBounds(48, 30, -100, -125);
  var center = { lat: 39, lng: -112.5 };
  var cov = core.buildCoverageCircles(center, bounds, { radiusKm: 460, maxCircles: 50 });
  assert.equal(cov.complete, true);
  assert.ok(cov.circles.length > 4);
  for (var i = 1; i < cov.circles.length; i++) {
    var prev = core.haversineKm(center.lat, center.lng, cov.circles[i - 1].lat, cov.circles[i - 1].lng);
    var cur = core.haversineKm(center.lat, center.lng, cov.circles[i].lat, cov.circles[i].lng);
    assert.ok(prev <= cur + 1e-6, "sorted by distance from the view center");
  }
  // Every point in the view is inside some circle.
  for (var lat = 30; lat <= 48; lat += 1.5) {
    for (var lng = -125; lng <= -100; lng += 1.5) {
      var covered = cov.circles.some(function(c) { return core.haversineKm(lat, lng, c.lat, c.lng) <= c.km; });
      assert.ok(covered, "point " + lat + "," + lng + " is covered");
    }
  }
});

test("coverage circles: centers stay put when the view pans slightly", () => {
  var a = core.buildCoverageCircles({ lat: 39, lng: -100 }, core.viewBounds(45, 33, -90, -110), { maxCircles: 50 });
  var b = core.buildCoverageCircles({ lat: 39.2, lng: -100.3 }, core.viewBounds(45.2, 33.2, -90.3, -110.3), { maxCircles: 50 });
  var key = function(c) { return c.lat + "," + c.lng; };
  var aKeys = a.circles.map(key);
  var shared = b.circles.filter(function(c) { return aKeys.indexOf(key(c)) !== -1; });
  assert.ok(shared.length >= a.circles.length - 3, "most circles are reused after a small pan");
});

test("coverage circles: capped views report incomplete coverage", () => {
  var cov = core.buildCoverageCircles({ lat: 39, lng: -95 }, core.viewBounds(50, 25, -65, -125), { maxCircles: 7 });
  assert.equal(cov.circles.length, 7);
  assert.equal(cov.complete, false);
  assert.ok(cov.total > 7);
});

test("countGroundByAirport assigns each plane to its nearest airport in range", () => {
  var airports = [{ code: "SFO", lat: 37.619, lng: -122.375 }, { code: "OAK", lat: 37.721, lng: -122.221 }];
  var planes = [
    { lat: 37.615, lng: -122.39 },
    { lat: 37.62, lng: -122.37 },
    { lat: 37.72, lng: -122.22 },
    { lat: 38.5, lng: -121.5 }
  ];
  assert.deepEqual(core.countGroundByAirport(planes, airports, 6), { SFO: 2, OAK: 1 });
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

test("airport departure rows: planes already climbing out sort after the ground queue", () => {
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

  // CLIMB1 has already taken off; PARK1 is stopped at the hold-short line.
  assert.deepEqual(callsigns(rows), ["PARK1", "TAXI1", "CLIMB1"]);
  assert.equal(core.describeAirportDepartureStatus(rows[0]).label, "Holding short");
  assert.equal(core.describeAirportDepartureStatus(rows[2]).label, "Just departed");
});

test("airport departure rows: lined up beats climbing; rolling stays first", () => {
  var rows = core.sortAirportDepartureRows([
    { callsign: "CLIMB1", status: "Climbing", runwayDistKm: 1, speedKts: 170, distKm: 3, originMatch: true },
    { callsign: "HOLD1", status: "Holding", runwayDistKm: 0.05, speedKts: 0, distKm: 0.5, activeRunway: true },
    { callsign: "ROLL1", status: "Departing", runwayDistKm: 0.6, speedKts: 90, distKm: 0.9, activeRunway: true }
  ], { activeRunways: true });
  assert.deepEqual(callsigns(rows), ["ROLL1", "HOLD1", "CLIMB1"]);
});

test("airport departure rows: queue ranks heading for the runway over parked near it or taxiing away", () => {
  var rows = core.sortAirportDepartureRows([
    { callsign: "AWAY", status: "Taxiing", runwayDistKm: 0.5, speedKts: 15, distKm: 1, towardRunway: false },
    { callsign: "GATE", status: "Parked", runwayDistKm: 0.6, speedKts: 0, distKm: 1, originMatch: true },
    { callsign: "TOWARD", status: "Taxiing", runwayDistKm: 1.8, speedKts: 15, distKm: 2, towardRunway: true },
    { callsign: "UNKNOWN", status: "Taxiing", runwayDistKm: 0.9, speedKts: 15, distKm: 1.2 },
    { callsign: "SHORT", status: "Parked", runwayDistKm: 0.1, speedKts: 0, distKm: 0.8 }
  ], { activeRunways: true });
  assert.deepEqual(callsigns(rows), ["SHORT", "TOWARD", "UNKNOWN", "GATE", "AWAY"]);
  assert.equal(core.describeAirportDepartureStatus(rows[1]).label, "Taxiing to runway");
  assert.equal(core.describeAirportDepartureStatus(rows[4]).label, "Taxiing away");
});

test("landedRecently: a descent within the window counts, a flag flicker at field elevation does not", () => {
  var now = 1000000000;
  var approach = [
    [0, 0, now - 300000, 3000, false], [0, 0, now - 200000, 1500, false],
    [0, 0, now - 120000, 200, false], [0, 0, now - 60000, null, true]
  ];
  assert.equal(core.landedRecently(approach, now), true);
  var flicker = [[0, 0, now - 90000, 5430, false], [0, 0, now - 60000, 5425, false], [0, 0, now - 30000, null, true]];
  assert.equal(core.landedRecently(flicker, now), false);
  assert.equal(core.landedRecently(approach, now + 20 * 60000), false, "outside the 15 min window");
  var seeded = [[0, 0, now - 50000, 3000, false, false, true], [0, 0, now - 40000, 200, false, false, true]];
  assert.equal(core.landedRecently(seeded, now), false, "synthetic seed points are ignored");
});

test("closingKm: positive when approaching the target, negative when leaving, null when too short or stale", () => {
  var t = [37.0, -122.0];
  var toward = [[37.02, -122.0, 0], [37.01, -122.0, 25000]];
  assert.ok(core.closingKm(toward, t[0], t[1], 20000) > 1);
  var away = [[37.01, -122.0, 0], [37.02, -122.0, 25000]];
  assert.ok(core.closingKm(away, t[0], t[1], 20000) < -1);
  assert.equal(core.closingKm([[37.01, -122.0, 0], [37.0, -122.0, 5000]], t[0], t[1], 20000), null);
  assert.equal(core.closingKm([[37.01, -122.0, 0], [37.0, -122.0, 200000]], t[0], t[1], 20000), null);
});

test("airport departure rows: closer parked beats farther taxiing", () => {
  // A plane parked/stopped near the runway start is more imminent than one
  // taxiing in from a far ramp -- distance-to-threshold crosses Taxiing/Parked.
  var rows = core.sortAirportDepartureRows([
    { callsign: "TAXFAR", status: "Taxiing", runwayDistKm: 1.4, speedKts: 15, distKm: 1.6 },
    { callsign: "PARKNEAR", status: "Parked", runwayDistKm: 0.3, speedKts: 0, distKm: 0.4 }
  ], { activeRunways: true });
  assert.deepEqual(callsigns(rows), ["PARKNEAR", "TAXFAR"]);
});

test("airport departure rows: taxiing/parked sort by distance-to-threshold, not speed", () => {
  // Closer-to-threshold but slower must beat farther-but-faster.
  var rows = core.sortAirportDepartureRows([
    { callsign: "TAXFAR", status: "Taxiing", runwayDistKm: 1.0, speedKts: 40, distKm: 1.1 },
    { callsign: "TAXNEAR", status: "Taxiing", runwayDistKm: 0.3, speedKts: 5, distKm: 0.5 }
  ], { activeRunways: true });
  assert.deepEqual(callsigns(rows), ["TAXNEAR", "TAXFAR"]);

  // On equal distance-to-threshold, speed is ignored (falls to airport distance).
  var tied = core.sortAirportDepartureRows([
    { callsign: "BBB", status: "Taxiing", runwayDistKm: 0.5, speedKts: 30, distKm: 0.9 },
    { callsign: "AAA", status: "Taxiing", runwayDistKm: 0.5, speedKts: 5, distKm: 0.5 }
  ], { activeRunways: true });
  assert.deepEqual(callsigns(tied), ["AAA", "BBB"]);
});

test("airport panel list rows omit the highlighted next row (arrivals and departures)", () => {
  var arrLive = { arrivals: [{ callsign: "UAL100" }, { callsign: "DAL200" }] };
  assert.equal(core.getAirportNextRow(arrLive, "arrivals").callsign, "UAL100");
  assert.deepEqual(callsigns(arrLive.arrivals.slice(1)), ["DAL200"]);

  var depLive = { departures: [{ callsign: "ASA101" }, { callsign: "JBU202" }] };
  assert.equal(core.getAirportNextRow(depLive, "departures").callsign, "ASA101");
  assert.deepEqual(callsigns(depLive.departures.slice(1)), ["JBU202"]);
});

test("airport departure rows: suppress duplicate aircraft after priority sorting", () => {
  var rows = core.sortAirportDepartureRows([
    {
      hex: "abc123",
      callsign: "DUP100",
      status: "Parked",
      runwayDistKm: 0.2,
      speedKts: 0,
      distKm: 0.3
    },
    {
      hex: "ABC123",
      callsign: "DUP100",
      status: "Departing",
      runwayDistKm: 0.6,
      speedKts: 40,
      distKm: 0.8,
      onRunway: true
    },
    {
      hex: "def456",
      callsign: "TAXI1",
      status: "Taxiing",
      runwayDistKm: 0.2,
      speedKts: 12,
      distKm: 0.6
    }
  ], { activeRunways: true });
  var next = core.getAirportNextRow({ departures: rows }, "departures");

  assert.deepEqual(callsigns(rows), ["DUP100", "TAXI1"]);
  assert.equal(next.status, "Departing", "duplicate suppression should keep the sorted next-takeoff row");
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

// --- classifyGroundDepartureStatus ---

test("classifyGroundDepartureStatus: on active runway tracking takeoff direction is Departing", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 25, track: 280, onActiveDepRunway: true, onAnyRunway: true, depRunwayBearing: 281
  }), "Departing");
});

test("classifyGroundDepartureStatus: on active runway tracking opposite is back-taxi -> Taxiing", () => {
  // Plane parallel to the runway but moving the reciprocal direction = taxiing to the
  // start to line up. Must NOT be labelled Departing/next departure.
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 22, track: 100, onActiveDepRunway: true, onAnyRunway: true, depRunwayBearing: 281
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: crossing the active runway perpendicular is Taxiing", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 18, track: 190, onActiveDepRunway: true, onAnyRunway: true, depRunwayBearing: 281
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: fast roll opposite the active runway is not Departing", () => {
  // e.g. a high-speed rollout from a reciprocal landing should not be a departure.
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 70, track: 101, onActiveDepRunway: true, onAnyRunway: true, depRunwayBearing: 281
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: low-speed track is not trusted for direction", () => {
  // Below the movement threshold ADS-B track is noise, so don't downgrade a
  // lined-up aircraft holding in position.
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 2, track: 100, onActiveDepRunway: true, onAnyRunway: true, depRunwayBearing: 281
  }), "Holding");
});

test("classifyGroundDepartureStatus: taxiing along an inactive/other runway is not Departing", () => {
  // On a runway, aligned to its centerline, but it isn't the active departure
  // runway -> back-taxi/transit on an inactive runway, not a takeoff roll.
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 22, track: 10, onActiveDepRunway: false, onAnyRunway: true,
    anyRunwayBearing: 10, haveActiveDep: true
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: crossing an inactive runway perpendicular is Taxiing", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 16, track: 100, onActiveDepRunway: false, onAnyRunway: true,
    anyRunwayBearing: 10, haveActiveDep: true
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: fast aligned roll on an undetected 2nd active runway is Departing", () => {
  // Safety valve: a confirmed fast, centerline-aligned roll on a parallel we didn't
  // flag active this tick should still count as a departure.
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 90, track: 11, onActiveDepRunway: false, onAnyRunway: true,
    anyRunwayBearing: 10, haveActiveDep: true
  }), "Departing");
});

test("classifyGroundDepartureStatus: with no active signal, crossing a runway is still Taxiing", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 18, track: 100, onActiveDepRunway: false, onAnyRunway: true,
    anyRunwayBearing: 10, haveActiveDep: false
  }), "Taxiing");
});

test("classifyGroundDepartureStatus: with no active signal, aligned on a runway is Departing", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 18, track: 12, onActiveDepRunway: false, onAnyRunway: true,
    anyRunwayBearing: 10, haveActiveDep: false
  }), "Departing");
});

test("classifyGroundDepartureStatus: preserves prior behavior when direction is unknown", () => {
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 60, onAnyRunway: false
  }), "Departing");
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 20, onAnyRunway: true, onActiveDepRunway: false
  }), "Departing");
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 12, onAnyRunway: false
  }), "Taxiing");
  assert.equal(core.classifyGroundDepartureStatus({
    speedKts: 1, onAnyRunway: false
  }), "Parked");
});

// --- deriveActiveRunways ---

function onRunwayAircraft(designator, overrides) {
  // Place a synthetic aircraft at the midpoint of an SFO runway, tracking in the
  // designator's direction, so geometry matches a real on-runway target.
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", designator);
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var lengthM = core.haversineKm(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon) * 1000;
  var mid = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, bearing, lengthM / 2);
  return Object.assign({ lat: mid[0], lng: mid[1], track: bearing, altFt: 150, vRate: 0, ground: false }, overrides || {});
}

test("deriveActiveRunways: climbing aircraft on a runway marks it departing", () => {
  var ac = onRunwayAircraft("28L", { vRate: 12, altFt: 250 }); // +720 fpm
  var res = core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]);
  assert.ok(res, "should detect an active runway");
  assert.deepEqual(res.departing_runways, ["28L"]);
  assert.deepEqual(res.arriving_runways, []);
});

test("deriveActiveRunways: descending aircraft on a runway marks it arriving", () => {
  var ac = onRunwayAircraft("28L", { vRate: -12, altFt: 120 }); // -720 fpm
  var res = core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]);
  assert.ok(res, "should detect an active runway");
  assert.deepEqual(res.arriving_runways, ["28L"]);
  assert.deepEqual(res.departing_runways, []);
});

test("deriveActiveRunways: direction of travel selects the correct designator", () => {
  var rwy = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", "28L");
  var bearing = core.bearingDegrees(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon);
  var lengthM = core.haversineKm(rwy.thresholdLat, rwy.thresholdLon, rwy.farEndLat, rwy.farEndLon) * 1000;
  var mid = core.projectLatLng(rwy.thresholdLat, rwy.thresholdLon, bearing, lengthM / 2);
  // Same physical runway, but tracking the reciprocal direction = the 10R end.
  var ac = { lat: mid[0], lng: mid[1], track: (bearing + 180) % 360, altFt: 250, vRate: 12, ground: false };
  var res = core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]);
  assert.deepEqual(res.departing_runways, ["10R"]);
});

test("deriveActiveRunways: high overflight is ignored", () => {
  var ac = onRunwayAircraft("28L", { altFt: 30000, vRate: 12 });
  assert.equal(core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]), null);
});

test("deriveActiveRunways: level traffic with no vertical signal is ignored", () => {
  var ac = onRunwayAircraft("28L", { vRate: 0, altFt: 200 });
  assert.equal(core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]), null);
});

test("deriveActiveRunways: aircraft off any runway is ignored", () => {
  var ac = { lat: 37.7, lng: -122.45, track: 280, altFt: 250, vRate: 12, ground: false };
  assert.equal(core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [ac]), null);
});

test("deriveActiveRunways: returns null with no aircraft or no runways", () => {
  assert.equal(core.deriveActiveRunways(SFO_RUNWAYS, "SFO", []), null);
  assert.equal(core.deriveActiveRunways(null, "SFO", [onRunwayAircraft("28L", { vRate: 12 })]), null);
});

test("parseDatisActiveRunways: extracts SFO departure and approach runways", () => {
  var datis = "SFO ATIS INFO Y 0656Z. 28012KT 10SM FEW200 13/09 A2988. " +
    "SIMUL CLSLY SPCD DPNDNT ILS RY 28R AND ILS RY 28L APP IN USE. " +
    "DEPG RWYS 28L, 28R. RY 1L, 1R CLSD. NUMEROUS TWY CLOSURES.";
  assert.deepEqual(core.parseDatisActiveRunways(datis), {
    departing_runways: ["28L", "28R"],
    arriving_runways: ["28R", "28L"]
  });
});

test("parseDatisActiveRunways: handles SEA-style mixed approach/departure phrasing", () => {
  var datis = "SEA ATIS INFO M 0653Z. RNAV, GPS, RY 34C, APCH IN USE. " +
    "DEPG RWY 34R, DEPG ACFT PLAN AND BRIEF NUMBERS FOR BOTH RWYS 34R AND 34C. " +
    "SIMUL ARRIVALS TO RWY 34L AND DEPARTURES TO RWY 34R ARE IN USE. RY 34L CLSD.";
  assert.deepEqual(core.parseDatisActiveRunways(datis), {
    departing_runways: ["34R"],
    arriving_runways: ["34C", "34L"]
  });
});

test("parseDatisActiveRunways: returns null when ATIS has no usable runway-use clauses", () => {
  assert.equal(core.parseDatisActiveRunways("INFO A. WINDS 28012KT. RY 1L, 1R CLSD. BIRD ACTIVITY."), null);
});

test("greatCirclePoints: endpoints match the inputs", () => {
  var pts = core.greatCirclePoints(37.62, -122.38, 40.64, -73.78, 32);
  assert.equal(pts.length, 33);
  assert.ok(Math.abs(pts[0][0] - 37.62) < 1e-6 && Math.abs(pts[0][1] - (-122.38)) < 1e-6);
  assert.ok(Math.abs(pts[pts.length - 1][0] - 40.64) < 1e-6 && Math.abs(pts[pts.length - 1][1] - (-73.78)) < 1e-6);
});

test("greatCirclePoints: an east-west northern route bows poleward at the midpoint", () => {
  // SFO->JFK both near 38-40N; the great circle arcs north of the straight
  // line average latitude.
  var pts = core.greatCirclePoints(37.62, -122.38, 40.64, -73.78, 64);
  var mid = pts[32];
  assert.ok(mid[0] > (37.62 + 40.64) / 2, "midpoint latitude should be north of the endpoint average");
});

test("greatCirclePoints: keeps longitude continuous across the antimeridian", () => {
  // Tokyo (HND) -> Los Angeles (LAX) crosses the Pacific / 180deg line. No
  // adjacent pair of sampled longitudes should jump by more than 180deg.
  var pts = core.greatCirclePoints(35.55, 139.78, 33.94, -118.41, 64);
  var maxJump = 0;
  for (var i = 1; i < pts.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(pts[i][1] - pts[i - 1][1]));
  }
  assert.ok(maxJump < 180, "no longitude jump should exceed 180 degrees");
});

test("greatCirclePoints: identical points and bad input degrade gracefully", () => {
  assert.deepEqual(core.greatCirclePoints(10, 20, 10, 20, 16), [[10, 20], [10, 20]]);
  assert.deepEqual(core.greatCirclePoints(null, 1, 2, 3), []);
  assert.deepEqual(core.greatCirclePoints(1, 1, NaN, 3), []);
});

test("declutterLabels keeps the higher-ranked of two overlapping labels", () => {
  const kept = core.declutterLabels([
    { id: "OAK", x: 100, y: 100, rank: 32 },
    { id: "SFO", x: 104, y: 108, rank: 150 },
    { id: "SJC", x: 140, y: 160, rank: 38 },
  ], { w: 44, h: 22 });
  assert.deepEqual(kept.map((k) => k.id), ["SFO", "SJC"]);
});

test("declutterLabels keeps labels that sit side by side without touching", () => {
  const kept = core.declutterLabels([
    { id: "A", x: 0, y: 0, rank: 1 },
    { id: "B", x: 60, y: 0, rank: 2 },
  ], { w: 44, h: 22 });
  assert.equal(kept.length, 2);
});

test("updateClockOffset tracks the freshest response and creeps up slowly", () => {
  let off = core.updateClockOffset(null, 10_500, 10_000);
  assert.equal(off, 500);
  off = core.updateClockOffset(off, 22_900, 20_000);
  assert.equal(off, 550);
  off = core.updateClockOffset(off, 30_200, 30_000);
  assert.equal(off, 200);
});

test("viewBounds pads every side by a fraction of the span and wraps longitude", () => {
  const b = core.viewBounds(40, 30, -100, -120).pad(0.1);
  assert.equal(b.north, 41);
  assert.equal(b.south, 29);
  assert.equal(b.east, -98);
  assert.equal(b.west, -122);
  assert.ok(b.contains(35, -110));
  assert.ok(!b.contains(42, -110));
  assert.ok(!b.contains(35, -90));
  const across = core.viewBounds(10, -10, 190, 170);
  assert.ok(across.contains(0, -175));
  assert.ok(across.contains(0, 175));
  assert.ok(!across.contains(0, 160));
});

test("alphaToSdf puts a filled square's edge at the cutoff and falls off by 255/radius per pixel", () => {
  const w = 32, h = 32;
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) alpha[y * w + x] = 255;
  const sdf = core.alphaToSdf(alpha, w, h, 8, 0.25);
  const at = (x, y) => sdf[y * w + x];
  assert.equal(at(16, 16), 255);
  // The edge falls between pixels 7 and 8, so they straddle 191 by half a step each way.
  assert.equal(at(8, 16), 223);
  assert.equal(at(7, 16), 159);
  assert.equal(at(3, 16), 32);
  assert.equal(at(0, 0), 0);
});

test("arrivalPathTimeMin slows to approach and final speeds", () => {
  // 15 km final at 150 kts = 3.24 min; at 280 kts the old constant-speed model said 1.74 min.
  assert.ok(Math.abs(core.arrivalPathTimeMin(15, 280) - 3.24) < 0.01);
  // 100 km: 40 km at 450 kts + 45 km at 220 kts + 15 km at 150 kts.
  var expected = 40 / (450 * 1.852 / 60) + 45 / (220 * 1.852 / 60) + 15 / (150 * 1.852 / 60);
  assert.ok(Math.abs(core.arrivalPathTimeMin(100, 450) - expected) < 0.01);
  // A plane already slower than the caps keeps its own speed.
  assert.ok(Math.abs(core.arrivalPathTimeMin(10, 120) - 10 / (120 * 1.852 / 60)) < 0.01);
  assert.equal(core.arrivalPathTimeMin(null, 200), null);
});

test("blendArrivalEta: geometry close in, feed ETA far out, linear between 10 and 20 min", () => {
  assert.equal(core.blendArrivalEta(6, 30), 6);
  assert.equal(core.blendArrivalEta(25, 40), 40);
  assert.equal(core.blendArrivalEta(15, 25), 20);
  assert.equal(core.blendArrivalEta(25, null), 25);
  assert.equal(core.blendArrivalEta(25, -3), 25, "a feed time already in the past is ignored");
});

test("scoreArrivalCandidate uses the feed ETA only for routed arrivals far out", () => {
  var far = core.scoreArrivalCandidate({ altFt: 30000, distKm: 300, spdKts: 450, vRate: -20, destinationMatch: true, feedEtaMin: 50 });
  assert.equal(far.etaMin, 50);
  var near = core.scoreArrivalCandidate({ altFt: 2000, distKm: 12, spdKts: 160, vRate: -12, destinationMatch: true, feedEtaMin: 30 });
  assert.ok(near.etaMin < 6, "close in, live geometry wins");
});

// SFO 28L: threshold at the east end, landing toward the west-northwest.
var RWY_28L = { thresholdLat: 37.6117, thresholdLon: -122.3584, farEndLat: 37.6263, farEndLon: -122.3931 };
var HDG_28L = core.bearingDegrees(RWY_28L.thresholdLat, RWY_28L.thresholdLon, RWY_28L.farEndLat, RWY_28L.farEndLon);

test("approachPathKm: lined up on final is the distance to the threshold", () => {
  var p = core.projectLatLng(RWY_28L.thresholdLat, RWY_28L.thresholdLon, (HDG_28L + 180) % 360, 10000);
  var r = core.approachPathKm(p[0], p[1], HDG_28L, [RWY_28L]);
  assert.equal(r.onFinal, true);
  assert.ok(Math.abs(r.pathKm - 10) < 0.1, "was " + r.pathKm);
});

test("approachPathKm: downwind abeam the field flies out to the join point and back", () => {
  // 5 km to the side of the threshold, tracking opposite the landing direction.
  var p = core.projectLatLng(RWY_28L.thresholdLat, RWY_28L.thresholdLon, (HDG_28L + 90) % 360, 5000);
  var r = core.approachPathKm(p[0], p[1], (HDG_28L + 180) % 360, [RWY_28L]);
  assert.equal(r.onFinal, false);
  // sqrt(15^2 + 5^2) + 15 ~= 30.8 km, versus 5 km straight to the threshold.
  assert.ok(Math.abs(r.pathKm - 30.8) < 0.5, "was " + r.pathKm);
});

test("approachPathKm: never shorter than the straight line, and picks the better runway", () => {
  var other = { thresholdLat: 37.6135, thresholdLon: -122.3572, farEndLat: 37.6287, farEndLon: -122.3934 }; // 28R
  var p = core.projectLatLng(RWY_28L.thresholdLat, RWY_28L.thresholdLon, 40, 30000);
  var r = core.approachPathKm(p[0], p[1], 220, [RWY_28L, other]);
  assert.ok(r.pathKm >= core.haversineKm(p[0], p[1], RWY_28L.thresholdLat, RWY_28L.thresholdLon) - 0.01);
  var lined = core.projectLatLng(other.thresholdLat, other.thresholdLon, (HDG_28L + 180) % 360, 8000);
  assert.equal(core.approachPathKm(lined[0], lined[1], HDG_28L, [RWY_28L, other]).runway, other);
  assert.equal(core.approachPathKm(37, -122, 0, []), null);
});

test("scoreArrivalCandidate: path distance drives the ETA; altitude rules use height above the field", () => {
  var straight = core.scoreArrivalCandidate({ altFt: 3000, distKm: 5, spdKts: 180, vRate: -5, destinationMatch: true });
  var downwind = core.scoreArrivalCandidate({ altFt: 3000, distKm: 5, spdKts: 180, vRate: -5, destinationMatch: true, pathKm: 30.8 });
  assert.ok(downwind.etaMin > straight.etaMin + 3, straight.etaMin + " vs " + downwind.etaMin);
  // Denver (5,431 ft): 1,000 ft above the field on a 5 km final is about 1 min out, not 4.3 (6,431 / 1,500).
  var den = core.scoreArrivalCandidate({ altFt: 6431, distKm: 5, spdKts: 140, vRate: -12, destinationMatch: true, fieldElevFt: 5431 });
  assert.ok(den.etaMin < 2, "was " + den.etaMin);
});

test("runwayApproachEnds: an OAK runway-30 final is on final there, not at SFO", () => {
  var oak = core.runwayApproachEnds([[37.7305, -122.222, 6, 37.7248, -122.205, 6, "OAK 10L/28R"], [37.7191, -122.241, 8, 37.7015, -122.214, 9, "OAK 12/30"]]);
  assert.equal(oak.length, 4);
  assert.deepEqual(oak[1], { thresholdLat: 37.7248, thresholdLon: -122.205, farEndLat: 37.7305, farEndLon: -122.222 });
  var sfo = core.runwayApproachEnds([[37.6263, -122.3931, 13, 37.6117, -122.3584, 10, "SFO 10R/28L"], [37.6287, -122.3934, 13, 37.6135, -122.3572, 10, "SFO 10L/28R"]]);
  // SWA2751, seen live: 1,275 ft, tracking 310 deg, south-east of Oakland.
  assert.equal(core.approachPathKm(37.6618, -122.155, 309.7, oak).onFinal, true);
  assert.equal(core.approachPathKm(37.6618, -122.155, 309.7, sfo).onFinal, false);
  // UAL1777, seen live on the SFO 28 final.
  assert.equal(core.approachPathKm(37.5617, -122.2393, 297.9, sfo).onFinal, true);
});

test("scoreArrivalCandidate: with a runway path, unrouted planes are timed by the path, not the sink rate", () => {
  // 1,275 ft sinking 832 fpm reads as ~1.5 min, but 22 km of approach at 138 kts is ~5 min.
  var noPath = core.scoreArrivalCandidate({ altFt: 1275, distKm: 22, spdKts: 138, vRate: -832 / 60 });
  var withPath = core.scoreArrivalCandidate({ altFt: 1275, distKm: 22, spdKts: 138, vRate: -832 / 60, pathKm: 22 });
  assert.ok(noPath.etaMin < 3, "was " + noPath.etaMin);
  assert.ok(withPath.etaMin > 4.5, "was " + withPath.etaMin);
});

// --- review fixes (v2.44) ---

test("scoreArrivalCandidate: a null pathKm doesn't count as a path; descending planes use the descent blend", () => {
  // The board always passes pathKm, often null. 3,000 ft at -900 fpm, 10 km out at 150 kts:
  // descent 3.33 min blended 80/20 with 2.16 min of distance = 3.10 min (the path-only formula gives 2.16).
  var scored = core.scoreArrivalCandidate({ altFt: 3000, distKm: 10, spdKts: 150, vRate: -900 / 60, pathKm: null });
  var omitted = core.scoreArrivalCandidate({ altFt: 3000, distKm: 10, spdKts: 150, vRate: -900 / 60 });
  assert.equal(scored.etaMin, omitted.etaMin);
  assert.ok(Math.abs(scored.etaMin - 3.1) < 0.05, "was " + scored.etaMin);
});

test("scoreArrivalCandidate: a null altitude stays unknown instead of reading as 0 ft", () => {
  var scored = core.scoreArrivalCandidate({ altFt: null, distKm: 5, spdKts: 140, vRate: -800 / 60, pathKm: null });
  // Unknown altitude is ineligible for an unrouted arrival (0 ft would have made it the top candidate).
  assert.equal(scored.eligible, false);
});

test("interpolatePlaybackPose: a null track doesn't extrapolate north", () => {
  var pose = core.interpolatePlaybackPose([
    { lat: 10, lng: 20, ts: 0, spdMs: 200, trackDeg: null },
    { lat: 10, lng: 20.01, ts: 1000, spdMs: 200, trackDeg: null }
  ], 1500, { maxExtrapolationMs: 1000 });
  assert.equal(pose.mode, "extrapolate");
  assert.equal(pose.lat, 10);
  assert.ok(pose.lng > 20.01);
});

test("sizeClass: helicopter codes stay helicopters", () => {
  ["EC35", "EC45", "H60", "H160", "AS50", "AS65", "B06", "B06T", "B407", "B429", "B412", "B212", "B47G", "B505",
    "MD52", "MD60", "A109", "A119", "A139", "A169", "A189", "BK17", "KA32", "R44", "S76", "MI8", "NH90"].forEach(function(t) {
    assert.equal(core.sizeClass(t, null), "heli", t);
  });
});

test("sizeClass: airliners that share helicopter prefixes are not helicopters", () => {
  ["MD81", "MD82", "MD83", "MD87", "MD88", "MD90", "B461", "B462", "B463", "A124", "A148", "KC10", "K35R"].forEach(function(t) {
    assert.notEqual(core.sizeClass(t, null), "heli", t);
  });
  assert.equal(core.sizeClass("MD88", null), "narrowbody");
  assert.equal(core.sizeClass("MD90", null), "narrowbody");
  assert.equal(core.sizeClass("B462", null), "narrowbody");
  assert.equal(core.sizeClass("A148", null), "narrowbody");
  assert.equal(core.sizeClass("A124", null), "quadjet");
  assert.equal(core.sizeClass("K35R", null), "quadjet");
  assert.equal(core.sizeClass("KC10", null), "widebody");
});

test("isLikelyPrivateCallsign: JA/HL registrations are private, JAL airline flights are not", () => {
  assert.equal(core.isLikelyPrivateCallsign("JAL123"), false);
  assert.equal(core.isLikelyPrivateCallsign("JAL5"), false);
  assert.equal(core.isLikelyPrivateCallsign("JA123A"), true);
  assert.equal(core.isLikelyPrivateCallsign("JA01KZ"), true);
  assert.equal(core.isLikelyPrivateCallsign("HL7782"), true);
  assert.equal(core.isLikelyPrivateCallsign("C-FABC"), true);
  assert.equal(core.isLikelyPrivateCallsign("C-GABC"), true);
});

test("normalizeAircraftHex keeps the non-ICAO '~' so it can't collide with a real ICAO address", () => {
  assert.equal(core.normalizeAircraftHex("~ABCDEF"), "~abcdef");
  assert.equal(core.normalizeAircraftHex("abcdef"), "abcdef");
  assert.notEqual(core.normalizeAircraftHex("~abcdef"), core.normalizeAircraftHex("abcdef"));
  assert.equal(core.normalizeAircraftHex("~abc"), null);
  // A typed hex search still finds the ICAO form.
  assert.equal(core.normalizeFlightQuery("~a1b2c3").value, "a1b2c3");
});

test("isIcaoHex accepts only plain ICAO addresses", () => {
  assert.equal(core.isIcaoHex("abcdef"), true);
  assert.equal(core.isIcaoHex("~abcdef"), false);
  assert.equal(core.isIcaoHex(null), false);
});

test("interpolateTimedPose crosses the antimeridian the short way", () => {
  var mid = core.interpolateTimedPose({ lat: 0, lng: 179.9, ts: 0 }, { lat: 0, lng: -179.9, ts: 1000 }, 500);
  assert.ok(Math.abs(Math.abs(mid.lng) - 180) < 1e-9, "was " + mid.lng);
  var quarter = core.interpolateTimedPose({ lat: 0, lng: 179.9, ts: 0 }, { lat: 0, lng: -179.9, ts: 1000 }, 250);
  assert.ok(Math.abs(quarter.lng - 179.95) < 1e-9, "was " + quarter.lng);
  var back = core.interpolateTimedPose({ lat: 0, lng: -179.9, ts: 0 }, { lat: 0, lng: 179.9, ts: 1000 }, 250);
  assert.ok(Math.abs(back.lng + 179.95) < 1e-9, "was " + back.lng);
  // Ordinary steps are unchanged.
  assert.equal(core.interpolateTimedPose({ lat: 0, lng: 10, ts: 0 }, { lat: 0, lng: 20, ts: 1000 }, 500).lng, 15);
});

test("interpolatePlaybackPose extrapolates across the antimeridian without a world-wide jump", () => {
  var pose = core.interpolatePlaybackPose([
    { lat: 0, lng: -179.95, ts: 0 },
    { lat: 0, lng: 179.95, ts: 1000 }
  ], 1500, { maxExtrapolationMs: 1000 });
  assert.equal(pose.mode, "extrapolate");
  assert.ok(Math.abs(pose.lng - 179.9) < 1e-9, "was " + pose.lng);
});

test("unwrapLngNear moves a longitude next to its reference", () => {
  assert.ok(Math.abs(core.unwrapLngNear(-179.9, 179.9) - 180.1) < 1e-9);
  assert.ok(Math.abs(core.unwrapLngNear(179.9, -179.9) + 180.1) < 1e-9);
  assert.equal(core.unwrapLngNear(10, 20), 10);
});

test("trafficRetryDelayMs backs off exponentially after failures, capped", () => {
  assert.equal(core.trafficRetryDelayMs(5000, 0, 60000), 5000);
  assert.equal(core.trafficRetryDelayMs(5000, 1, 60000), 5000);
  assert.equal(core.trafficRetryDelayMs(5000, 2, 60000), 10000);
  assert.equal(core.trafficRetryDelayMs(5000, 3, 60000), 20000);
  assert.equal(core.trafficRetryDelayMs(5000, 6, 60000), 60000);
});

test("trafficOutage: two failures in a row, or one with no good data for 30 s", () => {
  assert.equal(core.trafficOutage(0, 0, 100000), false);
  assert.equal(core.trafficOutage(1, 95000, 100000), false);
  assert.equal(core.trafficOutage(1, 60000, 100000), true);
  assert.equal(core.trafficOutage(1, 0, 100000), true);
  assert.equal(core.trafficOutage(2, 99000, 100000), true);
});

test("routeCacheEntryStale gives every source a TTL (60 min for authoritative destinations)", () => {
  var now = 10 * 60 * 60 * 1000;
  var min = 60 * 1000;
  assert.equal(core.routeCacheEntryStale({ destSource: "fr24-search", fetchedAt: now - 30 * min }, now), false);
  assert.equal(core.routeCacheEntryStale({ destSource: "fr24-search", fetchedAt: now - 61 * min }, now), true);
  assert.equal(core.routeCacheEntryStale({ destSource: "schedule", fetchedAt: now - 61 * min }, now), true);
  assert.equal(core.routeCacheEntryStale({ destSource: "cross-validated", fetchedAt: now - 61 * min }, now), true);
  assert.equal(core.routeCacheEntryStale({ destSource: "adsbdb", fetchedAt: now - 5 * min }, now), false);
  assert.equal(core.routeCacheEntryStale({ destSource: "adsbdb", fetchedAt: now - 11 * min }, now), true);
  assert.equal(core.routeCacheEntryStale(null, now), true);
  assert.equal(core.isAuthoritativeDestSource("schedule"), true);
  assert.equal(core.isAuthoritativeDestSource("convergence"), false);
});

test("selectRouteFetchPlanes skips recent misses so unresolvable planes don't starve the request", () => {
  var now = 1000000;
  var planes = [];
  for (var i = 0; i < 25; i++) planes.push({ callsign: "MISS" + i });
  planes.push({ callsign: "UAL1" }, { callsign: "N123AB", private: true }, { callsign: null });
  var retryAt = {};
  for (var j = 0; j < 25; j++) retryAt["MISS" + j] = now + 60000;
  var picked = core.selectRouteFetchPlanes(planes, {}, { now: now, retryAt: retryAt, maxPlanes: 20 });
  assert.deepEqual(picked.map(function(p) { return p.callsign; }), ["UAL1"]);
  // Once the retry time passes they are asked again.
  var later = core.selectRouteFetchPlanes(planes, {}, { now: now + 60001, retryAt: retryAt, maxPlanes: 20 });
  assert.equal(later.length, 20);
  // Fresh cache entries are skipped; stale ones are re-asked.
  var cache = { UAL1: { destSource: "adsbdb", fetchedAt: now - 1000 } };
  assert.equal(core.selectRouteFetchPlanes([{ callsign: "UAL1" }], cache, { now: now }).length, 0);
  assert.equal(core.selectRouteFetchPlanes([{ callsign: "UAL1" }], cache, { now: now + 11 * 60 * 1000 }).length, 1);
});

test("routeEntryReplaceable: no /routeset answer replaces a fresh FR24/schedule destination, even 'cross-validated'", () => {
  var now = 10 * 60 * 60 * 1000;
  var fr24 = { destination: { iata: "LAX" }, destSource: "fr24-search", fetchedAt: now - 1000 };
  // The Worker's cross-validated SFO->JFK must not clobber FR24's SFO->LAX.
  assert.equal(core.routeEntryReplaceable(fr24, now), false);
  assert.equal(core.routeEntryReplaceable({ destination: { iata: "SFO" }, destSource: "schedule", fetchedAt: now }, now), false);
  // Once stale it may be replaced.
  assert.equal(core.routeEntryReplaceable({ destination: { iata: "SFO" }, destSource: "fr24-search", fetchedAt: now - 61 * 60 * 1000 }, now), true);
  // Other or empty entries are always replaceable.
  assert.equal(core.routeEntryReplaceable({ destination: { iata: "OAK" }, destSource: "convergence", fetchedAt: now }, now), true);
  assert.equal(core.routeEntryReplaceable({ destination: { iata: "OAK" }, destSource: "cross-validated", fetchedAt: now }, now), true);
  assert.equal(core.routeEntryReplaceable({ destination: null, destSource: "fr24-search", fetchedAt: now }, now), true);
  assert.equal(core.routeEntryReplaceable(undefined, now), true);
});

test("isUsableTrafficRow skips malformed feed rows", () => {
  assert.equal(core.isUsableTrafficRow({ hex: "abcdef", lat: 37.6, lon: -122.4 }), true);
  assert.equal(core.isUsableTrafficRow(null), false);
  assert.equal(core.isUsableTrafficRow("abcdef"), false);
  assert.equal(core.isUsableTrafficRow({ lat: "37.6", lon: -122.4 }), false);
  assert.equal(core.isUsableTrafficRow({ lat: 37.6, lon: null }), false);
  assert.equal(core.isUsableTrafficRow({ lat: NaN, lon: 1 }), false);
});

// The same fixed observations exercise the frontend and all three Worker consumers.
const fs = require("node:fs");
const vm = require("node:vm");
const airlineFixture = require("./worker/src/airlines-characterization.json");
function classicScript(file, globals) {
  const context = vm.createContext(Object.assign({ core, document: { addEventListener() {} } }, core, globals));
  vm.runInContext(fs.readFileSync(require.resolve(file), "utf8"), context, { filename: file });
  return context;
}
function frontendPrivateClassifier() {
  const context = vm.createContext(Object.assign({ core }, core));
  const source = fs.readFileSync(require.resolve("./js/app-core.js"), "utf8");
  vm.runInContext(source.match(/^function isPrivate\([^]*?^}/m)[0], context);
  return context.isPrivate;
}

test("airline characterization: core and frontend preserve the shared fixture", () => {
  const isPrivate = frontendPrivateClassifier();
  for (const original of airlineFixture.cases) {
    const row = Object.assign({}, original, original.regionalFix);
    assert.deepEqual([core.airlineName(row.callsign), core.isLikelyPrivateCallsign(row.callsign)], row.core, String(row.callsign));
    assert.equal(isPrivate(row.callsign, "CRJ9", null), row.frontendRegional, String(row.callsign));
  }
});


test("regional flights: explicit carriers stay visible, unknown airline shapes keep the size fallback", () => {
  const isPrivate = frontendPrivateClassifier();
  for (const callsign of ["ENY3456", "ASH5678", "QXE2100", "LOG123", "EDV4800", "RPA4500", "SKW5000"]) {
    for (const type of ["CRJ9", "E175", "DH8D"]) {
      assert.equal(isPrivate(callsign, type, null), false, callsign + " " + type);
    }
    assert.equal(core.isLikelyPrivateCallsign(callsign), false, callsign);
  }
  for (const callsign of ["N123AB", "N12345", "JA123A", "HL7612", "C-GABC", "~abcdef", "EJA123", "LXJ123", "ZZZ12345", "ZZZ1ABC", "HLF123", "ZZZ1", "ZZZ1234AB", "ABC123"]) {
    assert.equal(isPrivate(callsign, "CRJ9", null), true, callsign);
  }
  assert.equal(core.isLikelyPrivateCallsign("EJA123"), false, "preserve callsign-only fractional behavior");
});

function sfoLaxGapGroundPath(groundAltitude = 0) {
  const path = [[1000, 37.62, -122.375, 0, 150, true], [1060, 37.60, -122.36, 300, 150, false]];
  for (let i = 0; i < 40; i++) path.push([1120 + i * 60, 37.5 - i / 39 * 3.3, -122.3 + i / 39 * 3.6, 10000, 150, false]);
  path.push([3600, 33.95, -118.42, 200, 150, false]);
  for (let i = 0; i < 3; i++) path.push([7200 + i * 30, 33.943 + i * .001, -118.408 - i * .002, groundAltitude, 150, groundAltitude !== "ground"]);
  return path;
}

test("flight-start regression: gap before trailing ground reports starts the LAX leg", () => {
  const path = sfoLaxGapGroundPath();
  assert.equal(core.findFlightStartIndex(path), path.length - 3);
});

test("flight-start regression: gaps among all-ground reports still split legs", () => {
  assert.equal(core.findFlightStartIndex([mkPt(100, true), mkPt(200, true), mkPt(4000, true)]), 2);
});

test("flight-start regression: retain the takeoff ground point and recognize readsb ground", () => {
  const path = [[0, 0, 0, 0, 0, true], [10, 0, 0, 500, 0, false],
    [20, 0, 0, "ground", 0, false], [30, 0, 0, 500, 0, false]];
  assert.equal(core.findFlightStartIndex(path), 2);
});

function originDetectionContext(route) {
  return classicScript("./js/render.js", {
    aircraft: [{ icao24: "abc123", callsign: "AAL2" }],
    airportData: [["SFO", 37.62, -122.375, "San Francisco"], ["LAX", 33.943, -118.408, "Los Angeles"]],
    posHistory: {}, routeCache: route ? { AAL2: route } : {},
    formatClientRouteLabel: (origin, dest) => (origin && origin.iata) + " to " + (dest && dest.iata)
  });
}

test("flight-start regression: ingested LAX ground reports replace the prior SFO origin and keep JFK", () => {
  const context = originDetectionContext({ origin: { iata: "SFO" }, originSource: "track", destination: { iata: "JFK" }, destSource: "adsbdb" });
  context.ingestTrackPath("abc123", { path: sfoLaxGapGroundPath() });
  assert.equal(context.routeCache.AAL2.origin.iata, "LAX");
  assert.equal(context.routeCache.AAL2.destination.iata, "JFK");
  assert.equal(context.posHistory.abc123.length, 3);
  assert.equal(context.posHistory.abc123[0][4], true);
});

test("flight-start regression: readsb ground altitude remains ground in history and origin detection", () => {
  const context = originDetectionContext();
  context.ingestTrackPath("abc123", { path: sfoLaxGapGroundPath("ground") });
  assert.equal(context.posHistory.abc123[0][4], true);
  assert.equal(context.routeCache.AAL2.origin.iata, "LAX");
});

test("flight-start regression: explicit ground flag with unknown altitude supplies the origin", () => {
  const context = originDetectionContext();
  context.ingestTrackPath("abc123", { path: sfoLaxGapGroundPath(null) });
  assert.equal(context.posHistory.abc123[0][4], true);
  assert.equal(context.routeCache.AAL2.origin.iata, "LAX");
});

test("flight-start regression: unknown airborne altitude cannot supply an origin", () => {
  const context = originDetectionContext();
  context.runOriginDetection("abc123", { path: Array.from({ length: 6 }, (_, i) => [1000 + i * 60, 37.62, -122.375, null, 0, false]) });
  assert.equal(context.routeCache.AAL2, undefined);
});

const SCHEDULE_NOW = 1700000000000;
const SCHEDULE_SEC = SCHEDULE_NOW / 1000;
const schedulePlane = { callsign: "UAL123", lat: 37.62, lng: -122.375, altFt: 2500, vRate: 12, ground: false };
function scheduleSource(data, iata = "SFO", lat = 37.62, lng = -122.375) { return { iata, data, lat, lng }; }
function selectScheduleForTest(sources, plane = schedulePlane) {
  // Replay the same regression against c67a18a's original selector when the new pure helper is absent.
  if (core.selectScheduleMatch) return core.selectScheduleMatch(["UAL123", "UA123"], sources, plane, SCHEDULE_NOW);
  const original = classicScript("./js/render.js");
  for (const source of sources) {
    const match = original.findScheduleMatch(["UAL123", "UA123"], source.data, source.iata);
    if (match) return match;
  }
  return null;
}
function departureRow(to, overrides) {
  return Object.assign({ callsign: "UAL123", to_iata: to, sched_dep: SCHEDULE_SEC - 300, live: true, status: "Departed" }, overrides);
}

test("schedule regression: previous-day JFK row cannot beat the live LAX departure", () => {
  const old = departureRow("JFK", { sched_dep: SCHEDULE_SEC - 86400, actual_arr: SCHEDULE_SEC - 60000, live: false, status: "Landed" });
  const current = departureRow("LAX");
  for (const departures of [[old, current], [current, old]]) {
    assert.equal(selectScheduleForTest([scheduleSource({ departures })]).to, "LAX");
  }
});

test("schedule regression: through-flight climb selects departure, descent selects arrival", () => {
  const data = {
    arrivals: [{ callsign: "UAL123", from_iata: "JFK", est_arr: SCHEDULE_SEC + 60, live: true }],
    departures: [departureRow("LAX", { est_dep: SCHEDULE_SEC - 120 })]
  };
  const sources = [scheduleSource(data)];
  const climbing = selectScheduleForTest(sources);
  assert.equal(climbing.dir, "departure");
  assert.equal(climbing.to, "LAX");
  assert.equal(selectScheduleForTest(sources, { ...schedulePlane, vRate: -12 }).dir, "arrival");
});

test("schedule regression: estimated time and live status outrank stale matching rows", () => {
  const data = { departures: [
    departureRow("JFK", { sched_dep: SCHEDULE_SEC - 1800, live: false, status: "Scheduled" }),
    departureRow("LAX", { sched_dep: SCHEDULE_SEC - 7200, est_dep: SCHEDULE_SEC - 60 })
  ] };
  assert.equal(selectScheduleForTest([scheduleSource(data)]).to, "LAX");
  data.departures[0].est_dep = SCHEDULE_SEC - 60;
  assert.equal(selectScheduleForTest([scheduleSource(data)]).to, "LAX");
});

test("schedule regression: reject ambiguous ties, cancellations and an opposite-direction-only row", () => {
  assert.equal(selectScheduleForTest([scheduleSource({ departures: [departureRow("JFK"), departureRow("LAX")] })]), null);
  assert.equal(selectScheduleForTest([scheduleSource({ departures: [departureRow("JFK", { status: "Cancelled" })] })]), null);
  assert.equal(selectScheduleForTest([scheduleSource({ arrivals: [{ callsign: "UAL123", from_iata: "JFK", est_arr: SCHEDULE_SEC, live: true }] })]), null);
});

test("schedule regression: rank across airports and aliases without depending on cache order", () => {
  const old = scheduleSource({ departures: [departureRow("JFK", { sched_dep: SCHEDULE_SEC - 86400, live: false })] }, "SEA", 47.45, -122.31);
  const live = scheduleSource({ departures: [departureRow("LAX", { callsign: "", flight: "UA 123" })] });
  for (const sources of [[old, live], [live, old]]) assert.equal(selectScheduleForTest(sources).to, "LAX");
});

test("schedule regression: duplicate rows for the same route are harmless, timeless conflicting rows are ambiguous", () => {
  const row = departureRow("LAX");
  assert.equal(selectScheduleForTest([scheduleSource({ departures: [row, { ...row }] })]).to, "LAX");
  assert.equal(selectScheduleForTest([scheduleSource({ departures: [departureRow("LAX", { sched_dep: null }), departureRow("JFK", { sched_dep: null })] })]), null);
});

test("schedule regression: cascade uses the onward leg instead of flipping a through-flight arrival", () => {
  const context = classicScript("./js/render.js", {
    Date: class extends Date { static now() { return SCHEDULE_NOW; } },
    aircraft: [schedulePlane], airportData: [["SFO", 37.62, -122.375, "San Francisco"]],
    routeCache: {}, SCHEDULE_CACHE_TTL: 300000,
    scheduleDataCache: { SFO: { ts: SCHEDULE_NOW, data: {
      arrivals: [{ callsign: "UAL123", from_iata: "JFK", est_arr: SCHEDULE_SEC, live: true }],
      departures: [departureRow("LAX")]
    } } },
    formatClientRouteLabel: (o, d) => o.iata + " to " + d.iata
  });
  assert.equal(context.cascadeScheduleMatches(), 1);
  assert.equal(context.routeCache.UAL123.origin.iata, "SFO");
  assert.equal(context.routeCache.UAL123.destination.iata, "LAX");
  assert.equal(context.routeCache.UAL123.destSource, "schedule");
});

function runwayMemoryForTest() {
  let seen = {};
  let now = 0;
  const original = core.updateActiveRunwayMemory ? null : classicScript("./js/airport-board.js", {
    Date: class extends Date { static now() { return now; } }
  });
  return (derived, nowMs) => {
    now = nowMs;
    if (original) return JSON.parse(JSON.stringify(original.rememberActiveRunways("SFO", derived)));
    const next = core.updateActiveRunwayMemory(seen, derived, nowMs);
    seen = next.seen;
    return next.active;
  };
}

test("runway regression: remember parallel and crossing runways until each individually expires", () => {
  const remember = runwayMemoryForTest();
  const minute = 60000;
  assert.deepEqual(remember({ departing_runways: ["28L"], arriving_runways: ["28R"] }, 0),
    { departing_runways: ["28L"], arriving_runways: ["28R"] });
  const both = remember({ departing_runways: ["1R"], arriving_runways: ["28L"] }, minute);
  assert.deepEqual(both.departing_runways, ["28L", "1R"]);
  assert.deepEqual(both.arriving_runways, ["28R", "28L"]);
  remember({ departing_runways: ["28L"], arriving_runways: [] }, 10 * minute);
  assert.deepEqual(remember(null, 16 * minute), { departing_runways: ["28L", "1R"], arriving_runways: ["28L"] });
  assert.deepEqual(remember(null, 16 * minute + 1), { departing_runways: ["28L"], arriving_runways: [] });
  assert.equal(remember(null, 25 * minute + 1), null);
});

test("runway regression: memory is pure, airport-scoped and D-ATIS keeps precedence", () => {
  const context = classicScript("./js/airport-board.js", { Date: class extends Date { static now() { return 1000; } } });
  context.rememberActiveRunways("SFO", { departing_runways: ["28L"], arriving_runways: ["28R"] });
  const sfo = context.rememberActiveRunways("SFO", { departing_runways: ["1R"], arriving_runways: ["28L"] });
  assert.equal(context.rememberActiveRunways("LAX", null), null);
  const overridden = context.mergeActiveRunways({ departing_runways: ["10R"], arriving_runways: [] }, sfo);
  assert.deepEqual(Array.from(overridden.departing_runways), ["10R"]);
  assert.deepEqual(Array.from(overridden.arriving_runways), ["28R", "28L"]);
  if (core.updateActiveRunwayMemory) {
    const memory = { departing_runways: { "28L": 0 }, arriving_runways: {} };
    const before = JSON.stringify(memory);
    core.updateActiveRunwayMemory(memory, { departing_runways: ["1R"] }, 1000);
    assert.equal(JSON.stringify(memory), before);
  }
});

function onFinalAircraft(designator, overrides) {
  const end = core.matchRunwayDesignator(SFO_RUNWAYS, "SFO", designator);
  const track = core.bearingDegrees(end.thresholdLat, end.thresholdLon, end.farEndLat, end.farEndLon);
  const pos = core.projectLatLng(end.thresholdLat, end.thresholdLon, (track + 180) % 360, 6000);
  return { lat: pos[0], lng: pos[1], track, altFt: 1000, vRate: -8, ground: false, ...overrides };
}

test("runway regression: on-final arrivals count before entering the runway box, including shallow descent", () => {
  for (const vRate of [-8, -1, 0]) {
    const result = core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [onFinalAircraft("28L", { vRate })]);
    assert.deepEqual(result && result.arriving_runways, ["28L"], String(vRate));
    assert.deepEqual(result.departing_runways, []);
  }
});

test("runway regression: final-approach inference excludes climbing, high, ground and wrong-heading traffic", () => {
  const base = onFinalAircraft("28L");
  for (const overrides of [{ vRate: 12 }, { altFt: 30000 }, { ground: true }, { track: (base.track + 90) % 360 }]) {
    assert.equal(core.deriveActiveRunways(SFO_RUNWAYS, "SFO", [{ ...base, ...overrides }]), null);
  }
});

function persistenceContext(value) {
  return classicScript("./js/features.js", {
    LS_VIEW: "view", LS_PLACES: "places",
    window: { localStorage: { getItem: () => JSON.stringify(value) } }
  });
}

test("saved coordinates regression: last view rejects null, strings, booleans and out-of-range coordinates", () => {
  for (const value of [null, "0", false, 91, -91, Infinity]) {
    assert.equal(persistenceContext({ lat: value, lng: 0 }).loadLastView(), null, "lat: " + value);
  }
  for (const value of [null, "0", false, -Infinity]) {
    assert.equal(persistenceContext({ lat: 0, lng: value }).loadLastView(), null, "lng: " + value);
  }
  for (const [lng, expected] of [[181, -179], [-181, 179], [541, -179], [-541, 179]]) {
    assert.equal(persistenceContext({ lat: 0, lng }).loadLastView()?.lng, expected, "lng: " + lng);
  }
});

test("saved coordinates regression: saved places filter corrupt coordinates", () => {
  const saved = [{ name: "Zero", lat: 0, lng: 0 }, { lat: null, lng: 0 }, { lat: 0, lng: null },
    { lat: "37", lng: -122 }, { lat: false, lng: 0 }, { lat: 90.01, lng: 0 }, null];
  assert.deepEqual(JSON.parse(JSON.stringify(persistenceContext(saved).loadPlaces())), [saved[0]]);
});

test("saved coordinates regression: valid zero and boundary coordinates survive", () => {
  for (const value of [{ lat: 0, lng: 0, zoom: 8 }, { lat: 90, lng: -180 }, { lat: -90, lng: 180 }]) {
    const expected = { ...value, lng: value.lng === 180 ? -180 : value.lng };
    assert.deepEqual(JSON.parse(JSON.stringify(persistenceContext(value).loadLastView())), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(persistenceContext([value]).loadPlaces())), [expected]);
  }
});

test("flight-start regression: new-leg origin updates even when live history already covers the trace", () => {
  const context = originDetectionContext({ origin: { iata: "SFO" }, originSource: "track", destination: { iata: "JFK" }, destSource: "adsbdb" });
  context.posHistory.abc123 = [[33.943, -118.408, 7200000, null, true]];
  context.ingestTrackPath("abc123", { path: sfoLaxGapGroundPath() });
  assert.equal(context.routeCache.AAL2.origin.iata, "LAX");
  assert.equal(context.posHistory.abc123.length, 1);
});

test("flight-start regression: a short arrival-only trace cannot replace an established origin", () => {
  const context = originDetectionContext({ origin: { iata: "SFO" }, originSource: "track" });
  context.runOriginDetection("abc123", { path: Array.from({ length: 6 }, (_, i) => [1000 + i * 60, 33.943, -118.408, 800, 0, false]) });
  assert.equal(context.routeCache.AAL2.origin.iata, "SFO");
});

test("airline data: the inlined browser core and Node expose the same data and classifications", async () => {
  const { buildBundle } = await import("./scripts/build-bundle.mjs");
  const bundle = await buildBundle();
  const context = vm.createContext({});
  vm.runInContext(bundle.slice(0, bundle.indexOf(";// ---- js/app-core.js")), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ContrailsCore.AIRLINES)), core.AIRLINES);
  assert.deepEqual(JSON.parse(JSON.stringify(context.ContrailsCore.AIRLINE_IATA_ALIASES)), core.AIRLINE_IATA_ALIASES);
  for (const original of airlineFixture.cases) {
    const row = Object.assign({}, original, original.regionalFix);
    assert.equal(context.ContrailsCore.isLikelyPrivateCallsign(row.callsign), row.core[1], String(row.callsign));
  }
});

function hotPathRenderContext() {
  const uploads = [], diffs = [], frames = [];
  let boundsReads = 0;
  const source = { setData: data => uploads.push(data), updateData: diff => diffs.push(diff) };
  const context = classicScript("./js/render.js", {
    mapReady: true, map: { getSource: () => source, getZoom: () => 10, setLayoutProperty() {},
      getBounds() { boundsReads++; return { getNorth: () => 2, getSouth: () => -2, getEast: () => 2, getWest: () => -2 }; } },
    aircraft: [], markerMap: {}, extraState: {}, posHistory: {}, selectedAircraftId: null, planePopupHex: null,
    filters: { ground: true, private: true, trails: true, labels: true }, VIEW_FILTER_PAD: 0.1,
    GROUND_PLANES_MIN_ZOOM: 10, EMPTY_COLLECTION: { type: "FeatureCollection", features: [] },
    currentDisplayTime: now => now, updateRouteLine() {}, applyFollow() {},
    markerAnimationFrame: 0, markerAnimationTimer: 0, MARKER_TARGET_INTERVAL_MS: 0, TRAIL_FRAME_MS: 67,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {},
    setTimeout: fn => { frames.push(fn); return frames.length; }, clearTimeout() {},
    getDisplayPoseForAircraft: () => ({ lat: 0, lng: 0, ts: 1000 }),
    getDisplayPoseForSamples: () => ({ lat: 0, lng: 0, ts: 1000 }),
    planeStyle: () => ({ icon: "plane", size: 1, color: "red", radiusPx: 5 })
  });
  for (const file of ["./js/features.js", "./js/map.js"]) {
    vm.runInContext(fs.readFileSync(require.resolve(file), "utf8"), context);
  }
  context.currentViewPolicy = () => ({ showLabels: true });
  context.updateRouteLine = () => {};
  return { context, uploads, diffs, frames, boundsReads: () => boundsReads };
}

// Independent review regressions: each fails against a5ec8a1.
const privateReviewFlights = [
  ["CAP1234", "C182"], ["SAM44", "GLF5"], ["PAT652", "C560"], ["GAF681", "GL6T"],
  ["IAM3150", "F900"], ["CFC3012", "CL60"], ["RRR1234", "BE20"], ["XOJ123", "CL35"],
  ["XSR456", "E55P"], ["JTL12", "C68A"], ["AHO123", "C56X"], ["TWY12", "GLF4"], ["RPC1234", "C172"]
];
test("review 1: government, CAP and charter aircraft retain the c67a18a private classification", () => {
  const isPrivate = frontendPrivateClassifier();
  for (const [callsign, type] of privateReviewFlights) {
    assert.equal(isPrivate(callsign, type, null), true, callsign + "/" + type);
    assert.equal(core.isAirlineCallsign(callsign), false, callsign);
  }
});

const reviewRunways = require("./runways.json");
for (const [iata, designators] of [["LAX", ["24R", "25L", "24L"]], ["ATL", ["26R"]]]) {
  test("review 2: " + iata + " finals use the closest centerline on staggered parallels", () => {
    for (const designator of designators) {
      const end = core.matchRunwayDesignator(reviewRunways[iata], iata, designator);
      const track = core.bearingDegrees(end.thresholdLat, end.thresholdLon, end.farEndLat, end.farEndLon);
      for (const km of [2, 4, 6, 8]) {
        const [lat, lng] = core.projectLatLng(end.thresholdLat, end.thresholdLon, (track + 180) % 360, km * 1000);
        const result = core.deriveActiveRunways(reviewRunways[iata], iata, [{ lat, lng, track, altFt: 1000, vRate: -8, ground: false }]);
        assert.deepEqual(result && result.arriving_runways, [designator], designator + " at " + km + " km");
      }
    }
  });
}

test("review 3: SFO 28L to 10R flow reversal immediately keeps the takeoff roll Departing", () => {
  const context = classicScript("./js/airport-board.js", {
    runwayData: reviewRunways, airportData: [["SFO", 37.62, -122.375]], routeCache: {},
    posHistory: {}, extraState: {}, DEPARTURE_PERIMETER_KM: 15, AIRPORT_POPUP_FETCH_KM: 100
  });
  context.rememberActiveRunways("SFO", { departing_runways: ["28L"], arriving_runways: [] });
  context.rememberActiveRunways("SFO", { departing_runways: ["10R"], arriving_runways: [] });
  const plane = onRunwayAircraft("10R", { ground: true, altFt: null, speedKts: 70, callsign: "UAL123", icao24: "abc123" });
  const board = context.buildLiveScheduleData("SFO", 37.62, -122.375, [plane]);
  assert.equal(board.departures[0]?.status, "Departing");
  assert.deepEqual(Array.from(context.rememberActiveRunways("SFO", null).departing_runways), ["10R"]);
});

test("review 3: runway memory removes reciprocals and normalizes leading zeroes in both directions", () => {
  for (const key of ["departing_runways", "arriving_runways"]) {
    for (const [old, observed] of [["28L", "10R"], ["10R", "28L"], ["01L", "19R"], ["19C", "01C"], ["18", "36"]]) {
      const next = core.updateActiveRunwayMemory({ [key]: { [old]: 0 } }, { [key]: [observed] }, 1000);
      assert.deepEqual(next.active[key], [observed.replace(/^0+/, "")], old + " -> " + observed);
    }
    const next = core.updateActiveRunwayMemory({ [key]: { "01L": 100, "1L": 200 } }, { [key]: ["01L"] }, 1000);
    assert.deepEqual(next.active[key], ["1L"]);
    assert.deepEqual(next.seen[key], { "1L": 1000 });
  }
  const onRunway = core.deriveActiveRunways(reviewRunways.SFO, "SFO", [onRunwayAircraft("1L", { vRate: 12 })]);
  assert.deepEqual(onRunway.departing_runways, ["1L"]);
  assert.deepEqual(core.parseDatisActiveRunways("DEPARTING RWY 01L. LANDING RWY 01L."),
    { departing_runways: ["1L"], arriving_runways: ["1L"] });
});

test("review 4: old world-copy views and places normalize and survive saving and deletion", () => {
  const storage = { places: JSON.stringify([{ name: "East", lat: 1, lng: 181 }, { name: "West", lat: 2, lng: -541 }]) };
  let scheduled, wraps = 0;
  const context = classicScript("./js/features.js", {
    LS_VIEW: "view", LS_PLACES: "places", _saveViewTimer: 0,
    setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() {},
    map: { getCenter: () => ({ lat: 3, lng: 541, wrap() { wraps++; return { lat: 3, lng: -179 }; } }) },
    window: { prompt: () => "New", localStorage: { getItem: key => storage[key], setItem: (key, value) => { storage[key] = value; } } },
    document: { addEventListener() {}, getElementById: () => null },
    viewZoom: () => 8, findNearestRegion: () => null, setControlsFeedback() {}
  });
  context.scheduleSaveLastView();
  scheduled();
  assert.equal(JSON.parse(storage.view).lng, -179);
  assert.equal(context.loadLastView().lng, -179);
  context.saveCurrentPlace();
  assert.equal(wraps, 2, "both writers wrap MapLibre centers");
  assert.deepEqual(JSON.parse(storage.places).map(p => p.lng), [-179, 179, -179]);
  context.deletePlace(2);
  assert.deepEqual(JSON.parse(storage.places).map(p => p.name), ["East", "West"]);
  assert.deepEqual(Array.from(context.loadPlaces(), p => p.lng), [-179, 179]);
});

test("review 5: grounded SWA1234 at MDW keeps BWI arrival over DEN departure in 45 minutes", () => {
  const plane = { callsign: "SWA1234", lat: 41.7868, lng: -87.7522, ground: true, altFt: null, vRate: 0 };
  const arrival = { callsign: "SWA1234", from_iata: "BWI", status: "Landed", actual_arr: SCHEDULE_SEC - 300 };
  const departure = { callsign: "SWA1234", to_iata: "DEN", status: "Scheduled", sched_dep: SCHEDULE_SEC + 45 * 60 };
  function select(arrivals, aircraft = plane) {
    return core.selectScheduleMatch(["SWA1234", "WN1234"],
      [scheduleSource({ arrivals, departures: [departure] }, "MDW", plane.lat, plane.lng)], aircraft, SCHEDULE_NOW);
  }
  const match = select([arrival]);
  assert.equal(match?.dir, "arrival");
  assert.equal(match.from, "BWI");
  const context = classicScript("./js/render.js", { routeCache: {}, formatClientRouteLabel: (o, d) => o.iata + " to " + d.iata });
  context.applyScheduleMatch(plane, match);
  assert.equal(context.routeCache.SWA1234.iata, "BWI to MDW");
  assert.equal(context.routeCache.SWA1234.destSource, "schedule");
  // Actual arrival, not row order or an older schedule, orders recent landed instances.
  assert.equal(select([{ ...arrival, from_iata: "ORD", actual_arr: SCHEDULE_SEC - 3600 }, arrival]).from, "BWI");
  // Between legs the nearer event wins: landed 30 min ago vs departing in 45 -> arrival; 89 min ago -> departure.
  assert.equal(select([{ ...arrival, actual_arr: SCHEDULE_SEC - 30 * 60 }]).dir, "arrival");
  assert.equal(select([{ ...arrival, actual_arr: SCHEDULE_SEC - 89 * 60 }]).dir, "departure");
  for (const overrides of [{ actual_arr: SCHEDULE_SEC - 91 * 60 }, { actual_arr: null }, { status: "Cancelled" }]) {
    assert.equal(select([{ ...arrival, ...overrides }]).dir, "departure");
  }
  assert.equal(select([arrival], { ...plane, ground: false }).dir, "departure");
});

test("re-check N2: FR24 search falls back to the ICAO callsign when the IATA query has no live match", async () => {
  const queries = [];
  const live = { type: "live", id: "x", detail: { callsign: "ENY3456", flight: "AA3456", schd_from: "DFW", schd_to: "AUS" } };
  const context = classicScript("./js/render.js", {
    WORKER_URL: "https://w", routeCache: {}, AIRLINE_ICAO_TO_IATA: { ENY: "MQ" },
    callsignVariants: () => ["ENY3456", "MQ3456"], refreshPlanePopup() {},
    formatClientRouteLabel: (o, d) => o.iata + " to " + d.iata,
    fetch: async (url) => { queries.push(decodeURIComponent(url.split("/").pop()));
      return { ok: true, json: async () => ({ results: url.endsWith("ENY3456") ? [live] : [] }) }; },
  });
  await context.tryFr24Search({ callsign: "ENY3456", icao24: "a1b2c3", private: false, ground: false, altFt: 30000, vRate: 0 });
  assert.deepEqual(queries, ["MQ3456", "ENY3456"]);
  assert.equal(context.routeCache.ENY3456.iata, "DFW to AUS");
  // A hit on the first (IATA) query makes no second request.
  queries.length = 0; context.routeCache = {};
  const hit = { ...live, detail: { ...live.detail, callsign: "MQ3456" } };
  context.fetch = async (url) => { queries.push(url); return { ok: true, json: async () => ({ results: [hit] }) }; };
  await context.tryFr24Search({ callsign: "ENY3456", icao24: "a1b2c3", private: false, ground: false, altFt: 30000, vRate: 0 });
  assert.equal(queries.length, 1);
});

test("re-check N1: a grounded through-flight taxiing out gets its departure, not the previous leg", () => {
  const plane = { callsign: "SWA1234", lat: 41.7868, lng: -87.7522, ground: true, altFt: null, vRate: 0 };
  const sources = (arrivals, departures) => [scheduleSource({ arrivals, departures }, "MDW", plane.lat, plane.lng)];
  const select = (arrivals, departures, aircraft = plane) =>
    core.selectScheduleMatch(["SWA1234", "WN1234"], sources(arrivals, departures), aircraft, SCHEDULE_NOW);
  const landed = (minsAgo) => ({ callsign: "SWA1234", from_iata: "BWI", status: "Landed", actual_arr: SCHEDULE_SEC - minsAgo * 60 });
  const dep = (extra) => ({ callsign: "SWA1234", to_iata: "DEN", status: "Scheduled", sched_dep: SCHEDULE_SEC + 5 * 60, ...extra });
  // Landed 40 min ago, departing in 5: taxi-out.
  assert.equal(select([landed(40)], [dep()]).to, "DEN");
  // Already pushed / rolling (actual_dep set, departed status) beats a 50-min-old arrival.
  assert.equal(select([landed(50)], [dep({ status: "Departed", actual_dep: SCHEDULE_SEC - 60 })]).to, "DEN");
  // Just landed (5 min ago), next departure in 40: taxi-in keeps the arrival.
  assert.equal(select([landed(5)], [dep({ sched_dep: SCHEDULE_SEC + 40 * 60 })]).from, "BWI");
  // A landed row at another airport's schedule is not this plane's recent arrival.
  const far = core.selectScheduleMatch(["SWA1234", "WN1234"],
    [scheduleSource({ arrivals: [landed(10)], departures: [] }, "LAX", 33.9425, -118.4081)], plane, SCHEDULE_NOW);
  assert.equal(far, null);
});

test("review 6: a gate gap clears the prior destination when it becomes the new SFO origin", () => {
  const context = originDetectionContext({ origin: { iata: "LAX" }, originSource: "track", destination: { iata: "SFO" }, destSource: "schedule" });
  const path = [[1000, 33.943, -118.408, 0, 0, true], [1060, 34, -118.4, 1000, 0, false],
    [4000, 37.62, -122.375, 0, 0, true], [7000, 37.62, -122.375, 0, 0, true], [7030, 37.62, -122.375, 0, 0, true]];
  context.runOriginDetection("abc123", { path });
  const route = context.routeCache.AAL2;
  assert.equal(route.origin.iata, "SFO");
  assert.equal(route.destination, null);
  assert.equal(route.destSource, null);
  assert.equal(route.iata, "SFO");
  assert.notEqual(route.display, "SFO to SFO");
});

test("review 7: the same SFO to LAX leg from both endpoint schedules is not ambiguous", () => {
  const sources = [scheduleSource({ departures: [departureRow("LAX")] }),
    scheduleSource({ arrivals: [{ callsign: "UAL123", from_iata: "SFO", est_arr: SCHEDULE_SEC + 300, live: true }] }, "LAX", 33.943, -118.408)];
  for (const order of [sources, sources.slice().reverse()]) {
    const match = selectScheduleForTest(order, { ...schedulePlane, altFt: 30000, vRate: 0 });
    assert.ok(match);
    assert.deepEqual(match.dir === "arrival" ? [match.from, match.airport] : [match.airport, match.to], ["SFO", "LAX"]);
  }
});

test("review 10: the standalone browser core loads with empty airline tables when AIRLINES_DATA is absent", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve("./contrails-core.js"), "utf8"), context);
  const standalone = context.ContrailsCore;
  assert.equal(standalone.airlineName("UAL123"), null);
  assert.equal(standalone.isAirlineCallsign("UAL123"), false);
  assert.equal(standalone.isLikelyPrivateCallsign("UAL123"), false, "empty registration table must not match every callsign");
  assert.equal(standalone.isPrivateAircraft("CAP1234", "C182", null), true);
  assert.deepEqual(Array.from(standalone.callsignVariants("UAL123")), ["UAL123"]);
});

test("hot path: render filtering reads bounds once per pass and keeps selected ground planes", () => {
  const { context: c, uploads, boundsReads } = hotPathRenderContext();
  c.map.getZoom = () => 7;
  c.selectedAircraftId = "000000";
  c.aircraft = Array.from({ length: 100 }, (_, i) => ({ icao24: i.toString(16).padStart(6, "0"),
    lat: i < 90 ? 0 : 10, lng: 0, ground: i < 2 }));
  c.buildDisplayTrailSegments = () => [{ latlngs: [[0, 0], [1, 1]], color: "red", opacity: 0.5, weight: 2.5 }];
  c.renderTrails(1000);
  assert.equal(uploads[0].features.length, 89);
  assert.equal(boundsReads(), 1);
  c.renderMarkers(1000);
  assert.equal(Object.keys(c.markerMap).length, 89);
  assert.equal(boundsReads(), 2);
});

test("hot path: plane diffs send only changed geometry and properties, including removal and re-add", () => {
  const { context: c, uploads, diffs } = hotPathRenderContext();
  c.markerMap = { abc123: { lat: 1, lng: 2, props: { hex: "abc123", label: "A", selected: false } },
    def456: { lat: 3, lng: 4, props: { hex: "def456", label: "B", selected: false } } };
  c.pushPlaneLayer();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].features.length, 2);
  assert.equal(uploads[0].features[0].id, "abc123");
  c.pushPlaneLayer();
  assert.equal(uploads.length, 1);
  assert.equal(diffs.length, 0);
  c.markerMap.abc123.lat = 1.25;
  c.markerMap.abc123.props = { ...c.markerMap.abc123.props, selected: true };
  c.pushPlaneLayer();
  assert.deepEqual(JSON.parse(JSON.stringify(diffs[0].update)), [{ id: "abc123",
    newGeometry: { type: "Point", coordinates: [2, 1.25] }, addOrUpdateProperties: [{ key: "selected", value: true }] }, { id: "def456" }]);
  delete c.markerMap.def456;
  c.pushPlaneLayer();
  assert.deepEqual(Array.from(uploads[1].features, f => f.id), ["abc123"]);
  c.markerMap.def456 = { lat: 5, lng: 6, props: { hex: "def456", label: "C" } };
  c.pushPlaneLayer();
  assert.equal(uploads[2].features[1].properties.label, "C");
});

test("hot path: held trails reuse geometry but moving time, history, selection and zoom keep exact styles", () => {
  const { context: c, uploads } = hotPathRenderContext();
  c.FETCH_TIMEOUT_MS = 20000;
  vm.runInContext(fs.readFileSync(require.resolve("./js/data.js"), "utf8"), c);
  c.currentDisplayTime = now => now;
  c.altColor = alt => "alt-" + alt;
  c.GROUND_COLOR = "gray";
  const a = { icao24: "abc123", lat: 0, lng: 0, ground: false };
  c.aircraft = [a];
  c.posHistory.abc123 = [[0, 0, 1000, 1000, false], [0.1, 0.1, 2000, 2000, false], [0.2, 0.2, 3000, 3000, false]];
  let pose = { lat: 0.15, lng: 0.15, ts: 2500 };
  const build = c.buildDisplayTrailSegments;
  let builds = 0;
  c.buildDisplayTrailSegments = (...args) => { builds++; return build(...args); };
  const draw = () => c.renderTrails(10000, { abc123: pose });
  draw(); draw();
  assert.equal(builds, 1);
  assert.equal(uploads.length, 1);
  const verify = () => {
    draw();
    const expected = build(c.posHistory.abc123, a, pose, 10000).map(seg => ({ type: "Feature",
      properties: { color: seg.color, opacity: seg.opacity, width: seg.weight },
      geometry: { type: "LineString", coordinates: seg.latlngs.map(p => [p[1], p[0]]) } }));
    assert.deepEqual(JSON.parse(JSON.stringify(uploads.at(-1).features)), JSON.parse(JSON.stringify(expected)));
  };
  pose = { ...pose, ts: 2750 }; verify();
  c.posHistory.abc123.push([0.3, 0.3, 4000, 4000, false]); verify();
  c.selectedAircraftId = a.icao24; verify();
  c.map.getZoom = () => 11; verify();
  assert.equal(builds, 5);
  c.aircraft = []; draw(); draw();
  assert.equal(uploads.at(-1).features.length, 0);
  assert.equal(uploads.length, 6);
});

test("hot path: airport grid preserves nearby candidates at cell edges, poles and dateline", () => {
  const airports = JSON.parse(fs.readFileSync(require.resolve("./airports.json"), "utf8"));
  airports.push(["EAST", 0, 179.95], ["WEST", 0, -179.95], ["POLE", 89.9, 130]);
  const grid = core.buildAirportGrid(airports);
  for (const [lat, lng] of [[51.4776, -0.38], [0, 180], [0, -180], [89.9, -40], [-89.9, 40], [40, -74]]) {
    for (const km of [30, 80]) {
      const expected = airports.filter(ap => core.haversineKm(lat, lng, ap[1], ap[2]) < km);
      const nearby = core.airportGridCandidates(grid, lat, lng, km);
      assert.deepEqual(nearby.filter(ap => core.haversineKm(lat, lng, ap[1], ap[2]) < km), expected);
      assert.ok(nearby.length < airports.length / 4);
    }
  }
});

test("hot path: convergence tests nearby airport cells instead of the full catalog", () => {
  let distances = 0;
  const c = classicScript("./js/data.js", {
    FETCH_TIMEOUT_MS: 20000, airportData: [["LHR", 51.4776, -0.38, "Heathrow"],
      ...Array.from({ length: 1000 }, (_, i) => ["FAR" + i, -40, i / 10, "Far"])],
    aircraft: [{ icao24: "abc123", callsign: "BAW1", lat: 51.48, lng: -0.38, altFt: 2000, vRate: 10 }],
    routeCache: {}, haversineKm: (...args) => { distances++; return core.haversineKm(...args); },
    formatClientRouteLabel: origin => origin.iata
  });
  c.clientConvergenceRefine();
  assert.equal(c.routeCache.BAW1.origin.iata, "LHR");
  assert.ok(distances < 10, "distance checks: " + distances);
});

test("hot path: schedule cascade indexes flight aliases once per fetched snapshot", () => {
  let reads = 0;
  const data = { departures: Array.from({ length: 1000 }, (_, i) => ({
    get flight() { reads++; return "UA" + (i + 1); }, to_iata: "LAX", sched_dep: SCHEDULE_SEC, live: true
  })) };
  const c = classicScript("./js/render.js", {
    Date: class extends Date { static now() { return SCHEDULE_NOW; } },
    airportData: [["SFO", 37.62, -122.375, "San Francisco"]],
    aircraft: Array.from({ length: 20 }, (_, i) => ({ ...schedulePlane, callsign: "UAL" + (i + 1) })),
    routeCache: {}, SCHEDULE_CACHE_TTL: 300000, scheduleDataCache: { SFO: { ts: SCHEDULE_NOW, data } },
    formatClientRouteLabel: (o, d) => o.iata + " to " + d.iata
  });
  assert.equal(c.cascadeScheduleMatches(), 20);
  assert.equal(c.routeCache.UAL20.destination.iata, "LAX");
  c.routeCache = {};
  const firstReads = reads;
  assert.equal(c.cascadeScheduleMatches(), 20);
  assert.ok(firstReads <= 1100, "first snapshot reads: " + firstReads);
  assert.ok(reads - firstReads < 100, "cached snapshot must not scan rows");
  c.scheduleDataCache.SFO = { ts: SCHEDULE_NOW, data: { departures: [departureRow("JFK", { callsign: "UAL1" })] } };
  c.routeCache = {};
  assert.equal(c.cascadeScheduleMatches(), 1);
  assert.equal(c.routeCache.UAL1.destination.iata, "JFK");
});

test("hot path: empty animation stops without uploading and restarts when markers arrive", () => {
  const { context: c, uploads, frames } = hotPathRenderContext();
  c.animateMarkers();
  c.renderTrails(1000);
  assert.equal(frames.length, 0);
  assert.equal(uploads.length, 0);
  c.aircraft = [{ icao24: "abc123", lat: 0, lng: 0, reportTs: 1000 }];
  c.renderMarkers(1000);
  assert.equal(frames.length, 1);
});

test("hot path: coverage checks circle unions, holes, dateline and high latitudes", () => {
  const covers = core.trafficCirclesCoverBounds;
  assert.equal(covers([{ lat: 0, lng: -0.8, km: 110 }, { lat: 0, lng: 0.8, km: 110 }], core.viewBounds(0.2, -0.2, 1.5, -1.5)), true);
  const corners = [-1, 1].flatMap(lat => [-1, 1].map(lng => ({ lat, lng, km: 40 })));
  assert.equal(covers(corners, core.viewBounds(1, -1, 1, -1)), false);
  assert.equal(covers([{ lat: 0, lng: -179.9, km: 100 }], core.viewBounds(0.1, -0.1, 180.2, 179.8)), true);
  assert.equal(covers([{ lat: 89, lng: 0, km: 160 }], core.viewBounds(89.2, 88.8, 45, -45)), true);
});

test("hot path: covered viewport requests survive pans while uncovered views and resume replace them", async () => {
  const pending = [];
  let spec = { center: { lat: 0, lng: 0 }, bounds: core.viewBounds(0.05, -0.05, 0.05, -0.05), visibleKm: 8, fetchKm: 50 };
  const c = classicScript("./js/data.js", {
    FETCH_TIMEOUT_MS: 20000, map: {}, AbortController, setTimeout: () => 1, clearTimeout() {},
    clearMapFetchTimer() {}, clearRefreshTimer() {}, syncUrlState() {}, scheduleRefreshTimer() {}, adaptiveRefreshMs: () => 5000,
    fetchAbortController: null, activeFetchUrl: null, activeFetchStartedAt: 0, fetchRequestSeq: 0,
    trafficFailStreak: 0, currentViewportFetchSpec: () => spec, VIEW_FILTER_PAD: 0.1
  });
  c.viewCoverage = () => null;
  c.trafficUrl = (lat, lng, km) => [lat, lng, km].join("/");
  c.fetchTrafficCircles = (circles, signal) => new Promise(resolve => pending.push({ signal, resolve }));
  c.processAircraft = () => {};
  c.trafficSource = null;
  c.setTrafficStale = c.updateControlsCompactSummary = c.updateViewHint = () => {};
  c.visibleAircraftCount = () => 0;
  const first = c.fetchAircraft();
  spec = { ...spec, center: { lat: 0, lng: 0.1 }, bounds: core.viewBounds(0.05, -0.05, 0.15, 0.05) };
  const covered = c.fetchAircraft({ source: "viewport" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal.aborted, false);
  await covered;
  spec = { ...spec, center: { lat: 0, lng: 2 }, bounds: core.viewBounds(0.05, -0.05, 2.05, 1.95) };
  const moved = c.fetchAircraft({ source: "viewport" });
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending.length, 2);
  const resumed = c.fetchAircraft({ source: "resume" });
  assert.equal(pending[1].signal.aborted, true);
  pending[2].resolve({ ac: [] });
  await Promise.all([first, moved, resumed]);
  assert.equal(c.fetchAbortController, null);
});
