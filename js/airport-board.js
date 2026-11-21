// Airport schedule popup card (FIDS boards).

// --- Airport schedule popup card ---
var _airportBoardState = core.createAirportBoardState();

// Read globals at call time: tests and the app can replace the clock, data and hooks.
function airportBoardEnvironment() {
  return {
    core: core, now: Date.now(), state: _airportBoardState,
    aircraft: typeof aircraft !== "undefined" ? aircraft : [],
    airportData: typeof airportData !== "undefined" ? airportData : null,
    runwayData: typeof runwayData !== "undefined" ? runwayData : null,
    posHistory: typeof posHistory !== "undefined" ? posHistory : {},
    extraState: typeof extraState !== "undefined" ? extraState : {},
    scheduleDataCache: typeof scheduleDataCache !== "undefined" ? scheduleDataCache : {},
    scheduleCacheTtl: typeof SCHEDULE_CACHE_TTL !== "undefined" ? SCHEDULE_CACHE_TTL : undefined,
    departurePerimeterKm: DEPARTURE_PERIMETER_KM, airportPopupFetchKm: AIRPORT_POPUP_FETCH_KM,
    validateCachedRoute: validateCachedRoute,
    selectClientScheduleMatch: typeof selectClientScheduleMatch === "function" ? selectClientScheduleMatch : undefined,
    applyScheduleMatch: typeof applyScheduleMatch === "function" ? applyScheduleMatch : undefined
  };
}

var _activeAirportPopup = null;
var _activeAirportIata = null;
var _activeAirportName = null;
var _activeAirportLat = null;
var _activeAirportLng = null;
var _activeAirportScopeId = null;
var _airportScopeSeq = 0;
var _activeScheduleDir = "arrivals";
var _lastScheduleHtml = "";
var _airportPopupCache = {};
var _activeAirportRefreshTimer = null;
var _airportPanelRepositionTimer = null;
var _airportFocusOpener = null;
var _airportRestoreFocusOnClose = true;
var AIRPORT_PANEL_DOCKED_QUERY = "(max-width: 759px)";
var AIRPORT_POPUP_FETCH_KM = 120;
// Outer radius (km) for the departures dashboard: once a climbing aircraft is
// farther than this from the airport it has left the perimeter / immediate
// climbout and is just an en-route flight, so it drops off the board.
var DEPARTURE_PERIMETER_KM = 6;
var AIRPORT_POPUP_REFRESH_MS = 5000;
var AIRPORT_POPUP_CACHE_TTL = 2 * 60 * 1000;
var DATIS_CACHE_TTL = 60 * 1000;
var _airportCountdowns = {};
var _airportCountdownTimer = null;
var _airportTabScroll = {};
var _airportBoardView = "list";
var _airportEtaPanelOpen = false;
var _airportEtaLog = null;
var _airportEtaResetAt = {};
var _airportEtaStorageAvailable = true;
var AIRPORT_ETA_STORAGE_KEY = "contrails-airport-eta-v1";
try { if (window.localStorage.getItem("contrails-airport-view") === "ladder") _airportBoardView = "ladder"; } catch (err) {}

function isAirportPanelDocked() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia(AIRPORT_PANEL_DOCKED_QUERY).matches;
}

function closeActiveAirportPanel(options) {
  if (!_activeAirportPopup) return;
  _airportRestoreFocusOnClose = !(options && options.restoreFocus === false);
  _activeAirportPopup.remove();
}

function handleAirportSchedulePanelClick(event) {
  var t = event && event.target;
  if (!t || !t.closest) return false;
  var viewBtn = t.closest("[data-board-view]");
  var accuracyBtn = t.closest("[data-eta-action]");
  if (viewBtn || accuracyBtn) {
    event.preventDefault(); event.stopPropagation();
    if (viewBtn) {
      _airportBoardView = viewBtn.getAttribute("data-board-view") === "ladder" ? "ladder" : "list";
      try { window.localStorage.setItem("contrails-airport-view", _airportBoardView); } catch (err) {}
    } else if (accuracyBtn.getAttribute("data-eta-action") === "reset") resetAirportEta(_activeAirportIata);
    else _airportEtaPanelOpen = !_airportEtaPanelOpen;
    renderSchedulePopup(viewBtn && _airportBoardView === "ladder" ? "arrivals" : _activeScheduleDir);
    return true;
  }
  var toggleBtn = t.closest(".sched-toggle-btn");
  if (toggleBtn) {
    event.preventDefault();
    event.stopPropagation();
    var dir = toggleBtn.getAttribute("data-dir");
    if (dir) {
      _lastScheduleHtml = "";
      renderSchedulePopup(dir);
    }
    return true;
  }
  var schedRow = t.closest(".sched-row, .sched-next-clickable, .sched-ladder-bead");
  if (schedRow) {
    event.preventDefault();
    event.stopPropagation();
    var hex = schedRow.getAttribute("data-hex");
    var cs = schedRow.getAttribute("data-callsign");
    var lat = parseFloat(schedRow.getAttribute("data-lat") || "");
    var lng = parseFloat(schedRow.getAttribute("data-lng") || "");
    closeActiveAirportPanel({ restoreFocus: false });
    if (hex && focusAircraftById(hex, { center: true, openPopup: true, minZoom: 12 })) return true;
    if (hex && isFinite(lat) && isFinite(lng)) {
      var label = (cs || hex).toUpperCase();
      queuePendingPlaneFocus(hex, {
        keepUrl: true,
        label: label,
        reason: "airport-popup"
      });
      setControlsFeedback("Centering on " + label + "…", "info", { timeoutMs: 4500 });
      centerMapOnPlane(lat, lng, SEARCH_MIN_ZOOM);
      return true;
    }
    if (cs) {
      var plane = findAircraftByQuery({ type: "callsign", value: cs.toUpperCase(), variants: [cs.toUpperCase()] });
      if (plane) focusAircraftById(plane.icao24, { center: true, openPopup: true, minZoom: 12 });
    }
    return true;
  }
  return false;
}

function ensureAirportSheetPanel() {
  var panel = document.getElementById("airport-panel");
  var sheet = document.getElementById("airport-panel-sheet");
  var content = document.getElementById("airport-panel-content");
  var close = document.getElementById("airport-panel-close");
  if (!panel || !sheet || !content || !close) return null;
  if (!panel.__contrailsAirportSheetBound) {
    panel.__contrailsAirportSheetBound = true;
    close.addEventListener("click", function(event) {
      event.preventDefault();
      closeActiveAirportPanel();
    });
    content.addEventListener("click", handleAirportSchedulePanelClick);
  }
  return { panel: panel, sheet: sheet, content: content };
}

function airportCloseLabel(iata) {
  return "Close " + (iata ? iata + " " : "") + "airport traffic";
}

