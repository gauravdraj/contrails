// Airport schedule popup card (FIDS boards).

// --- Airport schedule popup card ---
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
  var schedRow = t.closest(".sched-row, .sched-next-clickable");
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

function buildArrivalEntry(a, routeEntry, airportIata, distKm, options) {
  options = options || {};
  var destinationMatch = !!(routeEntry && routeEntry.destination && routeEntry.destination.iata === airportIata);
  var originMatch = !!(routeEntry && routeEntry.origin && routeEntry.origin.iata === airportIata);
  var scored = scoreArrivalCandidate({
    altFt: a.altFt,
    vRate: a.vRate,
    distKm: distKm,
    spdKts: a.speedKts,
    private: a.private,
    confidence: routeEntry && routeEntry.confidence ? routeEntry.confidence : "",
    phase: routeEntry && routeEntry.phase ? routeEntry.phase : "",
    destinationMatch: destinationMatch,
    originMatch: originMatch
  });
  if (!scored.eligible) return null;
  return {
    hex: a.icao24,
    callsign: a.callsign,
    originIata: routeEntry && routeEntry.origin ? routeEntry.origin.iata : null,
    aircraftType: a.aircraftType,
    lat: a.lat,
    lng: a.lng,
    altFt: a.altFt,
    distKm: distKm,
    etaMin: scored.etaMin,
    arrivalScore: scored.score,
    proximity: !!options.proximity
  };
}

function formatLandingEta(etaMin) {
  if (etaMin == null || !isFinite(etaMin)) return "";
  if (etaMin < 1) return "<1m";
  if (etaMin < 3) {
    var roundedHalf = Math.round(etaMin * 2) / 2;
    return "~" + (roundedHalf % 1 ? roundedHalf.toFixed(1) : String(Math.round(roundedHalf))) + "min";
  }
  return "~" + Math.round(etaMin) + "min";
}

function formatScheduleFlightNumber(callsign) {
  return (callsign || "\u2014").replace(/^([A-Za-z]+)(\d+)$/, "$1 $2");
}

function formatLandingSummaryStatus(row) {
  if (!row) return "";
  if (row.landed) return "On runway";
  if (row.parked) return "At gate";
  if (row.taxiingIn) return "Taxiing in";
  var eta = formatLandingEta(row.etaMin);
  return eta ? "ETA " + eta : "Inbound";
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
      '<span class="sched-next-flight">' + flightNum + '</span>' +
      '<span class="sched-next-status">' + escapeHtml(statusText) + '</span>' +
    '</div>' +
    (routeText ? '<div class="sched-next-route">' + escapeHtml(routeText) + '</div>' : '') +
  '</div>';
}

function mergeActiveRunways(primary, fallback) {
  if (!primary) return fallback || null;
  fallback = fallback || {};
  var dep = primary.departing_runways && primary.departing_runways.length ? primary.departing_runways : (fallback.departing_runways || []);
  var arr = primary.arriving_runways && primary.arriving_runways.length ? primary.arriving_runways : (fallback.arriving_runways || []);
  if (!dep.length && !arr.length) return null;
  return { departing_runways: dep, arriving_runways: arr };
}

// Runways seen in use per airport, so a quiet few minutes with no plane on a runway don't drop the active
// runway and reshuffle the board between refreshes. A newly seen runway replaces the remembered one.
var ACTIVE_RUNWAY_MEMORY_MS = 15 * 60 * 1000;
var _activeRunwayMemory = {};

function rememberActiveRunways(iata, derived) {
  var now = Date.now();
  var mem = _activeRunwayMemory[iata] || (_activeRunwayMemory[iata] = {});
  var out = {};
  ["departing_runways", "arriving_runways"].forEach(function(key) {
    var seen = derived && derived[key];
    if (seen && seen.length) mem[key] = { list: seen, at: now };
    out[key] = mem[key] && now - mem[key].at <= ACTIVE_RUNWAY_MEMORY_MS ? mem[key].list : [];
  });
  return out.departing_runways.length || out.arriving_runways.length ? out : null;
}

// Feed speed change (kts) across the client's recent samples for this plane; negative when slowing.
function recentSpeedChangeKts(hex, spanMs) {
  var samples = extraState[hex] && extraState[hex].samples;
  if (!samples || samples.length < 2) return null;
  var last = samples[samples.length - 1];
  for (var i = 0; i < samples.length - 1; i++) {
    if (last.ts - samples[i].ts <= spanMs) return (last.spdMs - samples[i].spdMs) / 0.514444;
  }
  return null;
}

