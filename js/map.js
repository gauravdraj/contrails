// MapLibre map setup, view helpers, popups, and map interaction.

// --- View helpers (app zoom scale, {lat, lng} order) ---
function viewZoom() { return map.getZoom() + 1; }
function toMapZoom(zoom) { return zoom - 1; }
function screenPoint(lat, lng) { return map.project([lng, lat]); }
function mapSize() {
  var el = map.getContainer();
  return { x: el.clientWidth, y: el.clientHeight };
}
function mapViewBounds() {
  var b = map.getBounds();
  return viewBounds(b.getNorth(), b.getSouth(), b.getEast(), b.getWest());
}
function setMapView(lat, lng, zoom) {
  map.jumpTo({ center: [lng, lat], zoom: toMapZoom(zoom) });
}
function flyMapTo(lat, lng, zoom, durationS) {
  map.flyTo({ center: [lng, lat], zoom: toMapZoom(zoom), duration: (durationS == null ? 0.75 : durationS) * 1000, essential: true });
}
function panMapTo(lat, lng, durationS) {
  map.easeTo({ center: [lng, lat], duration: durationS * 1000 });
}
function panMapBy(dx, dy, durationS) {
  map.panBy([dx, dy], { duration: durationS * 1000 });
}

var _mapReadyQueue = [];
function whenMapReady(fn) {
  if (mapReady) fn();
  else _mapReadyQueue.push(fn);
}

// --- Map setup ---
function initMap(lat, lng) {
  var zoom = Number.isFinite(bootZoomOverride) ? bootZoomOverride
    : (Number.isFinite(paramZoom) ? paramZoom : DEFAULT_MAP_ZOOM);
  try {
    map = new maplibregl.Map({
      container: "map",
      style: withCartoKey(VECTOR_STYLE_URL),
      center: [lng, lat],
      zoom: toMapZoom(Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, zoom))),
      minZoom: toMapZoom(MIN_MAP_ZOOM),
      maxZoom: toMapZoom(MAX_MAP_ZOOM),
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      // Plane labels are re-placed as planes move; fading them in and out on every placement would flicker.
      fadeDuration: 0,
      transformRequest: function(url) {
        if (/^https:\/\/([\w-]+\.)?basemaps\.cartocdn\.com\//.test(url)) return { url: withCartoKey(url) };
        return { url: url };
      }
    });
  } catch (err) {
    console.error("Map failed to start:", err);
    map = null;
    return false;
  }
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-left");
  // "style.load", not "load": "load" also waits for every initial tile, and one slow tile would hold planes back.
  map.once("style.load", onMapStyleLoad);

  map.on("movestart", function() {
    _isPanning = true;
    if (_autoPanning) { _autoPanning = false; return; }
    if (pendingPlaneFocus && pendingPlaneFocus.failed) clearPendingPlaneFocus();
  });
  map.on("click", function(e) {
    if (Date.now() < ignoreMapClickUntil) return;
    var hex = planeAtPoint(e.point);
    if (hex) {
      setSelectedAircraft(hex);
      openPlanePopup(hex);
      return;
    }
    closeMapPopup();
    if (selectedAircraftId) setSelectedAircraft(null);
  });
  if (isDesktopFinePointer) {
    var hoverFrame = 0, hoverPoint = null;
    map.on("mousemove", function(e) {
      hoverPoint = e.point;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(function() {
        hoverFrame = 0;
        map.getCanvas().style.cursor = hoverPoint && planeAtPoint(hoverPoint) ? "pointer" : "";
      });
    });
  }
  map.on("zoomstart", function() { clearTimeout(moveEndDebounceTimer); moveEndDebounceTimer = null; });

  if (weatherOn) enableWeather({ silent: true });
  map.on("move", function() {
    if (_popupJustOpened || _autoPanning) return;
    if (popupCheckRafPending) return;
    popupCheckRafPending = true;
    requestAnimationFrame(function() {
      popupCheckRafPending = false;
      var p = activeMapPopup;
      if (p && !p._isSheet && !isAirportSchedulePopup(p) && popupPanelLeavingView(p)) closeMapPopup();
    });
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
    var p = activeMapPopup;
    if (p && !p._isSheet && !isAirportSchedulePopup(p)) {
      var ll = p.getLngLat();
      if (popupPanelLeavingView(p) || !mapViewBounds().contains(ll.lat, ll.lng)) closeMapPopup();
    }
  });
  if (isIOSDevice) {
    setTimeout(function() { if (map) map.resize(); }, 300);
  }
  window.addEventListener("resize", function() {
    scheduleAirportPanelReposition(160);
  });
  return true;
}

