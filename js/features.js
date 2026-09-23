// Persistence, route line, follow mode, weather radar, and saved places.

// ===========================================================================
// User features: persistence (filters / last view / saved places),
// route line, follow mode, and weather radar overlay.
// ===========================================================================
function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { window.localStorage.setItem(key, val); } catch (e) {} }

function loadSavedFilters() {
  var raw = lsGet(LS_FILTERS);
  if (!raw) return;
  try {
    var saved = JSON.parse(raw);
    if (saved && typeof saved === "object") {
      ["private", "ground", "trails", "labels"].forEach(function(k) {
        if (typeof saved[k] === "boolean") filters[k] = saved[k];
      });
    }
  } catch (e) {}
}
function saveFilters() { lsSet(LS_FILTERS, JSON.stringify(filters)); }

function loadLastView() {
  var raw = lsGet(LS_VIEW);
  if (!raw) return null;
  try {
    var v = JSON.parse(raw);
    if (v && isFinite(v.lat) && isFinite(v.lng)) return v;
  } catch (e) {}
  return null;
}
function scheduleSaveLastView() {
  if (!map) return;
  if (_saveViewTimer) clearTimeout(_saveViewTimer);
  _saveViewTimer = setTimeout(function() {
    _saveViewTimer = 0;
    if (!map) return;
    var c = map.getCenter();
    if (!c) return;
    lsSet(LS_VIEW, JSON.stringify({ lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: map.getZoom() }));
  }, 600);
}

function loadPlaces() {
  var raw = lsGet(LS_PLACES);
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.filter(function(p) { return p && isFinite(p.lat) && isFinite(p.lng); }).slice(0, 30);
    }
  } catch (e) {}
  return [];
}
function savePlaces(arr) { lsSet(LS_PLACES, JSON.stringify((arr || []).slice(0, 30))); }

// --- Route line (great circle for the selected aircraft) ---
function airportLatLngByIata(iata) {
  if (!iata) return null;
  if (!airportLatLngIndex) {
    airportLatLngIndex = {};
    if (airportData) {
      for (var i = 0; i < airportData.length; i++) {
        var ap = airportData[i];
        if (ap && ap[0] && isFinite(ap[1]) && isFinite(ap[2])) {
          airportLatLngIndex[String(ap[0]).toUpperCase()] = [ap[1], ap[2]];
        }
      }
    }
  }
  return airportLatLngIndex[String(iata).toUpperCase()] || null;
}

function clearRouteLine() {
  if (routeLayer) routeLayer.clearLayers();
  _routeLineKey = null;
}

function addRouteEndpoint(ll, iata, isOrigin) {
  if (!ll) return;
  var color = isOrigin ? "#7CFC9B" : "#FF9E6C";
  L.circleMarker([ll[0], ll[1]], {
    radius: 5, color: color, weight: 2, fillColor: color, fillOpacity: 0.9,
    interactive: false, pane: "overlayPane"
  }).addTo(routeLayer);
  if (iata) {
    L.marker([ll[0], ll[1]], {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: "route-endpoint-label",
        html: '<span class="route-endpoint-tag ' + (isOrigin ? "is-origin" : "is-dest") + '">' +
          escapeHtml(String(iata).toUpperCase()) + '</span>',
        iconSize: [0, 0], iconAnchor: [0, -7]
      })
    }).addTo(routeLayer);
  }
}

function updateRouteLine() {
  if (!map || !routeLayer) return;
  var id = selectedAircraftId;
  if (!id) { if (_routeLineKey) clearRouteLine(); return; }
  var plane = findAircraftById(id);
  var rc = plane && plane.callsign ? routeCache[plane.callsign] : null;
  var oIata = rc && rc.origin ? rc.origin.iata : null;
  var dIata = rc && rc.destination ? rc.destination.iata : null;
  var oLL = airportLatLngByIata(oIata);
  var dLL = airportLatLngByIata(dIata);
  var key = id + "|" + (oIata || "") + "|" + (dIata || "") + "|" + (oLL ? "o" : "") + (dLL ? "d" : "");
  if (key === _routeLineKey) return;
  _routeLineKey = key;
  routeLayer.clearLayers();
  if (!oLL && !dLL) return;
  if (oLL && dLL) {
    var pts = greatCirclePoints(oLL[0], oLL[1], dLL[0], dLL[1], 64);
    if (pts.length) {
      L.polyline(pts, {
        color: "#6cb6ff", weight: 2, opacity: 0.8, dashArray: "6 7",
        interactive: false, pane: "overlayPane"
      }).addTo(routeLayer);
    }
  }
  addRouteEndpoint(oLL, oIata, true);
  addRouteEndpoint(dLL, dIata, false);
}