function openAirportSheetPanel(html, iata) {
  var els = ensureAirportSheetPanel();
  if (!els) return null;
  var removeHandlers = [];
  // Same surface as a map popup (setHTML / getElement / on("close") / remove) so callers needn't care.
  var api = {
    _isAirportSheet: true,
    setHTML: function(contentHtml) {
      els.content.innerHTML = contentHtml;
      return api;
    },
    getElement: function() {
      return els.sheet;
    },
    on: function(eventName, handler) {
      if (eventName === "close" && typeof handler === "function") removeHandlers.push(handler);
      return api;
    },
    remove: function() {
      if (!els.panel.classList.contains("open")) return;
      els.panel.classList.remove("open");
      els.panel.setAttribute("aria-hidden", "true");
      els.content.innerHTML = "";
      for (var i = 0; i < removeHandlers.length; i++) removeHandlers[i]();
    }
  };
  api.setHTML(html);
  var close = document.getElementById("airport-panel-close");
  if (close) close.setAttribute("aria-label", airportCloseLabel(iata));
  els.panel.classList.add("open");
  els.panel.setAttribute("aria-hidden", "false");
  return api;
}

function updateAirportPopupCloseName(popup, iata) {
  if (!popup || !popup.getElement) return;
  var el = popup.getElement();
  if (!el || !el.querySelector) return;
  var close = el.querySelector(".maplibregl-popup-close-button");
  if (!close) return;
  var label = airportCloseLabel(iata);
  close.setAttribute("aria-label", label);
  close.setAttribute("title", label);
}

function focusAirportPopupClose(popup) {
  if (!popup || !popup.getElement) return;
  var el = popup.getElement();
  if (!el || !el.querySelector) return;
  var close = popup._isAirportSheet
    ? document.getElementById("airport-panel-close")
    : el.querySelector(".maplibregl-popup-close-button");
  focusWithoutScroll(close);
}

function clearAirportPanelReposition() {
  if (_airportPanelRepositionTimer) {
    clearTimeout(_airportPanelRepositionTimer);
    _airportPanelRepositionTimer = null;
  }
}

function scheduleAirportPanelReposition(delayMs) {
  if (!_activeAirportPopup || _activeAirportLat == null || _activeAirportLng == null) return;
  clearAirportPanelReposition();
  _airportPanelRepositionTimer = setTimeout(function() {
    _airportPanelRepositionTimer = null;
    panAirportIntoDockedMapRegion();
  }, delayMs == null ? 80 : delayMs);
}

function panAirportIntoDockedMapRegion() {
  if (!map || !_activeAirportPopup || _activeAirportLat == null || _activeAirportLng == null) return;
  if (!isAirportPanelDocked() || !_activeAirportPopup.getElement) return;
  var el = _activeAirportPopup.getElement();
  if (!el || !el.getBoundingClientRect) return;
  var mapEl = map.getContainer && map.getContainer();
  if (!mapEl || !mapEl.getBoundingClientRect) return;

  var mapRect = mapEl.getBoundingClientRect();
  var panelRect = el.getBoundingClientRect();
  if (mapRect.width < 1 || mapRect.height < 1 || panelRect.height < 1) return;

  var panelTop = Math.max(0, Math.min(mapRect.height, panelRect.top - mapRect.top));
  var visibleTop = 18;
  var visibleBottom = Math.max(visibleTop + 120, panelTop - 12);
  visibleBottom = Math.min(visibleBottom, mapRect.height - 18);
  var visibleHeight = visibleBottom - visibleTop;
  if (visibleHeight < 120) return;

  var targetPoint = screenPoint(_activeAirportLat, _activeAirportLng);
  var desiredX = mapRect.width / 2;
  var desiredY = visibleTop + visibleHeight * 0.52;
  var dx = targetPoint.x - desiredX;
  var dy = targetPoint.y - desiredY;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
  panMapBy(Math.round(dx), Math.round(dy), 0.35);
}

// Field elevation (ft) from airports.json, 0 when unknown. The feed reports sea-level altitude, so every
// "low altitude" rule on the board compares height above this.
function airportElevationFt(iata) {
  return core.airportElevationIn(airportBoardEnvironment(), iata);
}

// FR24's estimated landing time for a live inbound flight, in minutes from now (null if not on the board).
// est_arr is an absolute time, so a schedule fetched a few minutes ago is still usable.
function feedArrivalEtaMin(callsign, airportIata) {
  return core.feedArrivalEtaIn(airportBoardEnvironment(), callsign, airportIata);
}

function buildArrivalEntry(a, routeEntry, airportIata, distKm, options) {
  return core.buildAirportArrival(airportBoardEnvironment(), a, routeEntry, airportIata, distKm, options);
}

function formatLandingEta(etaMin) {
  return core.formatLandingEta(etaMin);
}

function formatScheduleFlightNumber(callsign) {
  return (callsign || "\u2014").replace(/^([A-Za-z]+)(\d+)$/, "$1 $2");
}

function formatLandingSummaryStatus(row) {
  if (!row) return "";
  if (row.goAround) return "GO-AROUND · back in ~" + Math.max(1, Math.round(row.etaMin)) + " min";
  if (row.landed) return "On runway";
  if (row.parked) return "At gate";
  if (row.taxiingIn) return "Taxiing in";
  var eta = formatLandingEta(row.etaMin);
  return eta ? "ETA " + eta : "Inbound";
}

function scheduleRunwayChip(row) {
  if (!row.runway) return "";
  return '<span class="sched-runway' + (row.runwayAssumed ? ' assumed' : '') + '" title="' +
    (row.runwayAssumed ? 'Assumed active runway' : 'Matched runway') + '">' + escapeHtml(row.runway) + '</span>' +
    (row.sequence && !row.runwayAssumed ? '<span class="sched-sequence">#' + row.sequence + '</span>' : '');
}

function scheduleArrivalTime(row, summary) {
  if (row.goAround) return '<span class="sched-go-around">' + escapeHtml(formatLandingSummaryStatus(row)) + '</span>';
  if (row.landed || row.taxiingIn) return escapeHtml(formatLandingSummaryStatus(row));
  if (!Number.isFinite(row.etaMin)) return "Inbound";
  var key = row.hex || row.callsign;
  var state = _airportCountdowns[key];
  var seconds = state ? state.remainingSec : row.etaMin * 60;
  return '<span data-countdown="' + escapeHtml(key || "") + '"' + (summary ? ' data-countdown-summary="true"' : '') + '>' +
    (seconds < 600 && !(state && state.coarse) ? core.formatArrivalCountdown(seconds) : (summary ? "ETA " : "") + formatLandingEta(seconds / 60)) + '</span>';
}

