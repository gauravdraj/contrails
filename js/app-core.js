// Core helpers, constants, shared state, environment detection, and Worker URLs.

const core = globalThis.ContrailsCore || {};
const airlineName = core.airlineName;
const angleDiffDeg = core.angleDiffDeg;
const bearingDegrees = core.bearingDegrees;
const buildViewPolicy = core.buildViewPolicy;
const buildViewportFetchSpec = core.buildViewportFetchSpec;
const cardinalDir = core.cardinalDir;
const computePlaybackDelayMs = core.computePlaybackDelayMs;
const callsignVariants = core.callsignVariants;
const escapeHtml = core.escapeHtml;
const formatDistanceMiles = core.formatDistanceMiles;
const formatSpeedMph = core.formatSpeedMph;
const getAirportNextRow = core.getAirportNextRow;
const haversineKm = core.haversineKm;
const interpolatePlaybackPose = core.interpolatePlaybackPose;
const interpolateTimedPose = core.interpolateTimedPose;
const isLikelyPrivateCallsign = core.isLikelyPrivateCallsign;
const normalizeAircraftHex = core.normalizeAircraftHex;
const normalizeFlightQuery = core.normalizeFlightQuery;
const normalizeSearchText = core.normalizeSearchText;
const parseCoordinate = core.parseCoordinate;
const parseDatisActiveRunways = core.parseDatisActiveRunways;
const projectLatLng = core.projectLatLng;
const roundTenths = core.roundTenths;
const scoreArrivalCandidate = core.scoreArrivalCandidate;
const sortAirportInboundRows = core.sortAirportInboundRows;
const sortAirportLandedRows = core.sortAirportLandedRows;
const buildCoverageCircles = core.buildCoverageCircles;
const countGroundByAirport = core.countGroundByAirport;
const sortAirportDepartureRows = core.sortAirportDepartureRows;
const describeAirportDepartureStatus = core.describeAirportDepartureStatus;
const classifyGroundDepartureStatus = core.classifyGroundDepartureStatus;
const landedRecently = core.landedRecently;
const closingKm = core.closingKm;
const slantKm = core.slantKm;
const elevationDeg = core.elevationDeg;
const sizeFromCategory = core.sizeFromCategory;
const sizeClass = core.sizeClass;
const isLikelyPrivateClass = core.isLikelyPrivateClass;
const dimColor = core.dimColor;
const findFlightStartIndex = core.findFlightStartIndex;
const matchRunwayDesignator = core.matchRunwayDesignator;
const deriveActiveRunways = core.deriveActiveRunways;
const greatCirclePoints = core.greatCirclePoints;
const pointOnRunway = core.pointOnRunway;
const SQUAWK_ALERT = core.SQUAWK_ALERTS;
const AIRLINE_ICAO_TO_IATA = core.AIRLINE_ICAO_TO_IATA;
const declutterLabels = core.declutterLabels;
const updateClockOffset = core.updateClockOffset;
const viewBounds = core.viewBounds;
const alphaToSdf = core.alphaToSdf;
if (!airlineName || !angleDiffDeg || !bearingDegrees || !buildViewPolicy || !buildViewportFetchSpec || !cardinalDir ||
    !callsignVariants || !computePlaybackDelayMs || !escapeHtml || !formatDistanceMiles || !formatSpeedMph ||
    !getAirportNextRow || !haversineKm || !interpolatePlaybackPose || !interpolateTimedPose || !isLikelyPrivateCallsign ||
    !normalizeAircraftHex || !normalizeFlightQuery || !normalizeSearchText || !parseCoordinate || !parseDatisActiveRunways || !projectLatLng ||
    !scoreArrivalCandidate || !sortAirportInboundRows || !sortAirportLandedRows || !sortAirportDepartureRows || !describeAirportDepartureStatus ||
    !classifyGroundDepartureStatus || !landedRecently || !closingKm ||
    !findFlightStartIndex || !matchRunwayDesignator || !deriveActiveRunways || !greatCirclePoints || !pointOnRunway ||
    !roundTenths || !slantKm || !elevationDeg || !SQUAWK_ALERT ||
    !sizeFromCategory || !sizeClass || !isLikelyPrivateClass || !dimColor || !declutterLabels || !updateClockOffset ||
    !viewBounds || !alphaToSdf || !buildCoverageCircles || !countGroundByAirport) {
  throw new Error("Contrails core helpers failed to load.");
}