// --- Follow mode (keep the map centered on the selected aircraft) ---
function setFollowMode(on, opts) {
  opts = opts || {};
  followMode = !!on;
  var btn = document.getElementById("toggle-follow");
  if (btn) {
    btn.classList.toggle("on", followMode);
    btn.setAttribute("aria-pressed", followMode ? "true" : "false");
  }
  if (!followMode) return;
  if (!selectedAircraftId) {
    if (!opts.silent) setControlsFeedback("Tap a plane to follow it.", "info", { timeoutMs: 3500 });
  } else {
    applyFollow(currentDisplayTime(Date.now()), true);
  }
}

function applyFollow(displayTime, force) {
  if (!followMode || !selectedAircraftId || !map) return;
  var pose = getDisplayPoseForAircraft(selectedAircraftId, displayTime);
  if (!pose) {
    var plane = findAircraftById(selectedAircraftId);
    if (plane && isFinite(plane.lat) && isFinite(plane.lng)) pose = { lat: plane.lat, lng: plane.lng };
  }
  if (!pose) return;
  var center = map.getCenter();
  if (!center) return;
  var sz = map.getSize();
  var minSide = Math.min(sz.x, sz.y) || 320;
  var planePt = map.latLngToContainerPoint([pose.lat, pose.lng]);
  var centerPt = map.latLngToContainerPoint(center);
  var drift = Math.sqrt(Math.pow(planePt.x - centerPt.x, 2) + Math.pow(planePt.y - centerPt.y, 2));
  if (!force && drift < minSide * FOLLOW_DRIFT_FRACTION) return;
  _followPanning = true;
  map.panTo([pose.lat, pose.lng], { animate: true, duration: 0.45, easeLinearity: 0.25 });
}

// --- Weather radar overlay (hybrid: IEM NEXRAD over CONUS, RainViewer global) ---
// IEM serves the real NWS NEXRAD mosaic natively at high zoom (sharp) but only
// covers the continental US. RainViewer is global, but its radar is only native
// through zoom 7 (upscaled above). We pick the source from the view center.
var CONUS_BOUNDS = { minLat: 22, maxLat: 50, minLng: -127, maxLng: -66 };

function viewIsConus() {
  if (!map) return false;
  var c = map.getCenter();
  return c.lat >= CONUS_BOUNDS.minLat && c.lat <= CONUS_BOUNDS.maxLat &&
         c.lng >= CONUS_BOUNDS.minLng && c.lng <= CONUS_BOUNDS.maxLng;
}

function buildIemLayer() {
  // USCOMP-N0Q base-reflectivity mosaic, "-0" = latest frame. Native NEXRAD
  // resolution (~1km) stays crisp into metro/street zoom; maxNativeZoom caps
  // requests once there's no more real detail (and to be polite to IEM).
  return L.tileLayer(
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-0/{z}/{x}/{y}.png",
    {
      pane: "weatherPane", opacity: 0.7, maxNativeZoom: 12, maxZoom: 18,
      tileSize: 256, crossOrigin: true,
      attribution: 'Radar \u00a9 <a href="https://mesonet.agron.iastate.edu/">IEM</a> / NWS NEXRAD'
    }
  );
}

function buildRainviewerLayer() {
  if (!_rvRadar || !_rvRadar.path) return null;
  return L.tileLayer(
    _rvRadar.host + _rvRadar.path + "/256/{z}/{x}/{y}/4/1_1.png",
    {
      pane: "weatherPane", opacity: 0.55, maxNativeZoom: 7, maxZoom: 18,
      tileSize: 256, crossOrigin: true,
      attribution: 'Radar \u00a9 <a href="https://www.rainviewer.com/">RainViewer</a>'
    }
  );
}