function buildLiveScheduleData(airportIata, airportLat, airportLng, sourceAircraft, activeRunwaysOverride) {
  var list = Array.isArray(sourceAircraft) ? sourceAircraft : aircraft;
  var arrivals = [];
  var departures = [];
  var justLanded = [];
  var nowMs = Date.now();
  var airportRwys = runwayData && runwayData[airportIata];
  var derivedRunways = rememberActiveRunways(airportIata, deriveActiveRunways(airportRwys, airportIata, list));
  var activeRunways = mergeActiveRunways(activeRunwaysOverride, derivedRunways);
  var activeDepThresholds = [];
  if (activeRunways && activeRunways.departing_runways) {
    var depDesigs = activeRunways.departing_runways;
    for (var d = 0; d < depDesigs.length; d++) {
      var matched = matchRunwayDesignator(airportRwys, airportIata, depDesigs[d]);
      if (matched) activeDepThresholds.push(matched);
    }
  }
  var activeArrThresholds = [];
  if (activeRunways && activeRunways.arriving_runways) {
    var arrDesigs = activeRunways.arriving_runways;
    for (var d = 0; d < arrDesigs.length; d++) {
      var matched = matchRunwayDesignator(airportRwys, airportIata, arrDesigs[d]);
      if (matched) activeArrThresholds.push(matched);
    }
  }
  function matchDepRunway(a) {
    if (activeDepThresholds.length > 0) {
      for (var t = 0; t < activeDepThresholds.length; t++) {
        var th = activeDepThresholds[t];
        var por = pointOnRunway(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon);
        if (por.onRunway) {
          return {
            on: true,
            distFromThresholdKm: por.distFromThresholdKm,
            // Bearing the aircraft would track during a takeoff roll on this end.
            bearing: bearingDegrees(th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon)
          };
        }
      }
    }
    return { on: false, distFromThresholdKm: null, bearing: null };
  }
  function matchArrRunway(a) {
    if (activeArrThresholds.length > 0) {
      for (var t = 0; t < activeArrThresholds.length; t++) {
        var th = activeArrThresholds[t];
        var por = pointOnRunway(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon);
        if (por.onRunway) return { on: true, distFromThresholdKm: por.distFromThresholdKm };
      }
    }
    return { on: false, distFromThresholdKm: null };
  }
  function matchAnyRunway(a) {
    if (activeDepThresholds.length > 0) {
      for (var t = 0; t < activeDepThresholds.length; t++) {
        var th = activeDepThresholds[t];
        var por = pointOnRunway(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon);
        if (por.onRunway) {
          return {
            on: true,
            distFromThresholdKm: por.distFromThresholdKm,
            bearing: bearingDegrees(th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon)
          };
        }
      }
    }
    var rwys = runwayData && runwayData[airportIata];
    if (rwys) {
      for (var r = 0; r < rwys.length; r++) {
        var rw = rwys[r];
        // Runway centerline axis; direction-agnostic, used to tell along-runway
        // motion (possible departure) from crossing it (taxiing).
        var axis = bearingDegrees(rw[0], rw[1], rw[3], rw[4]);
        var porA = pointOnRunway(a.lat, a.lng, rw[0], rw[1], rw[3], rw[4]);
        if (porA.onRunway) return { on: true, distFromThresholdKm: porA.distFromThresholdKm, bearing: axis };
        var porB = pointOnRunway(a.lat, a.lng, rw[3], rw[4], rw[0], rw[1]);
        if (porB.onRunway) return { on: true, distFromThresholdKm: porB.distFromThresholdKm, bearing: axis };
      }
    }
    return { on: false, distFromThresholdKm: null, bearing: null };
  }
  function nearestDepThreshold(a) {
    var best = null;
    function consider(lat, lng) {
      var d = haversineKm(a.lat, a.lng, lat, lng);
      if (!best || d < best.km) best = { lat: lat, lng: lng, km: d };
    }
    if (activeDepThresholds.length > 0) {
      for (var t = 0; t < activeDepThresholds.length; t++) {
        consider(activeDepThresholds[t].thresholdLat, activeDepThresholds[t].thresholdLon);
      }
      return best;
    }
    var rwys = runwayData && runwayData[airportIata];
    if (rwys) {
      for (var r = 0; r < rwys.length; r++) {
        consider(rwys[r][0], rwys[r][1]);
        consider(rwys[r][3], rwys[r][4]);
      }
    }
    return best;
  }
  function nearestDepThresholdKm(a) {
    var th = nearestDepThreshold(a);
    return th ? th.km : null;
  }
  // Is a ground plane heading for a departure threshold? With known active runways, any of their thresholds
  // counts (the nearest may not be the one it is going to); otherwise only the nearest runway end. Prefer the
  // track's actual change in distance over the last ~20 s, else its heading while moving. Returns { toward, km } with km to the
  // threshold it is heading for; toward is null when unknown.
  function headingForRunway(a, nearest) {
    var targets = activeDepThresholds.length
      ? activeDepThresholds.map(function(th) { return { lat: th.thresholdLat, lng: th.thresholdLon }; })
      : (nearest ? [nearest] : []);
    if (!targets.length) return null;
    var hist = posHistory[a.icao24];
    var moving = (a.speedKts || 0) >= 5 && a.track != null;
    var verdict = { toward: null, km: null };
    for (var i = 0; i < targets.length; i++) {
      var th = targets[i];
      var closing = closingKm(hist, th.lat, th.lng, 20000);
      var toward = closing != null && Math.abs(closing) >= 0.02
        ? closing > 0
        : (moving ? angleDiffDeg(a.track, bearingDegrees(a.lat, a.lng, th.lat, th.lng)) < 90 : null);
      if (toward) {
        var km = haversineKm(a.lat, a.lng, th.lat, th.lng);
        if (!verdict.toward || km < verdict.km) verdict = { toward: true, km: km };
      } else if (toward === false && verdict.toward == null) {
        verdict.toward = false;
      }
    }
    return verdict;
  }

  var departureHexes = {};
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a.callsign) continue;
    var rc = routeCache[a.callsign];
    var destinationHere = !!(rc && rc.destination && rc.destination.iata === airportIata);
    var originHere = !!(rc && rc.origin && rc.origin.iata === airportIata);
    var distKm = haversineKm(a.lat, a.lng, airportLat, airportLng);

    if (!a.ground) {
      if (destinationHere) {
        if (distKm > AIRPORT_POPUP_FETCH_KM) continue;
        var inboundEntry = buildArrivalEntry(a, rc, airportIata, distKm);
        if (inboundEntry) arrivals.push(inboundEntry);
        continue;
      }
      // Airborne-departure detection — not bound to RIU availability so non-US airports
      // and RIU-unavailable cases still show planes climbing out after liftoff.
      var vRateFpm = a.vRate != null ? a.vRate * 60 : 0;
      var climbing = vRateFpm > 100;
      var lowAlt = a.altFt != null && a.altFt < 6000;
      var depRwy = matchDepRunway(a);
      var bearingFromAirport = bearingDegrees(airportLat, airportLng, a.lat, a.lng);
      var outboundTrack = a.track != null && angleDiffDeg(a.track, bearingFromAirport) < 75;
      var shouldShow = false;
      var depRunwayKm = null;
      var depStatus = "Departing";
      if (depRwy.on && distKm <= 5 && (a.altFt == null || a.altFt < 2000)) {
        // Over the active departure runway at low altitude — takeoff roll / rotation.
        // Gate on climbing or very low altitude to filter out level transit overflights. A descending plane
        // under 500 ft is landing on a runway shared with departures, not taking off.
        if (climbing || (a.altFt != null && a.altFt < 500 && vRateFpm > -200)) {
          shouldShow = true;
          depRunwayKm = depRwy.distFromThresholdKm;
          depStatus = a.altFt != null && a.altFt > 500 ? "Climbing" : "Departing";
        }
      } else if (originHere && distKm <= DEPARTURE_PERIMETER_KM && lowAlt && climbing) {
        shouldShow = true;
        depRunwayKm = nearestDepThresholdKm(a);
        depStatus = "Climbing";
      } else if (distKm <= DEPARTURE_PERIMETER_KM && lowAlt && climbing && outboundTrack) {
        // No route info yet but geometry is strong: close, low, climbing, heading outbound.
        shouldShow = true;
        depRunwayKm = nearestDepThresholdKm(a);
        depStatus = a.altFt != null && a.altFt > 500 ? "Climbing" : "Departing";
      }
      if (shouldShow) {
        departures.push({
          hex: a.icao24,
          callsign: a.callsign,
          destIata: rc && rc.destination ? rc.destination.iata : null,
          aircraftType: a.aircraftType,
          lat: a.lat,
          lng: a.lng,
          speedKts: a.speedKts || 0,
          altFt: a.altFt,
          status: depStatus,
          distKm: distKm,
          runwayDistKm: depRunwayKm,
          hasDest: !!(rc && rc.destination),
          originMatch: originHere,
          routeConfidence: rc && rc.confidence ? rc.confidence : null,
          activeRunway: depRwy.on,
          onRunway: depRwy.on
        });
        departureHexes[a.icao24] = true;
      }
    } else {
      // Ground aircraft whose destination is this airport are handled by the
      // landed/taxi-in passes below so they show under arrivals, not departures.
      if (destinationHere) continue;
      if (distKm > (originHere ? 8 : 5)) continue;
      var spdKts = a.speedKts || 0;
      var depRwyGround = matchDepRunway(a);
      var anyRwy = matchAnyRunway(a);
      // Arrivals with no resolved route: seen descending in the last 15 min, or braking hard on a runway
      // (a takeoff roll only speeds up). They go to the Landed tab instead of the takeoff queue.
      var speedChange = anyRwy.on && spdKts >= 30 ? recentSpeedChangeKts(a.icao24, 30000) : null;
      if (landedRecently(posHistory[a.icao24], nowMs) || (speedChange != null && speedChange <= -10)) {
        justLanded.push({ a: a, rc: rc, distKm: distKm });
        continue;
      }
      var depThreshold = nearestDepThreshold(a);
      var groundRunwayKm = depRwyGround.on
        ? depRwyGround.distFromThresholdKm
        : (anyRwy.on ? anyRwy.distFromThresholdKm : (depThreshold ? depThreshold.km : null));
      // Direction- and runway-aware: a plane tracking opposite/across the active
      // departure runway, or sitting on a different (inactive/closed) runway or
      // crossing one, is taxiing — not beginning a takeoff roll.
      var groundStatus = classifyGroundDepartureStatus({
        speedKts: spdKts,
        track: a.track,
        onActiveDepRunway: depRwyGround.on,
        onAnyRunway: anyRwy.on,
        depRunwayBearing: depRwyGround.bearing,
        anyRunwayBearing: anyRwy.bearing,
        haveActiveDep: activeDepThresholds.length > 0
      });
      var heading = groundStatus === "Taxiing" ? headingForRunway(a, depThreshold) : { toward: null, km: null };
      if (heading.toward && !depRwyGround.on && !anyRwy.on) groundRunwayKm = heading.km;
      departures.push({
        hex: a.icao24,
        callsign: a.callsign,
        destIata: rc && rc.destination ? rc.destination.iata : null,
        aircraftType: a.aircraftType,
        lat: a.lat,
        lng: a.lng,
        speedKts: spdKts,
        status: groundStatus,
        distKm: distKm,
        runwayDistKm: groundRunwayKm,
        towardRunway: heading.toward,
        hasDest: !!(rc && rc.destination),
        originMatch: originHere,
        routeConfidence: rc && rc.confidence ? rc.confidence : null,
        activeRunway: depRwyGround.on,
        onRunway: anyRwy.on
      });
      departureHexes[a.icao24] = true;
    }
  }
  var seenCallsigns = {};
  for (var s = 0; s < arrivals.length; s++) seenCallsigns[arrivals[s].callsign] = true;
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a.callsign || a.ground || seenCallsigns[a.callsign]) continue;
    if (departureHexes[a.icao24]) continue;
    var rc = routeCache[a.callsign];
    if (rc && rc.origin && rc.origin.iata === airportIata) continue;
    if (rc && rc.destination && rc.destination.iata !== airportIata && rc.confidence === "high") continue;
    var vRateFpm = a.vRate != null ? a.vRate * 60 : 0;
    if (a.altFt == null || a.altFt > 10000 || vRateFpm > -200) continue;
    var toBearing = bearingDegrees(a.lat, a.lng, airportLat, airportLng);
    if (a.track != null && angleDiffDeg(a.track, toBearing) > 60) continue;
    var fbDistKm = haversineKm(a.lat, a.lng, airportLat, airportLng);
    if (fbDistKm > 40) continue;
    var fallbackEntry = buildArrivalEntry(a, rc, airportIata, fbDistKm, { proximity: true });
    if (fallbackEntry) arrivals.push(fallbackEntry);
  }
  var landed = [];
  var landedHexes = {};
  if (activeArrThresholds.length > 0) {
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.callsign) continue;
      var rc = routeCache[a.callsign];
      if (!rc || !rc.destination || rc.destination.iata !== airportIata) continue;
      var landedDist = haversineKm(a.lat, a.lng, airportLat, airportLng);
      if (!a.ground) {
        if (landedDist > 5 || a.altFt == null || a.altFt >= 500) continue;
      }
      var arrMatch = matchArrRunway(a);
      if (!arrMatch.on) continue;
      landed.push({
        hex: a.icao24,
        callsign: a.callsign,
        originIata: rc && rc.origin ? rc.origin.iata : null,
        aircraftType: a.aircraftType,
        lat: a.lat,
        lng: a.lng,
        altFt: a.ground ? 0 : (a.altFt || 0),
        distKm: landedDist,
        etaMin: 0,
        arrivalScore: 0,
        proximity: false,
        landed: true,
        _rolloutDist: arrMatch.distFromThresholdKm
      });
      landedHexes[a.icao24] = true;
    }
  } else {
    var rwys = runwayData && runwayData[airportIata];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.callsign || !a.ground) continue;
      var rc = routeCache[a.callsign];
      if (!rc || !rc.destination || rc.destination.iata !== airportIata) continue;
      var landedDist = haversineKm(a.lat, a.lng, airportLat, airportLng);
      if (landedDist > 5) continue;
      var onRwy = false;
      if (rwys) {
        for (var r3 = 0; r3 < rwys.length; r3++) {
          var rw3 = rwys[r3];
          var porA = pointOnRunway(a.lat, a.lng, rw3[0], rw3[1], rw3[3], rw3[4]);
          var porB = pointOnRunway(a.lat, a.lng, rw3[3], rw3[4], rw3[0], rw3[1]);
          if (porA.onRunway || porB.onRunway) { onRwy = true; break; }
        }
        if (!onRwy) continue;
      } else {
        if (landedDist > 0.5) continue;
      }
      landed.push({
        hex: a.icao24,
        callsign: a.callsign,
        originIata: rc && rc.origin ? rc.origin.iata : null,
        aircraftType: a.aircraftType,
        lat: a.lat,
        lng: a.lng,
        altFt: 0,
        distKm: landedDist,
        etaMin: 0,
        arrivalScore: 0,
        proximity: false,
        landed: true
      });
      landedHexes[a.icao24] = true;
    }
  }
  // Taxi-in pass: ground aircraft whose destination is this airport but that aren't on
  // the active arrival runway. Covers the runway-exit-to-gate gap where the aircraft would
  // otherwise vanish from the panel for 5-15 minutes.
  var taxiingIn = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a.callsign || !a.ground) continue;
    if (landedHexes[a.icao24]) continue;
    var rc = routeCache[a.callsign];
    if (!rc || !rc.destination || rc.destination.iata !== airportIata) continue;
    var taxDist = haversineKm(a.lat, a.lng, airportLat, airportLng);
    if (taxDist > 6) continue;
    var taxSpd = a.speedKts || 0;
    taxiingIn.push({
      hex: a.icao24,
      callsign: a.callsign,
      originIata: rc && rc.origin ? rc.origin.iata : null,
      aircraftType: a.aircraftType,
      lat: a.lat,
      lng: a.lng,
      altFt: 0,
      distKm: taxDist,
      etaMin: 0,
      arrivalScore: 0,
      proximity: false,
      taxiingIn: true,
      parked: taxSpd < 3,
      speedKts: taxSpd
    });
  }
  for (var jl = 0; jl < justLanded.length; jl++) {
    var la = justLanded[jl].a, lrc = justLanded[jl].rc;
    var lSpd = la.speedKts || 0;
    taxiingIn.push({
      hex: la.icao24,
      callsign: la.callsign,
      originIata: lrc && lrc.origin && lrc.origin.iata !== airportIata ? lrc.origin.iata : null,
      aircraftType: la.aircraftType,
      lat: la.lat,
      lng: la.lng,
      altFt: 0,
      distKm: justLanded[jl].distKm,
      etaMin: 0,
      arrivalScore: 0,
      proximity: false,
      taxiingIn: true,
      parked: lSpd < 3,
      speedKts: lSpd
    });
  }
  var landedRows = sortAirportLandedRows(landed, taxiingIn);
  arrivals = sortAirportInboundRows(arrivals, { exclude: landedRows });
  departures = sortAirportDepartureRows(departures, { activeRunways: activeDepThresholds.length > 0 });
  return {
    arrivals: arrivals,
    landed: landedRows,
    departures: departures,
    activeDepartureRunways: activeDepThresholds.length > 0
  };
}

