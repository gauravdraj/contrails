// Geolocation, boot sequence, and page-resume handling.

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
  var lastView = loadLastView();
  if (lastView) {
    bootZoomOverride = isFinite(lastView.zoom) ? lastView.zoom : null;
    boot(lastView.lat, lastView.lng, {
      watchPosition: false,
      referenceMode: "manual",
      referenceMeta: { label: "your last viewed area" }
    });
    requestBackgroundDeviceLocation();
    return;
  }
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
    function(pos) {
      updateDevicePosition(pos.coords.latitude, pos.coords.longitude, {
        useAsReference: geolocationUpdatesAffectReference
      });
    },
    function(err) {
      console.warn("Location updates unavailable:", err && err.message ? err.message : err);
    },
    { enableHighAccuracy: true, maximumAge: 10000 }
  );
}

function requestBackgroundDeviceLocation() {
  if (!navigator.geolocation || backgroundGeoRequestPending || deviceLat != null || appBooted === false) return;
  backgroundGeoRequestPending = true;
  navigator.geolocation.getCurrentPosition(
    function(pos) {
      backgroundGeoRequestPending = false;
      shouldWatchUserPosition = true;
      geolocationUpdatesAffectReference = false;
      updateDevicePosition(pos.coords.latitude, pos.coords.longitude, { useAsReference: false });
      startGeolocation();
    },
    function(err) {
      backgroundGeoRequestPending = false;
      console.warn("Background location unavailable:", err && err.message ? err.message : err);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function boot(lat, lng, options) {
  options = options || {};
  if (appBooted) return;
  appBooted = true;
  shouldWatchUserPosition = options.watchPosition !== false;
  referenceMode = options.referenceMode || (shouldWatchUserPosition ? "device" : "manual");
  referenceMeta = options.referenceMeta || null;
  geolocationUpdatesAffectReference = referenceMode === "device";
  document.getElementById("loading").style.display = "none";
  loadSavedFilters();
  updateFilterButtons();
  updateSummaryUi();
  initMap(lat, lng);
  scheduleSafariToolbarCollapse();
  syncUrlState();
  setReferencePosition(lat, lng, { refresh: false });
  if (referenceMode === "device") {
    updateDevicePosition(lat, lng, { useAsReference: false, refresh: false });
  }
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
  maybeRefreshWeather();
  fetchAircraft({ source: "resume" });
  scheduleActiveAirportRefresh(0);
}