async function fetchRainviewerFrame() {
  var resp = await fetch(RAINVIEWER_INDEX_URL, { cache: "no-store" });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  var data = await resp.json();
  var past = (data && data.radar && data.radar.past) || [];
  var nowcast = (data && data.radar && data.radar.nowcast) || [];
  var frames = past.concat(nowcast);
  var latest = frames.length ? frames[frames.length - 1] : null;
  if (!latest || !latest.path) throw new Error("no radar frames");
  _rvRadar = { host: (data && data.host) || "https://tilecache.rainviewer.com", path: latest.path };
  return _rvRadar;
}

function applyWeatherLayer() {
  if (!map || !weatherOn) return null;
  var source = viewIsConus() ? "iem" : "rainviewer";
  var layer = source === "iem" ? buildIemLayer() : buildRainviewerLayer();
  if (!layer) return null;
  if (_weatherLayer && map) map.removeLayer(_weatherLayer);
  _weatherLayer = layer;
  _weatherLayer.addTo(map);
  _weatherSource = source;
  return source;
}

function weatherSourceLabel(source) {
  return source === "iem" ? "US radar \u00b7 NWS NEXRAD" : "Global radar \u00b7 RainViewer";
}

async function enableWeather(opts) {
  opts = opts || {};
  weatherOn = true;
  var btn = document.getElementById("toggle-weather");
  if (btn) { btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); }
  if (!map) return;
  try {
    // Always keep a RainViewer frame ready for the global fallback, even when
    // booting over CONUS, so panning out of the US has data immediately.
    await fetchRainviewerFrame();
    if (!weatherOn) return; // toggled off mid-fetch
    var source = applyWeatherLayer();
    _weatherRefreshTs = Date.now();
    if (!opts.silent && source) {
      setControlsFeedback("Weather radar on \u00b7 " + weatherSourceLabel(source), "info", { timeoutMs: 3500 });
    }
  } catch (e) {
    // RainViewer index failed. If we're over CONUS we can still show IEM.
    if (weatherOn && viewIsConus()) {
      try {
        if (_weatherLayer && map) map.removeLayer(_weatherLayer);
        _weatherLayer = buildIemLayer();
        _weatherLayer.addTo(map);
        _weatherSource = "iem";
        _weatherRefreshTs = Date.now();
        if (!opts.silent) setControlsFeedback("Weather radar on \u00b7 " + weatherSourceLabel("iem"), "info", { timeoutMs: 3500 });
        return;
      } catch (e2) {}
    }
    weatherOn = false;
    if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); }
    if (!opts.silent) setControlsFeedback("Weather radar unavailable right now.", "info", { timeoutMs: 4000 });
  }
}

function disableWeather() {
  weatherOn = false;
  var btn = document.getElementById("toggle-weather");
  if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); }
  if (_weatherLayer && map) map.removeLayer(_weatherLayer);
  _weatherLayer = null;
  _weatherSource = null;
}

function toggleWeather() {
  if (weatherOn) disableWeather();
  else enableWeather();
}

// Swap the active radar source when the view crosses into/out of CONUS.
function maybeSwapWeatherSource() {
  if (!weatherOn || !map) return;
  var want = viewIsConus() ? "iem" : "rainviewer";
  if (want === _weatherSource) return;
  if (want === "rainviewer" && (!_rvRadar || !_rvRadar.path)) {
    fetchRainviewerFrame().then(function() { if (weatherOn) applyWeatherLayer(); }).catch(function() {});
    return;
  }
  applyWeatherLayer();
}

function maybeRefreshWeather() {
  if (!weatherOn || !map) return;
  if (Date.now() - _weatherRefreshTs < 5 * 60 * 1000) return;
  enableWeather({ silent: true });
}