var SCHEDULE_TABS = [
  { dir: "arrivals", label: "Landings", title: "Next landing", empty: "No landings nearby", none: "No other landings nearby", emptyNext: "No landing candidates nearby" },
  { dir: "landed", label: "Landed", title: "Just landed", empty: "No planes on the ground from recent landings", none: "No other landed planes", emptyNext: "No recently landed planes" },
  { dir: "departures", label: "Takeoffs", title: "Next takeoff", empty: "No takeoffs nearby", none: "No other takeoffs nearby", emptyNext: "No takeoff candidates nearby" }
];

function scheduleTab(dir) {
  for (var i = 0; i < SCHEDULE_TABS.length; i++) if (SCHEDULE_TABS[i].dir === dir) return SCHEDULE_TABS[i];
  return SCHEDULE_TABS[0];
}

function scheduleRowAttrs(f) {
  return ' data-callsign="' + escapeHtml(f.callsign || "") +
    '" data-hex="' + escapeHtml(f.hex || "") +
    '" data-lat="' + (f.lat != null ? String(f.lat) : "") +
    '" data-lng="' + (f.lng != null ? String(f.lng) : "") + '"';
}

function formatTakeoffSummaryStatus(row, liveData) {
  if (!row) return "";
  var signal = describeAirportDepartureStatus(row, {
    activeRunways: !!(liveData && liveData.activeDepartureRunways)
  });
  if (row.status === "Departing") return "Departing";
  if (row.status === "Climbing") return "Climbing";
  return signal.label;
}

function boardRouteTag(row, dir) {
  var code = dir === "departures" ? row.destIata : row.originIata;
  if (!code) return "";
  var rc = routeCache[row.callsign];
  var provenance = core.routeProvenance(dir === "departures"
    ? { destination: { iata: code }, destSource: rc && rc.destSource }
    : { origin: { iata: code }, originSource: rc && rc.originSource });
  return ' <span class="route-provenance" title="' + escapeHtml(provenance.note) + '">' + provenance.label + '</span>';
}

function buildScheduleNextSummary(liveData, dir) {
  var tab = scheduleTab(dir);
  var next = getAirportNextRow(liveData, dir);
  var message = liveData && liveData.message ? liveData.message : "";
  var state = liveData && liveData.state ? liveData.state : "";
  var title = tab.title;
  if (!next) {
    var emptyClass = state === "loading" ? " loading" : (state === "error" ? " error" : " empty");
    var emptyMessage = message || tab.emptyNext;
    return '<div class="sched-next' + emptyClass + '">' +
      '<div class="sched-next-kicker">' + title + '</div>' +
      '<div class="sched-next-empty-text">' + escapeHtml(emptyMessage) + '</div>' +
    '</div>';
  }

  var flightNum = escapeHtml(formatScheduleFlightNumber(next.callsign));
  var statusText;
  var routeParts = [];
  var summaryClass = "sched-next";
  if (next.goAround) summaryClass += " go-around";
  if (dir !== "departures") {
    statusText = formatLandingSummaryStatus(next);
    if (next.originIata) routeParts.push("from " + next.originIata);
    if (next.aircraftType) routeParts.push(next.aircraftType);
    if (dir === "landed") summaryClass += " landed";
  } else {
    var depSignal = describeAirportDepartureStatus(next, { activeRunways: !!liveData.activeDepartureRunways });
    // Climbing rows sort last, so a climbing top row means nothing is queued on the ground.
    if (next.status === "Climbing") title = "Just departed";
    else if (depSignal.confidence === "medium") title = "Likely next takeoff";
    else if (depSignal.confidence === "low") title = "Possible next takeoff";
    statusText = formatTakeoffSummaryStatus(next, liveData);
    if (next.destIata) routeParts.push("to " + next.destIata);
    summaryClass += " departure";
  }
  var routeText = routeParts.length ? routeParts.join(" \u00b7 ") : "";

  // Make the highlighted next-flight summary tappable, matching the rows below.
  return '<div class="' + summaryClass + ' sched-next-clickable" role="button" tabindex="0"' + scheduleRowAttrs(next) + '>' +
    '<div class="sched-next-kicker">' + escapeHtml(title) + '</div>' +
    '<div class="sched-next-main">' +
      '<span class="sched-next-flight">' + flightNum + '</span>' + scheduleRunwayChip(next) +
      '<span class="sched-next-status">' + (dir === "arrivals" ? scheduleArrivalTime(next, true) : escapeHtml(statusText)) + '</span>' +
    '</div>' +
    (routeText ? '<div class="sched-next-route">' + escapeHtml(routeText) + boardRouteTag(next, dir) + '</div>' : '') +
  '</div>';
}

function mergeActiveRunways(primary, fallback) {
  return core.mergeActiveRunways(primary, fallback);
}

// Runways seen in use per airport, so a quiet few minutes with no plane on a runway don't drop the active
// runway and reshuffle the board between refreshes. Each runway expires 15 minutes after its last sighting.

function rememberActiveRunways(iata, derived) {
  return core.rememberRunwaysIn(airportBoardEnvironment(), iata, derived);
}

// Feed speed change (kts) across the client's recent samples for this plane; negative when slowing.
function recentSpeedChangeKts(hex, spanMs) {
  return core.recentSpeedChangeIn(airportBoardEnvironment(), hex, spanMs);
}


// Landing ends of every runway at other airports within 50 km, for telling apart traffic bound for a
// neighbour (OAK finals pass close to SFO).
function nearbyRunwayEnds(iata, lat, lng) {
  return core.nearbyRunwayEndsIn(airportBoardEnvironment(), iata, lat, lng);
}

function airportGoAroundObservations(iata, lat, lng, list, ends, nowMs, fieldElev) {
  return core.observeAirportGoArounds(airportBoardEnvironment(), iata, lat, lng, list, ends, nowMs, fieldElev);
}

function buildLiveScheduleData(airportIata, airportLat, airportLng, sourceAircraft, activeRunwaysOverride) {
  return core.buildAirportBoard(airportBoardEnvironment(), airportIata, airportLat, airportLng, sourceAircraft, activeRunwaysOverride);
}

function loadAirportEtaLog() {
  if (_airportEtaLog) return _airportEtaLog;
  try {
    var saved = JSON.parse(window.localStorage.getItem(AIRPORT_ETA_STORAGE_KEY) || "[]");
    _airportEtaLog = core.pruneArrivalLog(Array.isArray(saved) ? saved : []);
  } catch (err) { _airportEtaLog = []; _airportEtaStorageAvailable = false; }
  return _airportEtaLog;
}

function saveAirportEtaLog(records) {
  _airportEtaLog = records;
  try { window.localStorage.setItem(AIRPORT_ETA_STORAGE_KEY, JSON.stringify(records)); _airportEtaStorageAvailable = true; }
  catch (err) { _airportEtaStorageAvailable = false; }
}

