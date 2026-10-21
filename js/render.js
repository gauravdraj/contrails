// Aircraft rendering, trails, and marker animation.

// --- Rendering ---
const GROUND_TRAIL_MS = 15000;

function trailWindowMs(a) {
  if (a.ground) return GROUND_TRAIL_MS;
  var zoom = map ? viewZoom() : 11;
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

var _trailsShown = false;
function renderTrails(now, displayPoses) {
  if (!mapReady) return;
  now = now || Date.now();
  var markerCount = Object.keys(markerMap).length;
  var trailsOff = !filters.trails || (viewZoom() < 7 && markerCount > 120);
  if (trailsOff) {
    if (_trailsShown) map.getSource("trails").setData(EMPTY_COLLECTION);
    _trailsShown = false;
    return;
  }

  var displayTime = currentDisplayTime(now);
  var features = [];
  for (var i = 0; i < aircraft.length; i++) {
    var a = aircraft[i];
    if (isFiltered(a)) continue;
    var pose = displayPoses && displayPoses[a.icao24] ? displayPoses[a.icao24] : getDisplayPoseForAircraft(a.icao24, displayTime);
    var segments = buildDisplayTrailSegments(posHistory[a.icao24], a, pose, displayTime);
    for (var si = 0; si < segments.length; si++) {
      var seg = segments[si];
      features.push({
        type: "Feature",
        properties: { color: seg.color, opacity: seg.opacity, width: seg.weight },
        geometry: { type: "LineString", coordinates: [[seg.latlngs[0][1], seg.latlngs[0][0]], [seg.latlngs[1][1], seg.latlngs[1][0]]] }
      });
    }
  }
  map.getSource("trails").setData({ type: "FeatureCollection", features: features });
  _trailsShown = true;
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
  var aircraftInfoHtml = '<div class="popup-aircraft" data-hex="' + escapeHtml(a.icao24) + '">' +
    buildAircraftInfoHtml(aircraftInfoCache[a.icao24]) + "</div>";

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
  if (shouldShowReferenceDistances() && a.slantKm != null) {
    distanceLine = formatDistanceMiles(a.slantKm) + " mi " + escapeHtml(a.cardinal);
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
    emergLine + typeLine + aircraftInfoHtml + alt + " &middot; " + spd + " &middot; " + vert + "<br>" +
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
  if (airline) {
    html += '<span class="popup-airline" style="display:inline;margin-top:0;white-space:nowrap">&nbsp;&middot;&nbsp;' + escapeHtml(airline) + "</span>";
  }
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

function flagEmoji(iso) {
  if (!iso || !/^[A-Za-z]{2}$/.test(iso)) return "";
  var base = 0x1F1E6;
  var up = iso.toUpperCase();
  return String.fromCodePoint(base + up.charCodeAt(0) - 65) +
    String.fromCodePoint(base + up.charCodeAt(1) - 65);
}

function buildAircraftInfoHtml(info) {
  if (!info) return "";
  var typeName = info.manufacturer && info.type
    ? info.manufacturer + " " + info.type
    : (info.type || info.manufacturer || "");
  var bits = [];
  if (typeName) bits.push(escapeHtml(typeName));
  if (info.operator) bits.push(escapeHtml(info.operator));
  if (!bits.length) return "";
  var flag = flagEmoji(info.countryIso);
  var prefix = flag ? flag + " " : "";
  return '<span style="color:#8fa6bd">' + prefix + bits.join(" &middot; ") + "</span><br>";
}

function renderAircraftInfo(container, info) {
  container.innerHTML = buildAircraftInfoHtml(info);
}

function loadPopupAircraftInfo(container) {
  var hex = container.getAttribute("data-hex");
  if (!hex) return;
  if (aircraftInfoCache[hex] !== undefined) {
    renderAircraftInfo(container, aircraftInfoCache[hex]);
    return;
  }
  if (aircraftInfoPending[hex]) return;
  aircraftInfoPending[hex] = true;
  fetch(aircraftUrl(hex))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      aircraftInfoCache[hex] = data || null;
      renderAircraftInfo(container, aircraftInfoCache[hex]);
    })
    .catch(function() { aircraftInfoCache[hex] = null; })
    .finally(function() { delete aircraftInfoPending[hex]; });
}

function ingestTrackPath(hex, data) {
  var path = data.path || data;
  if (!path || !path.length) return;
  var flightStart = findFlightStartIndex(path);
  path = path.slice(flightStart);
  if (!path.length) return;
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
    runOriginDetection(hex, { path: path });
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

function loadPopupTrack(hex) {
  if (!hex || trackExtended[hex]) return;
  trackExtended[hex] = true;
  fetch(trackUrl(hex))
    .then(function(r) { return r.json(); })
    .then(function(data) { ingestTrackPath(hex, data); })
    .catch(function() {});
}

function fetchScheduleData(iata) {
  var cached = scheduleDataCache[iata];
  if (cached && Date.now() - cached.ts < SCHEDULE_CACHE_TTL) return Promise.resolve(cached.data);
  var url = WORKER_URL + "/schedule/" + encodeURIComponent(iata);
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
    airline_iata: match.row.airline_iata || "",
    airline_icao: match.row.airline_icao || "",
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
    if (bounds.contains(ap[1], ap[2])) visible.push(ap[0]);
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

async function tryFr24Search(a, options) {
  if (!a || a.private || !a.callsign) return;
  var variants = callsignVariants(a.callsign);
  if (!variants.length) return;
  var force = options && options.force;
  var rc = routeCache[a.callsign];
  if (!force && rc && (rc.destSource === "schedule" || rc.destSource === "fr24-search" || rc.destSource === "cross-validated")) return;

  var iataCs = variants.length > 1 ? variants[1] : variants[0];
  var url = WORKER_URL + "/fr24search/" + encodeURIComponent(iataCs);

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

    var searchIcao = a.callsign.length >= 3 ? a.callsign.substring(0, 3).toUpperCase() : "";
    var searchIata = AIRLINE_ICAO_TO_IATA[searchIcao] || "";

    routeCache[a.callsign] = {
      display: formatClientRouteLabel(origin, destination, phase),
      iata: from + " to " + to,
      origin: origin,
      destination: destination,
      originSource: "fr24-search",
      destSource: "fr24-search",
      confidence: "high",
      phase: phase,
      airline_iata: searchIata,
      airline_icao: searchIcao,
      fetchedAt: Date.now()
    };

    refreshPlanePopup(a.icao24);
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

    cascadeScheduleMatches();

    refreshPlanePopup(hex);
  });
}

// --- Plane layer ---
// markerMap holds one record per drawn plane: its display position plus the feature properties the plane
// and label layers read. The map draws them; this side only pushes positions.
function planeRecordProps(a, isSelected) {
  var style = planeStyle(a);
  return {
    hex: a.icao24,
    icon: style.icon,
    size: style.size,
    color: style.color,
    radiusPx: style.radiusPx,
    track: a.track || 0,
    selected: isSelected,
    // Lower keys are placed first, so airborne labels win collisions with planes parked at the gate.
    labelRank: a.ground ? 1 : 0,
    label: a.callsign || a.icao24,
    // In ems of the 10px label text: clear of the silhouette, plus the chip's 2px padding.
    labelOffset: (style.radiusPx + 6) / 10
  };
}

function pushPlaneLayer() {
  if (!mapReady) return;
  var features = [];
  for (var hex in markerMap) {
    var rec = markerMap[hex];
    features.push({ type: "Feature", properties: rec.props, geometry: { type: "Point", coordinates: [rec.lng, rec.lat] } });
  }
  map.getSource("planes").setData({ type: "FeatureCollection", features: features });
  if (planePopupHex && markerMap[planePopupHex]) {
    activeMapPopup.setLngLat([markerMap[planePopupHex].lng, markerMap[planePopupHex].lat]);
  }
}

var _labelsShown = false;
function setPlaneLabelsShown(show) {
  if (!mapReady || show === _labelsShown) return;
  _labelsShown = show;
  map.setLayoutProperty("plane-labels", "visibility", show ? "visible" : "none");
}

function syncMarkerPose(rec, pose) {
  rec.lat = pose.lat;
  rec.lng = pose.lng;
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
  ignoreMapClickUntil = Date.now() + 250;
  if (selectedAircraftId === normalized) return;
  selectedAircraftId = normalized;
  if (pendingPlaneFocus) pendingPlaneFocus = null;
  if (!normalized) {
    if (followMode) setFollowMode(false);
    clearRouteLine();
  }
  syncUrlState();
  renderMap();
}

function groundPlanesShown() {
  return !!map && viewZoom() >= GROUND_PLANES_MIN_ZOOM;
}

function isFiltered(a) {
  if (!filters.ground && a.ground) return true;
  if (a.ground && a.icao24 !== selectedAircraftId && !groundPlanesShown()) return true;
  if (!filters.private && a.private) return true;
  if (!isLatLngInView(a.lat, a.lng, VIEW_FILTER_PAD)) return true;
  return false;
}

function markerAnimationIntervalMs(markerCount) {
  if (!markerCount) return 250;
  if (markerCount > 1500) return 100;
  if (markerCount > 320) return 50;
  if (markerCount > 200) return 33;
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
  for (var i = 0; i < aircraft.length; i++) {
    var a = aircraft[i];
    if (isFiltered(a)) continue;
    seen[a.icao24] = true;

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

    var rec = markerMap[a.icao24] || (markerMap[a.icao24] = { lat: displayPose.lat, lng: displayPose.lng });
    syncMarkerPose(rec, displayPose);
    rec.props = planeRecordProps(a, selectedAircraftId === a.icao24);

    if (planePopupHex === a.icao24) {
      var popupHtml = buildPopup(a, policy);
      if (state.popupHtml !== popupHtml) {
        setPlanePopupHtml(a.icao24, popupHtml);
        state.popupHtml = popupHtml;
      }
    }
  }
  for (var id in markerMap) {
    if (!seen[id]) {
      if (planePopupHex === id) closeMapPopup();
      delete markerMap[id];
      delete extraState[id];
    }
  }
  if (selectedAircraftId && !seen[selectedAircraftId]) {
    selectedAircraftId = null;
    syncUrlState();
  }
  setPlaneLabelsShown(!!policy.showLabels);
  pushPlaneLayer();
}

var _lastAnimateTs = 0;
var _lastTrailFrameTs = 0;
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
  for (var id in markerMap) {
    var st = extraState[id];
    if (!st || !st.samples || !st.samples.length) continue;
    var pose = getDisplayPoseForSamples(st.samples, displayTime);
    if (!pose) continue;
    st.displayPose = pose;
    displayPoses[id] = pose;
    syncMarkerPose(markerMap[id], pose);
  }
  if (markerCount) pushPlaneLayer();
  // Trail tips trail the plane by at most one trail frame, which isn't visible, and trails cost far more
  // to rebuild than plane positions.
  if (now - _lastTrailFrameTs >= TRAIL_FRAME_MS) {
    _lastTrailFrameTs = now;
    renderTrails(now, displayPoses);
  }
  scheduleMarkerAnimation(minInterval);
}

function renderMap(now, displayPoses) {
  renderMarkers(now, displayPoses);
  renderTrails(now, displayPoses);
  updateRouteLine();
  applyFollow(currentDisplayTime(now || Date.now()));
}

function vertLabel(rate) {
  if (rate == null || Math.abs(rate) < 0.5) return '<span class="vert-level">—</span>';
  if (rate > 0) return '<span class="vert-up">&uarr; climbing</span>';
  return '<span class="vert-down">&darr; descending</span>';
}