// --- Saved places panel ---
function placesPanelOpen() {
  var panel = document.getElementById("places-panel");
  return !!(panel && !panel.hidden);
}
function setPlacesPanel(open) {
  var panel = document.getElementById("places-panel");
  var btn = document.getElementById("toggle-places");
  if (!panel) return;
  panel.hidden = !open;
  if (btn) {
    btn.classList.toggle("on", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (open) renderPlaces();
}
function renderPlaces() {
  var list = document.getElementById("places-list");
  if (!list) return;
  var places = loadPlaces();
  if (!places.length) {
    list.innerHTML = '<div class="places-empty">No saved places yet. Pan/zoom the map, then tap “Save current view”.</div>';
    return;
  }
  var html = "";
  for (var i = 0; i < places.length; i++) {
    var p = places[i];
    html += '<div class="places-row">' +
      '<button type="button" class="places-go" data-idx="' + i + '">' + escapeHtml(p.name || "Saved view") + '</button>' +
      '<button type="button" class="places-del" data-del="' + i + '" aria-label="Delete saved place">&times;</button>' +
      '</div>';
  }
  list.innerHTML = html;
}
function saveCurrentPlace() {
  if (!map) return;
  var c = map.getCenter();
  if (!c) return;
  var name = "";
  try { name = window.prompt("Name this place", suggestPlaceName(c.lat, c.lng)) || ""; } catch (e) { name = ""; }
  name = name.trim();
  if (!name) return;
  var places = loadPlaces();
  places.push({ name: name.slice(0, 40), lat: +c.lat.toFixed(4), lng: +c.lng.toFixed(4), zoom: map.getZoom() });
  savePlaces(places);
  renderPlaces();
  setControlsFeedback("Saved “" + name.slice(0, 40) + "”.", "info", { timeoutMs: 3000 });
}
function suggestPlaceName(lat, lng) {
  var region = findNearestRegion(lat, lng, 90);
  if (region) return region.name;
  return lat.toFixed(2) + ", " + lng.toFixed(2);
}
function goToPlace(idx) {
  var places = loadPlaces();
  var p = places[idx];
  if (!p || !map) return;
  setPlacesPanel(false);
  map.flyTo([p.lat, p.lng], isFinite(p.zoom) ? p.zoom : map.getZoom(), { duration: 0.75, easeLinearity: 0.18 });
}
function deletePlace(idx) {
  var places = loadPlaces();
  if (idx < 0 || idx >= places.length) return;
  places.splice(idx, 1);
  savePlaces(places);
  renderPlaces();
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
    // Hidden tabs stop polling; handlePageResume restarts the loop.
    if (document.hidden) return;
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

function shouldShowReferenceDistances() {
  return referenceMode === "device" || referenceMode === "manual";
}

function updateReferenceNote() {
  var note = document.getElementById("reference-note");
  if (!note) return;
  var label = formatReferenceLabel(referenceMeta);
  var hasDeviceDot = deviceLat != null && deviceLng != null && referenceMode !== "device";
  if (referenceMode === "approximate") {
    note.textContent = label
      ? "Using an approximate network area near " + label + ". Distance readouts stay hidden until live location is available."
      : "Using an approximate network area. Distance readouts stay hidden until live location is available.";
    return;
  }
  if (referenceMode === "default") {
    note.textContent = "Using " + (label || "the default browse area") + " as the reference area. Distance readouts stay hidden until live location is available.";
    return;
  }
  if (referenceMode === "manual") {
    note.textContent = "Using " + (label || "your selected area") + " as the reference area." +
      (hasDeviceDot ? " Your live location is still shown with the blue dot." : "");
    return;
  }
  note.textContent = "Using your live location for distance and bearing.";
}

function updateViewHint(visibleCount) {
  var hint = document.getElementById("view-hint");
  if (!hint) return;
  if (trafficFetchOk === false) {
    hint.textContent = "Retrying automatically \u2014 browse the map while you wait.";
    return;
  }
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
  if (trafficSource === "backup") {
    hint.textContent = "Using backup traffic feed \u2014 coverage may vary.";
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

function setReferencePosition(lat, lng, options) {
  options = options || {};
  userLat = lat;
  userLng = lng;
  if (options.refresh === false) return;
  refreshAircraftProximity();
  renderMap();
  updateStatus();
  updateAlerts();
  updateReferenceNote();
  if (refreshSearchUi) refreshSearchUi();
}

function updateDevicePosition(lat, lng, options) {
  options = options || {};
  deviceLat = lat;
  deviceLng = lng;
  if (map && !userMarker) {
    userMarker = L.circleMarker([lat, lng], {
      radius: 7, fillColor: "#5bbcf5", fillOpacity: 1,
      color: "#fff", weight: 2
    }).addTo(map);
  }
  if (userMarker) userMarker.setLatLng([lat, lng]);
  if (options.useAsReference) {
    setReferencePosition(lat, lng, { refresh: options.refresh });
    return;
  }
  if (options.refresh === false) return;
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