function resetAirportEta(iata) {
  _airportEtaResetAt[iata] = Date.now();
  saveAirportEtaLog(loadAirportEtaLog().filter(function(r) { return r.airport !== iata; }));
}

function observeAirportEta(iata, liveData, snapshot) {
  if (!_activeAirportPopup || _activeAirportIata !== iata) return;
  var original = loadAirportEtaLog(), records = original, now = Date.now();
  (liveData.arrivals || []).forEach(function(row) {
    if (!Number.isFinite(row.reportTs) || now - row.reportTs > 30000 || row.reportTs > now || row.reportTs <= (_airportEtaResetAt[iata] || 0)) return;
    records = core.recordArrivalPrediction(records, { airport: iata, hex: row.hex, nowMs: row.reportTs,
      predictionAtMs: row.reportTs, etaMin: row.etaMin, goAround: row.goAround });
  });
  (snapshot || []).forEach(function(a) {
    if (!a.ground || !Number.isFinite(a.reportTs) || now - a.reportTs > 30000 || a.reportTs > now || a.reportTs <= (_airportEtaResetAt[iata] || 0)) return;
    // First observed ground report at this field. A missing plane or an airborne low pass is not touchdown.
    records = core.recordArrivalPrediction(records, { airport: iata, hex: a.icao24, nowMs: a.reportTs,
      touchdown: true, atAirport: _activeAirportLat != null && _activeAirportLng != null &&
        haversineKm(a.lat, a.lng, _activeAirportLat, _activeAirportLng) <= 6 });
  });
  if (records !== original) {
    // Keep last-seen freshness in memory; persist only new horizons, touchdown or voided approaches.
    _airportEtaLog = records;
    if (records.length !== original.length || records.some(function(r, i) {
      return r.key !== original[i].key || r.predictions !== original[i].predictions || r.actualAtMs !== original[i].actualAtMs;
    })) saveAirportEtaLog(records);
  }
}

function buildAirportEtaFooter(iata) {
  var score = core.arrivalEtaScorecard(loadAirportEtaLog(), iata);
  var two = score.horizons[2];
  var summary = two.count ? 'last ' + score.count + ' landings: median error ' + core.formatArrivalCountdown(Math.round(two.medianSec)) + ' at 2 min' : 'waiting for landings';
  var html = '<div class="sched-footer"><button type="button" class="sched-accuracy-link" data-eta-action="toggle" aria-expanded="' +
    _airportEtaPanelOpen + '">ETA accuracy · ' + escapeHtml(summary) + '</button>';
  if (_airportEtaPanelOpen) {
    html += '<div class="sched-accuracy"><div class="sched-accuracy-title">' + escapeHtml(iata) + ' · last ' + score.count + ' landings' +
      '<button type="button" data-eta-action="reset">Reset this airport</button></div>' +
      '<table><caption>Absolute ETA error at each predicted horizon</caption><thead><tr><th>Horizon</th><th>Median</th><th>90th %</th><th>Count</th></tr></thead><tbody>';
    score.horizons.forEach(function(h) {
      html += '<tr><th>' + h.minutes + ' min</th><td>' + core.formatArrivalCountdown(h.medianSec == null ? null : Math.round(h.medianSec)) +
        '</td><td>' + core.formatArrivalCountdown(h.p90Sec == null ? null : Math.round(h.p90Sec)) + '</td><td>' + h.count + '</td></tr>';
    });
    html += '</tbody></table><p>Logged only while this board is open. First forecast near each horizon; touchdown is the first ground report here. ' +
      (_airportEtaStorageAvailable ? 'Stored on this device only; up to 2,000 arrivals.' : 'Storage unavailable; kept for this session only.') + '</p></div>';
  }
  return html + '</div>';
}

function buildApproachLadder(liveData) {
  var layout = core.layoutApproachLadder(liveData.arrivals, { runways: liveData.activeArrivalRunways });
  var n = layout.runways.length;
  var waiting = (liveData.arrivals || []).filter(function(r) { return r.goAround || !r.runway || layout.runways.indexOf(r.runway) < 0; });
  var holding = '<div class="sched-ladder-holding' + (!n ? ' sched-ladder-unknown' : '') + '">' + (!n ? '<div class="sched-empty">Runway unknown</div>' : '');
  waiting.forEach(function(row) {
    holding += '<button type="button" class="sched-row"' + scheduleRowAttrs(row) + '><span class="sched-flight">' +
      escapeHtml(row.callsign || row.hex) + '</span><span class="sched-eta">' +
      (row.goAround ? scheduleArrivalTime(row) : (row.runway ? 'Runway ' + escapeHtml(row.runway) : 'Runway unknown') + ' · ' + scheduleArrivalTime(row)) + '</span></button>';
  });
  holding += '</div>';
  var html = '<div class="sched-ladder" data-ladder-runways="' + escapeHtml(layout.runways.join(',')) + '" aria-label="Arrival times, 15 minutes to touchdown">';
  if (!n) return html + holding + '</div>';
  html += '<div class="sched-ladder-plot">';
  [15, 10, 5, 0].forEach(function(min) {
    html += '<div class="sched-ladder-tick" style="top:' + ((15 - min) / 15 * 100) + '%"><span>' + (min ? min + 'm' : 'now') + '</span></div>';
  });
  layout.runways.forEach(function(runway, i) {
    html += '<div class="sched-ladder-lane" style="left:' + (i / n * 100) + '%;width:' + (100 / n) + '%"><span>' + escapeHtml(runway) + '</span></div>';
  });
  layout.pairs.forEach(function(pair) {
    html += '<span class="sched-ladder-pair" data-ladder-key="pair-' + escapeHtml(pair.a + '-' + pair.b) + '" style="top:' + (pair.y * 100) +
      '%;left:' + (pair.left / n * 100) + '%;width:' + ((pair.right - pair.left) / n * 100) + '%" title="Parallel arrivals within 20 seconds">pair</span>';
  });
  layout.beads.forEach(function(bead) {
    var key = escapeHtml(bead.hex);
    html += '<span class="sched-ladder-dot" data-ladder-key="dot-' + key + '" style="top:' + (bead.y * 100) + '%;left:' + (bead.lane / n * 100) + '%"></span>';
    html += '<span class="sched-ladder-leader" data-ladder-key="leader-' + key + '" style="top:' + (Math.min(bead.y, bead.labelY) * 100) +
      '%;height:' + (Math.abs(bead.y - bead.labelY) * 100) + '%;left:' + (bead.lane / n * 100) + '%"></span>';
    html += '<button type="button" class="sched-ladder-bead' + (bead.runwayAssumed ? ' assumed' : '') + (bead.compactLabel ? ' compact' : '') + '" data-ladder-key="bead-' + key + '"' + scheduleRowAttrs(bead) +
      ' style="top:' + (bead.labelY * 100) + '%;left:' + (bead.lane / n * 100) + '%;width:' + (100 / n) + '%" title="' +
      escapeHtml((bead.callsign || bead.hex) + ' · ' + bead.runway + ' · ' + formatLandingEta(bead.etaMin) + (bead.runwayAssumed ? ' · assumed runway' : '')) + '">' +
      '<span>' + escapeHtml(bead.callsign || bead.hex) + '</span><small>' + escapeHtml(bead.aircraftType || '') + '</small></button>';
  });
  html += '</div>';
  html += holding + '<div class="sched-ladder-note">Time to touchdown · tap a flight</div>';
  return html + '</div>';
}