const APP_VERSION = "2.42";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const isIOSDevice = /iP(ad|hone|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOSDevice && /WebKit/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|EdgiOS/i.test(navigator.userAgent);
const isStandaloneWebApp = window.navigator.standalone === true ||
  (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
const isDesktopFinePointer = !isIOSDevice &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(hover: hover) and (pointer: fine)").matches;
// Local dev runs the real Worker under Node (scripts/dev-server.mjs).
const WORKER_URL = isLocal ? location.protocol + "//" + location.hostname + ":8791" : "https://contrails-api.therealgraj.workers.dev";
document.getElementById("version-badge").textContent = APP_VERSION;
document.getElementById("app-touch-icon").setAttribute("href", "apple-touch-icon.png?v=" + APP_VERSION);
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", function() {
    navigator.serviceWorker.register("sw.js").catch(function() {});
  });
}
function syncLoadingViewportState() {
  var loading = document.getElementById("loading");
  if (!loading) return;
  var keyboardOffset = 0;
  if (window.visualViewport) {
    keyboardOffset = Math.max(0, Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop));
    if (keyboardOffset < 120) keyboardOffset = 0;
  }
  loading.classList.toggle("keyboard-open", keyboardOffset > 0);
  loading.style.setProperty("--loading-keyboard-offset", keyboardOffset ? keyboardOffset + "px" : "0px");
}
function nudgeLoadingFieldIntoView(input) {
  if (!input || !isIOSDevice) return;
  setTimeout(function() {
    try {
      input.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (err) {}
  }, 240);
}
// iOS Safari only collapses the toolbar when the page itself can scroll.
function nudgeSafariToolbarCollapse() {
  if (!isIOSSafari || isStandaloneWebApp) return;
  var scrollingEl = document.scrollingElement || document.documentElement || document.body;
  if (!scrollingEl) return;
  var maxScroll = Math.max(0, scrollingEl.scrollHeight - window.innerHeight);
  if (maxScroll < 1 || window.scrollY > 1) return;
  window.scrollTo(0, Math.min(1, maxScroll));
}
function scheduleSafariToolbarCollapse() {
  if (!isIOSSafari || isStandaloneWebApp) return;
  requestAnimationFrame(function() {
    nudgeSafariToolbarCollapse();
    setTimeout(nudgeSafariToolbarCollapse, 180);
    setTimeout(nudgeSafariToolbarCollapse, 700);
  });
}
(function installSafariToolbarNudge() {
  if (!isIOSSafari || isStandaloneWebApp) return;
  var nudgedAfterTouch = false;
  window.addEventListener("load", scheduleSafariToolbarCollapse);
  window.addEventListener("pageshow", scheduleSafariToolbarCollapse);
  window.addEventListener("orientationchange", function() {
    nudgedAfterTouch = false;
    setTimeout(scheduleSafariToolbarCollapse, 250);
  });
  document.addEventListener("touchend", function() {
    if (nudgedAfterTouch) return;
    nudgedAfterTouch = true;
    scheduleSafariToolbarCollapse();
  }, { passive: true });
})();
(function installLoadingViewportHandling() {
  var inputs = document.querySelectorAll("#loading-coordinates .loading-input");
  for (var i = 0; i < inputs.length; i++) {
    inputs[i].addEventListener("focus", function() {
      syncLoadingViewportState();
      nudgeLoadingFieldIntoView(this);
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncLoadingViewportState);
    window.visualViewport.addEventListener("scroll", syncLoadingViewportState);
    window.visualViewport.addEventListener("resize", function() { scheduleAirportPanelReposition(160); });
    window.visualViewport.addEventListener("scroll", function() { scheduleAirportPanelReposition(160); });
  }
  syncLoadingViewportState();
})();
function adsbUrl(path) {
  return WORKER_URL + "/adsb" + path;
}
function datisUrl(iata) {
  return WORKER_URL + "/datis/" + encodeURIComponent(iata);
}
function photoUrl(hex) {
  return WORKER_URL + "/photo/" + hex;
}
function routesetUrl() {
  return WORKER_URL + "/routeset";
}
function trackUrl(hex) {
  return WORKER_URL + "/track/" + hex;
}
function geoUrl() {
  return WORKER_URL + "/geo";
}
function aircraftUrl(hex) {
  return WORKER_URL + "/aircraft/" + hex;
}
const REFRESH_MS = 5000;
// App zoom levels (URL ?zoom=, saved views, every threshold below) use the 256-px tile scale the app was
// built on. MapLibre counts 512-px tiles, so its zoom is one lower; viewZoom()/toMapZoom() convert.
const DEFAULT_MAP_ZOOM = 11;
const MIN_MAP_ZOOM = 5;
const MAX_MAP_ZOOM = 18;
// IP geolocation is city-level at best, so it opens on the wider region.
const APPROX_AREA_ZOOM = 9;
const GEO_QUICK_BOOT_MS = 1500;
// CARTO basemap keys are client-side by design and restricted to the live
// site's referrer, so localhost requests go keyless (raster tiles watermark).
const CARTO_KEY = "cb1_3umv_1_aa4684ea4fce195778be2673";
const VECTOR_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const DEFAULT_BROWSE_LAT = 51.5074;
const DEFAULT_BROWSE_LNG = -0.1278;
const VIEW_FILTER_PAD = 0.08;
const AIRPORT_VIEW_PAD = 0.16;
// Screen footprint of an airport dot plus its IATA tag, for label decluttering.
const AIRPORT_LABEL_BOX = { w: 60, h: 24 };
// Wider while the label also carries a ground-plane count.
const AIRPORT_LABEL_BOX_COUNTED = { w: 80, h: 24 };
const AIRPORT_GROUND_KM = 5;
const TRAIL_VIEW_PAD = 0.18;
const FETCH_RADIUS_PAD = 1.22;
const MIN_VIEW_FETCH_KM = 18;
const MAX_VIEW_FETCH_KM = 460;
// Wider views are fetched as up to this many circles (fewer on phones, whose views are narrower); past that,
// planes far from the center are left out.
const MAX_COVERAGE_CIRCLES = 12;
const MAX_COVERAGE_CIRCLES_NARROW = 7;
// Below this zoom, ground planes are hidden and counted on their airport's label instead.
const GROUND_PLANES_MIN_ZOOM = 12;
const WIDE_VIEW_FETCH_KM = 220;
const ROUTE_FETCH_MAX_KM = 220;
const ROUTE_FETCH_MIN_ZOOM = 9.25;
const LABEL_MIN_ZOOM = 9.5;
const LABEL_MAX_VISIBLE_PLANES = 90;
const MAP_FETCH_IDLE_MS = 220;
const MAP_FETCH_IDLE_MS_WIDE = 320;
const PLAYBACK_DELAY_MIN_MS = 3200;
const PLAYBACK_DELAY_MAX_MS = 8000;
const PLAYBACK_DELAY_SAFETY_MS = 250;
const PLAYBACK_EXTRAPOLATION_MS = 1200;
// 0 = every animation frame.
const MARKER_TARGET_INTERVAL_MS = 0;
const TRAIL_FRAME_MS = 66;
const STALE_HISTORY_MS = 6 * 60 * 1000;
const SEEDED_TRAIL_WINDOW_MS = 30000;
const SEEDED_TRAIL_POINTS = 8;
const SEEDED_MIN_DISPLAY_SPEED_KTS = 35;
const PLAYBACK_EXTRAPOLATION_MAX_MS = 2200;
const SEARCH_MIN_ZOOM = 13;
const SEARCH_SUGGESTION_LIMIT = 7;
const SEARCH_LOOKUP_DEBOUNCE_MS = 180;
const SHARED_PLANE_LOOKUP_LIMIT = 3;
const posHistory = {};
const routeCache = {};
const photoCache = {};
const photoPending = {};
const aircraftInfoCache = {};
const aircraftInfoPending = {};
const dormantHistory = {};
const trackExtended = {};
const scheduleDataCache = {};
const SCHEDULE_CACHE_TTL = 5 * 60 * 1000;

let map, userMarker;
// True once the basemap style has loaded and the app's sources and layers exist.
let mapReady = false;
let airportData = null;
let runwayData = null;
let airportLatLngIndex = null;

// --- User feature state (route line, follow, weather, persistence) ---
var followMode = false;
var _followPanning = false;
var _routeLineKey = null;
var routeAirports = { origin: null, dest: null };
var weatherOn = false;
var _weatherLayer = null;
var _weatherRefreshTs = 0;
var _weatherSource = null;
var _rvRadar = null;
var _saveViewTimer = 0;
var bootZoomOverride = null;
const RAINVIEWER_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
const LS_FILTERS = "contrails:filters";
const LS_VIEW = "contrails:view";
const LS_PLACES = "contrails:places";
const FOLLOW_DRIFT_FRACTION = 0.28;

var METRO_REGIONS = [
  { name: "Bay Area", lat: 37.62, lon: -122.38 },
  { name: "Los Angeles", lat: 33.94, lon: -118.41 },
  { name: "Chicago", lat: 41.98, lon: -87.90 },
  { name: "New York", lat: 40.66, lon: -73.78 },
  { name: "Washington DC", lat: 38.85, lon: -77.04 },
  { name: "Dallas-Fort Worth", lat: 32.90, lon: -97.04 },
  { name: "Denver", lat: 39.86, lon: -104.67 },
  { name: "Atlanta", lat: 33.64, lon: -84.43 },
  { name: "Seattle", lat: 47.45, lon: -122.31 },
  { name: "Miami", lat: 25.80, lon: -80.29 },
  { name: "Boston", lat: 42.37, lon: -71.02 },
  { name: "Phoenix", lat: 33.44, lon: -112.01 },
  { name: "Houston", lat: 29.98, lon: -95.34 },
  { name: "Minneapolis", lat: 44.88, lon: -93.22 },
  { name: "Detroit", lat: 42.21, lon: -83.35 },
  { name: "Philadelphia", lat: 39.87, lon: -75.24 },
  { name: "Orlando", lat: 28.43, lon: -81.31 },
  { name: "Las Vegas", lat: 36.08, lon: -115.15 },
  { name: "San Diego", lat: 32.73, lon: -117.19 },
  { name: "Portland", lat: 45.59, lon: -122.60 },
  { name: "Honolulu", lat: 21.32, lon: -157.92 },
  { name: "London", lat: 51.47, lon: -0.46 },
  { name: "Paris", lat: 49.01, lon: 2.55 },
  { name: "Frankfurt", lat: 50.03, lon: 8.57 },
  { name: "Amsterdam", lat: 52.31, lon: 4.76 },
  { name: "Dubai", lat: 25.25, lon: 55.36 },
  { name: "Tokyo", lat: 35.55, lon: 139.78 },
  { name: "Singapore", lat: 1.35, lon: 103.99 },
  { name: "Sydney", lat: -33.95, lon: 151.18 },
  { name: "Toronto", lat: 43.68, lon: -79.63 },
  { name: "Mexico City", lat: 19.44, lon: -99.07 }
];

function findNearestRegion(lat, lon, maxKm) {
  var best = null;
  for (var i = 0; i < METRO_REGIONS.length; i++) {
    var r = METRO_REGIONS[i];
    var dist = haversineKm(lat, lon, r.lat, r.lon);
    if (dist <= maxKm && (best === null || dist < best.dist)) {
      best = { name: r.name, dist: dist };
    }
  }
  return best;
}
let userLat = null, userLng = null;
let deviceLat = null, deviceLng = null;
let aircraft = [];
let refreshTimer = null;
let selectedAircraftId = null;
let ignoreMapClickUntil = 0;
let lastFetchKm = MIN_VIEW_FETCH_KM;
let mapFetchTimer = null;
var moveEndDebounceTimer = null;
let suppressViewportRefresh = false;
let fetchAbortController = null;
let activeFetchUrl = null;
let fetchRequestSeq = 0;
let appBooted = false;
let bootView = null;
let playbackDelayMs = REFRESH_MS + PLAYBACK_DELAY_SAFETY_MS;
let feedClockOffsetMs = null;
let feedAgeMs = 0;
let fetchJitterMs = 0;
let shouldWatchUserPosition = true;
let geolocationWatchId = null;
let geolocationUpdatesAffectReference = true;
let backgroundGeoRequestPending = false;
let referenceMode = "device";
let referenceMeta = null;
let controlsFeedbackTimer = 0;
const markerMap = {};
const extraState = {};
const airportMarkers = {};
var refreshSearchUi = null;
let markerAnimationFrame = 0;
let markerAnimationTimer = 0;
var _isPanning = false;
var lastFetchTs = 0;
var fetchInterval = REFRESH_MS;
var trailBreakPending = {};
var trafficFetchOk = null;
var trafficFailStreak = 0;
var trafficSource = null;
const filters = { private: true, ground: true, trails: true, labels: true };

// --- URL params for Siri Shortcut ---
const params = new URLSearchParams(window.location.search);
const paramLat = parseFloat(params.get("lat"));
const paramLng = parseFloat(params.get("lng"));
const paramZoom = parseFloat(params.get("zoom"));
const paramHex = normalizeAircraftHex(params.get("hex"));
let pendingPlaneFocus = paramHex ? {
  hex: paramHex,
  keepUrl: true,
  label: paramHex.toUpperCase(),
  lookupAttempts: 0,
  loading: false,
  failed: false,
  reason: "shared-link"
} : null;

function isPrivate(callsign, type, category) {
  if (isLikelyPrivateCallsign(callsign)) return true;
  if (!callsign) return isLikelyPrivateClass(type, category);
  if (!airlineName(callsign) && isLikelyPrivateClass(type, category)) return true;
  return false;
}

// Aircraft silhouettes from tar1090 (GPL-3.0) - top-down SVG paths
// Each shape: [viewBox, cx, cy, strokeW, path]
const SHAPES = {
  light: ["0 -1 32 31", 16, 14.5, 0.5, "M16.36 20.96l2.57.27s.44.05.4.54l-.02.63s-.03.47-.45.54l-2.31.34-.44-.74-.22 1.63-.25-1.62-.38.73-2.35-.35s-.44-.1-.43-.6l-.02-.6s0-.5.48-.5l2.5-.27-.56-5.4-3.64-.1-5.83-1.02h-.45v-2.06s-.07-.37.46-.34l5.8-.17 3.55.12s-.1-2.52.52-2.82l-1.68-.04s-.1-.06 0-.14l1.94-.03s.35-1.18.7 0l1.91.04s.11.05 0 .14l-1.7.02s.62-.09.56 2.82l3.54-.1 5.81.17s.51-.04.48.35l-.01 2.06h-.47l-5.8 1-3.67.11z"],
  turboprop: ["-3 -4 25 22", 9.5, 7, 0.4, "M9.5,15.75c-.21,0-.34-.17-.41-.51l-2.88.23v-.27c0-.78,0-1.11.28-1.13L9,13.1c-.31-1.86-.55-5-.59-5.55l-.08-.09H6.08L.25,6.54v-1A.43.43,0,0,1,.67,5l3.75-.27L5,4.45V3.53H4.73V2.7a.35.35,0,0,1,.34-.35h.07c.12-.52.26-.83.54-.83s.42.31.53.83h.07a.35.35,0,0,1,.34.35v.83H6.36v1l2-.08C8.42.81,9.09.25,9.49.25s1.09.55,1.12,4.21l2,.08v-1h-.25V2.7a.35.35,0,0,1,.34-.35h.07c.12-.52.26-.83.53-.83s.42.31.54.83h.07a.35.35,0,0,1,.34.35v.83H14v.92l.57.32L18.32,5a.42.42,0,0,1,.43.46v1L13,7.46H10.71l-.08.09c0,.56-.27,3.68-.59,5.55l2.46,1c.28,0,.28.35.28,1.13v.27l-2.88-.23C9.84,15.58,9.71,15.75,9.5,15.75Z"],
  bizjet: ["-1 -1 20 26", 9, 12, 0.4, "M9.44,23c-.1.6-.35.6-.44.6s-.34,0-.44-.6l-3,.67V22.6A.54.54,0,0,1,6,22.05l2.38-1.12L8,19.33H6.69l0-.2a8.23,8.23,0,0,1-.14-3.85l.06-.18H7.73V13.19h-2L.26,14.29v-.93c0-.28.07-.46.22-.53l7.25-3.6V3.85A4.47,4.47,0,0,1,8.83.49L9,.34l.17.15a4.47,4.47,0,0,1,1.1,3.36V9.23l7.25,3.6c.14.07.22.25.22.53v.93l-5.51-1.1h-2V15.1h1.17l.06.18a8.24,8.24,0,0,1-.15,3.84l0,.2H10l-.36,1.6,2.43,1.14a.52.52,0,0,1,.35.53v1.08Z"],
  narrowbody: ["-1 -2 34 34", 16, 15, 0.5, "M16 1c-.17 0-.67.58-.9 1.03-.6 1.21-.6 1.15-.65 5.2-.04 2.97-.08 3.77-.18 3.9-.15.17-1.82 1.1-1.98 1.1-.08 0-.1-.25-.05-.83.03-.5.01-.92-.05-1.08-.1-.25-.13-.26-.71-.26-.82 0-.86.07-.78 1.5.03.6.08 1.17.11 1.25.05.12-.02.2-.25.33l-8 4.2c-.2.2-.18.1-.19 1.29 3.9-1.2 3.71-1.21 3.93-1.21.06 0 .1 0 .13.14.08.3.28.3.28-.04 0-.25.03-.27 1.16-.6.65-.2 1.22-.35 1.28-.35.05 0 .12.04.15.17.07.3.27.27.27-.08 0-.25.01-.27.7-.47.68-.1.98-.09 1.47-.1.18 0 .22 0 .26.18.06.34.22.35.27-.01.04-.2.1-.17 1.06-.14l1.07.02.05 4.2c.05 3.84.07 4.28.26 5.09.11.49.2.99.2 1.11 0 .19-.31.43-1.93 1.5l-1.93 1.26v1.02l4.13-.95.63 1.54c.05.07.12.09.19.09s.14-.02.19-.09l.63-1.54 4.13.95V29.3l-1.93-1.27c-1.62-1.06-1.93-1.3-1.93-1.49 0-.12.09-.62.2-1.11.19-.81.2-1.25.26-5.09l.05-4.2 1.07-.02c.96-.03 1.02-.05 1.06.14.05.36.21.35.27 0 .04-.17.08-.16.26-.16.49 0 .8-.02 1.48.1.68.2.69.21.69.46 0 .35.2.38.28.04.03-.13.1-.17.15-.17.06 0 .63.15 1.28.34 1.13.34 1.16.36 1.16.61 0 .35.2.34.28.04.03-.13.07-.14.13-.14.22 0 .03 0 3.93 1.2-.01-1.18.02-1.07-.19-1.27l-8-4.21c-.23-.12-.3-.21-.25-.33.03-.08.08-.65.11-1.25.08-1.43.04-1.5-.78-1.5-.58 0-.61.01-.71.26-.06.16-.08.58-.05 1.08.04.58.03.83-.05.83-.16 0-1.83-.93-1.98-1.1-.1-.13-.14-.93-.18-3.9-.05-4.05-.05-3.99-.65-5.2C16.67 1.58 16.17 1 16 1z"],
  widebody: ["0 -3.2 64.2 64.2", 32.1, 28.9, 0.7, "m 31.414,2.728 c -0.314,0.712 -1.296,2.377 -1.534,6.133 l -0.086,13.379 c 0.006,0.400 -0.380,0.888 -0.945,1.252 l -2.631,1.729 c 0.157,-0.904 0.237,-3.403 -0.162,-3.850 l -2.686,0.006 c -0.336,1.065 -0.358,2.518 -0.109,4.088 h 0.434 L 24.057,26.689 8.611,36.852 7.418,38.432 7.381,39.027 8.875,38.166 l 8.295,-2.771 0.072,0.730 0.156,-0.004 0.150,-0.859 3.799,-1.234 0.074,0.727 0.119,0.004 0.117,-0.832 2.182,-0.730 h 1.670 l 0.061,0.822 h 0.176 l 0.062,-0.822 4.018,-0.002 v 13.602 c 0.051,1.559 0.465,3.272 0.826,4.963 l -6.836,5.426 c -0.097,0.802 -0.003,1.372 0.049,1.885 l 7.734,-2.795 0.477,1.973 h 0.232 l 0.477,-1.973 7.736,2.795 c 0.052,-0.513 0.146,-1.083 0.049,-1.885 l -6.836,-5.426 c 0.361,-1.691 0.775,-3.404 0.826,-4.963 V 33.193 l 4.016,0.002 0.062,0.822 h 0.178 L 38.875,33.195 h 1.672 l 2.182,0.730 0.117,0.832 0.119,-0.004 0.072,-0.727 3.799,1.234 0.152,0.859 0.154,0.004 0.072,-0.730 8.297,2.771 1.492,0.861 -0.037,-0.596 -1.191,-1.580 -15.447,-10.162 0.363,-1.225 H 41.125 c 0.248,-1.569 0.225,-3.023 -0.111,-4.088 l -2.686,-0.006 c -0.399,0.447 -0.317,2.945 -0.160,3.850 L 35.535,23.492 C 34.970,23.128 34.584,22.640 34.590,22.240 L 34.504,8.910 C 34.193,4.926 33.369,3.602 32.934,2.722 32.442,1.732 31.894,1.828 31.414,2.728 Z"],
  quadjet: ["0 0 64 64", 32, 32, 0.7, "m 30.764,3.957 c -1.030,1.995 -1.438,5.650 -1.600,7.687 -0.248,3.120 -0.114,5.478 -0.156,7.568 -0.016,0.798 -0.737,1.483 -1.435,2.163 l -4.630,4.207 c 0.136,-0.609 0.313,-2.735 0.011,-3.413 l -2.147,-0.067 c -0.337,0.636 -0.227,2.516 -0.102,3.486 l 0.414,0.033 0.179,1.447 -5.794,5.342 c 0.077,-0.914 0.114,-2.161 -0.105,-2.633 l -2.172,-0.078 c -0.367,0.716 -0.185,2.323 -0.053,3.475 h 0.394 l 0.138,0.949 -7.991,6.563 C 5.411,40.937 5.586,41.437 5.564,41.830 l -0.694,2.353 0.005,0.991 0.715,-1.236 10.464,-6.218 c 0.012,0.663 0.110,1.051 0.231,1.010 0.135,-0.045 0.328,-0.852 0.361,-1.290 l 2.274,-1.389 c -0.003,0.493 0.054,1.174 0.196,1.088 0.126,-0.076 0.384,-0.807 0.362,-1.370 l 1.528,-0.943 2.988,-1.018 c 0.073,0.381 0.122,0.929 0.292,0.896 0.159,-0.031 0.257,-0.491 0.355,-1.065 l 1.704,-0.597 c 0.025,0.437 0.163,0.976 0.297,0.914 0.149,-0.070 0.339,-0.647 0.356,-1.118 l 1.935,-0.666 0.054,10.106 c 0.183,3.800 0.173,5.797 0.919,9.127 -0.072,0.573 -0.374,0.766 -0.640,1.020 l -6.724,6.317 -0.007,2.046 8.553,-2.312 c 0.019,0.586 0.061,1.045 0.432,1.368 l 0.146,1.817 0.146,-1.817 c 0.371,-0.323 0.413,-0.782 0.432,-1.368 l 8.553,2.312 -0.007,-2.046 -6.724,-6.317 c -0.266,-0.253 -0.569,-0.446 -0.640,-1.020 0.747,-3.331 0.736,-5.327 0.919,-9.127 l 0.054,-10.106 1.935,0.666 c 0.017,0.470 0.207,1.048 0.356,1.118 0.134,0.062 0.272,-0.477 0.297,-0.914 l 1.704,0.597 c 0.098,0.574 0.196,1.034 0.355,1.065 0.170,0.033 0.219,-0.515 0.292,-0.896 l 2.988,1.018 1.528,0.943 c -0.021,0.563 0.237,1.294 0.362,1.370 0.141,0.086 0.198,-0.595 0.196,-1.088 l 2.274,1.389 c 0.033,0.439 0.227,1.245 0.361,1.290 0.121,0.041 0.219,-0.347 0.231,-1.010 l 10.464,6.218 0.715,1.236 0.005,-0.991 -0.694,-2.353 c -0.021,-0.393 0.153,-0.893 -0.151,-1.143 l -7.991,-6.563 0.138,-0.949 h 0.394 c 0.132,-1.152 0.314,-2.760 -0.053,-3.475 l -2.172,0.078 c -0.218,0.472 -0.182,1.719 -0.105,2.633 l -5.794,-5.342 0.179,-1.447 0.414,-0.033 c 0.125,-0.970 0.236,-2.850 -0.102,-3.486 l -2.147,0.067 c -0.302,0.678 -0.125,2.804 0.011,3.413 l -4.630,-4.207 c -0.698,-0.680 -1.419,-1.365 -1.435,-2.163 -0.042,-2.090 0.092,-4.448 -0.156,-7.568 -0.162,-2.037 -0.600,-5.677 -1.600,-7.687 -0.592,-1.190 -1.211,-1.157 -1.809,0 z"]
};
const ICON_SZ = { light: 24, turboprop: 26, bizjet: 24, narrowbody: 30, widebody: 40, quadjet: 44 };

const GROUND_COLOR = "hsl(210,15%,42%)";

// Planes are drawn by the map as SDF images: one silhouette per shape class, tinted per plane with
// icon-color and outlined with icon-halo, so altitude colors don't need an image each.
const PLANE_IMAGE_RATIO = 2;
const PLANE_SDF_RADIUS = 8;

function planeShapeImage(cls) {
  var shape = SHAPES[cls];
  var sz = ICON_SZ[cls];
  var vb = shape[0].split(/\s+/).map(Number);
  var px = sz * PLANE_IMAGE_RATIO;
  var pad = PLANE_SDF_RADIUS;
  var dim = px + pad * 2;
  var canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  var ctx = canvas.getContext("2d");
  var scale = px / Math.max(vb[2], vb[3]);
  ctx.translate(pad + (px - vb[2] * scale) / 2, pad + (px - vb[3] * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-vb[0], -vb[1]);
  ctx.fill(new Path2D(shape[4]));
  var rgba = ctx.getImageData(0, 0, dim, dim).data;
  var alpha = new Uint8ClampedArray(dim * dim);
  for (var i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  var sdf = alphaToSdf(alpha, dim, dim, PLANE_SDF_RADIUS, 0.25);
  var data = new Uint8ClampedArray(dim * dim * 4);
  for (var j = 0; j < sdf.length; j++) {
    data[j * 4] = data[j * 4 + 1] = data[j * 4 + 2] = 255;
    data[j * 4 + 3] = sdf[j];
  }
  return { width: dim, height: dim, data: data };
}

// Stretchable rounded box behind plane labels (icon-text-fit), matching the old tooltip chip.
function labelChipImage() {
  var r = PLANE_IMAGE_RATIO;
  var dim = 16 * r;
  var canvas = document.createElement("canvas");
  canvas.width = dim;
  canvas.height = dim;
  var ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(8, 15, 26, 0.88)";
  ctx.beginPath();
  ctx.roundRect(0, 0, dim, dim, 3 * r);
  ctx.fill();
  return {
    image: { width: dim, height: dim, data: ctx.getImageData(0, 0, dim, dim).data },
    options: { pixelRatio: r, stretchX: [[4 * r, 12 * r]], stretchY: [[4 * r, 12 * r]], content: [4 * r, 4 * r, 12 * r, 12 * r] }
  };
}

function addPlaneImages() {
  for (var cls in SHAPES) {
    map.addImage("plane-" + cls, planeShapeImage(cls), { sdf: true, pixelRatio: PLANE_IMAGE_RATIO });
  }
  var chip = labelChipImage();
  map.addImage("label-chip", chip.image, chip.options);
}

// Size is relative to the shape's own ICON_SZ, which its image is drawn at.
function planeStyle(a) {
  var color = a.ground ? GROUND_COLOR : altColor(a.altFt);
  if (a.private) color = dimColor(color);
  var cls = sizeClass(a.aircraftType, a.category);
  if (!SHAPES[cls]) cls = "narrowbody";
  return {
    icon: "plane-" + cls,
    size: a.private ? 0.8 : 1,
    color: color,
    radiusPx: ICON_SZ[cls] * (a.private ? 0.8 : 1) / 2
  };
}

function focusWithoutScroll(el) {
  if (!el || typeof el.focus !== "function") return;
  try {
    el.focus({ preventScroll: true });
  } catch (e) {
    el.focus();
  }
}

function connectedFocusableElement(el) {
  return !!(el && typeof el.focus === "function" && el.ownerDocument && el.ownerDocument.contains(el));
}

function captureOverlayOpener(overlayEl) {
  var active = document.activeElement;
  if (!connectedFocusableElement(active)) return null;
  if (active === document.body || active === document.documentElement) return null;
  if (overlayEl && overlayEl.contains && overlayEl.contains(active)) return null;
  return active;
}

function restoreFocusIfConnected(el) {
  if (connectedFocusableElement(el)) focusWithoutScroll(el);
}

function withCartoKey(url) {
  if (isLocal || url.indexOf("key=") !== -1) return url;
  return url + (url.indexOf("?") === -1 ? "?" : "&") + "key=" + CARTO_KEY;
}