function buildScheduleCardContent(iata, name, liveData, dir, scopeId) {
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
      html += '<div class="sched-row"' + scheduleRowAttrs(f) + '>';
      if (f.landed || f.taxiingIn) {
        var dot = f.landed ? "cyan" : (f.parked ? "gray" : "green");
        html += '<span class="sched-dot ' + dot + '"></span>' +
          '<span class="sched-flight">' + flightNum + '</span>' +
          '<span class="sched-route">from ' + fromIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + '</span>' +
          '<span class="sched-landed">' + formatLandingSummaryStatus(f) + '</span>';
      } else {
        var altStr = f.altFt != null ? f.altFt.toLocaleString() + "ft" : "\u2014";
        var etaStr = formatLandingEta(f.etaMin);
        html += '<span class="sched-dot cyan live"></span>' +
          '<span class="sched-flight">' + flightNum + '</span>' +
          '<span class="sched-route">from ' + fromIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + '</span>' +
          '<span class="sched-alt">' + altStr + '</span>' +
          (etaStr ? '<span class="sched-eta">' + etaStr + '</span>' : '');
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
      html += '<div class="sched-row"' + scheduleRowAttrs(f) + '>' +
        '<span class="sched-dot ' + dotColor + '"></span>' +
        '<span class="sched-flight">' + flightNum + '</span>' +
        '<span class="sched-route">to ' + destIata + (f.aircraftType ? ' \u00b7 ' + escapeHtml(f.aircraftType) : '') + '</span>' +
        '<span class="sched-speed">' + spdStr + '</span>' +
        '<span class="sched-hint">' + escapeHtml(hintLabel) + '</span>' +
        '</div>';
    }
  }
  html += '</div></div>';
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
    var resp = await fetch(datisUrl(iata));
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
      var resp = await fetch(trafficUrl(lat, lng, AIRPORT_POPUP_FETCH_KM));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      var payload = await resp.json();
      var datisActiveRunways = await datisPromise;
      var snapshot = buildAircraftSnapshot(payload.ac || [], { includeProximity: false });
      entry.snapshot = snapshot.aircraft;

      entry.data = buildLiveScheduleData(iata, lat, lng, snapshot.aircraft, datisActiveRunways);
      entry.ts = Date.now();
      entry.error = null;
      if (_activeAirportIata === iata && _activeAirportPopup) {
        _lastScheduleHtml = "";
        renderSchedulePopup(_activeScheduleDir);
      }

      await fetchRoutesForPlanes(snapshot.aircraft, { sortFn: airportRouteCandidateComparator(lat, lng) });
      entry.data = buildLiveScheduleData(iata, lat, lng, snapshot.aircraft, datisActiveRunways);
      if (_activeAirportIata === iata && _activeAirportPopup) {
        _lastScheduleHtml = "";
        renderSchedulePopup(_activeScheduleDir);
      }
    } catch (err) {
      console.warn("Airport popup traffic fetch failed:", err);
      if (!entry.data) entry.error = "Could not load airport traffic.";
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
  var html = buildScheduleCardContent(_activeAirportIata, _activeAirportName, liveData, dir, _activeAirportScopeId);
  if (html === _lastScheduleHtml) return;
  _lastScheduleHtml = html;
  _activeAirportPopup.setHTML(html);
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
    if (e.key !== "Escape") return;
    if (_activeAirportPopup) {
      closeActiveAirportPanel();
    } else if (activeMapPopup && activeMapPopup._isSheet) {
      closeMapPopup();
      setSelectedAircraft(null);
    }
  });
})();