function onMapStyleLoad() {
  addPlaneImages();
  addAppLayers();
  mapReady = true;
  var queued = _mapReadyQueue;
  _mapReadyQueue = [];
  for (var i = 0; i < queued.length; i++) queued[i]();
  renderRunways();
  refreshViewportUi({ fetch: false });
}

var PLANE_LABEL_FONT = ["Montserrat Medium", "Open Sans Bold", "Noto Sans Regular"];
var EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };

// Bottom to top: runways, route line, trails, route endpoints, plane labels, planes, the selected plane.
// Planes ignore placement: a rotated icon's collision box is the box around the rotated image, which would
// swallow its own label. Labels still collide with each other and push basemap text aside.
function addAppLayers() {
  ["runways", "route", "trails", "planes"].forEach(function(id) {
    map.addSource(id, { type: "geojson", data: EMPTY_COLLECTION });
  });
  map.addLayer({
    id: "runways", type: "line", source: "runways",
    paint: { "line-color": "#7a8a9f", "line-width": 2.5, "line-opacity": 0.7, "line-dasharray": [3.2, 2] }
  });
  map.addLayer({
    id: "route-line", type: "line", source: "route", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#6cb6ff", "line-width": 2, "line-opacity": 0.8, "line-dasharray": [3, 3.5] }
  });
  map.addLayer({
    id: "trails", type: "line", source: "trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-opacity": ["get", "opacity"], "line-width": ["get", "width"] }
  });
  map.addLayer({
    id: "route-ends", type: "circle", source: "route", filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 5, "circle-color": ["get", "color"], "circle-opacity": 0.9,
      "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2
    }
  });
  map.addLayer({
    id: "plane-labels", type: "symbol", source: "planes",
    layout: {
      visibility: "none",
      "symbol-sort-key": ["get", "labelRank"],
      "text-field": ["get", "label"],
      "text-font": PLANE_LABEL_FONT,
      "text-size": 10,
      "text-variable-anchor": ["top", "right", "bottom", "left"],
      "text-radial-offset": ["get", "labelOffset"],
      "text-padding": 1,
      "icon-image": "label-chip",
      "icon-text-fit": "both",
      "icon-text-fit-padding": [2, 5, 2, 5]
    },
    paint: { "text-color": "#d5e0eb" }
  });
  var planeLayout = {
    "icon-image": ["get", "icon"],
    "icon-size": ["get", "size"],
    "icon-rotate": ["get", "track"],
    "icon-rotation-alignment": "map",
    "icon-allow-overlap": true,
    "icon-ignore-placement": true,
    "symbol-z-order": "viewport-y"
  };
  var planePaint = { "icon-color": ["get", "color"], "icon-halo-color": "#0a0e17", "icon-halo-width": 1 };
  map.addLayer({ id: "planes", type: "symbol", source: "planes", filter: ["!", ["get", "selected"]], layout: planeLayout, paint: planePaint });
  map.addLayer({ id: "planes-selected", type: "symbol", source: "planes", filter: ["get", "selected"], layout: planeLayout, paint: planePaint });
  map.on("mousemove", "runways", showRunwayTooltip);
  map.on("mouseleave", "runways", hideRunwayTooltip);
}

// Nearest drawn plane within a finger's (or cursor's) reach of a screen point.
function planeAtPoint(point) {
  var reach = isDesktopFinePointer ? 6 : 14;
  var best = null, bestDist = Infinity;
  for (var hex in markerMap) {
    var rec = markerMap[hex];
    var pt = screenPoint(rec.lat, rec.lng);
    var d = Math.hypot(pt.x - point.x, pt.y - point.y);
    if (d <= rec.props.radiusPx + reach && d < bestDist) {
      best = hex;
      bestDist = d;
    }
  }
  return best;
}

