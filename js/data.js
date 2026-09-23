// Traffic, route, airport, and runway data fetching.

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
  if (fetchAbortController && activeFetchUrl === url) return;
  var requestSeq = ++fetchRequestSeq;
  if (fetchAbortController && !options.skipAbort) fetchAbortController.abort();
  var controller = new AbortController();
  fetchAbortController = controller;
  activeFetchUrl = url;

  try {
    var resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    var data = await resp.json();
    if (requestSeq !== fetchRequestSeq) return;
    var prevSource = trafficSource;
    trafficFetchOk = true;
    trafficFailStreak = 0;
    trafficSource = data.source || null;
    if (prevSource && trafficSource && prevSource !== trafficSource) {
      if (trafficSource === "backup") {
        setControlsFeedback("Using backup traffic feed.", "info", { timeoutMs: 6000 });
      } else if (prevSource === "backup") {
        setControlsFeedback("Primary traffic feed restored.", "success", { timeoutMs: 4000 });
      }
    }
    processAircraft(data.ac || []);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    trafficFailStreak++;
    trafficFetchOk = false;
    trafficSource = null;
    updateControlsCompactSummary(0);
    setControlsFeedback(
      trafficFailStreak <= 1
        ? "Could not reach the traffic feed \u2014 retrying\u2026"
        : "Still trying to reach the traffic feed\u2026",
      "warning", { timeoutMs: 8000 }
    );
    updateViewHint(0);
  } finally {
    if (fetchAbortController === controller) {
      fetchAbortController = null;
      activeFetchUrl = null;
    }
    if (map) scheduleRefreshTimer(adaptiveRefreshMs());
  }
}

function buildAircraftSnapshot(ac, options) {
  options = options || {};
  var now = options.now != null ? options.now : Date.now();
  var includeProximity = options.includeProximity !== false;
  var snapshot = [];
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
    if (activeIds[hex]) continue;

    var callsign = (s.flight || "").trim() || null;
    var priv = isPrivate(callsign, s.t || null, s.category || null);
    var squawk = s.squawk || null;
    var emerg = s.emergency && s.emergency !== "none" ? s.emergency : null;
    var baseBearing = s.dir != null ? s.dir : (heading != null ? heading : 0);
    var metrics = includeProximity ? proximityMetrics(s.lat, s.lon, baseBearing) : null;
    var viewDistKm = includeProximity ? viewportDistanceKm(s.lat, s.lon) : null;
    var altFt = isGround ? null : (typeof s.alt_baro === "number" ? Math.round(s.alt_baro) : null);
    var slantDistanceKm = includeProximity && metrics && metrics.distKm != null ? slantKm(metrics.distKm, altFt) : null;
    var reportTs = now - Math.max(0, (s.seen_pos || 0) * 1000);
    activeIds[hex] = true;

    snapshot.push({
      icao24: hex,
      callsign: callsign,
      aircraftType: s.t || null,
      category: s.category || null,
      registration: s.r || null,
      lat: s.lat, lng: s.lon,
      altFt: altFt,
      ground: isGround,
      speedKts: s.gs != null ? Math.round(s.gs) : null,
      track: heading,
      vRate: s.baro_rate != null ? s.baro_rate / 60 : null,
      distKm: metrics ? metrics.distKm : null,
      slantKm: slantDistanceKm != null ? roundTenths(slantDistanceKm) : null,
      viewDistKm: viewDistKm != null ? roundTenths(viewDistKm) : null,
      bearingDeg: metrics ? metrics.bearingDeg : baseBearing,
      cardinal: metrics ? metrics.cardinal : cardinalDir(baseBearing),
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
  return {
    aircraft: snapshot,
    activeIds: activeIds,
    now: now
  };
}

function processAircraft(ac) {
  var snapshot = buildAircraftSnapshot(ac);
  var now = snapshot.now;
  if (lastFetchTs) updatePlaybackDelay(now - lastFetchTs);
  else updatePlaybackDelay(null);
  lastFetchTs = now;
  aircraft = snapshot.aircraft;
  var activeIds = snapshot.activeIds;

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
  if (refreshSearchUi) refreshSearchUi();
  if (!tryResolvePendingPlaneFocus()) maybeLookupPendingPlaneFocus();
  updateStatus();
  updateAlerts();
  updateViewHint(visibleAircraftCount());
  fetchRoutes();
  clientConvergenceRefine();
  proactiveFetchTracks();
  proactiveScheduleSweep();
  proactiveFr24SearchSweep();
  if (_activeAirportPopup && _activeAirportIata) patchAirportCacheFromViewport();
}

function buildRouteFetchPayload(sourcePlanes, options) {
  options = options || {};
  var maxPlanes = options.maxPlanes != null ? options.maxPlanes : 20;
  var needed = [];
  var now = Date.now();
  for (var i = 0; i < sourcePlanes.length && needed.length < maxPlanes; i++) {
    var a = sourcePlanes[i];
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
  return needed;
}

function mergeRoutesetEntries(routes, sourcePlanes) {
  sourcePlanes = sourcePlanes || [];
  var fetchedAt = Date.now();
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
      fetchedAt: fetchedAt
    };
    if (r.destSource === "adsbdb" || r.originSource === "adsbdb") adsbdbCallsigns.push(r.callsign);
  }
  for (var ac = 0; ac < adsbdbCallsigns.length; ac++) {
    var cs = adsbdbCallsigns[ac];
    if (fr24SearchPending[cs] || isLikelyPrivateCallsign(cs)) continue;
    var plane = null;
    for (var p = 0; p < sourcePlanes.length; p++) {
      if (sourcePlanes[p].callsign === cs) {
        plane = sourcePlanes[p];
        break;
      }
    }
    if (!plane) plane = aircraft.find(function(candidate) { return candidate.callsign === cs; });
    if (plane) {
      fr24SearchPending[cs] = true;
      tryFr24Search(plane).then((function(callsign) {
        return function() { delete fr24SearchPending[callsign]; };
      })(cs));
    }
  }
}

async function fetchRoutesForPlanes(sourcePlanes, options) {
  if (!sourcePlanes || !sourcePlanes.length) return false;
  options = options || {};
  var candidates = options.sortFn ? sourcePlanes.slice().sort(options.sortFn) : sourcePlanes;
  var needed = buildRouteFetchPayload(candidates, options);
  if (!needed.length) return false;
  try {
    var resp = await fetch(routesetUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planes: needed })
    });
    if (!resp.ok) return false;
    var routes = await resp.json();
    mergeRoutesetEntries(routes, candidates);
    return true;
  } catch (e) {
    console.warn("Route fetch failed:", e);
    return false;
  }
}