function buildScheduleCardContent(iata, name, liveData, dir, scopeId, staleNote) {
  var tab = scheduleTab(dir);
  dir = tab.dir;
  var items = liveData[dir] || [];
  var listRows = items.length > 0 ? items.slice(1) : [];
  var message = liveData && liveData.message ? liveData.message : "";
  var safeName = escapeHtml(name || "").replace(/"/g, "&quot;");
  var titleId = scopeId ? scopeId + "-title" : "";
  var titleAttr = titleId ? ' id="' + titleId + '"' : "";
  var html = '<div class="sched-card" data-sched-iata="' + escapeHtml(iata) +
    '" data-sched-name="' + safeName +
    '" data-sched-dir="' + dir + '">' +
    '<div class="sched-header"' + titleAttr + '>' +
      '<span class="sched-iata">' + escapeHtml(iata) + '</span> ' +
      '<span class="sched-name">' + escapeHtml(name) + '</span>' +
      (dir === 'arrivals' ? '<span class="sched-view-toggle" role="group" aria-label="Arrival display">' +
      '<button type="button" data-board-view="list" aria-pressed="' + (_airportBoardView === 'list') + '">List</button>' +
      '<button type="button" data-board-view="ladder" aria-pressed="' + (_airportBoardView === 'ladder') + '">Ladder</button></span>' : '') +
      (staleNote ? ' <span class="sched-stale" style="opacity:0.7;font-size:0.85em;white-space:nowrap">' + escapeHtml(staleNote) + '</span>' : '') +
    '</div>' +
    '<div class="sched-toggle" role="group" aria-label="Airport traffic view">';
  for (var t = 0; t < SCHEDULE_TABS.length; t++) {
    var on = SCHEDULE_TABS[t].dir === dir;
    var count = (liveData[SCHEDULE_TABS[t].dir] || []).length;
    html += '<button type="button" class="sched-toggle-btn' + (on ? " active" : "") + '" data-dir="' + SCHEDULE_TABS[t].dir +
      '" aria-pressed="' + (on ? "true" : "false") + '">' + SCHEDULE_TABS[t].label +
      (count ? ' <span class="sched-toggle-count">' + count + '</span>' : '') + '</button>';
  }
  html += '</div>';
  html += '<div class="sched-body">';
  if (_airportBoardView === "ladder" && dir === "arrivals") {
    html += buildApproachLadder(liveData);
    return html + '</div>' + buildAirportEtaFooter(iata) + '</div>';
  }
  html += buildScheduleNextSummary(liveData, dir);
  html += '<div class="sched-rows">';
  if (!items.length) {
    html += '<div class="sched-empty">' + escapeHtml(message || tab.empty) + '</div>';
  } else if (!listRows.length) {
    html += '<div class="sched-empty">' + escapeHtml(tab.none) + '</div>';
  } else if (dir !== "departures") {
    for (var i = 0; i < listRows.length; i++) {
      var f = listRows[i];
      var cs = f.callsign || "";
      var flightNum = escapeHtml(formatScheduleFlightNumber(cs));
      var fromIata = f.originIata ? escapeHtml(f.originIata) : "\u2014";
      html += '<div class="sched-row' + (f.goAround ? ' go-around' : '') + '" role="button" tabindex="0"' + scheduleRowAttrs(f) + '>';
      if (f.landed || f.taxiingIn) {
        var dot = f.landed ? "cyan" : (f.parked ? "gray" : "green");
        html += '<span class="sched-dot ' + dot + '"></span>' +
          '<span class="sched-flight-group"><span class="sched-flight">' + flightNum + '</span><span class="sched-runway-info">' + scheduleRunwayChip(f) + '</span></span>' +
          '<span class="sched-route">from ' + fromIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + boardRouteTag(f, dir) + '</span>' +
          '<span class="sched-landed">' + formatLandingSummaryStatus(f) + '</span>';
      } else {
        html += '<span class="sched-dot cyan live"></span>' +
          '<span class="sched-flight-group"><span class="sched-flight">' + flightNum + '</span><span class="sched-runway-info">' + scheduleRunwayChip(f) + '</span></span>' +
          '<span class="sched-route">from ' + fromIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + boardRouteTag(f, dir) + '</span>' +
          '<span class="sched-alt">' + (f.altFt != null ? f.altFt.toLocaleString() + 'ft' : '\u2014') + '</span>' +
          '<span class="sched-eta">' + scheduleArrivalTime(f) + '</span>';
      }
      html += '</div>';
    }
  } else {
    for (var i = 0; i < listRows.length; i++) {
      var f = listRows[i];
      var cs = f.callsign || "";
      var flightNum = escapeHtml(formatScheduleFlightNumber(cs));
      var destIata = f.destIata ? escapeHtml(f.destIata) : "\u2014";
      var spdStr = f.speedKts >= 5 ? formatSpeedMph(f.speedKts) + "mph" : "\u2014";
      var depSignal = describeAirportDepartureStatus(f, { activeRunways: !!liveData.activeDepartureRunways });
      var hintLabel = depSignal.label;
      var dotColor;
      if (f.status === "Departing" || f.status === "Climbing") dotColor = "cyan live";
      else if (f.status === "Holding" || depSignal.label === "Holding short") dotColor = "yellow";
      else if (f.status === "Taxiing") dotColor = "green";
      else dotColor = "gray";
      html += '<div class="sched-row" role="button" tabindex="0"' + scheduleRowAttrs(f) + '>' +
        '<span class="sched-dot ' + dotColor + '"></span>' +
        '<span class="sched-flight-group"><span class="sched-flight">' + flightNum + '</span><span class="sched-runway-info">' + scheduleRunwayChip(f) + '</span></span>' +
        '<span class="sched-route">to ' + destIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + boardRouteTag(f, dir) + '</span>' +
        '<span class="sched-speed">' + spdStr + '</span>' +
        '<span class="sched-hint">' + escapeHtml(hintLabel) + '</span>' +
        '</div>';
    }
  }
  html += '</div></div>' + (dir === 'arrivals' ? buildAirportEtaFooter(iata) : '') + '</div>';
  return html;
}

function buildAirportPopupPlaceholder(message, state) {
  return {
    arrivals: [],
    landed: [],
    departures: [],
    activeDepartureRunways: false,
    message: message,
    state: state || "empty"
  };
}

function getAirportPopupCacheEntry(iata) {
  if (!_airportPopupCache[iata]) {
    _airportPopupCache[iata] = {
      data: null,
      error: null,
      loading: false,
      pending: null,
      datisActiveRunways: null,
      datisTs: 0,
      snapshot: null,
      ts: 0
    };
  }
  return _airportPopupCache[iata];
}

function isAirportPopupCacheFresh(entry) {
  return !!(entry && entry.data && entry.ts && Date.now() - entry.ts < AIRPORT_POPUP_CACHE_TTL);
}

function getCachedDatisActiveRunways(entry) {
  if (!entry || !entry.datisTs) return null;
  return Date.now() - entry.datisTs < DATIS_CACHE_TTL ? entry.datisActiveRunways : null;
}

async function fetchAirportDatisActiveRunways(iata, entry) {
  if (entry && entry.datisTs && Date.now() - entry.datisTs < DATIS_CACHE_TTL) {
    return entry.datisActiveRunways || null;
  }
  try {
    var resp = await fetchWithTimeout(datisUrl(iata));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var payload = await resp.json();
    var datisText = payload && (payload.datis || payload.text || payload.raw);
    var parsed = parseDatisActiveRunways(datisText);
    if (parsed) {
      entry.datisActiveRunways = parsed;
      entry.datisTs = Date.now();
      return parsed;
    }
  } catch (err) {
    console.warn("Airport D-ATIS fetch failed:", err);
  }
  entry.datisActiveRunways = null;
  entry.datisTs = Date.now();
  return null;
}

function clearActiveAirportRefreshTimer() {
  if (_activeAirportRefreshTimer) {
    clearTimeout(_activeAirportRefreshTimer);
    _activeAirportRefreshTimer = null;
  }
}

function scheduleActiveAirportRefresh(delayMs) {
  clearActiveAirportRefreshTimer();
  if (!_activeAirportIata || !_activeAirportPopup) return;
  _activeAirportRefreshTimer = setTimeout(function() {
    if (document.hidden) return;
    refreshActiveAirportPopup({ reason: "timer" });
  }, Math.max(0, delayMs != null ? delayMs : AIRPORT_POPUP_REFRESH_MS));
}

function airportRouteCandidateComparator(airportLat, airportLng) {
  return function(a, b) {
    var aGroundFar = a.ground && haversineKm(a.lat, a.lng, airportLat, airportLng) > 5;
    var bGroundFar = b.ground && haversineKm(b.lat, b.lng, airportLat, airportLng) > 5;
    if (aGroundFar !== bGroundFar) return aGroundFar ? 1 : -1;
    var altA = a.altFt != null ? a.altFt : Infinity;
    var altB = b.altFt != null ? b.altFt : Infinity;
    if (altA !== altB) return altA - altB;
    var distA = haversineKm(a.lat, a.lng, airportLat, airportLng);
    var distB = haversineKm(b.lat, b.lng, airportLat, airportLng);
    if (distA !== distB) return distA - distB;
    return (a.callsign || "").localeCompare(b.callsign || "");
  };
}

async function refreshActiveAirportPopup(options) {
  options = options || {};
  if (!_activeAirportIata || _activeAirportLat == null || _activeAirportLng == null) return null;
  clearActiveAirportRefreshTimer();

  var iata = _activeAirportIata;
  var lat = _activeAirportLat;
  var lng = _activeAirportLng;
  var entry = getAirportPopupCacheEntry(iata);
  if (entry.pending) return entry.pending;

  entry.loading = true;
  if (_activeAirportPopup && !entry.data) {
    _lastScheduleHtml = "";
    renderSchedulePopup(_activeScheduleDir);
  }

  var promise = (async function() {
    try {
      var datisPromise = fetchAirportDatisActiveRunways(iata, entry);
      var schedulePromise = fetchScheduleData(iata);
      var resp = await fetchWithTimeout(trafficUrl(lat, lng, AIRPORT_POPUP_FETCH_KM));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var payload = await resp.json();
      var snapshot = buildAircraftSnapshot(payload.ac || [], {
        includeProximity: false,
        positionNow: boardPositionNow(payload.now)
      });
      entry.snapshot = snapshot.aircraft;

      // Traffic is shown as soon as it arrives, with the cached runway configuration if D-ATIS is still out.
      entry.data = buildLiveScheduleData(iata, lat, lng, snapshot.aircraft, getCachedDatisActiveRunways(entry));
      entry.ts = Date.now();
      entry.error = null;
      entry.stale = false;
      if (_activeAirportIata === iata && _activeAirportPopup) {
        _lastScheduleHtml = "";
        renderSchedulePopup(_activeScheduleDir);
      }

      var datisActiveRunways = await datisPromise;
      await fetchRoutesForPlanes(snapshot.aircraft, { sortFn: airportRouteCandidateComparator(lat, lng), waitTurn: true });
      applyAirportScheduleMatches(iata, await schedulePromise, snapshot.aircraft);
      entry.data = buildLiveScheduleData(iata, lat, lng, snapshot.aircraft, datisActiveRunways);
      if (_activeAirportIata === iata && _activeAirportPopup) {
        _lastScheduleHtml = "";
        renderSchedulePopup(_activeScheduleDir);
      }
    } catch (err) {
      console.warn("Airport popup traffic fetch failed:", err);
      if (!entry.data) entry.error = "Could not load airport traffic.";
      else entry.stale = true;
    } finally {
      entry.loading = false;
      if (entry.pending === promise) entry.pending = null;
      if (_activeAirportIata === iata && _activeAirportPopup) {
        _lastScheduleHtml = "";
        renderSchedulePopup(_activeScheduleDir);
        scheduleActiveAirportRefresh(AIRPORT_POPUP_REFRESH_MS);
      }
    }
    return entry.data;
  })();

  entry.pending = promise;
  return promise;
}

// The board lists planes from its own snapshot, which the map's schedule cascade never sees (and the cascade only
// runs at route-friendly zooms). Its own airport's schedule is the best evidence of where these planes are going,
// so apply it here: a stale ADSBDB route (11-18: UAL3911 recorded as SYD->LAX while flying HNL->SFO) must not
// decide which tab a plane lands in.
function applyAirportScheduleMatches(iata, scheduleData, planes) {
  return core.applyAirportScheduleIn(airportBoardEnvironment(), iata, scheduleData, planes);
}

// The board's positions stamped on the same clock as the main feed's (see feedPositionClock), so rows can be
// compared by reportTs. The offset is only read here, never updated.
function boardPositionNow(feedNow) {
  var receivedAt = Date.now();
  if (!Number.isFinite(feedNow) || feedClockOffsetMs == null) return receivedAt;
  return Math.min(receivedAt, feedNow + feedClockOffsetMs);
}

function patchAirportCacheFromViewport() {
  if (!_activeAirportPopup || !_activeAirportIata) return;
  var entry = _airportPopupCache[_activeAirportIata];
  if (!entry || !entry.snapshot || !entry.snapshot.length) return;
  if (entry.loading) return;

  var lookup = {};
  for (var i = 0; i < aircraft.length; i++) {
    lookup[aircraft[i].icao24] = aircraft[i];
  }

  var snap = entry.snapshot;
  for (var j = 0; j < snap.length; j++) {
    var fresh = lookup[snap[j].icao24];
    if (!fresh) continue;
    // Only a newer position report replaces the board's own.
    if (fresh.reportTs == null || (snap[j].reportTs != null && fresh.reportTs <= snap[j].reportTs)) continue;
    snap[j].lat = fresh.lat;
    snap[j].lng = fresh.lng;
    snap[j].altFt = fresh.altFt;
    snap[j].speedKts = fresh.speedKts;
    snap[j].vRate = fresh.vRate;
    snap[j].ground = fresh.ground;
    snap[j].track = fresh.track;
    snap[j].reportTs = fresh.reportTs;
  }

  entry.data = buildLiveScheduleData(_activeAirportIata, _activeAirportLat, _activeAirportLng, snap, getCachedDatisActiveRunways(entry));
  renderSchedulePopup(_activeScheduleDir);
}

// After a failed refresh the board keeps its last data; this says how old it is.
function airportBoardStaleNote(entry) {
  if (!entry || !entry.stale || !entry.data || !entry.ts) return "";
  var minutes = Math.floor((Date.now() - entry.ts) / 60000);
  return "stale \u00b7 updated " + (minutes < 1 ? "<1m" : minutes + "m") + " ago";
}

function syncAirportCountdowns(liveData) {
  var next = {}, now = Date.now();
  (liveData.arrivals || []).forEach(function(row) {
    var key = row.hex || row.callsign;
    if (!key || row.goAround || !Number.isFinite(row.etaMin)) return;
    next[key] = core.updateArrivalCountdown(_airportCountdowns[key], row.touchdownAtMs || now + row.etaMin * 60000, now);
  });
  _airportCountdowns = next;
  liveData.arrivals = core.sequenceAirportArrivals((liveData.arrivals || []).map(function(row) {
    var state = next[row.hex || row.callsign];
    return Object.assign({}, row, { displayEtaMin: state ? state.remainingSec / 60 : row.etaMin });
  }).sort(function(a, b) {
    var etaA = Number.isFinite(a.displayEtaMin) ? a.displayEtaMin : Infinity;
    var etaB = Number.isFinite(b.displayEtaMin) ? b.displayEtaMin : Infinity;
    var distance = Number.isFinite(a.pathKm) && Number.isFinite(b.pathKm) ? a.pathKm - b.pathKm : 0;
    return (etaA === etaB ? 0 : etaA - etaB) || distance || String(a.hex || a.callsign).localeCompare(String(b.hex || b.callsign));
  }));
}

function tickAirportCountdowns() {
  _airportCountdownTimer = null;
  if (!_activeAirportPopup) return;
  var now = Date.now();
  Object.keys(_airportCountdowns).forEach(function(key) {
    var state = _airportCountdowns[key];
    _airportCountdowns[key] = core.updateArrivalCountdown(state, state.targetMs, now);
  });
  var el = _activeAirportPopup.getElement && _activeAirportPopup.getElement();
  if (el) el.querySelectorAll('[data-countdown]').forEach(function(node) {
    var state = _airportCountdowns[node.getAttribute('data-countdown')];
    if (state) node.textContent = state.remainingSec < 600 && !state.coarse ? core.formatArrivalCountdown(state.remainingSec) : (node.hasAttribute('data-countdown-summary') ? "ETA " : "") + formatLandingEta(state.remainingSec / 60);
  });
  _airportCountdownTimer = setTimeout(tickAirportCountdowns, 1000);
  // Small corrections can cross between feed polls. Reorder only when the displayed order changes.
  var entry = _airportPopupCache[_activeAirportIata], lastEta = -Infinity;
  if (entry && entry.data && (entry.data.arrivals || []).some(function(row) {
    var state = _airportCountdowns[row.hex || row.callsign];
    var eta = state ? state.remainingSec : Number.isFinite(row.etaMin) ? row.etaMin * 60 : Infinity;
    if (eta < lastEta) return true;
    lastEta = eta; return false;
  })) renderSchedulePopup(_activeScheduleDir);
}

function setAirportScheduleHtml(html) {
  var oldRoot = _activeAirportPopup.getElement && _activeAirportPopup.getElement();
  var oldLadder = oldRoot && oldRoot.querySelector('.sched-ladder');
  var oldRows = oldRoot && oldRoot.querySelector('.sched-rows');
  var oldCard = oldRoot && oldRoot.querySelector('.sched-card');
  if (oldRows && oldCard) _airportTabScroll[oldCard.getAttribute('data-sched-dir')] = oldRows.scrollTop;
  var focused = oldRoot && oldRoot.contains(document.activeElement) ? document.activeElement : null;
  var focusAttrs = ['data-board-view', 'data-eta-action', 'data-dir', 'data-hex'];
  var focusKey = null, focusValue = null;
  if (focused) focusAttrs.some(function(attr) {
    if (!focused.hasAttribute(attr)) return false;
    focusKey = attr; focusValue = focused.getAttribute(attr); return true;
  });
  _activeAirportPopup.setHTML(html);
  var root = _activeAirportPopup.getElement && _activeAirportPopup.getElement();
  if (!root) return;
  var fresh = root.querySelector('.sched-ladder');
  if (oldLadder && fresh && oldLadder.getAttribute('data-ladder-runways') === fresh.getAttribute('data-ladder-runways')) {
    // Keep existing bead DOM nodes: CSS transitions can then ease positions between traffic polls.
    var oldNodes = {}, newKeys = {};
    oldLadder.querySelectorAll('[data-ladder-key]').forEach(function(node) { oldNodes[node.getAttribute('data-ladder-key')] = node; });
    fresh.querySelectorAll('[data-ladder-key]').forEach(function(node) {
      var key = node.getAttribute('data-ladder-key'), old = oldNodes[key];
      newKeys[key] = true;
      if (!old) oldLadder.querySelector('.sched-ladder-plot').appendChild(node);
      else {
        Array.from(node.attributes).forEach(function(attr) { old.setAttribute(attr.name, attr.value); });
        if (old.innerHTML !== node.innerHTML) old.innerHTML = node.innerHTML;
      }
    });
    Object.keys(oldNodes).forEach(function(key) { if (!newKeys[key]) oldNodes[key].parentNode.removeChild(oldNodes[key]); });
    var note = oldLadder.querySelector('.sched-ladder-note'), newNote = fresh.querySelector('.sched-ladder-note');
    if (note && newNote) note.textContent = newNote.textContent;
    var holding = oldLadder.querySelector('.sched-ladder-holding'), freshHolding = fresh.querySelector('.sched-ladder-holding');
    if (holding && freshHolding) holding.innerHTML = freshHolding.innerHTML;
    fresh.parentNode.replaceChild(oldLadder, fresh);
  }
  var rows = root.querySelector('.sched-rows');
  if (rows) rows.scrollTop = _airportTabScroll[_activeScheduleDir] || 0;
  if (focusKey) root.querySelectorAll('[' + focusKey + ']').forEach(function(node) {
    if (node.getAttribute(focusKey) === focusValue) focusWithoutScroll(node);
  });
}

function renderSchedulePopup(dir) {
  if (!_activeAirportPopup || _activeAirportLat == null) return;
  _activeScheduleDir = dir;
  var entry = _activeAirportIata ? getAirportPopupCacheEntry(_activeAirportIata) : null;
  var liveData = entry && entry.data
    ? entry.data
    : buildAirportPopupPlaceholder(
      entry && entry.error ? entry.error : "Loading airport traffic…",
      entry && entry.error ? "error" : "loading"
    );
  syncAirportCountdowns(liveData);
  if (!entry || !entry.stale) observeAirportEta(_activeAirportIata, liveData, entry && entry.snapshot ? entry.snapshot : aircraft);
  var html = buildScheduleCardContent(_activeAirportIata, _activeAirportName, liveData, dir, _activeAirportScopeId,
    airportBoardStaleNote(entry));
  if (html === _lastScheduleHtml) return;
  _lastScheduleHtml = html;
  setAirportScheduleHtml(html);
  if (!_airportCountdownTimer) tickAirportCountdowns();
  if (!_activeAirportPopup._isAirportSheet && _activeAirportScopeId && _activeAirportPopup.getElement) {
    var el = _activeAirportPopup.getElement();
    if (el) {
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "false");
      el.setAttribute("aria-labelledby", _activeAirportScopeId + "-title");
    }
    updateAirportPopupCloseName(_activeAirportPopup, _activeAirportIata);
  }
  scheduleAirportPanelReposition();
}