var _runwayTooltip = null;
function showRunwayTooltip(e) {
  var f = e.features && e.features[0];
  if (!f || !f.properties.name) return;
  if (!_runwayTooltip) {
    _runwayTooltip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "runway-label", offset: 6 });
  }
  _runwayTooltip.setLngLat(e.lngLat).setText(f.properties.name);
  if (!_runwayTooltip.isOpen()) _runwayTooltip.addTo(map);
}
function hideRunwayTooltip() {
  if (_runwayTooltip) _runwayTooltip.remove();
}

// --- Popups: one open at a time ---
var activeMapPopup = null;
var planePopupHex = null;
var _autoPanning = false;
var _popupJustOpened = false;
var popupCheckRafPending = false;

function showMapPopup(popup, options) {
  closeMapPopup();
  activeMapPopup = popup;
  planePopupHex = options && options.planeHex ? options.planeHex : null;
  popup.on("close", function() {
    if (activeMapPopup !== popup) return;
    activeMapPopup = null;
    planePopupHex = null;
  });
  popup.addTo(map);
  afterPopupOpened(popup, options);
  return popup;
}

function closeMapPopup() {
  if (activeMapPopup) activeMapPopup.remove();
}

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
  var el = popup.getElement && popup.getElement();
  return !!(el && el.classList && el.classList.contains("airport-schedule-popup"));
}

function bindPopupActions(el) {
  if (!el || el.__contrailsPopupActionsBound) return;
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
    handleAirportSchedulePanelClick(event);
  });
}

// Pans so the popup clears the controls dock and, with `padding` ({top, right, bottom, left}), the map edges.
function afterPopupOpened(popup, options) {
  _popupJustOpened = true;
  setTimeout(function() { _popupJustOpened = false; }, 600);
  bindPopupActions(popup.getElement());
  if (popup._isSheet) return;
  var padding = options && options.padding;
  setTimeout(function() {
    var el = popup.getElement();
    if (!el || activeMapPopup !== popup) return;
    var mapRect = map.getContainer().getBoundingClientRect();
    var popupRect = el.getBoundingClientRect();
    var ctrl = document.getElementById("map-controls");
    var ctrlBottom = ctrl ? ctrl.getBoundingClientRect().bottom : mapRect.top;
    var dx = 0, dy = 0;
    if (popupRect.top < ctrlBottom + 10) dy = popupRect.top - ctrlBottom - 10;
    if (padding) {
      if (popupRect.top + dy < mapRect.top + padding.top) dy = popupRect.top - mapRect.top - padding.top;
      else if (popupRect.bottom > mapRect.bottom - padding.bottom) dy = popupRect.bottom - mapRect.bottom + padding.bottom;
      if (popupRect.left < mapRect.left + padding.left) dx = popupRect.left - mapRect.left - padding.left;
      else if (popupRect.right > mapRect.right - padding.right) dx = popupRect.right - mapRect.right + padding.right;
    }
    if (!dx && !dy) return;
    _autoPanning = true;
    panMapBy(Math.round(dx), Math.round(dy), 0.3);
  }, 50);
}

function openPlanePopup(hex) {
  var a = findAircraftById(hex);
  var rec = markerMap[hex];
  if (!a || !rec) return;
  var html = buildPopup(a);
  // Phones get a bottom sheet, like the airport board, so the card doesn't cover the plane.
  var docked = isAirportPanelDocked();
  if (docked && _activeAirportPopup) closeActiveAirportPanel({ restoreFocus: false });
  var popup = docked ? planeSheet() : new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    anchor: "bottom",
    offset: rec.props.radiusPx + 2,
    maxWidth: "300px",
    className: "plane-popup",
    focusAfterOpen: false
  }).setLngLat([rec.lng, rec.lat]);
  popup.setHTML(html);
  if (extraState[hex]) extraState[hex].popupHtml = html;
  showMapPopup(popup, { planeHex: hex });
  onPlanePopupOpened(hex, popup.getElement());
}