async function fetchRoutes() {
  if (!aircraft.length) return;
  var visible = aircraft.filter(function(a) { return !isFiltered(a); });
  var policy = currentViewPolicy(visible.length);
  if (!policy.allowRoutes) return;
  await fetchRoutesForPlanes(visible);
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
  var oLabel = origin && origin.iata ? airportDisplayName(origin.iata) : null;
  var dLabel = null;
  if (destination && destination.region) {
    dLabel = destination.display || destination.region;
  } else if (destination && destination.iata) {
    dLabel = airportDisplayName(destination.iata);
  }
  if (oLabel && dLabel) return oLabel + " to " + dLabel;
  if (oLabel) return oLabel;
  if (dLabel) return dLabel;
  return "";
}

var lastProactiveFetch = 0;
var proactivePending = {};
function proactiveFetchTracks() {
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
      fetch(trackUrl(hex))
        .then(function(r) { return r.json(); })
        .then(function(data) {
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
    airportLatLngIndex = null;
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

function decodeUnicodeEscapes(text) {
  if (typeof text !== "string" || text.indexOf("\\u") === -1) return text;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, function(_, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

function airportCityName(iata) {
  var city = airportCityIndex[iata] || null;
  return city ? decodeUnicodeEscapes(city) : null;
}

function airportDisplayName(iata) {
  var city = airportCityName(iata);
  return city ? city + " (" + iata + ")" : iata;
}

function buildAirportLabelHtml(iata) {
  return escapeHtml(iata);
}

function renderAirports() {
  var bounds = currentViewBounds(AIRPORT_VIEW_PAD);
  if (!airportData || !bounds) {
    for (var k in airportMarkers) {
      airportLayer.removeLayer(airportMarkers[k].marker);
      delete airportMarkers[k];
    }
    return;
  }
  var inBounds = {};
  for (var i = 0; i < airportData.length; i++) {
    var ap = airportData[i];
    if (!bounds.contains([ap[1], ap[2]])) continue;
    inBounds[ap[0]] = ap;
  }
  for (var old in airportMarkers) {
    if (!inBounds[old]) {
      airportLayer.removeLayer(airportMarkers[old].marker);
      delete airportMarkers[old];
    }
  }
  for (var code in inBounds) {
    if (airportMarkers[code]) continue;
    var ap = inBounds[code];
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
  var bounds = currentViewBounds(AIRPORT_VIEW_PAD);
  if (!runwayData || !bounds) {
    for (var k in runwayLines) {
      runwayLayer.removeLayer(runwayLines[k]);
      delete runwayLines[k];
    }
    return;
  }
  var inBounds = {};
  for (var iata in runwayData) {
    var rwys = runwayData[iata];
    for (var j = 0; j < rwys.length; j++) {
      var r = rwys[j];
      if (!bounds.contains([(r[0] + r[3]) / 2, (r[1] + r[4]) / 2])) continue;
      inBounds[iata + "-" + j] = r;
    }
  }
  for (var old in runwayLines) {
    if (!inBounds[old]) {
      runwayLayer.removeLayer(runwayLines[old]);
      delete runwayLines[old];
    }
  }
  for (var key in inBounds) {
    if (runwayLines[key]) continue;
    var r = inBounds[key];
    runwayLines[key] = L.polyline([[r[0],r[1]], [r[3],r[4]]], {
      color: "#7a8a9f", weight: 2.5, opacity: 0.7, dashArray: "8,5"
    }).bindTooltip(r[6], {
      permanent: false, direction: "center", className: "runway-label"
    }).addTo(runwayLayer);
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