function openAirportSchedulePopup(iata, name, lat, lng) {
  var existingAirportEl = _activeAirportPopup && _activeAirportPopup.getElement
    ? _activeAirportPopup.getElement()
    : null;
  var airportOpener = captureOverlayOpener(existingAirportEl);
  closeActiveAirportPanel({ restoreFocus: false });
  clearActiveAirportRefreshTimer();

  _airportFocusOpener = airportOpener;
  _airportRestoreFocusOnClose = true;
  _activeAirportIata = iata;
  _activeAirportName = name;
  _activeAirportLat = lat;
  _activeAirportLng = lng;
  _activeAirportScopeId = "airport-sched-" + (++_airportScopeSeq);
  _activeScheduleDir = "arrivals";
  _airportTabScroll = {};
  _airportCountdowns = {};
  _airportEtaPanelOpen = false;
  _lastScheduleHtml = "";
  var entry = getAirportPopupCacheEntry(iata);

  if (!entry.data) {
    var preview = buildLiveScheduleData(iata, lat, lng, aircraft);
    if (preview.arrivals.length || preview.landed.length || preview.departures.length) {
      entry.data = preview;
    }
  }

  var liveData = entry.data || buildAirportPopupPlaceholder("Loading airport traffic…", "loading");
  var dockedPanel = isAirportPanelDocked();
  if (dockedPanel && map) closeMapPopup();
  var panelHtml = buildScheduleCardContent(iata, name, liveData, "arrivals", _activeAirportScopeId);
  var popup = dockedPanel
    ? openAirportSheetPanel(panelHtml, iata)
    : showMapPopup(new maplibregl.Popup({
      maxWidth: "340px",
      closeButton: true,
      closeOnClick: false,
      className: "airport-schedule-popup",
      focusAfterOpen: false
    }).setLngLat([lng, lat]).setHTML(panelHtml), { padding: { top: 88, right: 16, bottom: 18, left: 16 } });
  if (!popup) {
    _airportFocusOpener = null;
    _airportRestoreFocusOnClose = true;
    return;
  }

  _activeAirportPopup = popup;
  renderSchedulePopup("arrivals");
  if (!popup._isAirportSheet && _activeAirportScopeId && popup.getElement) {
    var popupEl = popup.getElement();
    if (popupEl) {
      popupEl.setAttribute("role", "dialog");
      popupEl.setAttribute("aria-modal", "false");
      popupEl.setAttribute("aria-labelledby", _activeAirportScopeId + "-title");
    }
    updateAirportPopupCloseName(popup, iata);
  }
  focusAirportPopupClose(popup);
  scheduleAirportPanelReposition();

  popup.on("close", function() {
    if (_activeAirportIata === iata) {
      var restoreFocus = _airportRestoreFocusOnClose;
      var restoreTarget = _airportFocusOpener;
      clearActiveAirportRefreshTimer();
      if (_airportCountdownTimer) clearTimeout(_airportCountdownTimer);
      _airportCountdownTimer = null;
      _airportCountdowns = {};
      _activeAirportPopup = null;
      _activeAirportIata = null;
      _activeAirportName = null;
      _activeAirportLat = null;
      _activeAirportLng = null;
      _activeAirportScopeId = null;
      _airportFocusOpener = null;
      _airportRestoreFocusOnClose = true;
      _lastScheduleHtml = "";
      clearAirportPanelReposition();
      if (restoreFocus) restoreFocusIfConnected(restoreTarget);
    }
  });

  if (!isAirportPopupCacheFresh(entry)) refreshActiveAirportPopup({ reason: entry.data ? "stale-open" : "open" });
  else scheduleActiveAirportRefresh(AIRPORT_POPUP_REFRESH_MS);
}

(function() {
  document.addEventListener("keydown", function(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.matches && e.target.matches('.sched-row, .sched-next-clickable')) {
      handleAirportSchedulePanelClick(e);
      return;
    }
    if (e.key !== "Escape") return;
    if (_activeAirportPopup) {
      closeActiveAirportPanel();
    } else if (activeMapPopup && activeMapPopup._isSheet) {
      closeMapPopup();
      setSelectedAircraft(null);
    }
  });
})();
