// Leaflet map setup, basemap, markers, and map interaction.

// --- Map setup ---
function initMap(lat, lng) {
  var desktopWheelTuning = isDesktopFinePointer;
  map = L.map("map", {
    center: [lat, lng],
    zoom: isFinite(bootZoomOverride) ? Math.max(MIN_MAP_ZOOM, bootZoomOverride)
      : (isFinite(paramZoom) ? Math.max(MIN_MAP_ZOOM, paramZoom) : DEFAULT_MAP_ZOOM),
    minZoom: MIN_MAP_ZOOM,
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    zoomSnap: desktopWheelTuning ? 0.25 : 0,
    scrollWheelZoom: !desktopWheelTuning,
    smoothWheelZoom: desktopWheelTuning,
    smoothSensitivity: 1,
    zoomDelta: desktopWheelTuning ? 0.5 : 0.25,
    wheelPxPerZoomLevel: desktopWheelTuning ? 120 : 180,
    wheelDebounceTime: desktopWheelTuning ? 50 : 40,
    zoomAnimation: true,
    zoomAnimationThreshold: 8,
    fadeAnimation: false,
    markerZoomAnimation: false,
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
  map.createPane("weatherPane");
  map.getPane("weatherPane").style.zIndex = 250;
  map.getPane("weatherPane").style.pointerEvents = "none";
  addBasemap();
  L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);

  var _autoPanning = false;
  map.on("autopanstart", function() { _autoPanning = true; });
  map.on("movestart", function() {
    _isPanning = true;
    if (_autoPanning) { _autoPanning = false; return; }
    if (pendingPlaneFocus && pendingPlaneFocus.failed) clearPendingPlaneFocus();
  });
  map.on("click", function(e) {
    if (Date.now() < ignoreMapClickUntil) return;
    if (!selectedAircraftId) return;
    setSelectedAircraft(null);
  });

  map.on("zoomstart", function() { _isZooming = true; clearTimeout(moveEndDebounceTimer); moveEndDebounceTimer = null; });
  map.on("zoomend", function() { _isZooming = false; });

  routeLayer = L.layerGroup().addTo(map);
  trailLayer = L.layerGroup().addTo(map);
  runwayLayer = L.layerGroup().addTo(map);
  airportLayer = L.layerGroup().addTo(map);
  aircraftLayer = L.layerGroup().addTo(map);
  if (weatherOn) enableWeather({ silent: true });
  installIOSOneFingerZoom();
  var _popupJustOpened = false;
  var popupCheckRafPending = false;
  function popupPanelLeavingView(popup) {
    if (!popup || !popup.getElement) return false;
    var el = popup.getElement();
    if (!el || !el.getBoundingClientRect) return false;
    var mapRect = map.getContainer().getBoundingClientRect();
    var popupRect = el.getBoundingClientRect();
    if (popupRect.height < 1 || popupRect.width < 1) return false;
    var edgeMargin = 6;
    return popupRect.top < mapRect.top + edgeMargin ||
      popupRect.left < mapRect.left + edgeMargin ||
      popupRect.bottom > mapRect.bottom - edgeMargin ||
      popupRect.right > mapRect.right - edgeMargin;
  }
  function isAirportSchedulePopup(popup) {
    if (!popup) return false;
    if (_activeAirportPopup && popup === _activeAirportPopup) return true;
    if (!popup.getElement) return false;
    var el = popup.getElement();
    return !!(el && el.classList && el.classList.contains("airport-schedule-popup"));
  }
  map.on("move", function() {
    if (_popupJustOpened || _autoPanning) return;
    if (popupCheckRafPending) return;
    popupCheckRafPending = true;
    requestAnimationFrame(function() {
      popupCheckRafPending = false;
      var p = map._popup;
      if (p && !isAirportSchedulePopup(p) && popupPanelLeavingView(p)) map.closePopup();
    });
  });
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
        if (handleAirportSchedulePanelClick(event)) return;
      });
    }
    var popupSourceHex = null;
    for (var id in markerMap) {
      if (markerMap[id].getPopup() === e.popup) { popupSourceHex = id; break; }
    }
    if (popupSourceHex) {
      var popupAircraft = findAircraftById(popupSourceHex);
      if (popupAircraft) e.popup.setContent(buildPopup(popupAircraft));
    }
    var photoEl = el.querySelector(".popup-photo");
    if (photoEl) {
      var hex = photoEl.getAttribute("data-hex");
      loadPopupPhoto(photoEl);
      var acInfoEl = el.querySelector(".popup-aircraft");
      if (acInfoEl) loadPopupAircraftInfo(acInfoEl);
      loadPopupTrack(hex);
      matchScheduleRoute(hex);
      var clickedPlane = findAircraftById(hex);
      if (clickedPlane && clickedPlane.callsign && !clickedPlane.private) {
        tryFr24Search(clickedPlane, { force: true }).then(function() {
          var m = markerMap[hex];
          if (m && m.getPopup() && m.getPopup().isOpen()) {
            var updA = findAircraftById(hex);
            if (updA) m.getPopup().setContent(buildPopup(updA));
          }
        });
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
    _isPanning = false;
    if (weatherOn) maybeSwapWeatherSource();
    if (_followPanning) { _followPanning = false; return; }
    scheduleSaveLastView();
    if (!suppressViewportRefresh) {
      clearTimeout(moveEndDebounceTimer);
      moveEndDebounceTimer = setTimeout(function() {
        moveEndDebounceTimer = null;
        refreshViewportUi({ fetch: true });
      }, 120);
    }
    if (_popupJustOpened || _autoPanning) { _autoPanning = false; return; }
    var p = map._popup;
    if (p && !isAirportSchedulePopup(p)) {
      if (popupPanelLeavingView(p)) {
        map.closePopup();
      } else if (p._latlng && !map.getBounds().contains(p._latlng)) {
        map.closePopup();
      }
    }
  });
  if (isIOSDevice) {
    setTimeout(function() { map.invalidateSize({ animate: false }); }, 300);
  }
  window.addEventListener("resize", function() {
    if (map) map.invalidateSize({ animate: false });
    scheduleAirportPanelReposition(160);
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
        referenceMode = "device";
        referenceMeta = null;
        shouldWatchUserPosition = true;
        geolocationUpdatesAffectReference = true;
        updateDevicePosition(lat, lng, { useAsReference: true });
        map.setView([lat, lng], map.getZoom());
        startGeolocation();
      },
      function() {
        fetchApproximateArea().then(function(approx) {
          if (!approx) return;
          referenceMode = approx.approximate ? "approximate" : "default";
          referenceMeta = approx;
          setReferencePosition(approx.lat, approx.lng);
          map.setView([approx.lat, approx.lng], map.getZoom());
        });
      },
      { timeout: 5000 }
    );
  } else {
    fetchApproximateArea().then(function(approx) {
      if (!approx) return;
      referenceMode = approx.approximate ? "approximate" : "default";
      referenceMeta = approx;
      setReferencePosition(approx.lat, approx.lng);
      map.setView([approx.lat, approx.lng], map.getZoom());
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
  var summary;
  var outage = false;
  var degraded = trafficSource === "backup" && trafficFetchOk === true;
  if (visibleCount > 0) {
    summary = visibleCount + " planes in view";
  } else if (aircraft.length) {
    summary = "No planes in view";
  } else if (trafficFetchOk === false) {
    summary = "Live traffic temporarily unavailable";
    outage = true;
  } else if (trafficFetchOk === true) {
    summary = "No planes nearby";
  } else {
    summary = "Scanning for planes";
  }
  el.textContent = summary;
  el.classList.toggle("outage", outage);
  el.classList.toggle("degraded", degraded);
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
    var isOn = !!filters[key];
    btns[i].classList.toggle("on", isOn);
    btns[i].setAttribute("aria-pressed", isOn ? "true" : "false");
  }
}