// --- Plane bottom sheet (phones) ---
// Same surface as a map popup (setHTML / setLngLat / getLngLat / getElement / on("close") / addTo / remove),
// so the one-popup-at-a-time code doesn't care which it has. While open, the map's bottom padding equals the
// sheet's height, so centering (follow mode, fly-to) lands the plane in the strip above the sheet.
var _planeSheetObserver = null;
var _insetPending = false;

function planeSheet() {
  var panel = document.getElementById("plane-panel");
  var sheet = document.getElementById("plane-panel-sheet");
  var content = document.getElementById("plane-panel-content");
  if (!panel.__contrailsBound) {
    panel.__contrailsBound = true;
    document.getElementById("plane-panel-close").addEventListener("click", function(e) {
      e.preventDefault();
      closeMapPopup();
      setSelectedAircraft(null);
    });
  }
  var closeHandlers = [];
  var open = false;
  var pendingHtml = "";
  var api = {
    _isSheet: true,
    setHTML: function(html) {
      pendingHtml = html;
      if (open) content.innerHTML = html;
      return api;
    },
    setLngLat: function() { return api; },
    getLngLat: function() {
      var rec = planePopupHex && markerMap[planePopupHex];
      return rec ? { lat: rec.lat, lng: rec.lng } : map.getCenter();
    },
    getElement: function() { return sheet; },
    on: function(eventName, handler) {
      if (eventName === "close") closeHandlers.push(handler);
      return api;
    },
    addTo: function() {
      open = true;
      content.innerHTML = pendingHtml;
      panel.classList.add("open");
      panel.setAttribute("aria-hidden", "false");
      if (typeof ResizeObserver === "function") {
        _planeSheetObserver = new ResizeObserver(function() { if (open) syncPlaneSheetInset(); });
        _planeSheetObserver.observe(sheet);
      }
      return api;
    },
    remove: function() {
      if (!open) return api;
      open = false;
      if (_planeSheetObserver) _planeSheetObserver.disconnect();
      _planeSheetObserver = null;
      panel.classList.remove("open");
      panel.setAttribute("aria-hidden", "true");
      content.innerHTML = "";
      setMapBottomInset(0);
      for (var i = 0; i < closeHandlers.length; i++) closeHandlers[i]();
      return api;
    }
  };
  return api;
}

function planeSheetInset() {
  var panel = document.getElementById("plane-panel");
  if (!map || !panel || !panel.classList.contains("open")) return 0;
  var mapRect = map.getContainer().getBoundingClientRect();
  var sheetRect = document.getElementById("plane-panel-sheet").getBoundingClientRect();
  return Math.max(0, Math.round(mapRect.bottom - sheetRect.top));
}

function syncPlaneSheetInset() {
  setMapBottomInset(planeSheetInset());
  panSelectedPlaneAboveSheet();
}

// Changes the map's bottom padding without moving the picture: the new center is whatever is already drawn at
// the middle of the new padded area. Waits out a running fly/ease, which a jump would cancel. That wait polls
// rather than listening for "moveend": a tap still in progress counts as moving but never ends a move.
function setMapBottomInset(px) {
  if (!map) return;
  if (map.isMoving()) {
    if (_insetPending) return;
    _insetPending = true;
    setTimeout(function() {
      _insetPending = false;
      setMapBottomInset(planeSheetInset());
      panSelectedPlaneAboveSheet();
    }, 150);
    return;
  }
  var current = map.getPadding().bottom || 0;
  if (Math.abs(current - px) < 2) return;
  var sz = mapSize();
  var center = map.unproject([sz.x / 2, (sz.y - px) / 2]);
  map.jumpTo({ center: center, padding: { top: 0, right: 0, bottom: px, left: 0 } });
}

