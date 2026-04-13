(function() {
  const core = globalThis.ContrailsCore || {};
  const airlineName = core.airlineName;
  const bearingDegrees = core.bearingDegrees;
  const buildViewPolicy = core.buildViewPolicy;
  const buildViewportFetchSpec = core.buildViewportFetchSpec;
  const cardinalDir = core.cardinalDir;
  const computePlaybackDelayMs = core.computePlaybackDelayMs;
  const callsignVariants = core.callsignVariants;
  const escapeHtml = core.escapeHtml;
  const formatDistanceMiles = core.formatDistanceMiles;
  const formatSpeedMph = core.formatSpeedMph;
  const haversineKm = core.haversineKm;
  const interpolatePlaybackPose = core.interpolatePlaybackPose;
  const interpolateTimedPose = core.interpolateTimedPose;
  const isLikelyPrivateCallsign = core.isLikelyPrivateCallsign;
  const normalizeAircraftHex = core.normalizeAircraftHex;
  const normalizeFlightQuery = core.normalizeFlightQuery;
  const normalizeSearchText = core.normalizeSearchText;
  const parseCoordinate = core.parseCoordinate;
  const projectLatLng = core.projectLatLng;
  const roundTenths = core.roundTenths;
  const slantKm = core.slantKm;
  const elevationDeg = core.elevationDeg;
  const SQUAWK_ALERT = core.SQUAWK_ALERTS;
  if (!airlineName || !bearingDegrees || !buildViewPolicy || !buildViewportFetchSpec || !cardinalDir ||
      !callsignVariants || !computePlaybackDelayMs || !escapeHtml || !formatDistanceMiles || !formatSpeedMph ||
      !haversineKm || !interpolatePlaybackPose || !interpolateTimedPose || !isLikelyPrivateCallsign ||
      !normalizeAircraftHex || !normalizeFlightQuery || !normalizeSearchText || !parseCoordinate || !projectLatLng ||
      !roundTenths || !slantKm || !elevationDeg || !SQUAWK_ALERT) {
    throw new Error("Contrails core helpers failed to load.");
  }

  const APP_VERSION = "v2.9";
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
  const WORKER_URL = "https://contrails-api.therealgraj.workers.dev";
  var workerOk = true;
  function setProxyBannerVisible(visible) {
    var banner = document.getElementById("proxy-banner");
    if (!banner) return;
    if (visible) {
      banner.textContent = "Worker unavailable \u2014 using fallback proxy";
      banner.style.display = "block";
    } else {
      banner.style.display = "none";
    }
  }
  document.getElementById("version-badge").textContent = APP_VERSION;
  document.getElementById("controls-logo-image").setAttribute("src", "contrails-logo.png?v=" + APP_VERSION);
  document.getElementById("app-touch-icon").setAttribute("href", "apple-touch-icon.png?v=" + APP_VERSION);
  document.getElementById("app-favicon").setAttribute("href", "apple-touch-icon.png?v=" + APP_VERSION);
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
    }
    syncLoadingViewportState();
  })();
  function corsProxy(url) { return "https://corsproxy.io/?" + encodeURIComponent(url); }
  function adsbUrl(path) {
    if (isLocal) return "/api/adsb" + path;
    if (workerOk) return WORKER_URL + "/adsb" + path;
    return corsProxy("https://api.adsb.lol/v2" + path);
  }
  function routeUrl(path) {
    if (isLocal) return "/api/adsb-route" + path;
    if (workerOk) return WORKER_URL + "/route" + path;
    return corsProxy("https://api.adsb.lol/api/0" + path);
  }
  function photoUrl(hex) {
    return WORKER_URL + "/photo/" + hex;
  }
  function routesetUrl() {
    return WORKER_URL + "/routeset";
  }
  const OPENSKY_PROXY = "https://raspberrypi.tail7af116.ts.net";
  var openskyProxyOk = null;
  function trackUrl(hex) {
    return WORKER_URL + "/track/" + hex;
  }
  function geoUrl() {
    if (isLocal) return "/api/geo";
    return WORKER_URL + "/geo";
  }
  const REFRESH_MS = 5000;
  const DEFAULT_MAP_ZOOM = 11;
  const MIN_MAP_ZOOM = 5;
  const TILE_LAYER_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const TILE_LAYER_OPTIONS = {
    maxZoom: 18,
    keepBuffer: 6,
    updateWhenIdle: false,
    updateInterval: 100,
    updateWhenZooming: true
  };
  const DEFAULT_BROWSE_LAT = 51.5074;
  const DEFAULT_BROWSE_LNG = -0.1278;
  const VIEW_FILTER_PAD = 0.08;
  const AIRPORT_VIEW_PAD = 0.16;
  const TRAIL_VIEW_PAD = 0.18;
  const FETCH_RADIUS_PAD = 1.22;
  const MIN_VIEW_FETCH_KM = 18;
  const MAX_VIEW_FETCH_KM = 460;
  const WIDE_VIEW_FETCH_KM = 220;
  const ROUTE_FETCH_MAX_KM = 220;
  const ROUTE_FETCH_MIN_ZOOM = 9.25;
  const LABEL_MIN_ZOOM = 9.5;
  const LABEL_MAX_VISIBLE_PLANES = 90;
  const MAP_FETCH_IDLE_MS = 220;
  const MAP_FETCH_IDLE_MS_WIDE = 320;
  const PLAYBACK_DELAY_MIN_MS = 3200;
  const PLAYBACK_DELAY_MAX_MS = 6500;
  const PLAYBACK_DELAY_SAFETY_MS = 250;
  const PLAYBACK_EXTRAPOLATION_MS = 1200;
  const MARKER_TARGET_INTERVAL_MS = Math.round(1000 / 24);
  const STALE_HISTORY_MS = 6 * 60 * 1000;
  const SEEDED_TRAIL_WINDOW_MS = 30000;
  const SEEDED_TRAIL_POINTS = 8;
  const SEEDED_MIN_DISPLAY_SPEED_KTS = 35;
  const NEW_MARKER_BATCH = 25;
  const MARKER_DRAIN_DELAY_MS = 80;
  const PLAYBACK_EXTRAPOLATION_MAX_MS = 2200;
  const SEARCH_MIN_ZOOM = 13;
  const SEARCH_SUGGESTION_LIMIT = 7;
  const SEARCH_LOOKUP_DEBOUNCE_MS = 180;
  const SHARED_PLANE_LOOKUP_LIMIT = 3;
  const posHistory = {};
  const routeCache = {};
  const photoCache = {};
  const photoPending = {};
  const dormantHistory = {};
  const trackExtended = {};
  const scheduleDataCache = {};
  const SCHEDULE_CACHE_TTL = 5 * 60 * 1000;

  let map, userMarker, aircraftLayer, trailLayer, airportLayer, runwayLayer;
  let airportData = null;
  let runwayData = null;

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
  let aircraft = [];
  let refreshTimer = null;
  let selectedAircraftId = null;
  let ignoreMapClickUntil = 0;
  let lastFetchKm = MIN_VIEW_FETCH_KM;
  let mapFetchTimer = null;
  let suppressViewportRefresh = false;
  let fetchAbortController = null;
  let fetchRequestSeq = 0;
  let appBooted = false;
  let playbackDelayMs = REFRESH_MS + PLAYBACK_DELAY_SAFETY_MS;
  let fetchJitterMs = 0;
  let shouldWatchUserPosition = true;
  let geolocationWatchId = null;
  let referenceMode = "device";
  let referenceMeta = null;
  let controlsFeedbackTimer = 0;
  const markerMap = {};
  const extraState = {};
  const airportMarkers = {};
  var refreshSearchUi = null;
  let markerAnimationFrame = 0;
  let markerAnimationTimer = 0;
  let _isZooming = false;
  var lastFetchTs = 0;
  var fetchInterval = REFRESH_MS;
  var trailBreakPending = {};
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

  function isLikelyPrivateClass(type, category) {
    var cls = sizeClass(type, category);
    return cls === "bizjet" || cls === "light" || cls === "turboprop";
  }
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

  function sizeFromCategory(cat) {
    if (!cat) return null;
    switch (cat) {
      case "A1": case "A2": case "B1": case "B2": case "B4": case "B6": return "light";
      case "A3": return "narrowbody";
      case "A4": case "A5": case "A6": return "widebody";
      case "A7": return "heli";
      default: return null;
    }
  }

  function sizeClass(type, category) {
    if (!type) return sizeFromCategory(category) || "light";
    var t = type.toUpperCase();
    if (/^(EC\d|H1[2-9]\d|H60|R22|R44|R66|S76|S92|A1[0-9]\d|AS\d|B[024]\d\d|MD[5-9]\d|BK|K[A-Z]\d|MI\d|NH90)/.test(t)) return "heli";
    if (/^(C1[2-9]\d|C2[0-1]\d|P28|PA\d|SR2[02]|DA[24]\d|BE[23]\d|M20|TB[12]\d|DR4|RV\d|COL[34]|TRIN|P46T|PC12|GLST)/.test(t)) return "light";
    if (/^(AT[4-7]\d|DH8[A-D]|DHC[6-8]|SF34|SB20|B190|C208|PC[0-9]|TBM[0-9]|JS[2-4]\d|AN[2-3]\d|L410|DO[0-9]|J328|E120|BE[9A][0-9]|SW[34]|M28)/.test(t)) return "turboprop";
    if (/^(CRJ|E[1-2][0-9]\d|ERJ|GLF[2-7]|GL\dT|GLEX|G[2-7]\d\d|GA[5-7].|LJ\d|CL[0-9]|C[5-7]\d\d|C25|C56|C68|F[29][0-9]\d|FA[57]|H25|HA4|PRM|ASTR|GALX|E35L|E55P|EA50|SF50|PC24|P180)/.test(t)) return "bizjet";
    if (/^(A38\d|B74[0-9]|A34[0-9]|IL96|C5M?|A400|AN12)/.test(t)) return "quadjet";
    if (/^(B7[6-8].|A3[03].|A35.|MD1[01]|DC10|L101|IL[89]\d|C17|KC46|A310)/.test(t)) return "widebody";
    if (/^(A3[12]\d|A2[02]\d|A[12]\dN|B73[0-9]|B3[89]M|BCS[1-3]|B75[0-9]|MD[89]\d|B712|E295|MC21)/.test(t)) return "narrowbody";
    return sizeFromCategory(category) || "light";
  }

  function dimColor(hslStr) {
    var m = hslStr.match(/[\d.]+/g);
    if (!m || m.length < 3) return hslStr;
    var h = +m[0], s = +m[1], l = +m[2];
    return "hsl(" + h + "," + Math.round(s * 0.4) + "%," + Math.round(l * 0.7 + 20) + "%)";
  }

  const GROUND_COLOR = "hsl(210,15%,42%)";

  function planeIcon(track, aircraftType, priv, category, altFt, ground) {
    var color = ground ? GROUND_COLOR : altColor(altFt);
    if (priv) color = dimColor(color);
    var cls = sizeClass(aircraftType, category);
    var shape = SHAPES[cls] || SHAPES.narrowbody;
    var sz = ICON_SZ[cls] || 30;
    if (priv) sz = Math.round(sz * 0.8);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + sz + '" height="' + sz + '" viewBox="' + shape[0] + '">' +
      '<g transform="rotate(' + (track || 0) + ',' + shape[1] + ',' + shape[2] + ')">' +
      '<path d="' + shape[4] + '" fill="' + color + '" stroke="#0a0e17" stroke-width="' + shape[3] + '"/>' +
      '</g></svg>';
    var half = sz / 2;
    return L.divIcon({ html: svg, iconSize: [sz, sz], iconAnchor: [half, half], className: "plane-marker-icon" });
  }

  // --- Map setup ---
  function initMap(lat, lng) {
    var desktopWheelTuning = isDesktopFinePointer;
    map = L.map("map", {
      center: [lat, lng],
      zoom: isFinite(paramZoom) ? Math.max(MIN_MAP_ZOOM, paramZoom) : DEFAULT_MAP_ZOOM,
      minZoom: MIN_MAP_ZOOM,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      zoomSnap: 0,
      scrollWheelZoom: !desktopWheelTuning,
      smoothWheelZoom: desktopWheelTuning,
      smoothSensitivity: 1,
      zoomDelta: desktopWheelTuning ? 0.5 : 0.25,
      wheelPxPerZoomLevel: desktopWheelTuning ? 90 : 180,
      wheelDebounceTime: desktopWheelTuning ? 28 : 40,
      zoomAnimation: true,
      zoomAnimationThreshold: 8,
      fadeAnimation: false,
      markerZoomAnimation: true,
      doubleClickZoom: !isIOSSafari,
      doubleTapDragZoom: isIOSSafari ? false : "center",
      doubleTapDragZoomOptions: { reverse: true }
    });
    map.createPane("airportCirclePane");
    map.getPane("airportCirclePane").style.zIndex = 620;
    map.getPane("airportCirclePane").style.pointerEvents = "none";
    map.createPane("planeLabelPane");
    map.getPane("planeLabelPane").style.zIndex = 630;
    map.createPane("airportTooltipPane");
    map.getPane("airportTooltipPane").style.zIndex = 640;
    L.tileLayer(TILE_LAYER_URL, TILE_LAYER_OPTIONS).addTo(map);

    if (shouldWatchUserPosition) {
      userMarker = L.circleMarker([lat, lng], {
        radius: 7, fillColor: "#5bbcf5", fillOpacity: 1,
        color: "#fff", weight: 2
      }).addTo(map);
    }

    var _autoPanning = false;
    map.on("autopanstart", function() { _autoPanning = true; });
    map.on("movestart", function() {
      if (_autoPanning) { _autoPanning = false; return; }
      if (pendingPlaneFocus && pendingPlaneFocus.failed) clearPendingPlaneFocus();
    });
    map.on("click", function(e) {
      if (Date.now() < ignoreMapClickUntil) return;
      if (!selectedAircraftId) return;
      setSelectedAircraft(null);
    });

    map.on("zoomstart", function() { _isZooming = true; });
    map.on("zoomend", function() { _isZooming = false; });

    trailLayer = L.layerGroup().addTo(map);
    runwayLayer = L.layerGroup().addTo(map);
    airportLayer = L.layerGroup().addTo(map);
    aircraftLayer = L.layerGroup().addTo(map);
    installIOSOneFingerZoom();
    var _popupJustOpened = false;
    map.on("popupopen", function(e) {
      _popupJustOpened = true;
      setTimeout(function() { _popupJustOpened = false; }, 600);
      var el = e.popup.getElement();
      if (!el) return;
      if (!el.__contrailsPopupActionsBound) {
        el.__contrailsPopupActionsBound = true;
        el.addEventListener("click", function(event) {
          var t = event.target;
          if (!t || !t.closest) return;
          var shareBtn = t.closest(".popup-share");
          if (shareBtn) {
            event.preventDefault();
            event.stopPropagation();
            sharePlaneById(shareBtn.getAttribute("data-hex"));
            return;
          }
          var toggleBtn = t.closest(".sched-toggle-btn");
          if (toggleBtn) {
            event.preventDefault();
            event.stopPropagation();
            var dir = toggleBtn.getAttribute("data-dir");
            if (dir) renderSchedulePopup(dir);
            return;
          }
        });
      }
      var photoEl = el.querySelector(".popup-photo");
      if (photoEl) {
        var hex = photoEl.getAttribute("data-hex");
        loadPopupPhoto(photoEl);
        loadPopupTrack(hex);
        matchScheduleRoute(hex);
        var clickedPlane = findAircraftById(hex);
        if (clickedPlane && clickedPlane.callsign && !clickedPlane.private) {
          var clickRc = routeCache[clickedPlane.callsign];
          if (!clickRc || (clickRc.destSource !== "fr24-search" && clickRc.destSource !== "schedule")) {
            tryFr24Search(clickedPlane).then(function() {
              var m = markerMap[hex];
              if (m && m.getPopup() && m.getPopup().isOpen()) {
                var updA = findAircraftById(hex);
                if (updA) m.getPopup().setContent(buildPopup(updA));
              }
            });
          }
        }
      }
      setTimeout(function() {
        var ctrl = document.getElementById("map-controls");
        if (!ctrl || !el) return;
        var ctrlBottom = ctrl.getBoundingClientRect().bottom;
        var popupRect = el.getBoundingClientRect();
        if (popupRect.top < ctrlBottom + 10) {
          _autoPanning = true;
          map.panBy([0, popupRect.top - ctrlBottom - 10], { animate: true, duration: 0.3 });
        }
      }, 50);
    });
    map.on("moveend", function() {
      if (suppressViewportRefresh) return;
      refreshViewportUi({ fetch: true });
      if (_popupJustOpened || _autoPanning) { _autoPanning = false; return; }
      var p = map._popup;
      if (p && p._latlng && !map.getBounds().contains(p._latlng)) {
        map.closePopup();
      }
    });
    if (isIOSDevice) {
      setTimeout(function() { map.invalidateSize({ animate: false }); }, 300);
    }
    window.addEventListener("resize", function() {
      if (map) map.invalidateSize({ animate: false });
    });
  }

  function clampZoom(zoom) {
    var min = map && map.getMinZoom() != null ? map.getMinZoom() : 0;
    var max = map && map.getMaxZoom() != null ? map.getMaxZoom() : 18;
    return Math.max(min, Math.min(max, zoom));
  }

  function installIOSOneFingerZoom() {
    if (!isIOSSafari || !map) return;
    var el = map.getContainer();
    var lastTap = null;
    var gesture = null;
    var zoomFrame = 0;
    var queuedZoom = null;

    function flushQueuedZoom() {
      if (zoomFrame) {
        cancelAnimationFrame(zoomFrame);
        zoomFrame = 0;
      }
      if (gesture && queuedZoom != null) {
        map.setZoomAround(gesture.anchorLatLng, queuedZoom, { animate: false });
        queuedZoom = null;
      }
    }

    function resetGesture() {
      if (zoomFrame) {
        cancelAnimationFrame(zoomFrame);
        zoomFrame = 0;
      }
      queuedZoom = null;
      if (map.dragging && !map.dragging.enabled()) map.dragging.enable();
      gesture = null;
    }

    function queueZoom(targetZoom) {
      queuedZoom = targetZoom;
      if (zoomFrame) return;
      zoomFrame = requestAnimationFrame(function() {
        zoomFrame = 0;
        if (!gesture || queuedZoom == null) return;
        map.setZoomAround(gesture.anchorLatLng, queuedZoom, { animate: false });
        queuedZoom = null;
      });
    }

    function onTouchStart(e) {
      if (e.touches.length !== 1) {
        suppressViewportRefresh = false;
        resetGesture();
        return;
      }
      var touch = e.touches[0];
      var now = Date.now();
      var point = { x: touch.clientX, y: touch.clientY };
      if (lastTap && now - lastTap.ts < 350 && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < 28) {
        if (map.dragging && map.dragging.enabled()) map.dragging.disable();
        suppressViewportRefresh = true;
        ignoreMapClickUntil = now + 500;
        var anchorPoint = map.mouseEventToContainerPoint({ clientX: touch.clientX, clientY: touch.clientY });
        gesture = {
          anchorLatLng: map.containerPointToLatLng(anchorPoint),
          startY: touch.clientY,
          startZoom: map.getZoom(),
          moved: false
        };
        lastTap = null;
        e.preventDefault();
        e.stopPropagation();
      } else {
        lastTap = { ts: now, x: point.x, y: point.y };
      }
    }

    function onTouchMove(e) {
      if (!gesture || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - gesture.startY;
      if (Math.abs(dy) > 6) gesture.moved = true;
      var targetZoom = clampZoom(gesture.startZoom + dy / 90);
      queueZoom(targetZoom);
      e.preventDefault();
      e.stopPropagation();
    }

    function onTouchEnd(e) {
      if (!gesture) return;
      if (!gesture.moved) {
        map.setZoomAround(gesture.anchorLatLng, clampZoom(gesture.startZoom + 1), { animate: true });
        setTimeout(function() {
          suppressViewportRefresh = false;
        }, 0);
      } else {
        flushQueuedZoom();
        requestAnimationFrame(function() {
          suppressViewportRefresh = false;
          refreshViewportUi({ fetch: true });
        });
      }
      ignoreMapClickUntil = Date.now() + 500;
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      resetGesture();
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", function() {
      suppressViewportRefresh = false;
      resetGesture();
    }, { passive: true });
  }

  function syncUrlState() {
    if (map) {
      var center = map.getCenter();
      params.set("lat", center.lat.toFixed(4));
      params.set("lng", center.lng.toFixed(4));
      params.set("zoom", String(Math.round(map.getZoom() * 4) / 4));
    } else if (userLat != null && userLng != null) {
      params.set("lat", userLat.toFixed(4));
      params.set("lng", userLng.toFixed(4));
    }
    var planeHex = selectedAircraftId || (pendingPlaneFocus && pendingPlaneFocus.keepUrl ? pendingPlaneFocus.hex : null);
    if (planeHex) params.set("hex", planeHex);
    else params.delete("hex");
    params.delete("radius");
    var query = params.toString();
    history.replaceState(null, "", query ? "?" + query : location.pathname);
  }

  function setControlsFeedback(message, tone, options) {
    var el = document.getElementById("controls-feedback");
    if (!el) return;
    if (controlsFeedbackTimer) {
      clearTimeout(controlsFeedbackTimer);
      controlsFeedbackTimer = 0;
    }
    el.textContent = message || "";
    el.className = tone || "";
    if (!message || (options && options.persistent)) return;
    var timeoutMs = options && options.timeoutMs != null ? options.timeoutMs : 4000;
    if (timeoutMs > 0) {
      controlsFeedbackTimer = setTimeout(function() {
        controlsFeedbackTimer = 0;
        el.textContent = "";
        el.className = "";
      }, timeoutMs);
    }
  }

  function findAircraftById(id) {
    var normalized = normalizeAircraftHex(id);
    if (!normalized) return null;
    for (var i = 0; i < aircraft.length; i++) {
      if (aircraft[i].icao24 === normalized) return aircraft[i];
    }
    return null;
  }

  function findAircraftByQuery(query) {
    if (!query) return null;
    if (query.type === "hex") return findAircraftById(query.value);
    var variants = query.variants || [query.value];
    for (var i = 0; i < aircraft.length; i++) {
      var callsign = aircraft[i].callsign ? aircraft[i].callsign.toUpperCase() : "";
      if (callsign && variants.indexOf(callsign) !== -1) return aircraft[i];
    }
    return null;
  }

  function pickLiveAircraft(acList) {
    if (!Array.isArray(acList)) return null;
    var best = null;
    for (var i = 0; i < acList.length; i++) {
      var snapshot = acList[i];
      var hex = normalizeAircraftHex(snapshot && snapshot.hex);
      if (!hex || snapshot.lat == null || snapshot.lon == null) continue;
      if (snapshot.seen != null && snapshot.seen > 60) continue;
      if (!best || snapshot.seen == null || snapshot.seen < best.seen) {
        best = {
          hex: hex,
          lat: snapshot.lat,
          lng: snapshot.lon,
          callsign: (snapshot.flight || "").trim().toUpperCase() || null,
          seen: snapshot.seen == null ? 0 : snapshot.seen
        };
      }
    }
    return best ? {
      hex: best.hex,
      lat: best.lat,
      lng: best.lng,
      callsign: best.callsign
    } : null;
  }

  async function fetchLookup(path) {
    var resp = await fetch(adsbUrl(path));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  }

  async function lookupAircraftQuery(query) {
    if (!query) return null;
    if (query.type === "hex") {
      var hexData = await fetchLookup("/hex/" + encodeURIComponent(query.value));
      return pickLiveAircraft(hexData.ac || []);
    }
    var variants = query.variants || [query.value];
    for (var i = 0; i < variants.length; i++) {
      var callsignData = await fetchLookup("/callsign/" + encodeURIComponent(variants[i]));
      var found = pickLiveAircraft(callsignData.ac || []);
      if (found) return found;
    }
    return null;
  }

  function queuePendingPlaneFocus(hex, options) {
    var normalized = normalizeAircraftHex(hex);
    if (!normalized) return null;
    pendingPlaneFocus = {
      hex: normalized,
      keepUrl: !options || options.keepUrl !== false,
      label: options && options.label ? options.label : normalized.toUpperCase(),
      lookupAttempts: options && options.lookupAttempts != null ? options.lookupAttempts : 0,
      loading: false,
      failed: false,
      reason: options && options.reason ? options.reason : "search"
    };
    syncUrlState();
    return pendingPlaneFocus;
  }

  function clearPendingPlaneFocus() {
    if (!pendingPlaneFocus) return;
    pendingPlaneFocus = null;
    syncUrlState();
  }

  function fallbackToUserLocation() {
    clearPendingPlaneFocus();
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          var lat = pos.coords.latitude;
          var lng = pos.coords.longitude;
          updateUserPosition(lat, lng);
          map.setView([lat, lng], map.getZoom());
          referenceMode = "device";
          referenceMeta = null;
          updateReferenceNote();
          shouldWatchUserPosition = true;
          startGeolocation();
        },
        function() {
          fetchApproximateArea().then(function(approx) {
            if (!approx) return;
            updateUserPosition(approx.lat, approx.lng);
            map.setView([approx.lat, approx.lng], map.getZoom());
            referenceMode = approx.approximate ? "approximate" : "default";
            referenceMeta = approx;
            updateReferenceNote();
          });
        },
        { timeout: 5000 }
      );
    } else {
      fetchApproximateArea().then(function(approx) {
        if (!approx) return;
        updateUserPosition(approx.lat, approx.lng);
        map.setView([approx.lat, approx.lng], map.getZoom());
        referenceMode = approx.approximate ? "approximate" : "default";
        referenceMeta = approx;
        updateReferenceNote();
      });
    }
  }

  function buildPlaneShareUrl(id) {
    var normalized = normalizeAircraftHex(id);
    var plane = normalized ? findAircraftById(normalized) : null;
    var pose = normalized ? getDisplayPoseForAircraft(normalized, currentDisplayTime(Date.now())) : null;
    var lat = pose ? pose.lat : (plane ? plane.lat : (map ? map.getCenter().lat : paramLat));
    var lng = pose ? pose.lng : (plane ? plane.lng : (map ? map.getCenter().lng : paramLng));
    var zoom = Math.max(map ? map.getZoom() : DEFAULT_MAP_ZOOM, SEARCH_MIN_ZOOM);
    var url = new URL(location.href);
    url.searchParams.set("lat", lat.toFixed(4));
    url.searchParams.set("lng", lng.toFixed(4));
    url.searchParams.set("zoom", String(Math.round(zoom * 4) / 4));
    if (normalized) url.searchParams.set("hex", normalized);
    else url.searchParams.delete("hex");
    url.searchParams.delete("radius");
    return url.toString();
  }

  async function sharePlaneById(id) {
    var normalized = normalizeAircraftHex(id);
    if (!normalized) return;
    var url = buildPlaneShareUrl(normalized);
    try {
      if (navigator.share) {
        await navigator.share({
          title: "Contrails",
          text: "Track this aircraft in Contrails",
          url: url
        });
        setControlsFeedback("Share link ready.", "success", { timeoutMs: 2400 });
        return;
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        setControlsFeedback("Plane link copied.", "success", { timeoutMs: 3200 });
        return;
      }
    } catch (_) {}
    window.prompt("Copy this Contrails link:", url);
    setControlsFeedback("Copy the plane link from the dialog.", "info", { timeoutMs: 5000 });
  }

  function focusAircraftById(id, options) {
    options = options || {};
    var plane = findAircraftById(id);
    if (!plane) return false;
    var filtersChanged = false;
    if (options.reveal !== false) {
      if (plane.ground && !filters.ground) {
        filters.ground = true;
        filtersChanged = true;
      }
      if (plane.private && !filters.private) {
        filters.private = true;
        filtersChanged = true;
      }
      if (filtersChanged) updateFilterButtons();
    }
    if (selectedAircraftId !== plane.icao24) setSelectedAircraft(plane.icao24);
    else if (filtersChanged) renderMap();
    var marker = markerMap[plane.icao24];
    if (options.center && map) {
      var pose = getDisplayPoseForAircraft(plane.icao24, currentDisplayTime(Date.now())) || { lat: plane.lat, lng: plane.lng };
      map.flyTo([pose.lat, pose.lng], Math.max(map.getZoom(), options.minZoom || SEARCH_MIN_ZOOM), {
        duration: options.duration == null ? 0.75 : options.duration,
        easeLinearity: 0.18
      });
    }
    if (marker && options.openPopup !== false) marker.openPopup();
    return true;
  }

  function centerMapOnPlane(lat, lng, minZoom) {
    if (!map) return;
    var targetZoom = Math.max(map.getZoom(), minZoom || SEARCH_MIN_ZOOM);
    var center = map.getCenter();
    var moved = !center ||
      Math.abs(center.lat - lat) > 1e-4 ||
      Math.abs(center.lng - lng) > 1e-4 ||
      Math.abs(map.getZoom() - targetZoom) > 0.01;
    if (moved) {
      map.flyTo([lat, lng], targetZoom, { duration: 0.75, easeLinearity: 0.18 });
    } else {
      fetchAircraft({ source: "lookup" });
    }
  }

  function tryResolvePendingPlaneFocus() {
    if (!pendingPlaneFocus) return false;
    if (!focusAircraftById(pendingPlaneFocus.hex, { center: false, openPopup: true })) return false;
    pendingPlaneFocus = null;
    syncUrlState();
    return true;
  }

  async function maybeLookupPendingPlaneFocus() {
    if (!pendingPlaneFocus ||
        (pendingPlaneFocus.reason !== "shared-link" && pendingPlaneFocus.reason !== "search") ||
        pendingPlaneFocus.loading || pendingPlaneFocus.failed ||
        pendingPlaneFocus.lookupAttempts >= SHARED_PLANE_LOOKUP_LIMIT) {
      return;
    }
    pendingPlaneFocus.loading = true;
    pendingPlaneFocus.lookupAttempts += 1;
    setControlsFeedback(
      pendingPlaneFocus.reason === "search" ? "Finding plane\u2026" : "Finding shared plane\u2026",
      "info", { persistent: true }
    );
    try {
      var found = await lookupAircraftQuery({
        type: "hex",
        value: pendingPlaneFocus.hex,
        variants: [pendingPlaneFocus.hex]
      });
      if (!pendingPlaneFocus) return;
      if (found) {
        setControlsFeedback(
          pendingPlaneFocus.reason === "search" ? "Centering on plane\u2026" : "Centering on shared plane\u2026",
          "info", { timeoutMs: 4000 }
        );
        centerMapOnPlane(found.lat, found.lng, SEARCH_MIN_ZOOM);
      } else if (pendingPlaneFocus.lookupAttempts >= SHARED_PLANE_LOOKUP_LIMIT) {
        pendingPlaneFocus.failed = true;
        setControlsFeedback("Plane not currently available.", "warning", { timeoutMs: 6000 });
        if (pendingPlaneFocus && pendingPlaneFocus.reason === "shared-link") {
          fallbackToUserLocation();
        }
      }
    } catch (_) {
      if (pendingPlaneFocus && pendingPlaneFocus.lookupAttempts >= SHARED_PLANE_LOOKUP_LIMIT) {
        var reason = pendingPlaneFocus.reason;
        pendingPlaneFocus.failed = true;
        setControlsFeedback(
          reason === "search"
            ? "Couldn\u2019t find that plane right now."
            : "Couldn\u2019t look up the shared plane right now.",
          "warning", { timeoutMs: 6000 }
        );
        if (reason === "shared-link") {
          fallbackToUserLocation();
        }
      }
    } finally {
      if (pendingPlaneFocus) pendingPlaneFocus.loading = false;
    }
  }

  function updateControlsCompactSummary(visibleCount) {
    var el = document.getElementById("controls-compact-summary");
    if (!el) return;
    if (visibleCount == null) {
      visibleCount = 0;
      for (var i = 0; i < aircraft.length; i++) {
        if (!isFiltered(aircraft[i])) visibleCount++;
      }
    }
    var summary = visibleCount > 0
      ? visibleCount + " planes in view"
      : (aircraft.length ? "No planes in view" : "Scanning for planes");
    el.textContent = summary;
  }

  function setControlsExpanded(expanded) {
    var wrap = document.getElementById("map-controls");
    var toggle = document.getElementById("controls-toggle");
    var icon = document.getElementById("controls-toggle-icon");
    if (!wrap || !toggle || !icon) return;
    wrap.classList.toggle("expanded", !!expanded);
    wrap.classList.toggle("collapsed", !expanded);
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    icon.textContent = expanded ? "-" : "+";
  }

  function updateSummaryUi() {
    updateControlsCompactSummary();
  }

  function updateFilterButtons() {
    var btns = document.querySelectorAll("[data-f]");
    for (var i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute("data-f");
      btns[i].classList.toggle("on", !!filters[key]);
    }
  }

  function clearMapFetchTimer() {
    if (!mapFetchTimer) return;
    clearTimeout(mapFetchTimer);
    mapFetchTimer = null;
  }

  function clearRefreshTimer() {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  function scheduleRefreshTimer(delayMs) {
    clearRefreshTimer();
    refreshTimer = setTimeout(function() {
      refreshTimer = null;
      fetchAircraft({ source: "poll" });
    }, delayMs);
  }

  function scheduleMapFetch(delayMs) {
    clearMapFetchTimer();
    clearRefreshTimer();
    mapFetchTimer = setTimeout(function() {
      mapFetchTimer = null;
      fetchAircraft({ source: "viewport" });
    }, delayMs);
  }

  function viewportFetchDelayMs() {
    var spec = currentViewportFetchSpec();
    return spec && spec.fetchKm >= WIDE_VIEW_FETCH_KM ? MAP_FETCH_IDLE_MS_WIDE : MAP_FETCH_IDLE_MS;
  }

  function adaptiveRefreshMs() {
    if (lastFetchKm < 80) return REFRESH_MS;
    if (lastFetchKm <= 220) return 8000;
    return 12000;
  }

  function currentViewBounds(padRatio) {
    if (!map) return null;
    var bounds = map.getBounds();
    return padRatio ? bounds.pad(padRatio) : bounds;
  }

  function currentViewCenter() {
    if (map) return map.getCenter();
    if (userLat != null && userLng != null) return L.latLng(userLat, userLng);
    return null;
  }

  function currentViewportFetchSpec() {
    var center = currentViewCenter();
    var bounds = currentViewBounds();
    if (!center || !bounds) return null;
    var spec = buildViewportFetchSpec({
      lat: center.lat,
      lng: center.lng
    }, {
      northEast: bounds.getNorthEast(),
      northWest: bounds.getNorthWest(),
      southEast: bounds.getSouthEast(),
      southWest: bounds.getSouthWest()
    }, {
      minKm: MIN_VIEW_FETCH_KM,
      maxKm: MAX_VIEW_FETCH_KM,
      pad: FETCH_RADIUS_PAD,
      wideViewKm: WIDE_VIEW_FETCH_KM,
      zoom: map ? map.getZoom() : DEFAULT_MAP_ZOOM
    });
    lastFetchKm = spec.fetchKm;
    return spec;
  }

  function currentViewPolicy(visibleCount) {
    var spec = currentViewportFetchSpec();
    return buildViewPolicy({
      zoom: spec ? spec.zoom : (map ? map.getZoom() : DEFAULT_MAP_ZOOM),
      fetchKm: spec ? spec.fetchKm : lastFetchKm,
      visibleCount: visibleCount,
      labelsEnabled: filters.labels
    }, {
      wideViewKm: WIDE_VIEW_FETCH_KM,
      routeFetchMaxKm: ROUTE_FETCH_MAX_KM,
      routeFetchMinZoom: ROUTE_FETCH_MIN_ZOOM,
      labelMinZoom: LABEL_MIN_ZOOM,
      labelMaxVisiblePlanes: LABEL_MAX_VISIBLE_PLANES
    });
  }

  function isLatLngInView(lat, lng, padRatio) {
    var bounds = currentViewBounds(padRatio == null ? VIEW_FILTER_PAD : padRatio);
    if (!bounds) return true;
    return bounds.contains([lat, lng]);
  }

  function visibleAircraftCount() {
    var count = 0;
    for (var i = 0; i < aircraft.length; i++) {
      if (!isFiltered(aircraft[i])) count++;
    }
    return count;
  }

  function formatReferenceLabel(meta) {
    if (!meta) return "";
    if (meta.label) return meta.label;
    var parts = [];
    if (meta.city) parts.push(meta.city);
    if (meta.region && meta.region !== meta.city) parts.push(meta.region);
    if (meta.country) parts.push(meta.country);
    return parts.join(", ");
  }

  function updateReferenceNote() {
    var note = document.getElementById("reference-note");
    if (!note) return;
    var label = formatReferenceLabel(referenceMeta);
    if (referenceMode === "approximate") {
      note.textContent = label
        ? "Using an approximate network area near " + label + ". Enter coordinates for more precise distances."
        : "Using an approximate network area. Enter coordinates for more precise distances.";
      return;
    }
    if (referenceMode === "default") {
      note.textContent = "Using " + (label || "the default browse area") + " as the reference area.";
      return;
    }
    if (referenceMode === "manual") {
      note.textContent = "Using " + (label || "your selected area") + " as the reference area.";
      return;
    }
    note.textContent = "Using your live location for distance and bearing.";
  }

  function updateViewHint(visibleCount) {
    var hint = document.getElementById("view-hint");
    if (!hint) return;
    var policy = currentViewPolicy(visibleCount);
    if (!policy.showLabels) {
      hint.textContent = visibleCount > LABEL_MAX_VISIBLE_PLANES
        ? "Labels are hidden in busy views. Zoom in or filter more planes."
        : "Labels appear once you zoom in a little more.";
      return;
    }
    if (!policy.allowRoutes) {
      hint.textContent = policy.fetchKm > ROUTE_FETCH_MAX_KM
        ? "Routes load when you zoom into a smaller area."
        : "Routes load when you zoom in a little more.";
      return;
    }
    hint.textContent = "Altitude colors run from warm low altitudes to cool high altitudes.";
  }

  function refreshViewportUi(options) {
    options = options || {};
    if (!map) return;
    syncUrlState();
    refreshAircraftProximity();
    renderAirports();
    renderRunways();
    renderMap();
    updateStatus();
    updateAlerts();
    updateReferenceNote();
    updateViewHint(visibleAircraftCount());
    if (refreshSearchUi) refreshSearchUi();
    if (options.fetch === false || suppressViewportRefresh) return;
    scheduleMapFetch(options.fetchDelay != null ? options.fetchDelay : viewportFetchDelayMs());
  }

  function updateUserPosition(lat, lng) {
    userLat = lat;
    userLng = lng;
    if (shouldWatchUserPosition && map && !userMarker) {
      userMarker = L.circleMarker([lat, lng], {
        radius: 7, fillColor: "#5bbcf5", fillOpacity: 1,
        color: "#fff", weight: 2
      }).addTo(map);
    }
    if (userMarker) userMarker.setLatLng([lat, lng]);
    refreshAircraftProximity();
    renderMap();
    updateStatus();
    updateAlerts();
    updateReferenceNote();
  }

  function pruneStaleHistoryEntries(activeIds, now) {
    for (var id in posHistory) {
      if (activeIds[id]) continue;
      var history = posHistory[id];
      var lastPoint = history && history.length ? history[history.length - 1] : null;
      if (!lastPoint || now - lastPoint[2] > STALE_HISTORY_MS) {
        delete posHistory[id];
        delete trailBreakPending[id];
        delete dormantHistory[id];
        delete trackExtended[id];
      } else {
        dormantHistory[id] = true;
      }
    }
  }

  // --- Data fetching ---
  async function fetchAircraft(options) {
    options = options || {};
    if (!map) return;
    clearMapFetchTimer();
    clearRefreshTimer();
    var spec = currentViewportFetchSpec();
    if (!spec) {
      scheduleRefreshTimer(adaptiveRefreshMs());
      return;
    }
    syncUrlState();
    var url = adsbUrl("/lat/" + spec.center.lat.toFixed(4) + "/lon/" + spec.center.lng.toFixed(4) + "/dist/" + spec.fetchKm);
    var requestSeq = ++fetchRequestSeq;
    if (fetchAbortController && !options.skipAbort) fetchAbortController.abort();
    var controller = new AbortController();
    fetchAbortController = controller;

    try {
      var resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();
      if (requestSeq !== fetchRequestSeq) return;
      if (!workerOk) { workerOk = true; setProxyBannerVisible(false); }
      processAircraft(data.ac || []);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (workerOk && !isLocal) {
        workerOk = false;
        setProxyBannerVisible(true);
        return fetchAircraft({ source: options.source, skipAbort: true });
      }
      updateControlsCompactSummary(0);
      setControlsFeedback("Live traffic unavailable: " + err.message, "warning", { timeoutMs: 6000 });
      updateViewHint(0);
    } finally {
      if (fetchAbortController === controller) fetchAbortController = null;
      if (map) scheduleRefreshTimer(adaptiveRefreshMs());
    }
  }

  function processAircraft(ac) {
    var now = Date.now();
    if (lastFetchTs) updatePlaybackDelay(now - lastFetchTs);
    else updatePlaybackDelay(null);
    lastFetchTs = now;
    aircraft = [];
    var activeIds = {};
    for (var i = 0; i < ac.length; i++) {
      var s = ac[i];
      var hex = normalizeAircraftHex(s.hex);
      var isGround = s.alt_baro === "ground";
      if (!hex) continue;
      if (!isGround && s.alt_baro == null) continue;
      if (s.lat == null || s.lon == null) continue;
      if (s.category && /^C/.test(s.category)) continue;
      if (sizeClass(s.t || null, s.category || null) === "heli") continue;
      if (s.seen != null && s.seen > 15) continue;
      var heading = s.track != null ? s.track : (s.true_heading != null ? s.true_heading : s.mag_heading);
      if (isGround && heading == null) continue;

      var callsign = (s.flight || "").trim() || null;
      var priv = isPrivate(callsign, s.t || null, s.category || null);
      var squawk = s.squawk || null;
      var emerg = s.emergency && s.emergency !== "none" ? s.emergency : null;
      var metrics = proximityMetrics(s.lat, s.lon, s.dir != null ? s.dir : 0);
      var viewDistKm = viewportDistanceKm(s.lat, s.lon);
      var reportTs = now - Math.max(0, (s.seen_pos || 0) * 1000);
      activeIds[hex] = true;

      aircraft.push({
        icao24: hex,
        callsign: callsign,
        aircraftType: s.t || null,
        category: s.category || null,
        registration: s.r || null,
        lat: s.lat, lng: s.lon,
        altFt: isGround ? null : (typeof s.alt_baro === "number" ? Math.round(s.alt_baro) : null),
        ground: isGround,
        speedKts: s.gs != null ? Math.round(s.gs) : null,
        track: heading,
        vRate: s.baro_rate != null ? s.baro_rate / 60 : null,
        distKm: metrics.distKm,
        viewDistKm: viewDistKm != null ? roundTenths(viewDistKm) : null,
        bearingDeg: metrics.bearingDeg,
        cardinal: metrics.cardinal,
        private: priv,
        mach: s.mach || null,
        ias: s.ias != null ? Math.round(s.ias) : null,
        oat: s.oat != null ? Math.round(s.oat) : null,
        windDir: s.wd != null ? Math.round(s.wd) : null,
        windSpd: s.ws != null ? Math.round(s.ws) : null,
        navAlt: s.nav_altitude_mcp || s.nav_altitude_fms || null,
        squawk: squawk,
        emergency: emerg,
        reportTs: reportTs,
        seen: s.seen != null ? s.seen : null,
        seenPos: s.seen_pos != null ? s.seen_pos : null,
        roll: s.roll != null ? Math.round(s.roll * 10) / 10 : null
      });
    }

    sortAircraftList();

    for (var j = 0; j < aircraft.length; j++) {
      var a = aircraft[j];
      if (dormantHistory[a.icao24]) {
        delete posHistory[a.icao24];
        delete dormantHistory[a.icao24];
        delete trailBreakPending[a.icao24];
      }
      if (!posHistory[a.icao24]) posHistory[a.icao24] = [];
      var h = posHistory[a.icao24];
      var reportTs = a.reportTs;
      seedSyntheticTrail(h, a, reportTs);
      var lastPt = h.length ? h[h.length - 1] : null;
      if (lastPt && reportTs <= lastPt[2]) reportTs = lastPt[2] + 1;
      var breakBefore = !!trailBreakPending[a.icao24] && !!lastPt;
      if (trailBreakPending[a.icao24]) delete trailBreakPending[a.icao24];
      var moved = !lastPt ||
        breakBefore ||
        Math.abs(lastPt[0] - a.lat) > 1e-5 ||
        Math.abs(lastPt[1] - a.lng) > 1e-5 ||
        lastPt[4] !== a.ground ||
        reportTs - lastPt[2] > Math.max(1500, fetchInterval * 0.9);
      if (moved) h.push([a.lat, a.lng, reportTs, a.altFt, a.ground, breakBefore]);
      pruneSeededTrailPrefix(h);
      var maxPts = trackExtended[a.icao24] ? 600 : 120;
      if (h.length > maxPts) h.splice(0, h.length - maxPts);
    }
    pruneStaleHistoryEntries(activeIds, now);

    renderMap();
    refreshAirportLabels();
    if (refreshSearchUi) refreshSearchUi();
    if (!tryResolvePendingPlaneFocus()) maybeLookupPendingPlaneFocus();
    updateStatus();
    updateAlerts();
    updateViewHint(visibleAircraftCount());
    fetchRoutes();
    clientConvergenceRefine();
    if (_activeAirportPopup && _activeAirportLat != null) {
      var now = Date.now();
      if (now - _lastScheduleRefresh >= 3000) {
        _lastScheduleRefresh = now;
        renderSchedulePopup(_activeScheduleDir);
      }
    }
    proactiveFetchTracks();
    proactiveScheduleSweep();
    proactiveFr24SearchSweep();
  }

  async function fetchRoutes() {
    if (!aircraft.length) return;
    var visible = aircraft.filter(function(a) { return !isFiltered(a); });
    var policy = currentViewPolicy(visible.length);
    if (!policy.allowRoutes) return;
    var needed = [];
    var now = Date.now();
    for (var i = 0; i < visible.length && needed.length < 20; i++) {
      var a = visible[i];
      var cached = a.callsign ? routeCache[a.callsign] : null;
      var hiConfSrc = cached && (cached.destSource === "fr24-search" || cached.destSource === "schedule" || cached.destSource === "cross-validated");
      var stale = cached && !hiConfSrc && (!cached.fetchedAt || now - cached.fetchedAt > 10 * 60 * 1000);
      if (a.callsign && !a.private && (!cached || stale)) {
        needed.push({
          callsign: a.callsign,
          hex: a.icao24,
          lat: a.lat,
          lng: a.lng,
          altFt: a.altFt,
          vRate: a.vRate != null ? Math.round(a.vRate * 60) : null,
          ground: a.ground
        });
      }
    }
    if (!needed.length) return;
    try {
      var resp = await fetch(routesetUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: needed })
      });
      if (!resp.ok) return;
      var routes = await resp.json();
      var adsbdbCallsigns = [];
      for (var j = 0; j < routes.length; j++) {
        var r = routes[j];
        if (!r.callsign || (!r.origin && !r.destination)) continue;
        var dest = r.destination;
        var destIata = dest ? (dest.region ? dest.display : dest.iata) : null;
        var iataParts = [r.origin ? r.origin.iata : null, destIata].filter(Boolean);
        routeCache[r.callsign] = {
          display: r.display || iataParts.join(" to "),
          iata: iataParts.join(" to "),
          origin: r.origin || null,
          destination: dest || null,
          originSource: r.originSource || null,
          destSource: r.destSource || null,
          confidence: r.confidence || null,
          phase: r.phase || null,
          fetchedAt: Date.now()
        };
        if (r.destSource === "adsbdb" || r.originSource === "adsbdb") {
          adsbdbCallsigns.push(r.callsign);
        }
      }
      for (var ac = 0; ac < adsbdbCallsigns.length; ac++) {
        var cs = adsbdbCallsigns[ac];
        if (fr24SearchPending[cs] || isLikelyPrivateCallsign(cs)) continue;
        var plane = aircraft.find(function(p) { return p.callsign === cs; });
        if (plane) {
          fr24SearchPending[cs] = true;
          tryFr24Search(plane).then((function(c) { return function() { delete fr24SearchPending[c]; }; })(cs));
        }
      }
      refreshAirportLabels();
    } catch (e) {
      console.warn("Route fetch failed:", e);
    }
  }

  function clientConvergenceRefine() {
    if (!airportData) return;
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign || a.private || a.ground) continue;
      var rc = routeCache[a.callsign];
      if (rc && rc.destination && rc.originSource === "track") continue;
      if (a.altFt != null && a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) {
        var hiSrc = ["adsbdb", "track", "cross-validated", "schedule", "fr24-search"];
        if (!rc || !rc.origin || hiSrc.indexOf(rc.originSource) === -1) {
          var depCands = [];
          for (var dc = 0; dc < airportData.length; dc++) {
            var dap = airportData[dc];
            var dd = haversineKm(a.lat, a.lng, dap[1], dap[2]);
            if (dd < 30) depCands.push({ iata: dap[0], name: dap[3], dist: dd });
          }
          if (depCands.length > 0) {
            depCands.sort(function(x, y) { return x.dist - y.dist; });
            if (depCands.length >= 2 && depCands[1].dist <= depCands[0].dist * 1.5) continue;
            var depOrigin = { iata: depCands[0].iata, name: depCands[0].name };
            if (rc) {
              rc.origin = depOrigin;
              rc.originSource = "convergence";
              var depParts = [depOrigin.iata, rc.destination ? rc.destination.iata : null].filter(Boolean);
              rc.iata = depParts.join(" to ");
              rc.display = formatClientRouteLabel(depOrigin, rc.destination, "departing");
            } else {
              routeCache[a.callsign] = {
                display: formatClientRouteLabel(depOrigin, null, "departing"),
                iata: depOrigin.iata,
                origin: depOrigin,
                destination: null,
                originSource: "convergence",
                destSource: null,
                confidence: "medium",
                phase: "departing",
                fetchedAt: Date.now()
              };
            }
            continue;
          }
        }
      }
      if (a.altFt != null && a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) continue;
      var h = posHistory[a.icao24];
      if (!h) continue;
      var realH = [];
      for (var rhi = 0; rhi < h.length; rhi++) { if (!h[rhi][6]) realH.push(h[rhi]); }
      if (realH.length < 10) continue;
      var tail = realH.length > 50 ? realH.slice(-50) : realH;
      var minAlt = Infinity;
      for (var t = 0; t < tail.length; t++) {
        if (tail[t][3] != null && tail[t][3] < minAlt) minAlt = tail[t][3];
      }
      if (minAlt > 10000) continue;
      var last = tail[tail.length - 1];
      var candidates = [];
      for (var j = 0; j < airportData.length; j++) {
        var ap = airportData[j];
        var d = haversineKm(last[0], last[1], ap[1], ap[2]);
        if (d < 80) candidates.push({ iata: ap[0], name: ap[3], lat: ap[1], lon: ap[2], dist: d });
      }
      candidates.sort(function(x, y) { return x.dist - y.dist; });
      if (candidates.length > 5) candidates.length = 5;
      if (!candidates.length) continue;
      var bestScore = 0, secondScore = 0, bestApt = null;
      for (var c = 0; c < candidates.length; c++) {
        var apt = candidates[c];
        var dists = [];
        for (var p = 0; p < tail.length; p++) {
          dists.push(haversineKm(tail[p][0], tail[p][1], apt.lat, apt.lon));
        }
        var dec = 0;
        for (var k = 1; k < dists.length; k++) { if (dists[k] < dists[k - 1]) dec++; }
        var pct = dec / (dists.length - 1);
        var net = dists[dists.length - 1] - dists[0];
        var finalD = dists[dists.length - 1];
        var minD = Math.min.apply(null, dists);
        var score = 0;
        if (net < 0) score = pct * Math.abs(net) / Math.max(finalD, 0.1);
        if (minD < 5) score += (5 - minD) / 5 * 8;
        if (score > bestScore) {
          secondScore = bestScore;
          bestScore = score;
          bestApt = apt;
        } else if (score > secondScore) {
          secondScore = score;
        }
      }
      if (!bestApt || bestScore <= 0) continue;
      if (secondScore > 0 && secondScore / bestScore > 0.8) {
        if (!a.private && !isLikelyPrivateCallsign(a.callsign) &&
            a.altFt != null && a.altFt < 15000 && a.vRate != null && a.vRate * 60 < -100) {
          var region = findNearestRegion(last[0], last[1], 100);
          if (region) {
            var regionDest = { region: region.name, display: "Landing in " + region.name };
            var regionPhase = "arriving";
            if (rc) {
              rc.destination = regionDest;
              rc.destSource = "region";
              rc.confidence = "low";
              rc.iata = rc.origin ? rc.origin.iata + " to " + regionDest.display : regionDest.display;
              rc.display = formatClientRouteLabel(rc.origin, regionDest, regionPhase);
              rc.phase = regionPhase;
            } else {
              routeCache[a.callsign] = {
                display: formatClientRouteLabel(null, regionDest, regionPhase),
                iata: regionDest.display,
                origin: null,
                destination: regionDest,
                originSource: null,
                destSource: "region",
                confidence: "low",
                phase: regionPhase,
                fetchedAt: Date.now()
              };
            }
          }
        }
        continue;
      }
      var dest = { iata: bestApt.iata, name: bestApt.name };
      if (rc) {
        if (rc.destination && rc.destination.iata === dest.iata) {
          if (rc.destSource === "adsbdb") {
            if (rc.originSource === "adsbdb") rc.originSource = "cross-validated";
            rc.confidence = "high";
          }
          continue;
        }
        var adsbdbDestDisagrees = rc.destination && rc.destSource === "adsbdb" && rc.destination.iata !== dest.iata;
        rc.destination = dest;
        if (adsbdbDestDisagrees) {
          rc.origin = null;
          rc.originSource = null;
          rc.destSource = "convergence";
          rc.confidence = "medium";
        } else if (rc.originSource === "adsbdb") {
          rc.destSource = "cross-validated";
          rc.confidence = "high";
        } else {
          rc.destSource = "convergence";
        }
        var iataParts = [rc.origin ? rc.origin.iata : null, dest.iata].filter(Boolean);
        rc.iata = iataParts.join(" to ");
        var phase = a.ground ? "landed" :
          (a.altFt < 15000 && a.vRate != null && a.vRate * 60 < -100) ? "arriving" :
          (a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) ? "departing" : "cruising";
        rc.display = formatClientRouteLabel(rc.origin, dest, phase);
        rc.phase = phase;
      } else {
        var phase2 = a.ground ? "landed" :
          (a.altFt < 15000 && a.vRate != null && a.vRate * 60 < -100) ? "arriving" :
          (a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) ? "departing" : "cruising";
        routeCache[a.callsign] = {
          display: formatClientRouteLabel(null, dest, phase2),
          iata: dest.iata,
          origin: null,
          destination: dest,
          originSource: "client",
          destSource: "convergence",
          confidence: "medium",
          phase: phase2,
          fetchedAt: Date.now()
        };
      }
    }
  }

  function formatClientRouteLabel(origin, destination, phase) {
    var oIata = origin ? origin.iata : null;
    var oName = oIata ? airportDisplayName(oIata) : null;
    var dName = null;
    if (destination && destination.region) {
      dName = destination.display || destination.region;
    } else if (destination && destination.iata) {
      dName = airportDisplayName(destination.iata);
    }
    if (oName && dName) return oName + " to " + dName;
    if (oName) return oName;
    if (dName) return dName;
    return "";
  }

  var lastProactiveFetch = 0;
  var proactivePending = {};
  function proactiveFetchTracks() {
    if (openskyProxyOk === false) return;
    var now = Date.now();
    if (now - lastProactiveFetch < 30000) return;
    lastProactiveFetch = now;
    var targets = [];
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign || a.private || a.ground || isFiltered(a)) continue;
      if (trackExtended[a.icao24] || proactivePending[a.icao24]) continue;
      var rc = routeCache[a.callsign];
      if (rc && ((rc.origin && rc.originSource === "track") || rc.confidence === "high")) continue;
      targets.push(a.icao24);
      if (targets.length >= 2) break;
    }
    for (var j = 0; j < targets.length; j++) {
      (function(hex) {
        proactivePending[hex] = true;
        fetchProxyTrack(hex).then(function(data) {
          delete proactivePending[hex];
          if (data && (data.path ? data.path.length : data.length)) {
            trackExtended[hex] = true;
            ingestTrackPath(hex, data);
          }
        }).catch(function() { delete proactivePending[hex]; });
      })(targets[j]);
    }
  }

  function proximityMetrics(lat, lng, fallbackBearing) {
    var bearing = fallbackBearing != null ? fallbackBearing : 0;
    var distKm = null;
    if (userLat != null && userLng != null) {
      distKm = haversineKm(userLat, userLng, lat, lng);
      bearing = bearingDegrees(userLat, userLng, lat, lng);
    }
    return {
      distKm: distKm != null ? roundTenths(distKm) : null,
      bearingDeg: bearing,
      cardinal: cardinalDir(bearing)
    };
  }

  function viewportDistanceKm(lat, lng) {
    var center = currentViewCenter();
    if (!center) return null;
    return haversineKm(center.lat, center.lng, lat, lng);
  }

  function updateAircraftProximity(a) {
    var metrics = proximityMetrics(a.lat, a.lng, a.bearingDeg);
    a.distKm = metrics.distKm;
    a.bearingDeg = metrics.bearingDeg;
    a.cardinal = metrics.cardinal;
    var viewDistKm = viewportDistanceKm(a.lat, a.lng);
    a.viewDistKm = viewDistKm != null ? roundTenths(viewDistKm) : null;
    var raw = slantKm(a.distKm, a.altFt);
    a.slantKm = raw != null ? roundTenths(raw) : null;
  }

  function sortAircraftList() {
    aircraft.sort(function(a, b) {
      if (a.emergency && !b.emergency) return -1;
      if (!a.emergency && b.emergency) return 1;
      if (a.ground && !b.ground) return 1;
      if (!a.ground && b.ground) return -1;
      var distA = a.slantKm != null ? a.slantKm : (a.viewDistKm != null ? a.viewDistKm : 999);
      var distB = b.slantKm != null ? b.slantKm : (b.viewDistKm != null ? b.viewDistKm : 999);
      return distA - distB;
    });
  }

  function refreshAircraftProximity() {
    if (!aircraft.length) return;
    for (var i = 0; i < aircraft.length; i++) updateAircraftProximity(aircraft[i]);
    sortAircraftList();
  }

  function resetInterpolationSamples() {
    for (var id in extraState) {
      if (extraState[id] && extraState[id].samples) {
        extraState[id].samples = extraState[id].samples.slice(-2);
      }
    }
  }

  function currentDisplayTime(now) {
    return now - playbackDelayMs;
  }

  function updatePlaybackDelay(observedIntervalMs) {
    var baseline = fetchInterval;
    if (observedIntervalMs != null) {
      fetchInterval = fetchInterval * 0.7 + observedIntervalMs * 0.3;
      var deviation = Math.abs(observedIntervalMs - baseline);
      fetchJitterMs = fetchJitterMs * 0.75 + deviation * 0.25;
    }
    var targetDelay = computePlaybackDelayMs(fetchInterval, fetchJitterMs, {
      minMs: PLAYBACK_DELAY_MIN_MS,
      maxMs: PLAYBACK_DELAY_MAX_MS,
      safetyMs: PLAYBACK_DELAY_SAFETY_MS
    });
    playbackDelayMs = playbackDelayMs * 0.8 + targetDelay * 0.2;
  }

  function currentPlaybackExtrapolationMs() {
    var adaptiveMs = fetchInterval * 0.58 + fetchJitterMs * 0.22;
    return Math.round(Math.max(PLAYBACK_EXTRAPOLATION_MS, Math.min(PLAYBACK_EXTRAPOLATION_MAX_MS, adaptiveMs)));
  }

  function getDisplayPoseForSamples(samples, displayTime) {
    return interpolatePlaybackPose(samples, displayTime, {
      maxExtrapolationMs: currentPlaybackExtrapolationMs()
    });
  }

  function getDisplayPoseForAircraft(id, displayTime) {
    var st = extraState[id];
    if (!st || !st.samples || !st.samples.length) return null;
    var pose = getDisplayPoseForSamples(st.samples, displayTime);
    if (pose) st.displayPose = pose;
    return pose;
  }

  function buildDisplayTrailSegments(trail, a, displayPose, displayTime) {
    if (!trail || trail.length < 2 || !displayPose) return [];
    var isSelected = selectedAircraftId === a.icao24;
    var headTs = displayPose.ts;
    var trailMs = trailWindowMs(a);
    var windowStart = isSelected ? -Infinity : headTs - trailMs;
    var built = [];

    for (var j = 1; j < trail.length; j++) {
      var prev = {
        lat: trail[j - 1][0],
        lng: trail[j - 1][1],
        ts: trail[j - 1][2],
        altFt: trail[j - 1][3],
        ground: trail[j - 1][4],
        synthetic: !!trail[j - 1][6]
      };
      var next = {
        lat: trail[j][0],
        lng: trail[j][1],
        ts: trail[j][2],
        altFt: trail[j][3],
        ground: trail[j][4],
        breakBefore: trail[j][5],
        synthetic: !!trail[j][6]
      };

      if (next.breakBefore) continue;
      if (headTs <= prev.ts) break;
      if (next.ts <= windowStart) continue;

      var visibleStart = prev;
      if (!isSelected && windowStart > prev.ts) {
        if (windowStart >= next.ts) continue;
        var clippedStart = interpolateTimedPose(prev, next, windowStart);
        visibleStart = {
          lat: clippedStart.lat,
          lng: clippedStart.lng,
          ts: clippedStart.ts,
          altFt: next.altFt,
          ground: next.ground,
          synthetic: prev.synthetic || next.synthetic
        };
      }

      var visibleEnd = next;
      if (headTs < next.ts) {
        var clippedEnd = interpolateTimedPose(prev, next, headTs);
        visibleEnd = {
          lat: clippedEnd.lat,
          lng: clippedEnd.lng,
          ts: clippedEnd.ts,
          altFt: next.altFt,
          ground: next.ground,
          synthetic: prev.synthetic || next.synthetic
        };
      }

      if (visibleEnd.ts <= visibleStart.ts) continue;
      built.push({
        latlngs: [[visibleStart.lat, visibleStart.lng], [visibleEnd.lat, visibleEnd.lng]],
        startTs: visibleStart.ts,
        endTs: visibleEnd.ts,
        altFt: visibleEnd.altFt,
        ground: visibleEnd.ground,
        synthetic: visibleEnd.synthetic
      });

      if (headTs < next.ts) break;
    }

    var last = trail[trail.length - 1];
    if (displayPose.ts > last[2] && last[2] >= windowStart) {
      built.push({
        latlngs: [[last[0], last[1]], [displayPose.lat, displayPose.lng]],
        startTs: last[2],
        endTs: displayPose.ts,
        altFt: last[3],
        ground: last[4],
        synthetic: !!last[6]
      });
    }

    if (!built.length) return [];
    var ageSpan = isSelected ? Math.max(1, headTs - built[0].startTs) : trailMs;
    var segments = [];
    for (var i = 0; i < built.length; i++) {
      var seg = built[i];
      var ageNorm = Math.max(0, Math.min(1, (headTs - seg.endTs) / ageSpan));
      if (seg.synthetic) ageNorm = Math.min(1, ageNorm * 1.25 + 0.08);
      var style = trailStyle(ageNorm, isSelected, seg.synthetic);
      segments.push({
        latlngs: seg.latlngs,
        color: seg.ground ? GROUND_COLOR : altColor(seg.altFt),
        opacity: style.opacity,
        weight: style.weight
      });
    }
    return segments;
  }

  function seedSyntheticTrail(history, a, reportTs) {
    if (history.length || a.ground) return;
    var trailTrack = a.track != null ? a.track : a.bearingDeg;
    if (trailTrack == null) return;
    var speedMs = Math.max(SEEDED_MIN_DISPLAY_SPEED_KTS, a.speedKts || 0) * 0.514444;
    var stepMs = SEEDED_TRAIL_WINDOW_MS / SEEDED_TRAIL_POINTS;
    var reverseTrack = (trailTrack + 180) % 360;
    for (var i = SEEDED_TRAIL_POINTS; i >= 1; i--) {
      var ageMs = stepMs * i;
      var point = projectLatLng(a.lat, a.lng, reverseTrack, speedMs * ageMs / 1000);
      if (!isLatLngInView(point[0], point[1], TRAIL_VIEW_PAD)) continue;
      history.push([point[0], point[1], reportTs - ageMs, a.altFt, false, false, true]);
    }
  }

  function pruneSeededTrailPrefix(history) {
    var realCount = 0;
    for (var i = 0; i < history.length; i++) {
      if (!history[i][6]) realCount++;
    }
    if (realCount < 8) return;
    while (history.length && history[0][6]) history.shift();
  }

  async function fetchAirports() {
    if (!map) return;
    if (airportData) {
      renderAirports();
      return;
    }
    try {
      var resp = await fetch("airports.json");
      if (!resp.ok) return;
      airportData = await resp.json();
      buildAirportCityIndex();
      renderAirports();
    } catch (e) { console.warn("Airport fetch failed:", e); }
  }

  var airportCityIndex = {};
  function buildAirportCityIndex() {
    if (!airportData) return;
    for (var i = 0; i < airportData.length; i++) {
      var ap = airportData[i];
      if (ap[4]) airportCityIndex[ap[0]] = ap[4];
    }
  }

  function airportCityName(iata) {
    return airportCityIndex[iata] || null;
  }

  function airportDisplayName(iata) {
    var city = airportCityName(iata);
    return city ? city + " (" + iata + ")" : iata;
  }

  function buildAirportLabelHtml(iata) {
    return escapeHtml(iata);
  }

  function refreshAirportLabels() {}

  function renderAirports() {
    airportLayer.clearLayers();
    for (var k in airportMarkers) delete airportMarkers[k];
    var bounds = currentViewBounds(AIRPORT_VIEW_PAD);
    if (!airportData || !bounds) return;
    for (var i = 0; i < airportData.length; i++) {
      var ap = airportData[i];
      if (!bounds.contains([ap[1], ap[2]])) continue;
      var iata = ap[0], name = ap[3] || iata;
      (function(code, apName, lat, lng) {
        var m = L.circleMarker([lat, lng], {
          radius: 6, fillColor: "#2a3f55", fillOpacity: 1,
          color: "#8aa0b8", weight: 2,
          pane: "airportCirclePane"
        })
        .bindTooltip(buildAirportLabelHtml(code, lat, lng), {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          className: "airport-label",
          interactive: true,
          pane: "airportTooltipPane"
        })
        .on("click", function() { openAirportSchedulePopup(code, apName, lat, lng); })
        .addTo(airportLayer);
        airportMarkers[code] = { marker: m, lat: lat, lng: lng };
        var el = m.getTooltip() && m.getTooltip().getElement();
        if (el) el.addEventListener("click", function() { openAirportSchedulePopup(code, apName, lat, lng); });
      })(iata, name, ap[1], ap[2]);
    }
  }

  async function fetchRunways() {
    if (runwayData) return;
    try {
      var resp = await fetch("runways.json");
      if (!resp.ok) return;
      runwayData = await resp.json();
      renderRunways();
    } catch (e) {
      console.warn("Runway fetch failed:", e);
    }
  }

  function renderRunways() {
    runwayLayer.clearLayers();
    var bounds = currentViewBounds(AIRPORT_VIEW_PAD);
    if (!runwayData || !bounds) return;
    for (var iata in runwayData) {
      var rwys = runwayData[iata];
      for (var j = 0; j < rwys.length; j++) {
        var r = rwys[j];
        if (!bounds.contains([(r[0] + r[3]) / 2, (r[1] + r[4]) / 2])) continue;
        L.polyline([[r[0],r[1]], [r[3],r[4]]], {
          color: "#7a8a9f", weight: 2.5, opacity: 0.7, dashArray: "8,5"
        }).bindTooltip(r[6], {
          permanent: false, direction: "center", className: "runway-label"
        }).addTo(runwayLayer);
      }
    }
  }

  function updateStatus() {
    var visible = aircraft.filter(function(a) { return !isFiltered(a); });
    updateControlsCompactSummary(visible.length);
  }

  function updateAlerts() {
    var bar = document.getElementById("alert-bar");
    var alerts = [];
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (isFiltered(a)) continue;
      var label = SQUAWK_ALERT[a.squawk];
      if (label || a.emergency) {
        var name = a.callsign || a.icao24;
        alerts.push(name + ": " + (label || a.emergency.toUpperCase()));
      }
    }
    if (alerts.length) {
      bar.textContent = alerts.join(" | ");
      bar.style.display = "block";
    } else {
      bar.style.display = "none";
    }
  }

  function altColor(altFt) {
    if (altFt == null) return "#8899aa";
    var t = Math.pow(Math.max(0, Math.min(1, altFt / 42000)), 0.4);
    // red(low) → orange → yellow → green → blue(high)
    var stops = [
      [0,     0, 95, 48],
      [0.2,  25, 95, 52],
      [0.4,  48, 95, 50],
      [0.65,120, 80, 45],
      [0.85,170, 70, 48],
      [1.0, 210, 75, 55]
    ];
    var i = 0;
    for (var j = 1; j < stops.length; j++) { if (t <= stops[j][0]) { i = j - 1; break; } }
    if (t > stops[stops.length - 1][0]) i = stops.length - 2;
    var a = stops[i], b = stops[i + 1];
    var f = (t - a[0]) / (b[0] - a[0]);
    var h = Math.round(a[1] + (b[1] - a[1]) * f);
    var s = Math.round(a[2] + (b[2] - a[2]) * f);
    var l = Math.round(a[3] + (b[3] - a[3]) * f);
    return "hsl(" + h + "," + s + "%," + l + "%)";
  }

  // --- Rendering ---
  const GROUND_TRAIL_MS = 15000;
  const trailLines = {};

  function trailWindowMs(a) {
    if (a.ground) return GROUND_TRAIL_MS;
    var zoom = map ? map.getZoom() : 11;
    if (zoom <= 5) return 8000;
    if (zoom <= 6) return 10000;
    if (zoom <= 7) return 12000;
    if (zoom <= 8) return 16000;
    if (zoom <= 9) return 24000;
    if (zoom <= 10) return 34000;
    if (zoom <= 11) return 46000;
    if (zoom <= 12) return 62000;
    return 82000;
  }

  function trailStyle(ageNorm, isSelected, isSynthetic) {
    var opacityFloor = isSelected ? 0.28 : 0.12;
    var opacitySpan = isSelected ? 0.62 : 0.58;
    var exponent = isSelected ? 1.15 : 1.65;
    var opacity = opacityFloor + opacitySpan * Math.pow(1 - ageNorm, exponent);
    if (isSynthetic) opacity *= isSelected ? 0.86 : 0.72;
    return {
      opacity: opacity,
      weight: isSelected ? 3.3 : (isSynthetic ? 2.2 : 2.5)
    };
  }

  function renderTrails(now, displayPoses) {
    if (_isZooming) return;
    now = now || Date.now();
    var zoom = map ? map.getZoom() : 11;
    var markerCount = Object.keys(markerMap).length;
    var trailsOff = !filters.trails || (zoom < 7 && markerCount > 120);
    if (trailsOff) {
      if (trailLayer.getLayers().length) trailLayer.clearLayers();
      for (var id in trailLines) delete trailLines[id];
      return;
    }

    var displayTime = currentDisplayTime(now);
    var activeIds = {};

    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (isFiltered(a)) continue;
      var pose = displayPoses && displayPoses[a.icao24] ? displayPoses[a.icao24] : getDisplayPoseForAircraft(a.icao24, displayTime);
      var segments = buildDisplayTrailSegments(posHistory[a.icao24], a, pose, displayTime);
      if (!segments.length) continue;

      activeIds[a.icao24] = true;
      var segs = trailLines[a.icao24] || (trailLines[a.icao24] = []);
      while (segs.length > segments.length) {
        trailLayer.removeLayer(segs.shift());
      }

      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        if (si < segs.length) {
          segs[si].setLatLngs(seg.latlngs);
          segs[si].setStyle({ color: seg.color, opacity: seg.opacity, weight: seg.weight });
        } else {
          var line = L.polyline(seg.latlngs, {
            color: seg.color, weight: seg.weight, opacity: seg.opacity,
            lineCap: "round", lineJoin: "round"
          }).addTo(trailLayer);
          segs.push(line);
        }
      }
    }

    for (var tid in trailLines) {
      if (!activeIds[tid]) {
        var old = trailLines[tid];
        for (var r = 0; r < old.length; r++) trailLayer.removeLayer(old[r]);
        delete trailLines[tid];
      }
    }
  }

  function buildPopup(a, policy) {
    policy = policy || currentViewPolicy(visibleAircraftCount());
    var titleSource = a.callsign || a.registration || a.icao24;
    var title = escapeHtml(titleSource);
    var alt = a.ground ? "On ground" : (a.altFt != null ? a.altFt.toLocaleString() + " ft" : "\u2014");
    var spd = a.speedKts != null ? formatSpeedMph(a.speedKts) + " mph" : "\u2014";
    var vert = a.ground ? "" : vertLabel(a.vRate);
    var typeStr = escapeHtml(a.aircraftType);
    var regStr = a.registration && a.registration !== titleSource ? escapeHtml(a.registration) : "";
    var typeLine = [typeStr, regStr].filter(Boolean).join(" &middot; ");
    if (typeLine) typeLine += "<br>";

    var machStr = a.mach ? "M" + a.mach.toFixed(2) : "";
    var iasStr = a.ias ? "IAS " + a.ias : "";
    var detail2 = [machStr, iasStr].filter(Boolean).join(" &middot; ");
    if (detail2) detail2 = '<span style="color:#8899aa">' + detail2 + "</span><br>";

    var windLine = "";
    if (a.windDir != null && a.windSpd != null) {
      windLine = '<span style="color:#667">Wind ' + a.windDir + "&deg; " + formatSpeedMph(a.windSpd) + " mph";
      if (a.oat != null) windLine += " &middot; OAT " + a.oat + "&deg;C";
      windLine += "</span><br>";
    }

    var emergLine = "";
    if (a.emergency || SQUAWK_ALERT[a.squawk]) {
      var emergText = SQUAWK_ALERT[a.squawk] || escapeHtml(a.emergency).toUpperCase();
      emergLine = '<span style="color:#f87171;font-weight:700">' + emergText + "</span><br>";
    }

    var rc = a.callsign ? routeCache[a.callsign] : null;
    var subheaderHtml = buildPopupSubheader(a, rc);

    var distanceLine = "";
    if (a.slantKm != null) {
      distanceLine = formatDistanceMiles(a.slantKm) + " mi " + escapeHtml(a.cardinal);
    } else if (a.viewDistKm != null) {
      distanceLine = formatDistanceMiles(a.viewDistKm) + " mi from view";
    }
    var distanceHtml = distanceLine ? distanceLine + "<br>" : "";

    var safeHex = escapeHtml(a.icao24);
    var photoHtml = '<div class="popup-photo" data-hex="' + safeHex + '">';
    var cached = photoCache[a.icao24];
    if (cached && cached.src) {
      photoHtml += '<img src="' + escapeHtml(cached.src) + '" style="width:100%;border-radius:6px;display:block;margin-bottom:6px" alt="Aircraft photo">';
    }
    photoHtml += '</div>';
    var shareButton = '<button type="button" class="popup-share" data-hex="' + safeHex + '" aria-label="Share plane" title="Share plane">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="18" cy="5" r="2.5"></circle>' +
      '<circle cx="6" cy="12" r="2.5"></circle>' +
      '<circle cx="18" cy="19" r="2.5"></circle>' +
      '<path d="M8.3 10.8l7.4-4.1M8.3 13.2l7.4 4.1"></path>' +
      '</svg>' +
      '</button>';

    return photoHtml +
      '<div class="popup-header"><div class="popup-title"><strong>' + title + "</strong>" + subheaderHtml + "</div>" + shareButton + "</div>" +
      emergLine + typeLine + alt + " &middot; " + spd + " &middot; " + vert + "<br>" +
      detail2 + windLine +
      distanceHtml;
  }

  function popupRouteDisplay(routeEntry) {
    if (!routeEntry) return "";
    return routeEntry.display || routeEntry.iata || "";
  }

  function buildPopupSubheader(a, routeEntry) {
    var airline = !a.private && a.callsign ? airlineName(a.callsign) : "";
    var routeDisplay = popupRouteDisplay(routeEntry);
    if (!airline && !routeDisplay) return "";
    var html = "";
    if (airline) html += '<span class="popup-airline"> &middot; ' + escapeHtml(airline) + "</span>";
    if (routeDisplay) {
      html += '<div class="popup-route">' + escapeHtml(routeDisplay) + "</div>";
    }
    return html;
  }

  function loadPopupPhoto(container) {
    var hex = container.getAttribute("data-hex");
    if (!hex) return;
    if (photoCache[hex] === null) return;
    if (photoCache[hex]) return;
    if (photoPending[hex]) return;
    photoPending[hex] = true;
    fetch(photoUrl(hex))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.src) { photoCache[hex] = null; return; }
        photoCache[hex] = data;
        renderPhoto(container, data);
      })
      .catch(function() { photoCache[hex] = null; })
      .finally(function() {
        delete photoPending[hex];
      });
  }

  function renderPhoto(container, photo) {
    container.innerHTML =
      '<img src="' + escapeHtml(photo.src) + '" style="width:100%;border-radius:6px;display:block;margin-bottom:6px" alt="Aircraft photo">';
  }

  function ingestTrackPath(hex, data) {
    var path = data.path || data;
    if (!path || !path.length) return;
    var history = posHistory[hex];
    if (!history) { posHistory[hex] = []; history = posHistory[hex]; }
    var earliestLive = history.length ? history[0][2] : Infinity;
    var converted = [];
    for (var i = 0; i < path.length; i++) {
      var pt = path[i];
      var ts = pt[0], lat = pt[1], lon = pt[2], altM = pt[3];
      var tsMs = ts > 1e12 ? ts : ts * 1000;
      if (tsMs >= earliestLive - 5000) break;
      var altFt = altM != null ? Math.round(altM * 3.28084) : null;
      var onGround = altFt != null && altFt <= 0;
      converted.push([lat, lon, tsMs, onGround ? null : altFt, onGround, i === 0]);
    }
    if (converted.length) {
      posHistory[hex] = converted.concat(history);
      runOriginDetection(hex, data);
    }
  }

  function runOriginDetection(hex, data) {
    if (!airportData) return;
    var cs = null;
    for (var i = 0; i < aircraft.length; i++) {
      if (aircraft[i].icao24 === hex) { cs = aircraft[i].callsign; break; }
    }
    if (!cs) return;
    var rc = routeCache[cs];
    if (rc && rc.origin && (rc.originSource === "track" || rc.originSource === "cross-validated")) return;
    var path = data.path || data;
    if (!path || path.length < 5) return;
    var scanEnd = Math.max(20, Math.floor(path.length * 0.25));
    var originPt = null;
    for (var i = 0; i < scanEnd && i < path.length; i++) {
      var altM = path[i][3];
      if (altM != null && altM <= 2500) { originPt = path[i]; break; }
    }
    if (!originPt) return;
    var bestDist = Infinity, bestApt = null;
    for (var j = 0; j < airportData.length; j++) {
      var ap = airportData[j];
      var d = haversineKm(originPt[1], originPt[2], ap[1], ap[2]);
      if (d < bestDist) { bestDist = d; bestApt = ap; }
    }
    if (!bestApt || bestDist > 15) return;
    var origin = { iata: bestApt[0], name: bestApt[3] };
    if (rc) {
      if (rc.originSource === "adsbdb" && rc.origin && rc.origin.iata === origin.iata &&
          rc.destSource === "adsbdb" && rc.destination) {
        rc.destSource = "cross-validated";
        rc.confidence = "high";
      }
      rc.origin = origin;
      rc.originSource = "track";
      var oIata = origin.iata;
      var dIata = rc.destination ? (rc.destination.region ? rc.destination.display : rc.destination.iata) : null;
      rc.iata = [oIata, dIata].filter(Boolean).join(" to ");
      rc.display = formatClientRouteLabel(origin, rc.destination, rc.phase || "cruising");
    } else {
      routeCache[cs] = {
        display: formatClientRouteLabel(origin, null, "cruising"),
        iata: origin.iata,
        origin: origin,
        destination: null,
        originSource: "track",
        destSource: null,
        phase: "cruising",
        fetchedAt: Date.now()
      };
    }
  }

  function fetchProxyTrack(hex) {
    if (openskyProxyOk === false) return Promise.resolve(null);
    return fetch(OPENSKY_PROXY + "/track?hex=" + hex, { signal: AbortSignal.timeout(5000) })
      .then(function(r) {
        if (r.ok) {
          openskyProxyOk = true;
          return r.json();
        }
        return r.json().catch(function() { return {}; }).then(function(body) {
          if (r.status === 503 && body.retryAfter) {
            var pauseMs = Math.min(body.retryAfter * 1000, 30 * 60 * 1000);
            console.warn("[contrails] OpenSky rate-limited — retrying in " + Math.round(pauseMs / 60000) + "m");
            openskyProxyOk = false;
            setTimeout(function() { openskyProxyOk = null; }, pauseMs);
          } else {
            openskyProxyOk = false;
            setTimeout(function() { openskyProxyOk = null; }, 5 * 60 * 1000);
          }
          return null;
        });
      })
      .catch(function() {
        openskyProxyOk = false;
        setTimeout(function() { openskyProxyOk = null; }, 5 * 60 * 1000);
        return null;
      });
  }

  function loadPopupTrack(hex) {
    if (!hex || trackExtended[hex]) return;
    trackExtended[hex] = true;
    fetchProxyTrack(hex).then(function(data) {
      if (data && (data.path ? data.path.length : data.length)) {
        ingestTrackPath(hex, data);
        return;
      }
      return fetch(trackUrl(hex))
        .then(function(r) { return r.json(); })
        .then(function(fallback) { ingestTrackPath(hex, fallback); });
    }).catch(function() {});
  }

  function fetchScheduleData(iata) {
    var cached = scheduleDataCache[iata];
    if (cached && Date.now() - cached.ts < SCHEDULE_CACHE_TTL) return Promise.resolve(cached.data);
    var url = (isLocal ? "/api/fr24/schedule/" : WORKER_URL + "/schedule/") + encodeURIComponent(iata);
    return fetch(url).then(function(r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function(data) {
      if (data) scheduleDataCache[iata] = { data: data, ts: Date.now() };
      return data;
    }).catch(function() { return null; });
  }

  function findScheduleMatch(variants, schedData, iata) {
    var arrs = schedData.arrivals || [];
    var deps = schedData.departures || [];
    for (var v = 0; v < variants.length; v++) {
      var vUpper = variants[v].toUpperCase();
      for (var ai = 0; ai < arrs.length; ai++) {
        var row = arrs[ai];
        if ((row.callsign || "").toUpperCase() === vUpper ||
            (row.flight || "").replace(/\s/g, "").toUpperCase() === vUpper) {
          return { dir: "arrival", airport: iata, airportName: schedData.name || iata, row: row, from: row.from_iata || null };
        }
      }
      for (var di = 0; di < deps.length; di++) {
        var row = deps[di];
        if ((row.callsign || "").toUpperCase() === vUpper ||
            (row.flight || "").replace(/\s/g, "").toUpperCase() === vUpper) {
          return { dir: "departure", airport: iata, airportName: schedData.name || iata, row: row, to: row.to_iata || null };
        }
      }
    }
    return null;
  }

  function applyScheduleMatch(a, match) {
    if (!a || !match) return false;
    var currentRc = routeCache[a.callsign];
    var origin = null, destination = null, originSource = null, destSource = null;

    var descending = a.altFt != null && a.altFt < 18000 && a.vRate != null && a.vRate * 60 < -200;
    var climbing = a.altFt != null && a.altFt < 18000 && a.vRate != null && a.vRate * 60 > 200;
    var nearAirport = airportData && (function() {
      for (var i = 0; i < airportData.length; i++) {
        if (airportData[i][0] === match.airport &&
            haversineKm(a.lat, a.lng, airportData[i][1], airportData[i][2]) < 80) return true;
      }
      return false;
    })();

    var dir = match.dir;
    if (dir === "departure" && descending && nearAirport) {
      dir = "arrival-flipped";
    } else if (dir === "arrival" && climbing && nearAirport) {
      dir = "departure-flipped";
    }

    var flipped = dir === "arrival-flipped" || dir === "departure-flipped";

    if (dir === "arrival" || dir === "arrival-flipped") {
      destination = { iata: match.airport, name: match.airportName };
      destSource = flipped ? "convergence" : "schedule";
      var counterIata = dir === "arrival" ? match.from : match.to;
      var counterName = dir === "arrival" ? (match.row.from_name || match.from) : (match.row.to_name || match.to);
      if (counterIata) {
        origin = { iata: counterIata, name: counterName || counterIata };
        originSource = flipped ? "schedule-inferred" : "schedule";
      } else if (currentRc && currentRc.origin) {
        origin = currentRc.origin;
        originSource = currentRc.originSource;
      }
    } else {
      origin = { iata: match.airport, name: match.airportName };
      originSource = flipped ? "convergence" : "schedule";
      var counterIata = dir === "departure" ? match.to : match.from;
      var counterName = dir === "departure" ? (match.row.to_name || match.to) : (match.row.from_name || match.from);
      if (counterIata) {
        destination = { iata: counterIata, name: counterName || counterIata };
        destSource = flipped ? "schedule-inferred" : "schedule";
      } else if (currentRc && currentRc.destination) {
        destination = currentRc.destination;
        destSource = currentRc.destSource;
      }
    }

    var phase = a.ground ? "landed" :
      (a.altFt < 15000 && a.vRate != null && a.vRate * 60 < -100) ? "arriving" :
      (a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) ? "departing" : "cruising";

    routeCache[a.callsign] = {
      display: formatClientRouteLabel(origin, destination, phase),
      iata: [origin ? origin.iata : null, destination ? destination.iata : null].filter(Boolean).join(" to "),
      origin: origin,
      destination: destination,
      originSource: originSource || (currentRc ? currentRc.originSource : null),
      destSource: destSource || (currentRc ? currentRc.destSource : null),
      confidence: flipped ? "medium" : "high",
      phase: phase,
      fetchedAt: Date.now()
    };
    return true;
  }

  var lastScheduleFetch = 0;

  function proactiveScheduleSweep() {
    if (!aircraft.length || !airportData) return;
    var policy = currentViewPolicy(visibleAircraftCount());
    if (!policy.allowRoutes) return;

    cascadeScheduleMatches();

    var now = Date.now();
    if (now - lastScheduleFetch < SCHEDULE_CACHE_TTL) return;
    lastScheduleFetch = now;

    var bounds = currentViewBounds(AIRPORT_VIEW_PAD);
    if (!bounds) return;
    var visible = [];
    for (var i = 0; i < airportData.length; i++) {
      var ap = airportData[i];
      if (bounds.contains([ap[1], ap[2]])) visible.push(ap[0]);
    }
    if (!visible.length) return;
    if (visible.length > 3) visible.length = 3;

    var fetches = visible.map(function(iata) { return fetchScheduleData(iata); });
    Promise.all(fetches).then(function() {
      cascadeScheduleMatches();
    });
  }

  function cascadeScheduleMatches() {
    var updated = 0;
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign || a.private) continue;
      var rc = routeCache[a.callsign];
      if (rc && rc.destSource === "schedule") continue;
      var variants = callsignVariants(a.callsign);
      if (!variants.length) continue;
      for (var iata in scheduleDataCache) {
        var cached = scheduleDataCache[iata];
        if (!cached || Date.now() - cached.ts > SCHEDULE_CACHE_TTL) continue;
        var match = findScheduleMatch(variants, cached.data, iata);
        if (match && applyScheduleMatch(a, match)) {
          updated++;
          break;
        }
      }
    }
    if (updated > 0) refreshAirportLabels();
    return updated;
  }

  var lastFr24SearchSweep = 0;
  var fr24SearchPending = {};
  var fr24SearchFailed = {};

  function proactiveFr24SearchSweep() {
    if (!aircraft.length) return;
    var policy = currentViewPolicy(visibleAircraftCount());
    if (!policy.allowRoutes) return;
    var now = Date.now();
    if (now - lastFr24SearchSweep < 5000) return;
    lastFr24SearchSweep = now;

    var targets = [];
    var deferred = [];
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign || a.private) continue;
      if (fr24SearchPending[a.callsign]) continue;
      if (fr24SearchFailed[a.callsign] && now - fr24SearchFailed[a.callsign] < 120000) continue;
      if (isLikelyPrivateCallsign(a.callsign)) continue;
      var rc = routeCache[a.callsign];
      if (rc && rc.destSource === "fr24-search") continue;
      if (rc && (rc.destSource === "adsbdb" || rc.originSource === "adsbdb")) {
        targets.push(a);
      } else {
        deferred.push(a);
      }
    }
    for (var d = 0; d < deferred.length && targets.length < 5; d++) {
      targets.push(deferred[d]);
    }
    if (targets.length > 5) targets.length = 5;

    for (var t = 0; t < targets.length; t++) {
      (function(plane) {
        fr24SearchPending[plane.callsign] = true;
        tryFr24Search(plane).then(function() {
          delete fr24SearchPending[plane.callsign];
          var rc = routeCache[plane.callsign];
          if (!rc || rc.destSource !== "fr24-search") {
            fr24SearchFailed[plane.callsign] = Date.now();
          }
        });
      })(targets[t]);
    }
  }

  async function tryFr24Search(a) {
    if (!a || a.private || !a.callsign) return;
    var variants = callsignVariants(a.callsign);
    if (!variants.length) return;
    var rc = routeCache[a.callsign];
    if (rc && (rc.destSource === "schedule" || rc.destSource === "fr24-search" || rc.destSource === "cross-validated")) return;

    var iataCs = variants.length > 1 ? variants[1] : variants[0];
    var url = (isLocal ? "/api/fr24/search/" : WORKER_URL + "/fr24search/") + encodeURIComponent(iataCs);

    try {
      var resp = await fetch(url);
      if (!resp.ok) return;
      var data = await resp.json();
      var results = data.results || [];
      if (!Array.isArray(results)) return;

      var variantsUpper = variants.map(function(v) { return v.toUpperCase(); });
      var matched = null;
      for (var i = 0; i < results.length; i++) {
        var entry = results[i];
        if (entry.type !== "live" || !entry.detail) continue;
        var candidates = [
          (entry.detail.callsign || "").replace(/\s/g, "").toUpperCase(),
          (entry.detail.flight || "").replace(/\s/g, "").toUpperCase(),
          (entry.id || "").replace(/\s/g, "").toUpperCase()
        ];
        for (var v = 0; v < variantsUpper.length; v++) {
          if (candidates.indexOf(variantsUpper[v]) !== -1) { matched = entry; break; }
        }
        if (matched) break;
      }

      if (!matched || !matched.detail) return;
      var from = matched.detail.schd_from;
      var to = matched.detail.schd_to;
      if (!from || !to) return;

      var origin = { iata: from, name: from };
      var destination = { iata: to, name: to };
      var phase = a.ground ? "landed" :
        (a.altFt < 15000 && a.vRate != null && a.vRate * 60 < -100) ? "arriving" :
        (a.altFt < 15000 && a.vRate != null && a.vRate * 60 > 100) ? "departing" : "cruising";

      routeCache[a.callsign] = {
        display: formatClientRouteLabel(origin, destination, phase),
        iata: from + " to " + to,
        origin: origin,
        destination: destination,
        originSource: "fr24-search",
        destSource: "fr24-search",
        confidence: "high",
        phase: phase,
        fetchedAt: Date.now()
      };

      var marker = markerMap[a.icao24];
      if (marker && marker.getPopup() && marker.getPopup().isOpen()) {
        marker.getPopup().setContent(buildPopup(a));
      }
    } catch (err) {
      console.warn("FR24 search failed for", a.callsign, err);
    }
  }

  function matchScheduleRoute(hex) {
    var a = findAircraftById(hex);
    if (!a || !a.callsign || a.private) return;
    var rc = routeCache[a.callsign];
    if (rc && rc.destSource === "schedule") return;

    var variants = callsignVariants(a.callsign);
    if (!variants.length) return;

    var candidateIatas = [];
    if (rc && rc.destination && rc.destination.iata) candidateIatas.push(rc.destination.iata);
    if (rc && rc.origin && rc.origin.iata) candidateIatas.push(rc.origin.iata);

    var hasRouteCandidates = candidateIatas.length > 0;
    if (!hasRouteCandidates && a.altFt != null && a.altFt > 25000 && !a.ground) { tryFr24Search(a); return; }

    if (!candidateIatas.length && airportData) {
      var nearby = [];
      for (var i = 0; i < airportData.length; i++) {
        var ap = airportData[i];
        var d = haversineKm(a.lat, a.lng, ap[1], ap[2]);
        if (d < 120) nearby.push({ iata: ap[0], dist: d });
      }
      nearby.sort(function(x, y) { return x.dist - y.dist; });
      for (var j = 0; j < Math.min(nearby.length, 3); j++) {
        candidateIatas.push(nearby[j].iata);
      }
    }

    var unique = [];
    var seen = {};
    for (var k = 0; k < candidateIatas.length; k++) {
      if (!seen[candidateIatas[k]]) {
        seen[candidateIatas[k]] = true;
        unique.push(candidateIatas[k]);
      }
    }
    if (!unique.length) { tryFr24Search(a); return; }

    var fetches = unique.map(function(iata) { return fetchScheduleData(iata); });
    Promise.all(fetches).then(function(results) {
      var matched = false;
      for (var r = 0; r < results.length; r++) {
        if (!results[r]) continue;
        var match = findScheduleMatch(variants, results[r], unique[r]);
        if (match) {
          applyScheduleMatch(a, match);
          matched = true;
          break;
        }
      }

      if (!matched) tryFr24Search(a);

      var cascaded = cascadeScheduleMatches();

      var marker = markerMap[hex];
      if (marker && marker.getPopup() && marker.getPopup().isOpen()) {
        var updatedA = findAircraftById(hex);
        if (updatedA) marker.getPopup().setContent(buildPopup(updatedA));
      }
      refreshAirportLabels();
    });
  }

  function collectOccupiedScreenPoints() {
    if (!map) return [];
    var points = [];
    var bounds = map.getBounds();
    if (airportData) {
      for (var i = 0; i < airportData.length; i++) {
        var ap = airportData[i];
        if (bounds.contains([ap[1], ap[2]])) {
          var pt = map.latLngToContainerPoint([ap[1], ap[2]]);
          points.push({ x: pt.x, y: pt.y, w: 50, h: 22 });
        }
      }
    }
    for (var id in markerMap) {
      var m = markerMap[id];
      var ll = m.getLatLng();
      if (ll && bounds.contains(ll)) {
        var pt = map.latLngToContainerPoint(ll);
        points.push({ x: pt.x, y: pt.y, w: 30, h: 30 });
      }
    }
    var popup = map._popup;
    if (popup && popup._latlng && bounds.contains(popup._latlng)) {
      var pt = map.latLngToContainerPoint(popup._latlng);
      points.push({ x: pt.x, y: pt.y - 80, w: 220, h: 160 });
    }
    return points;
  }

  var LABEL_DIRS = ["top", "right", "bottom", "left"];
  var LABEL_W = 56, LABEL_H = 18;

  function chooseLabelDirection(markerLatLng, occupiedPoints) {
    if (!map || !occupiedPoints || occupiedPoints.length < 2) return "top";
    var mp = map.latLngToContainerPoint(markerLatLng);
    var bestDir = "top";
    var bestScore = -Infinity;
    for (var d = 0; d < LABEL_DIRS.length; d++) {
      var dir = LABEL_DIRS[d];
      var lx, ly;
      if (dir === "top") { lx = mp.x; ly = mp.y - 26; }
      else if (dir === "bottom") { lx = mp.x; ly = mp.y + 26; }
      else if (dir === "right") { lx = mp.x + 34; ly = mp.y; }
      else { lx = mp.x - 34; ly = mp.y; }

      var hw = LABEL_W / 2, hh = LABEL_H / 2;
      var minDist = Infinity;
      for (var i = 0; i < occupiedPoints.length; i++) {
        var op = occupiedPoints[i];
        if (Math.abs(op.x - mp.x) < 4 && Math.abs(op.y - mp.y) < 4) continue;
        var ox = Math.max(0, Math.abs(lx - op.x) - (hw + op.w / 2));
        var oy = Math.max(0, Math.abs(ly - op.y) - (hh + op.h / 2));
        var gap = ox * ox + oy * oy;
        if (gap < minDist) minDist = gap;
      }
      if (minDist > bestScore) {
        bestScore = minDist;
        bestDir = dir;
      }
    }
    return bestDir;
  }

  function bindPlaneLabel(marker, text, yOffset, direction) {
    direction = direction || "top";
    var offset = direction === "top" ? [0, -yOffset] :
                 direction === "bottom" ? [0, yOffset] :
                 direction === "right" ? [yOffset, 0] : [-yOffset, 0];
    marker.bindTooltip(text, { permanent: true, direction: direction, offset: offset, className: "plane-label", pane: "planeLabelPane" });
    if (marker.getTooltip() && marker.getLatLng()) {
      marker.getTooltip().setLatLng(marker.getLatLng());
      marker.getTooltip().update();
    }
  }

  function markerIconKey(a) {
    return [
      a.track == null ? "" : Math.round(a.track * 10) / 10,
      a.aircraftType || "",
      a.private ? 1 : 0,
      a.category || "",
      a.altFt == null ? "" : a.altFt,
      a.ground ? 1 : 0
    ].join("|");
  }

  function currentMarkerLabelOffset(marker) {
    var icon = marker && marker.options ? marker.options.icon : null;
    var iconSize = icon && icon.options ? icon.options.iconSize : null;
    return iconSize && iconSize[1] ? iconSize[1] / 2 : 15;
  }

  function syncMarkerVisualState(marker, a, markerState, policy, isSelected, popupHtml, label, labelDir) {
    var iconKey = markerIconKey(a);
    if (markerState.iconKey !== iconKey) {
      marker.setIcon(planeIcon(a.track, a.aircraftType, a.private, a.category, a.altFt, a.ground));
      markerState.iconKey = iconKey;
    }
    if (markerState.popupHtml !== popupHtml) {
      marker.setPopupContent(popupHtml);
      markerState.popupHtml = popupHtml;
    }
    if (markerState.selected !== isSelected) {
      marker.setZIndexOffset(isSelected ? 1000 : 0);
      markerState.selected = isSelected;
    }
    var showLabels = !!policy.showLabels;
    var labelOffset = currentMarkerLabelOffset(marker);
    labelDir = labelDir || "top";
    if (showLabels) {
      if (!marker.getTooltip() || markerState.labelText !== label || markerState.labelOffset !== labelOffset || markerState.showLabels !== showLabels || markerState.labelDir !== labelDir) {
        if (marker.getTooltip()) marker.unbindTooltip();
        bindPlaneLabel(marker, label, labelOffset, labelDir);
      }
    } else if (marker.getTooltip()) {
      marker.unbindTooltip();
    }
    markerState.showLabels = showLabels;
    markerState.labelText = showLabels ? label : "";
    markerState.labelOffset = showLabels ? labelOffset : 0;
    markerState.labelDir = showLabels ? labelDir : "";
  }

  function syncMarkerPose(marker, pose) {
    if (!marker || !pose) return;
    var cur = marker.getLatLng();
    if (!cur || Math.abs(pose.lat - cur.lat) > 5e-6 || Math.abs(pose.lng - cur.lng) > 5e-6) {
      marker.setLatLng([pose.lat, pose.lng]);
    }
  }

  function scheduleMarkerAnimation(delayMs) {
    delayMs = delayMs == null ? 0 : delayMs;
    if (delayMs <= 0) {
      if (markerAnimationTimer) {
        clearTimeout(markerAnimationTimer);
        markerAnimationTimer = 0;
      }
      if (markerAnimationFrame) return;
      markerAnimationFrame = requestAnimationFrame(animateMarkers);
      return;
    }
    if (markerAnimationFrame || markerAnimationTimer) return;
    markerAnimationTimer = setTimeout(function() {
      markerAnimationTimer = 0;
      if (markerAnimationFrame) return;
      markerAnimationFrame = requestAnimationFrame(animateMarkers);
    }, delayMs);
  }

  function setSelectedAircraft(id) {
    var normalized = id ? normalizeAircraftHex(id) : null;
    if (selectedAircraftId === normalized) return;
    ignoreMapClickUntil = Date.now() + 250;
    selectedAircraftId = normalized;
    if (pendingPlaneFocus) pendingPlaneFocus = null;
    syncUrlState();
    renderMap();
  }

  function isFiltered(a) {
    if (!filters.ground && a.ground) return true;
    if (!filters.private && a.private) return true;
    if (!isLatLngInView(a.lat, a.lng, VIEW_FILTER_PAD)) return true;
    return false;
  }

  var _markerDrainTimer = 0;

  function markerAnimationIntervalMs(markerCount) {
    if (!markerCount) return 250;
    if (markerCount > 320) return 84;
    if (markerCount > 220) return 56;
    return MARKER_TARGET_INTERVAL_MS;
  }

  function renderMarkers(now, displayPoses) {
    now = now || Date.now();
    var displayTime = currentDisplayTime(now);
    var seen = {};
    var visibleCount = 0;
    for (var vc = 0; vc < aircraft.length; vc++) {
      if (!isFiltered(aircraft[vc])) visibleCount++;
    }
    var policy = currentViewPolicy(visibleCount);
    var occupiedPts = policy.showLabels ? collectOccupiedScreenPoints() : null;
    var newThisFrame = 0;
    var deferredNew = false;
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (isFiltered(a)) continue;
      seen[a.icao24] = true;

      var existing = markerMap[a.icao24];
      if (!existing && newThisFrame >= NEW_MARKER_BATCH) {
        deferredNew = true;
        continue;
      }

      var isSelected = selectedAircraftId === a.icao24;
      var label = a.callsign || a.icao24;

      var state = extraState[a.icao24] || {};
      var samples = state.samples ? state.samples.slice() : [];
      var reportTs = a.reportTs != null ? a.reportTs : now;
      var lastSample = samples.length ? samples[samples.length - 1] : null;
      var shouldAppend = true;
      if (lastSample) {
        var samePoint = Math.abs(lastSample.lat - a.lat) <= 1e-6 &&
          Math.abs(lastSample.lng - a.lng) <= 1e-6;
        if (reportTs <= lastSample.ts) {
          if (samePoint) shouldAppend = false;
          else reportTs = lastSample.ts + 1;
        } else if (samePoint && reportTs - lastSample.ts <= 1) {
          shouldAppend = false;
        }
      }
      if (shouldAppend) {
        samples.push({
          lat: a.lat,
          lng: a.lng,
          ts: reportTs,
          spdMs: (a.speedKts || 0) * 0.514444,
          trackDeg: a.track
        });
      }
      if (samples.length > 8) samples.splice(0, samples.length - 8);

      var displayPose = displayPoses && displayPoses[a.icao24] ? displayPoses[a.icao24] : getDisplayPoseForSamples(samples, displayTime);
      if (!displayPose) displayPose = { lat: a.lat, lng: a.lng, ts: reportTs, mode: "hold", usedExtrapolationMs: 0 };
      state.samples = samples;
      state.displayPose = displayPose;
      extraState[a.icao24] = state;
      var popupHtml = buildPopup(a, policy);

      var labelDir = policy.showLabels ? chooseLabelDirection([displayPose.lat, displayPose.lng], occupiedPts) : "top";

      if (existing) {
        syncMarkerPose(existing, displayPose);
        syncMarkerVisualState(existing, a, state, policy, isSelected, popupHtml, label, labelDir);
      } else {
        newThisFrame++;
        var icon = planeIcon(a.track, a.aircraftType, a.private, a.category, a.altFt, a.ground);
        var marker = L.marker([displayPose.lat, displayPose.lng], { icon: icon }).bindPopup(popupHtml, {
          closeButton: false
        });
        marker.on("click", (function(id) {
          return function() { setSelectedAircraft(id); };
        })(a.icao24));
        marker.setZIndexOffset(isSelected ? 1000 : 0);
        marker.addTo(aircraftLayer);
        if (policy.showLabels) {
          bindPlaneLabel(marker, label, icon.options.iconSize[1] / 2, labelDir);
        }
        markerMap[a.icao24] = marker;
        state.iconKey = markerIconKey(a);
        state.popupHtml = popupHtml;
        state.selected = isSelected;
        state.showLabels = !!policy.showLabels;
        state.labelText = policy.showLabels ? label : "";
        state.labelOffset = policy.showLabels ? icon.options.iconSize[1] / 2 : 0;
        state.labelDir = policy.showLabels ? labelDir : "";
      }
    }
    for (var id in markerMap) {
      if (!seen[id]) {
        aircraftLayer.removeLayer(markerMap[id]);
        delete markerMap[id];
        delete extraState[id];
      }
    }
    if (selectedAircraftId && !seen[selectedAircraftId]) {
      selectedAircraftId = null;
      syncUrlState();
    }
    if (deferredNew && !_markerDrainTimer) {
      _markerDrainTimer = setTimeout(function() {
        _markerDrainTimer = 0;
        renderMap();
      }, MARKER_DRAIN_DELAY_MS);
    }
  }

  var _lastAnimateTs = 0;
  function animateMarkers() {
    markerAnimationFrame = 0;
    var now = Date.now();
    var markerCount = Object.keys(markerMap).length;
    var minInterval = markerAnimationIntervalMs(markerCount);
    var elapsedMs = now - _lastAnimateTs;
    if (_lastAnimateTs && minInterval > 0 && elapsedMs < minInterval) {
      scheduleMarkerAnimation(Math.ceil(minInterval - elapsedMs));
      return;
    }
    _lastAnimateTs = now;
    var displayTime = currentDisplayTime(now);
    var displayPoses = {};
    for (var id in extraState) {
      var marker = markerMap[id];
      if (!marker) continue;
      var st = extraState[id];
      var samples = st.samples;
      if (!samples || !samples.length) continue;
      var pose = getDisplayPoseForSamples(samples, displayTime);
      if (!pose) continue;
      st.displayPose = pose;
      displayPoses[id] = pose;
      syncMarkerPose(marker, pose);
    }
    renderTrails(now, displayPoses);
    scheduleMarkerAnimation(minInterval);
  }

  function renderMap(now, displayPoses) {
    renderMarkers(now, displayPoses);
    renderTrails(now, displayPoses);
  }

  function vertLabel(rate) {
    if (rate == null || Math.abs(rate) < 0.5) return '<span class="vert-level">—</span>';
    if (rate > 0) return '<span class="vert-up">&uarr; climbing</span>';
    return '<span class="vert-down">&darr; descending</span>';
  }

  // --- Geolocation ---
  function setLoadingFallbackVisible(visible) {
    var loading = document.getElementById("loading");
    var actions = document.getElementById("loading-actions");
    if (!loading || !actions) return;
    loading.classList.toggle("fallback", !!visible);
    actions.hidden = !visible;
  }

  function setLoadingMessage(msg, showFallback) {
    document.getElementById("loading-text").textContent = msg;
    setLoadingFallbackVisible(!!showFallback);
  }

  function showLocationFallback(msg) {
    setLoadingMessage(msg, true);
  }

  async function fetchApproximateArea() {
    try {
      var resp = await fetch(geoUrl());
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var data = await resp.json();
      var lat = parseCoordinate(data.lat != null ? data.lat : data.latitude, -90, 90);
      var lng = parseCoordinate(data.lng != null ? data.lng : data.longitude, -180, 180);
      if (lat == null || lng == null) return null;
      return {
        lat: lat,
        lng: lng,
        city: data.city || "",
        region: data.region || "",
        country: data.country || "",
        timezone: data.timezone || "",
        label: data.label || "",
        source: data.source || "ip",
        approximate: data.approximate !== false
      };
    } catch (err) {
      console.warn("Approximate location unavailable:", err && err.message ? err.message : err);
      return null;
    }
  }

  async function requestApproximateArea(fallbackMessage) {
    if (appBooted) return;
    setLoadingMessage("Finding an approximate area...", false);
    var approx = await fetchApproximateArea();
    if (approx) {
      boot(approx.lat, approx.lng, {
        watchPosition: false,
        referenceMode: approx.approximate ? "approximate" : "default",
        referenceMeta: approx
      });
      return;
    }
    showLocationFallback(fallbackMessage);
  }

  function startGeolocation() {
    if (!navigator.geolocation || !shouldWatchUserPosition || geolocationWatchId != null) return;
    geolocationWatchId = navigator.geolocation.watchPosition(
      function(pos) { updateUserPosition(pos.coords.latitude, pos.coords.longitude); },
      function(err) {
        console.warn("Location updates unavailable:", err && err.message ? err.message : err);
      },
      { enableHighAccuracy: true, maximumAge: 10000 }
    );
  }

  function boot(lat, lng, options) {
    options = options || {};
    if (appBooted) return;
    appBooted = true;
    shouldWatchUserPosition = options.watchPosition !== false;
    referenceMode = options.referenceMode || (shouldWatchUserPosition ? "device" : "manual");
    referenceMeta = options.referenceMeta || null;
    document.getElementById("loading").style.display = "none";
    updateFilterButtons();
    updateSummaryUi();
    initMap(lat, lng);
    scheduleSafariToolbarCollapse();
    syncUrlState();
    updateUserPosition(lat, lng);
    updateReferenceNote();
    fetchAircraft({ source: "boot" });
    fetchAirports();
    fetchRunways();
    scheduleMarkerAnimation();
    if (shouldWatchUserPosition) startGeolocation();
    scheduleRefreshTimer(adaptiveRefreshMs());
    document.addEventListener("visibilitychange", function() {
      if (!document.hidden) handlePageResume();
    });
    window.addEventListener("pageshow", function(e) {
      if (e.persisted) handlePageResume();
    });
    updateViewHint(0);
  }

  function requestInitialLocation() {
    if (appBooted) return;
    if (!navigator.geolocation) {
      requestApproximateArea("Location is unavailable in this browser. You can still browse the map or enter coordinates.");
      return;
    }
    setLoadingMessage("Getting location...", false);
    navigator.geolocation.getCurrentPosition(
      function(pos) { boot(pos.coords.latitude, pos.coords.longitude, { watchPosition: true }); },
      function() {
        requestApproximateArea("Location access is off. You can still browse the map or enter coordinates.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function scheduleTrailBreaks() {
    trailBreakPending = {};
    for (var id in posHistory) trailBreakPending[id] = true;
  }

  function handlePageResume() {
    if (!map) return;
    lastFetchTs = 0;
    fetchInterval = adaptiveRefreshMs();
    fetchJitterMs = 0;
    playbackDelayMs = computePlaybackDelayMs(adaptiveRefreshMs(), 0, {
      minMs: PLAYBACK_DELAY_MIN_MS,
      maxMs: PLAYBACK_DELAY_MAX_MS,
      safetyMs: PLAYBACK_DELAY_SAFETY_MS
    });
    scheduleTrailBreaks();
    clearMapFetchTimer();
    clearRefreshTimer();
    resetInterpolationSamples();
    scheduleMarkerAnimation();
    fetchAircraft({ source: "resume" });
  }

  // --- Controls dock ---
  (function() {
    var controls = document.getElementById("map-controls");
    var toggle = document.getElementById("controls-toggle");
    if (!controls || !toggle) return;
    setControlsExpanded(false);
    toggle.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      setControlsExpanded(!controls.classList.contains("expanded"));
    });
    controls.addEventListener("click", function(e) {
      e.stopPropagation();
    });
    document.addEventListener("click", function(e) {
      if (!controls.classList.contains("expanded")) return;
      if (controls.contains(e.target)) return;
      setControlsExpanded(false);
    });
  })();

  // --- Search ---
  (function() {
    var shell = document.getElementById("search-shell");
    var input = document.getElementById("search-input");
    var resultsEl = document.getElementById("search-results");
    if (!shell || !input || !resultsEl) return;
    input.setAttribute("aria-controls", "search-results");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");

    var renderedResults = [];
    var highlightIndex = -1;
    var lookupTimer = 0;
    var lookupSeq = 0;
    var remoteLookup = {
      key: "",
      query: null,
      status: "idle",
      result: null
    };

    function clearLookupTimer() {
      if (!lookupTimer) return;
      clearTimeout(lookupTimer);
      lookupTimer = 0;
    }

    function clearRemoteLookup() {
      clearLookupTimer();
      remoteLookup = {
        key: "",
        query: null,
        status: "idle",
        result: null
      };
    }

    function searchLookupKey(query) {
      return query ? (query.type + ":" + query.value) : "";
    }

    function setSearchResultsVisible(visible) {
      resultsEl.hidden = !visible;
      input.setAttribute("aria-expanded", visible ? "true" : "false");
    }

    function closeSearchResults() {
      renderedResults = [];
      highlightIndex = -1;
      resultsEl.innerHTML = "";
      setSearchResultsVisible(false);
    }

    function matchScore(text, queryText) {
      if (!text) return -1;
      if (text === queryText) return 120;
      if (text.indexOf(queryText) === 0) return 90 - Math.min(20, text.length - queryText.length);
      var idx = text.indexOf(queryText);
      if (idx !== -1) return 65 - Math.min(20, idx);
      return -1;
    }

    function buildLocalResultMeta(plane, preferredLabel, aliasLabel) {
      var liveCallsign = plane.callsign ? plane.callsign.toUpperCase() : null;
      var airline = plane.callsign ? airlineName(plane.callsign) : null;
      var metaParts = [];
      if (liveCallsign && preferredLabel !== liveCallsign) metaParts.push("live " + liveCallsign);
      if (aliasLabel && aliasLabel !== preferredLabel) metaParts.push(aliasLabel);
      if (airline) metaParts.push(airline);
      metaParts.push(plane.icao24.toUpperCase());
      return metaParts.join(" · ");
    }

    function buildGlobalResultMeta(query, found) {
      var liveCallsign = found.callsign || null;
      var airline = liveCallsign ? airlineName(liveCallsign) : null;
      var metaParts = [];
      if (liveCallsign && query.display !== liveCallsign) metaParts.push("matched " + query.display);
      if (airline) metaParts.push(airline);
      metaParts.push(found.hex.toUpperCase());
      metaParts.push("exact live lookup");
      return metaParts.join(" · ");
    }

    function buildLocalResults(rawValue) {
      var queryText = normalizeSearchText(rawValue);
      if (!queryText) return [];
      var matches = [];
      for (var i = 0; i < aircraft.length; i++) {
        var plane = aircraft[i];
        var callsign = plane.callsign ? plane.callsign.toUpperCase() : "";
        var preferredLabel = callsign || plane.icao24.toUpperCase();
        var aliasLabel = null;
        var bestScore = -1;
        var variants = callsignVariants(plane.callsign);
        for (var v = 0; v < variants.length; v++) {
          var variant = variants[v];
          var variantScore = matchScore(variant, queryText);
          if (variant !== callsign) aliasLabel = variant;
          if (variantScore > bestScore) {
            bestScore = variantScore;
            preferredLabel = variant !== callsign ? variant : (callsign || plane.icao24.toUpperCase());
          }
        }
        var hexScore = matchScore(plane.icao24.toUpperCase(), queryText);
        if (hexScore > bestScore) {
          bestScore = hexScore;
          preferredLabel = plane.icao24.toUpperCase();
        }
        var airline = plane.callsign ? airlineName(plane.callsign) : null;
        var airlineScore = matchScore(normalizeSearchText(airline), queryText);
        if (airlineScore >= 0) bestScore = Math.max(bestScore, airlineScore - 4);
        if (bestScore < 0) continue;
        matches.push({
          key: "local:" + plane.icao24,
          type: "local",
          disabled: false,
          aircraft: plane,
          label: preferredLabel,
          meta: buildLocalResultMeta(plane, preferredLabel, aliasLabel),
          badge: "live",
          score: bestScore
        });
      }
      matches.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        var distA = a.aircraft.slantKm != null ? a.aircraft.slantKm : (a.aircraft.viewDistKm != null ? a.aircraft.viewDistKm : 999999);
        var distB = b.aircraft.slantKm != null ? b.aircraft.slantKm : (b.aircraft.viewDistKm != null ? b.aircraft.viewDistKm : 999999);
        return distA - distB;
      });
      if (matches.length > SEARCH_SUGGESTION_LIMIT) matches.length = SEARCH_SUGGESTION_LIMIT;
      return matches;
    }

    function buildRemoteResult(query, localExactMatch) {
      if (!query || localExactMatch) return null;
      var lookupKey = searchLookupKey(query);
      if (remoteLookup.key !== lookupKey || remoteLookup.status === "loading") {
        return {
          key: "global-loading:" + lookupKey,
          type: "status",
          disabled: true,
          label: "Finding " + query.display + "…",
          meta: "Checking live traffic beyond the currently loaded aircraft.",
          badge: "global"
        };
      }
      if (remoteLookup.status === "ready" && remoteLookup.result) {
        return {
          key: "global:" + remoteLookup.result.hex,
          type: "global",
          disabled: false,
          query: query,
          result: remoteLookup.result,
          label: remoteLookup.result.callsign || remoteLookup.result.hex.toUpperCase(),
          meta: buildGlobalResultMeta(query, remoteLookup.result),
          badge: "global"
        };
      }
      if (remoteLookup.status === "empty") {
        return {
          key: "global-empty:" + lookupKey,
          type: "status",
          disabled: true,
          label: "No live match for " + query.display,
          meta: "Nothing exact is reporting right now.",
          badge: "global"
        };
      }
      if (remoteLookup.status === "error") {
        return {
          key: "global-error:" + lookupKey,
          type: "status",
          disabled: true,
          label: "Global lookup unavailable",
          meta: "Couldn't check " + query.display + " right now.",
          badge: "global"
        };
      }
      return null;
    }

    function firstSelectableIndex() {
      for (var i = 0; i < renderedResults.length; i++) {
        if (!renderedResults[i].disabled) return i;
      }
      return -1;
    }

    function stepHighlight(direction) {
      if (!renderedResults.length) return -1;
      var index = highlightIndex;
      if (index < 0 || index >= renderedResults.length) index = direction > 0 ? -1 : 0;
      for (var step = 0; step < renderedResults.length; step++) {
        index = (index + direction + renderedResults.length) % renderedResults.length;
        if (!renderedResults[index].disabled) return index;
      }
      return -1;
    }

    function renderResults(rawValue, options) {
      options = options || {};
      var queryText = normalizeSearchText(rawValue);
      if (!queryText) {
        clearRemoteLookup();
        closeSearchResults();
        return;
      }

      var localResults = buildLocalResults(rawValue);
      var exactQuery = normalizeFlightQuery(rawValue);
      var localExactMatch = exactQuery ? findAircraftByQuery(exactQuery) : null;
      var remoteResult = buildRemoteResult(exactQuery, localExactMatch);
      renderedResults = remoteResult ? localResults.concat(remoteResult) : localResults;

      if (!options.preserveHighlight) highlightIndex = -1;
      if (highlightIndex < 0 || highlightIndex >= renderedResults.length || renderedResults[highlightIndex].disabled) {
        highlightIndex = firstSelectableIndex();
      }

      if (!renderedResults.length) {
        resultsEl.innerHTML = '<div class="search-empty">No loaded matches yet. Keep typing a full flight or hex for a wider live lookup.</div>';
        setSearchResultsVisible(true);
        return;
      }

      var html = "";
      for (var i = 0; i < renderedResults.length; i++) {
        var result = renderedResults[i];
        var classes = "search-option";
        if (i === highlightIndex) classes += " active";
        html += '<button type="button" class="' + classes + '" data-index="' + i + '" role="option" aria-selected="' + (i === highlightIndex ? "true" : "false") + '"' + (result.disabled ? " disabled" : "") + '>' +
          '<span class="search-option-main">' +
            '<span class="search-option-label">' + escapeHtml(result.label) + '</span>' +
            '<span class="search-option-meta">' + escapeHtml(result.meta) + '</span>' +
          '</span>' +
          '<span class="search-option-badge">' + escapeHtml(result.badge) + '</span>' +
        '</button>';
      }
      resultsEl.innerHTML = html;
      setSearchResultsVisible(true);
    }

    function scheduleRemoteLookup(query, localExactMatch) {
      var lookupKey = searchLookupKey(query);
      if (!query || localExactMatch) {
        clearRemoteLookup();
        return;
      }
      if (remoteLookup.key === lookupKey && (remoteLookup.status === "loading" || remoteLookup.status === "ready" || remoteLookup.status === "empty" || remoteLookup.status === "error")) {
        return;
      }
      clearLookupTimer();
      remoteLookup = {
        key: lookupKey,
        query: query,
        status: "loading",
        result: null
      };
      var requestSeq = ++lookupSeq;
      lookupTimer = setTimeout(async function() {
        lookupTimer = 0;
        try {
          var found = await lookupAircraftQuery(query);
          if (requestSeq !== lookupSeq || !remoteLookup.query || remoteLookup.key !== lookupKey) return;
          remoteLookup.status = found ? "ready" : "empty";
          remoteLookup.result = found;
        } catch (_) {
          if (requestSeq !== lookupSeq || !remoteLookup.query || remoteLookup.key !== lookupKey) return;
          remoteLookup.status = "error";
          remoteLookup.result = null;
        }
        renderResults(input.value, { preserveHighlight: true });
      }, SEARCH_LOOKUP_DEBOUNCE_MS);
    }

    function refreshSearch(rawValue, options) {
      var exactQuery = normalizeFlightQuery(rawValue);
      var localExactMatch = exactQuery ? findAircraftByQuery(exactQuery) : null;
      scheduleRemoteLookup(exactQuery, localExactMatch);
      renderResults(rawValue, options);
    }

    function chooseResult(index) {
      var result = renderedResults[index];
      if (!result || result.disabled) return;
      if (result.type === "local") {
        focusAircraftById(result.aircraft.icao24, {
          center: true,
          minZoom: SEARCH_MIN_ZOOM,
          openPopup: true,
          reveal: true
        });
        input.value = result.label;
        input.blur();
        closeSearchResults();
        setControlsExpanded(false);
        setControlsFeedback("Centered on " + (result.aircraft.callsign || result.aircraft.icao24.toUpperCase()) + ".", "success", { timeoutMs: 3200 });
        return;
      }
      if (result.type === "global") {
        var found = result.result;
        setSelectedAircraft(null);
        queuePendingPlaneFocus(found.hex, {
          keepUrl: true,
          label: result.query.display,
          reason: "search"
        });
        if (map) map.closePopup();
        input.value = result.query.display;
        input.blur();
        closeSearchResults();
        setControlsExpanded(false);
        setControlsFeedback("Centering on " + (found.callsign || found.hex.toUpperCase()) + "…", "info", { timeoutMs: 4500 });
        centerMapOnPlane(found.lat, found.lng, SEARCH_MIN_ZOOM);
      }
    }

    input.addEventListener("input", function() {
      refreshSearch(input.value);
    });
    input.addEventListener("search", function() {
      refreshSearch(input.value);
    });
    input.addEventListener("focus", function() {
      refreshSearch(input.value, { preserveHighlight: true });
    });
    input.addEventListener("keydown", function(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightIndex = stepHighlight(1);
        renderResults(input.value, { preserveHighlight: true });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightIndex = stepHighlight(-1);
        renderResults(input.value, { preserveHighlight: true });
        return;
      }
      if (e.key === "Enter") {
        if (highlightIndex >= 0) {
          e.preventDefault();
          chooseResult(highlightIndex);
        }
        return;
      }
      if (e.key === "Escape") {
        closeSearchResults();
        input.blur();
      }
    });
    resultsEl.addEventListener("mousedown", function(e) {
      if (e.target && e.target.closest && e.target.closest(".search-option")) e.preventDefault();
    });
    resultsEl.addEventListener("click", function(e) {
      var option = e.target && e.target.closest ? e.target.closest(".search-option") : null;
      if (!option) return;
      var index = parseInt(option.getAttribute("data-index"), 10);
      if (!isFinite(index)) return;
      chooseResult(index);
    });
    document.addEventListener("click", function(e) {
      if (shell.contains(e.target)) return;
      closeSearchResults();
    });

    refreshSearchUi = function() {
      if (!normalizeSearchText(input.value)) {
        closeSearchResults();
        return;
      }
      refreshSearch(input.value, { preserveHighlight: true });
    };
  })();

  // --- Filter toggles ---
  (function() {
    var browseBtn = document.getElementById("loading-browse");
    var retryBtn = document.getElementById("loading-retry");
    var coordsForm = document.getElementById("loading-coordinates");
    var latInput = document.getElementById("loading-lat");
    var lngInput = document.getElementById("loading-lng");
    if (!browseBtn || !retryBtn || !coordsForm || !latInput || !lngInput) return;
    browseBtn.addEventListener("click", function() {
      boot(DEFAULT_BROWSE_LAT, DEFAULT_BROWSE_LNG, {
        watchPosition: false,
        referenceMode: "default",
        referenceMeta: { label: "the default browse area" }
      });
    });
    retryBtn.addEventListener("click", function() {
      requestInitialLocation();
    });
    coordsForm.addEventListener("submit", function(e) {
      e.preventDefault();
      var lat = parseCoordinate(latInput.value, -90, 90);
      var lng = parseCoordinate(lngInput.value, -180, 180);
      if (lat == null || lng == null) {
        showLocationFallback("Enter a valid latitude and longitude to continue.");
        return;
      }
      boot(lat, lng, {
        watchPosition: false,
        referenceMode: "manual",
        referenceMeta: { label: "your entered coordinates" }
      });
    });
  })();

  (function() {
    var btns = document.querySelectorAll("#visibility-controls .ftag");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function() {
        var f = this.getAttribute("data-f");
        filters[f] = !filters[f];
        updateFilterButtons();
        renderMap();
        updateStatus();
        updateAlerts();
        updateViewHint(visibleAircraftCount());
        if (refreshSearchUi) refreshSearchUi();
      });
    }
    updateFilterButtons();
  })();

  if (!isNaN(paramLat) && !isNaN(paramLng)) {
    boot(paramLat, paramLng, {
      watchPosition: false,
      referenceMode: "manual",
      referenceMeta: { label: "the shared map area" }
    });
  } else {
    requestInitialLocation();
  }

  // --- Airport schedule popup card ---
  var _activeAirportPopup = null;
  var _activeAirportIata = null;
  var _activeAirportName = null;
  var _activeAirportLat = null;
  var _activeAirportLng = null;
  var _activeScheduleDir = "arrivals";
  var _lastScheduleRefresh = 0;

  function relativeMinutes(unixTs) {
    var diffSec = unixTs - Math.floor(Date.now() / 1000);
    if (Math.abs(diffSec) < 60) return "now";
    var totalMin = Math.round(Math.abs(diffSec) / 60);
    var sign = diffSec > 0 ? "+" : "-";
    if (totalMin < 60) return sign + totalMin + "m";
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return sign + h + "h" + (m < 10 ? "0" : "") + m + "m";
  }

  var LANDING_SCAN_RADIUS_KM = 350;

  function buildLiveScheduleData(airportIata, airportLat, airportLng) {
    var arrivals = [];
    var departures = [];
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign) continue;
      var rc = routeCache[a.callsign];
      if (!a.ground) {
        if (rc && rc.destination && rc.destination.iata === airportIata) {
          var distKm = haversineKm(a.lat, a.lng, airportLat, airportLng);
          if (distKm > LANDING_SCAN_RADIUS_KM) continue;
          var spdKts = a.speedKts || 0;
          var etaMin = spdKts > 0 ? (distKm / (spdKts * 1.852)) * 60 : null;
          arrivals.push({
            callsign: a.callsign,
            originIata: rc.origin ? rc.origin.iata : null,
            aircraftType: a.aircraftType,
            altFt: a.altFt,
            distKm: distKm,
            etaMin: etaMin != null ? Math.round(etaMin) : null,
            estLandingTime: etaMin != null ? Date.now() + etaMin * 60000 : null
          });
        }
      } else {
        if (rc && rc.destination && rc.destination.iata === airportIata) continue;
        var distKm = haversineKm(a.lat, a.lng, airportLat, airportLng);
        var hasOriginHere = rc && rc.origin && rc.origin.iata === airportIata;
        if (distKm > (hasOriginHere ? 8 : 5)) continue;
        var spdKts = a.speedKts || 0;
        var status = spdKts > 0 ? "Taxiing" : "Parked";
        var runwayDistKm = null;
        var rwys = runwayData && runwayData[airportIata];
        if (rwys) {
          var minD = Infinity;
          for (var r = 0; r < rwys.length; r++) {
            var rw = rwys[r];
            var d = haversineKm(a.lat, a.lng, (rw[0] + rw[3]) / 2, (rw[1] + rw[4]) / 2);
            if (d < minD) minD = d;
          }
          if (minD < Infinity) runwayDistKm = minD;
        }
        departures.push({
          callsign: a.callsign,
          destIata: rc && rc.destination ? rc.destination.iata : null,
          aircraftType: a.aircraftType,
          speedKts: spdKts,
          status: status,
          distKm: distKm,
          runwayDistKm: runwayDistKm,
          hasDest: !!(rc && rc.destination)
        });
      }
    }
    var seenCallsigns = {};
    for (var s = 0; s < arrivals.length; s++) seenCallsigns[arrivals[s].callsign] = true;
    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a.callsign || a.ground || seenCallsigns[a.callsign]) continue;
      var rc = routeCache[a.callsign];
      if (rc && rc.origin && rc.origin.iata === airportIata) continue;
      if (rc && rc.destination && rc.destination.iata !== airportIata) continue;
      var vRateFpm = a.vRate != null ? a.vRate * 60 : 0;
      if (a.altFt == null || a.altFt >= 8000 || vRateFpm > -500) continue;
      var distKm = haversineKm(a.lat, a.lng, airportLat, airportLng);
      if (distKm > 20) continue;
      var spdKts = a.speedKts || 0;
      var etaMin = spdKts > 0 ? (distKm / (spdKts * 1.852)) * 60 : null;
      arrivals.push({
        callsign: a.callsign,
        originIata: rc && rc.origin ? rc.origin.iata : null,
        aircraftType: a.aircraftType,
        altFt: a.altFt,
        distKm: distKm,
        etaMin: etaMin != null ? Math.round(etaMin) : null,
        estLandingTime: etaMin != null ? Date.now() + etaMin * 60000 : null,
        proximity: true
      });
    }
    arrivals.sort(function(a, b) {
      var etaA = a.etaMin != null ? a.etaMin : Infinity;
      var etaB = b.etaMin != null ? b.etaMin : Infinity;
      if (etaA !== etaB) return etaA - etaB;
      return a.distKm - b.distKm;
    });
    departures.sort(function(a, b) {
      var aTaxi = a.speedKts > 0 ? 0 : 1;
      var bTaxi = b.speedKts > 0 ? 0 : 1;
      if (aTaxi !== bTaxi) return aTaxi - bTaxi;
      if (aTaxi === 0) {
        if (a.runwayDistKm != null && b.runwayDistKm != null)
          return a.runwayDistKm - b.runwayDistKm;
        return b.speedKts - a.speedKts;
      }
      if (a.hasDest !== b.hasDest) return a.hasDest ? -1 : 1;
      return a.distKm - b.distKm;
    });
    if (arrivals.length > 15) arrivals.length = 15;
    if (departures.length > 15) departures.length = 15;
    return { arrivals: arrivals, departures: departures };
  }

  function buildScheduleCardContent(iata, name, liveData, dir) {
    var isArr = dir === "arrivals";
    var items = isArr ? (liveData.arrivals || []) : (liveData.departures || []);
    var safeName = escapeHtml(name || "").replace(/"/g, "&quot;");
    var html = '<div class="sched-card" data-sched-iata="' + escapeHtml(iata) +
      '" data-sched-name="' + safeName +
      '" data-sched-dir="' + dir + '">' +
      '<div class="sched-header">' +
        '<span class="sched-iata">' + escapeHtml(iata) + '</span> ' +
        '<span class="sched-name">' + escapeHtml(name) + '</span>' +
      '</div>' +
      '<div class="sched-toggle">' +
        '<button class="sched-toggle-btn' + (isArr ? " active" : "") + '" data-dir="arrivals">Landings</button>' +
        '<button class="sched-toggle-btn' + (isArr ? "" : " active") + '" data-dir="departures">Takeoffs</button>' +
      '</div>';
    if (!items.length) {
      html += '<div class="sched-empty">No aircraft nearby</div>';
    } else if (isArr) {
      for (var i = 0; i < items.length; i++) {
        var f = items[i];
        var flightNum = escapeHtml((f.callsign || "\u2014").replace(/^([A-Za-z]+)(\d+)$/, "$1 $2"));
        var fromIata = f.originIata ? escapeHtml(f.originIata) : "\u2014";
        var altStr = f.altFt != null ? f.altFt.toLocaleString() + "ft" : "\u2014";
        var distNm = Math.round(f.distKm / 1.852) + "nm";
        var etaStr = "";
        if (f.etaMin != null) {
          etaStr = "~" + f.etaMin + "min";
          if (f.proximity) etaStr += " (est.)";
        }
        html += '<div class="sched-row">' +
          '<span class="sched-dot cyan live"></span>' +
          '<span class="sched-flight">' + flightNum + '</span>' +
          '<span class="sched-route">from ' + fromIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + '</span>' +
          '<span class="sched-alt">' + altStr + '</span>' +
          '<span class="sched-dist">' + distNm + '</span>' +
          (etaStr ? '<span class="sched-eta">' + etaStr + '</span>' : '') +
          '</div>';
      }
    } else {
      for (var i = 0; i < items.length; i++) {
        var f = items[i];
        var flightNum = escapeHtml((f.callsign || "\u2014").replace(/^([A-Za-z]+)(\d+)$/, "$1 $2"));
        var destIata = f.destIata ? escapeHtml(f.destIata) : "\u2014";
        var spdStr = f.speedKts > 0 ? f.speedKts + "kt" : "\u2014";
        var dotColor = f.status === "Taxiing" ? "green" : "gray";
        html += '<div class="sched-row">' +
          '<span class="sched-dot ' + dotColor + '"></span>' +
          '<span class="sched-flight">' + flightNum + '</span>' +
          '<span class="sched-route">to ' + destIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + '</span>' +
          '<span class="sched-speed">' + spdStr + '</span>' +
          '<span class="sched-hint">' + escapeHtml(f.status) + '</span>' +
          '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderSchedulePopup(dir) {
    if (!_activeAirportPopup || _activeAirportLat == null) return;
    _activeScheduleDir = dir;
    var liveData = buildLiveScheduleData(_activeAirportIata, _activeAirportLat, _activeAirportLng);
    _activeAirportPopup.setContent(
      buildScheduleCardContent(_activeAirportIata, _activeAirportName, liveData, dir)
    );
  }

  function openAirportSchedulePopup(iata, name, lat, lng) {
    if (_activeAirportPopup) {
      map.closePopup(_activeAirportPopup);
      _activeAirportPopup = null;
      _activeAirportIata = null;
    }

    _activeAirportIata = iata;
    _activeAirportName = name;
    _activeAirportLat = lat;
    _activeAirportLng = lng;
    _activeScheduleDir = "arrivals";

    var liveData = buildLiveScheduleData(iata, lat, lng);
    var popup = L.popup({ maxWidth: 320, minWidth: 280, closeButton: true, className: "" })
      .setLatLng([lat, lng])
      .setContent(buildScheduleCardContent(iata, name, liveData, "arrivals"))
      .openOn(map);

    _activeAirportPopup = popup;

    popup.on("remove", function() {
      if (_activeAirportIata === iata) {
        _activeAirportPopup = null;
        _activeAirportIata = null;
        _activeAirportName = null;
        _activeAirportLat = null;
        _activeAirportLng = null;
      }
    });
  }

  // --- FIDS (airport schedule board) ---
  var _fidsData = null;
  var _fidsDir = "arrivals";

  function fidsTime(ts) {
    if (!ts) return "\u2014";
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderFidsTab() {
    var flights = _fidsData ? (_fidsData[_fidsDir] || []) : [];
    var body = document.getElementById("fids-body");
    if (!flights.length) {
      body.innerHTML = '<div class="fids-empty">No flights found</div>';
      return;
    }
    var isArr = _fidsDir === "arrivals";
    var html = "";
    for (var i = 0; i < flights.length; i++) {
      var f = flights[i];
      var color = f.color || "gray";
      var sched = fidsTime(isArr ? f.sched_arr : f.sched_dep);
      var est = fidsTime(isArr ? f.est_arr : f.est_dep);
      var actual = fidsTime(isArr ? f.actual_arr : f.actual_dep);
      var route = isArr
        ? (f.from_iata ? "from " + f.from_iata : "")
        : (f.to_iata ? "to " + f.to_iata : "");
      if (f.ac_code) route = route ? route + " \u00b7 " + f.ac_code : f.ac_code;
      html += '<div class="fids-row">' +
        '<div class="fids-top">' +
          '<div><span class="fids-flight-num">' + (f.flight || "\u2014") + '</span>' +
          '<span class="fids-airline-name">' + (f.airline || "") + '</span></div>' +
          '<span class="fids-badge ' + color + '">' + (f.status || "\u2014") + '</span>' +
        '</div>' +
        (route ? '<div class="fids-route">' + route + '</div>' : '') +
        '<div class="fids-times">' +
          '<span>Sched ' + sched + '</span>' +
          '<span>Est ' + est + '</span>' +
          '<span class="ft-actual">Act ' + actual + '</span>' +
        '</div></div>';
    }
    body.innerHTML = html;
  }

  window.openFids = function(iata, name, direction) {
    document.getElementById("fids-title").textContent = iata;
    document.getElementById("fids-subtitle").textContent = name || "";
    document.getElementById("fids-body").innerHTML =
      '<div class="fids-empty"><div class="spinner"></div><br>Loading schedule\u2026</div>';
    _fidsDir = direction || "arrivals";
    var tabs = document.querySelectorAll(".fids-tab");
    for (var t = 0; t < tabs.length; t++)
      tabs[t].classList.toggle("active", tabs[t].getAttribute("data-dir") === _fidsDir);
    document.getElementById("fids").classList.add("open");

    var schedUrl = (isLocal ? "/api/fr24/schedule/" : WORKER_URL + "/schedule/") + encodeURIComponent(iata);
    fetch(schedUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          document.getElementById("fids-body").innerHTML =
            '<div class="fids-empty">' + data.error + '</div>';
          return;
        }
        _fidsData = data;
        if (data.name) document.getElementById("fids-subtitle").textContent = data.name;
        renderFidsTab();
      })
      .catch(function() {
        document.getElementById("fids-body").innerHTML =
          '<div class="fids-empty">Failed to load schedule</div>';
      });
  };

  window.closeFids = function() {
    document.getElementById("fids").classList.remove("open");
    _fidsData = null;
  };

  (function() {
    document.getElementById("fids-backdrop").addEventListener("click", window.closeFids);
    document.getElementById("fids-close").addEventListener("click", window.closeFids);
    var tabs = document.querySelectorAll(".fids-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function() {
        _fidsDir = this.getAttribute("data-dir");
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle("active", tabs[j] === this);
        renderFidsTab();
      });
    }
    document.addEventListener("keydown", function(e) {
      if (e.key !== "Escape") return;
      if (document.getElementById("fids").classList.contains("open")) {
        window.closeFids();
        return;
      }
      if (_activeAirportPopup) {
        map.closePopup(_activeAirportPopup);
      }
    });
  })();
})();