// Eases the selected plane into the strip between the controls dock and the sheet when it's hidden.
function panSelectedPlaneAboveSheet() {
  if (!map || map.isMoving() || !activeMapPopup || !activeMapPopup._isSheet) return;
  var rec = planePopupHex && markerMap[planePopupHex];
  if (!rec) return;
  var mapRect = map.getContainer().getBoundingClientRect();
  var ctrl = document.getElementById("map-controls");
  var top = (ctrl ? ctrl.getBoundingClientRect().bottom - mapRect.top : 0) + 16;
  var bottom = mapSize().y - planeSheetInset() - 24;
  var pt = screenPoint(rec.lat, rec.lng);
  if (pt.y >= top && pt.y <= bottom && pt.x >= 16 && pt.x <= mapSize().x - 16) return;
  _autoPanning = true;
  map.easeTo({ center: [rec.lng, rec.lat], duration: 350 });
}

function setPlanePopupHtml(hex, html) {
  if (planePopupHex !== hex || !activeMapPopup) return;
  activeMapPopup.setHTML(html);
}

function refreshPlanePopup(hex) {
  if (planePopupHex !== hex) return;
  var a = findAircraftById(hex);
  if (a) setPlanePopupHtml(hex, buildPopup(a));
}

function onPlanePopupOpened(hex, el) {
  var photoEl = el && el.querySelector(".popup-photo");
  if (!photoEl) return;
  loadPopupPhoto(photoEl);
  var acInfoEl = el.querySelector(".popup-aircraft");
  if (acInfoEl) loadPopupAircraftInfo(acInfoEl);
  loadPopupTrack(hex);
  matchScheduleRoute(hex);
  var clickedPlane = findAircraftById(hex);
  if (clickedPlane && clickedPlane.callsign && !clickedPlane.private) {
    tryFr24Search(clickedPlane, { force: true }).then(function() { refreshPlanePopup(hex); });
  }
}

function syncUrlState() {
  if (map) {
    var center = map.getCenter();
    params.set("lat", center.lat.toFixed(4));
    params.set("lng", center.lng.toFixed(4));
    params.set("zoom", String(Math.round(viewZoom() * 4) / 4));
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
        setMapView(lat, lng, viewZoom());
        startGeolocation();
      },
      function() {
        fetchApproximateArea().then(function(approx) {
          if (!approx) return;
          referenceMode = approx.approximate ? "approximate" : "default";
          referenceMeta = approx;
          setReferencePosition(approx.lat, approx.lng);
          setMapView(approx.lat, approx.lng, viewZoom());
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
      setMapView(approx.lat, approx.lng, viewZoom());
    });
  }
}

function buildPlaneShareUrl(id) {
  var normalized = normalizeAircraftHex(id);
  var plane = normalized ? findAircraftById(normalized) : null;
  var pose = normalized ? getDisplayPoseForAircraft(normalized, currentDisplayTime(Date.now())) : null;
  var lat = pose ? pose.lat : (plane ? plane.lat : (map ? map.getCenter().lat : paramLat));
  var lng = pose ? pose.lng : (plane ? plane.lng : (map ? map.getCenter().lng : paramLng));
  var zoom = Math.max(map ? viewZoom() : DEFAULT_MAP_ZOOM, SEARCH_MIN_ZOOM);
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
  if (options.center && map) {
    var pose = getDisplayPoseForAircraft(plane.icao24, currentDisplayTime(Date.now())) || { lat: plane.lat, lng: plane.lng };
    flyMapTo(pose.lat, pose.lng, Math.max(viewZoom(), options.minZoom || SEARCH_MIN_ZOOM), options.duration);
  }
  if (markerMap[plane.icao24] && options.openPopup !== false) openPlanePopup(plane.icao24);
  return true;
}

function centerMapOnPlane(lat, lng, minZoom) {
  if (!map) return;
  var targetZoom = Math.max(viewZoom(), minZoom || SEARCH_MIN_ZOOM);
  var center = map.getCenter();
  var moved = !center ||
    Math.abs(center.lat - lat) > 1e-4 ||
    Math.abs(center.lng - lng) > 1e-4 ||
    Math.abs(viewZoom() - targetZoom) > 0.01;
  if (moved) {
    flyMapTo(lat, lng, targetZoom);
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
