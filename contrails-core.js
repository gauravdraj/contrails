(function(root, factory) {
  var data = typeof module !== "undefined" && module.exports ? require("./airlines.json") : root.AIRLINES_DATA;
  var api = factory(data);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ContrailsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function(airlinesData) {
  airlinesData = airlinesData || { airlines: {}, privateRegistrationPrefixes: [], fractionalCallsignPrefixes: [] };
  var CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function roundTenths(value) {
    return Math.round(value * 10) / 10;
  }

  function roundTo(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(value * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var radiusKm = 6371;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    var phi1 = lat1 * Math.PI / 180;
    var phi2 = lat2 * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var y = Math.sin(dLon) * Math.cos(phi2);
    var x = Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function cardinalDir(deg) {
    return CARDINALS[Math.round(deg / 45) % 8];
  }

  function angleDiffDeg(a, b) {
    var delta = ((b - a) % 360 + 360) % 360;
    return delta > 180 ? 360 - delta : delta;
  }

  function parseCoordinate(value, min, max) {
    var parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < min || parsed > max) return null;
    return Math.round(parsed * 10000) / 10000;
  }

  function projectLatLng(lat, lng, bearingDeg, distanceMeters) {
    if (!distanceMeters) return [lat, lng];
    var earthRadius = 6371000;
    var angular = distanceMeters / earthRadius;
    var bearing = bearingDeg * Math.PI / 180;
    var phi1 = lat * Math.PI / 180;
    var lambda1 = lng * Math.PI / 180;
    var sinPhi1 = Math.sin(phi1);
    var cosPhi1 = Math.cos(phi1);
    var sinAngular = Math.sin(angular);
    var cosAngular = Math.cos(angular);
    var sinPhi2 = sinPhi1 * cosAngular + cosPhi1 * sinAngular * Math.cos(bearing);
    var phi2 = Math.asin(sinPhi2);
    var lambda2 = lambda1 + Math.atan2(
      Math.sin(bearing) * sinAngular * cosPhi1,
      cosAngular - sinPhi1 * sinPhi2
    );
    return [
      phi2 * 180 / Math.PI,
      ((lambda2 * 180 / Math.PI + 540) % 360) - 180
    ];
  }

  function computePlaybackDelayMs(fetchIntervalMs, jitterMs, options) {
    options = options || {};
    var minMs = options.minMs == null ? 1500 : options.minMs;
    var maxMs = options.maxMs == null ? 5000 : options.maxMs;
    var safetyMs = options.safetyMs == null ? 250 : options.safetyMs;
    var jitterWeight = options.jitterWeight == null ? 1.25 : options.jitterWeight;
    var delay = (fetchIntervalMs || 0) + safetyMs + (jitterMs || 0) * jitterWeight;
    return clamp(Math.round(delay), minMs, maxMs);
  }

  // Longitude `lng` moved by whole turns to lie within 180 degrees of `refLng`, so a step across the
  // antimeridian (179.9 -> -179.9) is a short hop rather than a sweep back through 0.
  function unwrapLngNear(lng, refLng) {
    while (lng - refLng > 180) lng -= 360;
    while (lng - refLng < -180) lng += 360;
    return lng;
  }

  function wrapLng(lng) {
    if (lng > 180) return lng - 360;
    if (lng < -180) return lng + 360;
    return lng;
  }

  function interpolateTimedPose(prev, next, targetTime) {
    if (!prev && !next) return null;
    if (!prev) return { lat: next.lat, lng: next.lng, ts: next.ts, progress: 1 };
    if (!next) return { lat: prev.lat, lng: prev.lng, ts: prev.ts, progress: 0 };
    if (targetTime <= prev.ts) return { lat: prev.lat, lng: prev.lng, ts: prev.ts, progress: 0 };
    if (targetTime >= next.ts) return { lat: next.lat, lng: next.lng, ts: next.ts, progress: 1 };
    var span = Math.max(1, next.ts - prev.ts);
    var progress = clamp((targetTime - prev.ts) / span, 0, 1);
    return {
      lat: prev.lat + (next.lat - prev.lat) * progress,
      lng: wrapLng(prev.lng + (unwrapLngNear(next.lng, prev.lng) - prev.lng) * progress),
      ts: prev.ts + (next.ts - prev.ts) * progress,
      progress: progress
    };
  }

  function interpolatePlaybackPose(samples, displayTime, options) {
    options = options || {};
    if (!samples || !samples.length) return null;

    var maxExtrapolationMs = options.maxExtrapolationMs == null ? 0 : options.maxExtrapolationMs;
    var first = samples[0];
    if (displayTime <= first.ts) {
      return {
        lat: first.lat,
        lng: first.lng,
        ts: first.ts,
        mode: "hold",
        prev: first,
        next: first,
        progress: 0,
        usedExtrapolationMs: 0
      };
    }

    for (var i = 1; i < samples.length; i++) {
      var prev = samples[i - 1];
      var next = samples[i];
      if (displayTime <= next.ts) {
        var pose = interpolateTimedPose(prev, next, displayTime);
        return {
          lat: pose.lat,
          lng: pose.lng,
          ts: pose.ts,
          mode: "interpolate",
          prev: prev,
          next: next,
          progress: pose.progress,
          usedExtrapolationMs: 0
        };
      }
    }

    var last = samples[samples.length - 1];
    var extrapolationMs = Math.max(0, Math.min(maxExtrapolationMs, displayTime - last.ts));
    if (extrapolationMs > 0 && Number.isFinite(last.spdMs) && Number.isFinite(last.trackDeg)) {
      var projected = projectLatLng(last.lat, last.lng, last.trackDeg, last.spdMs * extrapolationMs / 1000);
      return {
        lat: projected[0],
        lng: projected[1],
        ts: last.ts + extrapolationMs,
        mode: "extrapolate",
        prev: samples.length > 1 ? samples[samples.length - 2] : last,
        next: last,
        progress: 1,
        usedExtrapolationMs: extrapolationMs
      };
    }

    if (extrapolationMs > 0 && samples.length > 1) {
      var observedPrev = samples[samples.length - 2];
      var observedSpan = Math.max(1, last.ts - observedPrev.ts);
      return {
        lat: last.lat + (last.lat - observedPrev.lat) * (extrapolationMs / observedSpan),
        lng: wrapLng(last.lng + (last.lng - unwrapLngNear(observedPrev.lng, last.lng)) * (extrapolationMs / observedSpan)),
        ts: last.ts + extrapolationMs,
        mode: "extrapolate",
        prev: observedPrev,
        next: last,
        progress: 1,
        usedExtrapolationMs: extrapolationMs
      };
    }

    return {
      lat: last.lat,
      lng: last.lng,
      ts: last.ts,
      mode: "hold",
      prev: last,
      next: last,
      progress: 1,
      usedExtrapolationMs: 0
    };
  }

  function buildViewportFetchSpec(center, bounds, options) {
    options = options || {};
    var corners = [
      bounds.northEast,
      bounds.northWest,
      bounds.southEast,
      bounds.southWest
    ];
    var farthestKm = 0;
    for (var i = 0; i < corners.length; i++) {
      var corner = corners[i];
      farthestKm = Math.max(farthestKm, haversineKm(center.lat, center.lng, corner.lat, corner.lng));
    }
    var fetchKm = clamp(Math.ceil(farthestKm * options.pad), options.minKm, options.maxKm);
    return {
      center: center,
      bounds: bounds,
      zoom: options.zoom,
      visibleKm: farthestKm,
      fetchKm: fetchKm,
      wideView: fetchKm >= options.wideViewKm
    };
  }

  // Circles that together cover a view too wide for one feed request (the feed caps the radius). Centers sit
  // on a fixed lattice, so panning reuses the same requests and edge-cache entries: rows `latStepDeg` tall,
  // columns as wide in km as the row's poleward edge, which keeps every cell corner within `radiusKm` of its
  // center up to ~70° latitude. Nearest-to-center cells win when more than `maxCircles` are needed.
  function buildCoverageCircles(center, bounds, options) {
    options = options || {};
    var radiusKm = options.radiusKm || 460;
    var latStep = options.latStepDeg || 5;
    var maxCircles = options.maxCircles || 7;
    var south = clamp(bounds.south, -85, 85);
    var north = clamp(bounds.north, -85, 85);
    var cells = [];
    for (var r = Math.floor(south / latStep); r * latStep < north; r++) {
      var poleEdge = Math.min(80, Math.max(Math.abs(r * latStep), Math.abs((r + 1) * latStep)));
      var lngStep = latStep / Math.cos(poleEdge * Math.PI / 180);
      var rowLat = (r + 0.5) * latStep;
      for (var c = Math.floor((bounds.west + 180) / lngStep); -180 + c * lngStep < bounds.east; c++) {
        var lng = -180 + (c + 0.5) * lngStep;
        var wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
        cells.push({
          lat: roundTo(rowLat, 4),
          lng: roundTo(wrapped, 4),
          km: radiusKm,
          dist: haversineKm(center.lat, center.lng, rowLat, lng)
        });
      }
    }
    cells.sort(function(a, b) { return a.dist - b.dist; });
    var circles = cells.slice(0, maxCircles).map(function(cell) {
      return { lat: cell.lat, lng: cell.lng, km: cell.km };
    });
    return { circles: circles, total: cells.length, complete: cells.length <= maxCircles };
  }

  // One-degree cells; store catalog positions so queries retain its order for equal-distance ties.
  function buildAirportGrid(airports) {
    var cells = {}, byIata = {};
    for (var i = 0; i < airports.length; i++) {
      var ap = airports[i];
      byIata[ap[0]] = ap;
      var row = Math.min(179, Math.floor(ap[1] + 90));
      var col = Math.floor(((ap[2] + 180) % 360 + 360) % 360);
      var key = row + ":" + col;
      (cells[key] || (cells[key] = [])).push(i);
    }
    return { airports: airports, cells: cells, byIata: byIata };
  }

  function airportGridCandidates(grid, lat, lng, km) {
    var angular = km / 6371;
    var latPad = angular * 180 / Math.PI + 1e-9;
    var lngPad = Math.abs(lat) + latPad >= 90 ? 180
      : Math.asin(Math.min(1, Math.sin(angular) / Math.cos(lat * Math.PI / 180))) * 180 / Math.PI + 1e-9;
    var south = Math.max(0, Math.floor(lat - latPad + 90));
    var north = Math.min(179, Math.floor(lat + latPad + 90));
    var west = Math.floor(lng - lngPad + 180);
    var east = Math.min(west + 359, Math.floor(lng + lngPad + 180));
    var indices = [];
    for (var row = south; row <= north; row++) {
      for (var col = west; col <= east; col++) {
        var cell = grid.cells[row + ":" + ((col % 360 + 360) % 360)];
        if (cell) for (var i = 0; i < cell.length; i++) indices.push(cell[i]);
      }
    }
    indices.sort(function(a, b) { return a - b; });
    return indices.map(function(i) { return grid.airports[i]; });
  }

  // Ground planes per airport: each plane counts toward the nearest airport within `maxKm`.
  function countGroundByAirport(planes, airports, maxKm) {
    var counts = {};
    var latPad = maxKm / 111;
    for (var i = 0; i < planes.length; i++) {
      var p = planes[i];
      var best = null, bestKm = maxKm;
      for (var j = 0; j < airports.length; j++) {
        var ap = airports[j];
        if (Math.abs(ap.lat - p.lat) > latPad) continue;
        var d = haversineKm(p.lat, p.lng, ap.lat, ap.lng);
        if (d <= bestKm) {
          bestKm = d;
          best = ap.code;
        }
      }
      if (best) counts[best] = (counts[best] || 0) + 1;
    }
    return counts;
  }

  function buildViewPolicy(input, options) {
    options = options || {};
    var zoom = input.zoom;
    var fetchKm = input.fetchKm;
    var visibleCount = input.visibleCount == null ? 0 : input.visibleCount;
    var showLabels = !!input.labelsEnabled &&
      zoom >= options.labelMinZoom &&
      visibleCount <= options.labelMaxVisiblePlanes;
    var allowRoutes = fetchKm <= options.routeFetchMaxKm &&
      zoom >= options.routeFetchMinZoom &&
      visibleCount <= options.labelMaxVisiblePlanes;
    return {
      zoom: zoom,
      fetchKm: fetchKm,
      wideView: fetchKm >= options.wideViewKm,
      allowRoutes: allowRoutes,
      showLabels: showLabels
    };
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var AIRLINES = {};
  var AIRLINE_IATA_ALIASES = {};
  for (var airlineIcao in airlinesData.airlines) {
    var airline = airlinesData.airlines[airlineIcao];
    AIRLINES[airlineIcao] = airline.name;
    if (airline.iata) AIRLINE_IATA_ALIASES[airline.iata] = airlineIcao;
  }
  var AIRLINE_ICAO_TO_IATA_ALIASES = {};
  for (var iataAlias in AIRLINE_IATA_ALIASES) {
    var icaoAlias = AIRLINE_IATA_ALIASES[iataAlias];
    if (icaoAlias && !AIRLINE_ICAO_TO_IATA_ALIASES[icaoAlias]) {
      AIRLINE_ICAO_TO_IATA_ALIASES[icaoAlias] = iataAlias;
    }
  }

  var SQUAWK_ALERTS = { "7700": "EMERGENCY", "7600": "RADIO FAILURE", "7500": "HIJACK" };

  function airlineName(callsign) {
    if (!callsign || callsign.length < 3) return null;
    return AIRLINES[callsign.substring(0, 3).toUpperCase()] || null;
  }

  // Feeds mark non-ICAO addresses (TIS-B, anonymised) with a leading "~". The "~" is kept so "~abcdef" never
  // collides with the real ICAO aircraft "abcdef"; ICAO-only services must check isIcaoHex first.
  function normalizeAircraftHex(value) {
    if (value == null) return null;
    var normalized = String(value).trim().toLowerCase();
    return /^~?[0-9a-f]{6}$/.test(normalized) ? normalized : null;
  }

  function isIcaoHex(id) {
    return typeof id === "string" && /^[0-9a-f]{6}$/.test(id);
  }

  function normalizeSearchText(value) {
    if (value == null) return "";
    return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function callsignVariants(callsign) {
    var normalized = normalizeSearchText(callsign);
    if (!normalized) return [];
    var variants = [normalized];
    if (normalized.length >= 3) {
      var aliasPrefix = AIRLINE_ICAO_TO_IATA_ALIASES[normalized.substring(0, 3)];
      if (aliasPrefix) variants.push(aliasPrefix + normalized.substring(3));
    }
    return variants;
  }

  // Schedule payloads are replaced on fetch. Weak keys let expired snapshots and their indexes be collected.
  var scheduleIndexes = new WeakMap();
  function scheduleFlightIndex(data) {
    var cached = scheduleIndexes.get(data);
    if (cached) return cached;
    cached = {};
    ["arrivals", "departures"].forEach(function(dir) {
      var index = Object.create(null);
      var rows = data[dir] || [];
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row) continue;
        var callsign = normalizeSearchText(row.callsign), flight = normalizeSearchText(row.flight);
        if (callsign) (index[callsign] || (index[callsign] = [])).push(i);
        if (flight && flight !== callsign) (index[flight] || (index[flight] = [])).push(i);
      }
      cached[dir] = index;
    });
    scheduleIndexes.set(data, cached);
    return cached;
  }

  // Sources are { iata, data, lat, lng }; schedule times are Unix seconds, aircraft vRate is ft/sec.
  // Compare every airport/alias together so neither feed row order nor cache insertion order chooses a leg.
  function selectScheduleMatch(variants, sources, aircraft, nowMs) {
    var wanted = variants.map(normalizeSearchText);
    var candidates = [];
    var nowSec = nowMs / 1000;
    aircraft = aircraft || {};
    for (var s = 0; s < sources.length; s++) {
      var source = sources[s], data = source.data;
      if (!data) continue;
      var near = Number.isFinite(aircraft.lat) && Number.isFinite(aircraft.lng) &&
        Number.isFinite(source.lat) && Number.isFinite(source.lng) &&
        haversineKm(aircraft.lat, aircraft.lng, source.lat, source.lng) < 80;
      var direction = null;
      if (near && !aircraft.ground && aircraft.altFt != null && aircraft.altFt < 18000 && aircraft.vRate != null) {
        if (aircraft.vRate * 60 > 200) direction = "departure";
        if (aircraft.vRate * 60 < -200) direction = "arrival";
      }
      ["arrival", "departure"].forEach(function(dir) {
        if (direction && dir !== direction) return;
        var directionKey = dir === "arrival" ? "arrivals" : "departures";
        var allRows = data[directionKey] || [];
        var index = scheduleFlightIndex(data)[directionKey];
        var positions = new Set();
        wanted.forEach(function(v) { (index[v] || []).forEach(function(i) { positions.add(i); }); });
        var rows = Array.from(positions).sort(function(a, b) { return a - b; }).map(function(i) { return allRows[i]; });
        var suffix = dir === "arrival" ? "arr" : "dep";
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var status = String(row.status || "").toLowerCase();
          var recentArrival = near && aircraft.ground && dir === "arrival" && Number.isFinite(row.actual_arr) &&
            row.actual_arr > 0 && row.actual_arr <= nowSec && nowSec - row.actual_arr <= 90 * 60;
          // A plane on the ground here is between its arrival and its next departure: rank both by how close
          // each event is (a departure counts as live), so taxi-in keeps the arrival and taxi-out gets the departure.
          var groundDeparture = near && aircraft.ground && dir === "departure";
          if (/cancel/.test(status) || (!recentArrival && (/landed|arrived/.test(status) || row.actual_arr > 0))) continue;
          var time = null;
          ["actual_", "est_", "sched_"].some(function(key) {
            var value = row[key + suffix];
            if (!Number.isFinite(value) || value <= 0) return false;
            time = value;
            return true;
          });
          var distance = time == null ? Infinity : Math.abs(time - nowSec);
          // A previous day's instance cannot describe this flight; allow long-haul departures up to 18h old.
          if (time != null && (nowSec - time > 18 * 3600 || time - nowSec > 6 * 3600)) continue;
          var live = row.live === true || /en.?route|airborne|departed|take.?off/.test(status);
          var match = { dir: dir, airport: source.iata, airportName: data.name || source.iata, row: row };
          if (dir === "arrival") match.from = row.from_iata || null;
          else match.to = row.to_iata || null;
          candidates.push({ match: match, directionRank: (recentArrival || groundDeparture) ? -1 : (direction ? 0 : 1),
            score: distance + (live || recentArrival || groundDeparture ? 0 : 3600),
            route: (dir === "arrival" ? [match.from || "", source.iata] : [source.iata, match.to || ""]).join(":") });
        }
      });
    }
    candidates.sort(function(a, b) { return a.directionRank - b.directionRank || a.score - b.score; });
    if (!candidates.length) return null;
    var best = candidates[0];
    for (var c = 1; c < candidates.length; c++) {
      var other = candidates[c];
      // Within a minute is ambiguous when it would produce a different route. Identical duplicates are OK.
      if (other.directionRank === best.directionRank &&
          (other.score === best.score || Math.abs(other.score - best.score) <= 60) && other.route !== best.route) return null;
    }
    return best.match;
  }

  function kmToMiles(km) {
    return km == null ? null : km * 0.621371;
  }

  function knotsToMph(knots) {
    return knots == null ? null : knots * 1.150779;
  }

  function formatDistanceMiles(km, options) {
    if (km == null) return options && options.fallback != null ? options.fallback : "";
    var miles = kmToMiles(km);
    var decimals = options && options.decimals != null ? options.decimals : (miles < 10 ? 1 : 0);
    var rounded = roundTo(miles, decimals);
    return rounded.toFixed(decimals).replace(/\.0+$/, "");
  }

  function formatSpeedMph(knots) {
    if (knots == null) return "";
    return String(Math.round(knotsToMph(knots)));
  }

  function normalizeFlightQuery(value) {
    var compact = normalizeSearchText(value);
    if (!compact) return null;

    var hex = normalizeAircraftHex(compact);
    if (hex) {
      return {
        type: "hex",
        display: compact,
        value: hex,
        variants: [hex]
      };
    }

    if (/^[A-Z]{3}[A-Z0-9]{1,6}$/.test(compact)) {
      return {
        type: "callsign",
        display: compact,
        value: compact,
        variants: [compact]
      };
    }

    if (/^[A-Z0-9]{2}[A-Z0-9]{1,6}$/.test(compact)) {
      var alias = AIRLINE_IATA_ALIASES[compact.substring(0, 2)];
      if (alias) {
        var canonical = alias + compact.substring(2);
        return {
          type: "callsign",
          display: compact,
          value: canonical,
          variants: canonical === compact ? [canonical] : [canonical, compact]
        };
      }
    }

    return null;
  }

  // Registration-shaped callsigns. Japan (JA) and Korea (HL) write registrations without a dash, so only
  // JA/HL followed by a digit count; JAL123 is an airline flight.
  var _PRIV_REG = new RegExp("^(?:" + (airlinesData.privateRegistrationPrefixes.join("|") || "(?!)") + ")", "i");
  var _PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
  var _PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

  function isAirlineCallsign(callsign) {
    if (!callsign || _PRIV_REG.test(callsign) || _PRIV_ANON_HEX.test(callsign)) return false;
    // Fractional operators retain the aircraft-size fallback (e.g. EJA on a business jet is private).
    if (airlinesData.fractionalCallsignPrefixes.indexOf(callsign.substring(0, 3).toUpperCase()) !== -1) return false;
    return !!airlineName(callsign);
  }

  function isLikelyPrivateCallsign(callsign) {
    if (!callsign) return false;
    if (_PRIV_REG.test(callsign) || _PRIV_ANON_HEX.test(callsign)) return true;
    return !isAirlineCallsign(callsign) && _PRIV_HEXLIKE.test(callsign);
  }

  function isPrivateAircraft(callsign, type, category) {
    if (isLikelyPrivateCallsign(callsign)) return true;
    return !isAirlineCallsign(callsign) && isLikelyPrivateClass(type, category);
  }

  function slantKm(groundKm, altFt) {
    if (groundKm == null) return null;
    var altKm = (altFt || 0) * 0.0003048;
    return Math.sqrt(groundKm * groundKm + altKm * altKm);
  }

  function elevationDeg(groundKm, altFt) {
    if (groundKm == null || altFt == null) return null;
    var altKm = altFt * 0.0003048;
    return Math.atan2(altKm, Math.max(groundKm, 0.001)) * 180 / Math.PI;
  }

  function tracePointOnGround(pt) {
    return pt[5] === true || pt[5] === 1 || pt[3] === "ground";
  }

  // Match the Worker's findLegStartIndex: gaps anywhere can start a new leg, including during a
  // turnaround. Only the ground->air search stops before trailing ground reports; keep the takeoff roll.
  function findFlightStartIndex(path) {
    if (!path || !path.length) return 0;
    var gapBound = 0;
    for (var j = path.length - 1; j >= 1; j--) {
      if (path[j][0] - path[j - 1][0] > 1800) { gapBound = j; break; }
    }

    var scanEnd = path.length - 1;
    while (scanEnd >= 0 && tracePointOnGround(path[scanEnd])) scanEnd--;

    var groundBound = 0;
    for (var i = scanEnd; i >= 0; i--) {
      if (tracePointOnGround(path[i])) { groundBound = i; break; }
    }

    return Math.max(groundBound, gapBound);
  }

  function normalizeRunwayDesignator(designator) {
    return String(designator).trim().toUpperCase().replace(/^0+/, "");
  }

  function reciprocalRunwayDesignator(designator) {
    var match = normalizeRunwayDesignator(designator).match(/^(\d{1,2})([LRC]?)$/);
    if (!match || +match[1] < 1 || +match[1] > 36) return null;
    return String((+match[1] + 17) % 36 + 1) + (match[2] === "L" ? "R" : match[2] === "R" ? "L" : match[2]);
  }

  function matchRunwayDesignator(runwayEntries, iata, designator) {
    if (!runwayEntries || !runwayEntries.length || !iata || !designator) return null;
    var desig = normalizeRunwayDesignator(designator);
    if (!desig) return null;
    var numMatch = desig.match(/^(\d{1,2})/);
    if (!numMatch) return null;
    var desigHeading = parseInt(numMatch[1], 10) * 10;
    var prefix = String(iata).toUpperCase() + " ";

    for (var i = 0; i < runwayEntries.length; i++) {
      var entry = runwayEntries[i];
      if (!entry || entry.length < 7) continue;
      var label = entry[6];
      if (!label || typeof label !== "string") continue;
      var upper = label.toUpperCase();
      if (upper.indexOf(prefix) !== 0) continue;
      var parts = upper.substring(prefix.length).split("/");
      if (parts.length !== 2) continue;
      var side1 = normalizeRunwayDesignator(parts[0]) || "0";
      var side2 = normalizeRunwayDesignator(parts[1]) || "0";
      if (side1 !== desig && side2 !== desig) continue;

      var lat1 = entry[0], lon1 = entry[1];
      var lat2 = entry[3], lon2 = entry[4];
      var bearing12 = bearingDegrees(lat1, lon1, lat2, lon2);
      var thresholdLat, thresholdLon, farEndLat, farEndLon;
      if (angleDiffDeg(bearing12, desigHeading) <= 30) {
        thresholdLat = lat1; thresholdLon = lon1;
        farEndLat = lat2; farEndLon = lon2;
      } else {
        thresholdLat = lat2; thresholdLon = lon2;
        farEndLat = lat1; farEndLon = lon1;
      }
      return {
        entry: entry,
        thresholdLat: thresholdLat,
        thresholdLon: thresholdLon,
        farEndLat: farEndLat,
        farEndLon: farEndLon,
        designator: desig
      };
    }
    return null;
  }

  function deriveActiveRunways(runwayEntries, iata, aircraft, options) {
    // Departures need a climb on the runway; arrivals can be observed along final, before touchdown.
    // High overflights, go-arounds and ambiguous ground rollouts do not establish an arrival runway.
    // Returns { departing_runways, arriving_runways } (designator strings) or
    // null when there is no confident signal, in which case callers fall back to
    // pure-geometry classification exactly as before.
    if (!runwayEntries || !runwayEntries.length || !aircraft || !aircraft.length) return null;
    options = options || {};
    var maxAltFt = options.maxAltFt != null ? options.maxAltFt : 1500;
    var climbFpm = options.climbFpm != null ? options.climbFpm : 200;
    var prefix = String(iata || "").toUpperCase() + " ";
    var departing = {};
    var arriving = {};
    var arrivalEnds = [];
    for (var e = 0; e < runwayEntries.length; e++) {
      var label = runwayEntries[e] && runwayEntries[e][6];
      if (typeof label !== "string" || label.toUpperCase().indexOf(prefix) !== 0) continue;
      label.toUpperCase().substring(prefix.length).split("/").forEach(function(designator) {
        var end = matchRunwayDesignator(runwayEntries, iata, designator.trim());
        if (end) arrivalEnds.push(end);
      });
    }

    for (var i = 0; i < aircraft.length; i++) {
      var a = aircraft[i];
      if (!a || a.lat == null || a.lng == null || a.track == null) continue;
      if (a.goAround) continue;
      if (a.altFt != null && a.altFt > maxAltFt) continue;
      var vRateFpm = a.vRate != null ? a.vRate * 60 : null;
      if (!a.ground && Number.isFinite(a.altFt) && vRateFpm != null && vRateFpm <= 0) {
        // Staggered parallels share the final corridor; the closest centerline identifies the runway.
        // Keep approachPathKm's shortest-path choice for ETA callers.
        var bestEnd = null, bestCrossTrack = Infinity;
        for (var e = 0; e < arrivalEnds.length; e++) {
          var end = arrivalEnds[e];
          var approach = approachPathKm(a.lat, a.lng, a.track, [end]);
          if (!approach || !approach.onFinal) continue;
          var xt = Math.abs(crossTrackKm(a.lat, a.lng, end.thresholdLat, end.thresholdLon, end.farEndLat, end.farEndLon));
          if (xt < bestCrossTrack) { bestEnd = end; bestCrossTrack = xt; }
        }
        if (bestEnd) arriving[bestEnd.designator] = true;
      }
      if (vRateFpm == null) continue;
      var isDep = vRateFpm >= climbFpm;
      var isArr = !a.ground && vRateFpm <= -climbFpm;
      if (!isDep && !isArr) continue; // level / ground rollout — too ambiguous

      for (var r = 0; r < runwayEntries.length; r++) {
        var entry = runwayEntries[r];
        if (!entry || entry.length < 7) continue;
        var por = pointOnRunway(a.lat, a.lng, entry[0], entry[1], entry[3], entry[4]);
        if (!por.onRunway) continue;
        var label = entry[6];
        if (typeof label !== "string" || label.toUpperCase().indexOf(prefix) !== 0) continue;
        var parts = label.toUpperCase().substring(prefix.length).split("/");
        if (parts.length !== 2) continue;
        var d0 = normalizeRunwayDesignator(parts[0]);
        var d1 = normalizeRunwayDesignator(parts[1]);
        // Pick the designator matching the aircraft's direction of travel.
        var h0 = parseInt(d0, 10) * 10;
        var h1 = parseInt(d1, 10) * 10;
        var inUse = angleDiffDeg(a.track, h0) <= angleDiffDeg(a.track, h1) ? d0 : d1;
        if (isDep) departing[inUse] = true;
        if (isArr) arriving[inUse] = true;
        break;
      }
    }

    var depList = Object.keys(departing);
    var arrList = Object.keys(arriving);
    if (!depList.length && !arrList.length) return null;
    return { departing_runways: depList, arriving_runways: arrList };
  }

  function updateActiveRunwayMemory(memory, derived, nowMs, windowMs) {
    windowMs = windowMs == null ? 15 * 60 * 1000 : windowMs;
    var seen = {}, active = {};
    var reciprocals = {};
    ["departing_runways", "arriving_runways"].forEach(function(key) {
      (derived && derived[key] || []).forEach(function(runway) {
        var reciprocal = reciprocalRunwayDesignator(runway);
        if (reciprocal) reciprocals[reciprocal] = true;
      });
    });
    ["departing_runways", "arriving_runways"].forEach(function(key) {
      var previous = memory && memory[key] || {};
      var current = seen[key] = {};
      Object.keys(previous).forEach(function(runway) {
        var normalized = normalizeRunwayDesignator(runway);
        if (!reciprocals[normalized] && nowMs - previous[runway] <= windowMs) {
          current[normalized] = Math.max(current[normalized] == null ? -Infinity : current[normalized], previous[runway]);
        }
      });
      var observed = derived && derived[key] || [];
      observed.forEach(function(runway) {
        delete current[reciprocalRunwayDesignator(runway)];
        current[normalizeRunwayDesignator(runway)] = nowMs;
      });
      active[key] = Object.keys(current);
    });
    return { seen: seen, active: active.departing_runways.length || active.arriving_runways.length ? active : null };
  }

  function parseDatisActiveRunways(datisText) {
    if (!datisText) return null;
    var text = String(datisText).toUpperCase()
      .replace(/\s+/g, " ")
      .replace(/\bRUNWAYS?\b/g, "RWYS")
      .replace(/\bRWY\b/g, "RY")
      .trim();
    if (!text) return null;

    var departing = {};
    var arriving = {};

    function addRunwayTokens(target, segment) {
      segment = String(segment || "").split(/\b(?:CLSD|CLOSED|OTS|OUT OF SERVICE|NOTAMS?|BIRD|TAXIWAY|TWY|DEPG ACFT|ARRIVALS?|DEPARTURES?|APP|APCH|APPROACH)\b/)[0];
      var tokenRe = /\b([0-3]?\d[CLR]?)\b/g;
      var t;
      while ((t = tokenRe.exec(segment))) {
        target[normalizeRunwayDesignator(t[1])] = true;
      }
    }

    function addRunwaysAfter(target, clause, re) {
      var m;
      while ((m = re.exec(clause))) {
        addRunwayTokens(target, m[1]);
      }
    }

    function addAllRunwaysInClause(target, clause) {
      var re = /\b(?:RY|RYS|RWYS)\s+([^.;]+)/g;
      var m;
      while ((m = re.exec(clause))) {
        var segment = m[1];
        var tokenRe = /\b([0-3]?\d[CLR]?)\b/g;
        var t;
        while ((t = tokenRe.exec(segment))) {
          target[normalizeRunwayDesignator(t[1])] = true;
        }
      }
    }

    var clauses = text.split(/\s*\.\s*/);
    for (var i = 0; i < clauses.length; i++) {
      var clause = clauses[i];
      if (!clause) continue;

      addRunwaysAfter(departing, clause, /\bDEPG\s+(?:RY|RYS|RWYS)\s+([^.;]+)/g);
      addRunwaysAfter(departing, clause, /\bDEPARTURES?\s+TO\s+(?:RY|RYS|RWYS)\s+([^.;]+)/g);
      addRunwaysAfter(departing, clause, /\bDEPARTING\s+(?:RY|RYS|RWYS)\s+([^.;]+)/g);

      if (/\b(?:ILS|RNAV|GPS|VISUAL|LDA|LOC|VOR|RNP)[^.]*(?:APP|APCH|APPROACH)\s+IN\s+USE\b/.test(clause)) {
        addAllRunwaysInClause(arriving, clause.split(/\b(?:APP|APCH|APPROACH)\b/)[0]);
      }
      addRunwaysAfter(arriving, clause, /\bARRIVALS?\s+TO\s+(?:RY|RYS|RWYS)\s+([^.;]+)/g);
      addRunwaysAfter(arriving, clause, /\bLANDING\s+(?:RY|RYS|RWYS)\s+([^.;]+)/g);
    }

    var depList = Object.keys(departing);
    var arrList = Object.keys(arriving);
    if (!depList.length && !arrList.length) return null;
    return { departing_runways: depList, arriving_runways: arrList };
  }

  function crossTrackKm(pLat, pLon, aLat, aLon, bLat, bLon) {
    var R = 6371;
    var dAP = haversineKm(aLat, aLon, pLat, pLon);
    var bearingAP = bearingDegrees(aLat, aLon, pLat, pLon) * Math.PI / 180;
    var bearingAB = bearingDegrees(aLat, aLon, bLat, bLon) * Math.PI / 180;
    return Math.asin(Math.sin(dAP / R) * Math.sin(bearingAP - bearingAB)) * R;
  }

  function alongTrackKm(pLat, pLon, aLat, aLon, bLat, bLon, crossTrack) {
    var R = 6371;
    var dAP = haversineKm(aLat, aLon, pLat, pLon);
    var cosRatio = Math.cos(dAP / R) / Math.cos(crossTrack / R);
    cosRatio = Math.max(-1, Math.min(1, cosRatio));
    var along = Math.acos(cosRatio) * R;
    if (angleDiffDeg(bearingDegrees(aLat, aLon, pLat, pLon), bearingDegrees(aLat, aLon, bLat, bLon)) > 90) {
      along = -along;
    }
    return along;
  }

  function pointOnRunway(acLat, acLon, thresholdLat, thresholdLon, farEndLat, farEndLon, lateralToleranceKm, overshootBufferKm) {
    if (lateralToleranceKm == null) lateralToleranceKm = 0.06;
    if (overshootBufferKm == null) overshootBufferKm = 0.3;
    var crossTrack = crossTrackKm(acLat, acLon, thresholdLat, thresholdLon, farEndLat, farEndLon);
    var alongTrack = alongTrackKm(acLat, acLon, thresholdLat, thresholdLon, farEndLat, farEndLon, crossTrack);
    var runwayLength = haversineKm(thresholdLat, thresholdLon, farEndLat, farEndLon);
    var pastEnd = alongTrack > runwayLength;
    return {
      onRunway: Math.abs(crossTrack) <= lateralToleranceKm &&
        alongTrack >= -overshootBufferKm &&
        alongTrack <= runwayLength + overshootBufferKm,
      distFromThresholdKm: alongTrack,
      pastEnd: pastEnd
    };
  }

  // Flying distance (km) to touchdown on the best of the given landing runways ({thresholdLat, thresholdLon,
  // farEndLat, farEndLon}). Lined up on final (within ~2 km of the extended centerline, tracking the landing
  // direction, up to 35 km out) it is the distance to the threshold. Otherwise (downwind, base, vectors) it is
  // the trip to a join point on the extended centerline 15-30 km out plus that final leg, so it is never
  // shorter than the straight line. Null without runways.
  // runways.json entries ([leLat, leLon, leElev, heLat, heLon, heElev, label]) as landing ends in both
  // directions, shaped like matchRunwayDesignator results.
  function runwayApproachEnds(entries, options) {
    var ends = [];
    for (var i = 0; entries && i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.length < 5) continue;
      var label = typeof e[6] === "string" && /^(\S+)\s+(\S+)\/(\S+)$/.exec(e[6]);
      if (label && options && options.designators) {
        ends.push(matchRunwayDesignator([e], label[1], label[2]));
        ends.push(matchRunwayDesignator([e], label[1], label[3]));
      } else {
        ends.push({ thresholdLat: e[0], thresholdLon: e[1], farEndLat: e[3], farEndLon: e[4] });
        ends.push({ thresholdLat: e[3], thresholdLon: e[4], farEndLat: e[0], farEndLon: e[1] });
      }
    }
    return ends;
  }

  function approachPathKm(lat, lng, track, runways, options) {
    if (!runways || !runways.length || lat == null || lng == null) return null;
    options = options || {};
    var joinKm = options.joinKm != null ? options.joinKm : 15;
    var best = null;
    for (var i = 0; i < runways.length; i++) {
      var r = runways[i];
      if (!r) continue;
      var hdg = bearingDegrees(r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon);
      var xt = crossTrackKm(lat, lng, r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon);
      var out = -alongTrackKm(lat, lng, r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon, xt);
      var aligned = track == null || angleDiffDeg(track, hdg) <= 30;
      var onFinal = out >= 0 && out <= 35 && Math.abs(xt) <= 2 + out * 0.05 && aligned;
      var pathKm;
      if (onFinal) {
        pathKm = Math.sqrt(out * out + xt * xt);
      } else {
        var jd = Math.max(joinKm, Math.min(out, 30));
        var join = projectLatLng(r.thresholdLat, r.thresholdLon, (hdg + 180) % 360, jd * 1000);
        pathKm = haversineKm(lat, lng, join[0], join[1]) + jd;
      }
      if (!best || pathKm < best.pathKm) best = { pathKm: pathKm, onFinal: onFinal, runway: r };
    }
    return best;
  }

  // A measured final/runway match uses the nearest centerline, including staggered parallel thresholds.
  // Callers may separately fall back to an active-runway path; that is an assumption, not a match.
  function matchArrivalRunway(a, runways) {
    if (!a || !Number.isFinite(a.track)) return null;
    var best = null, bestCross = Infinity;
    for (var i = 0; runways && i < runways.length; i++) {
      var r = runways[i];
      if (!r || angleDiffDeg(a.track, bearingDegrees(r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon)) > 30) continue;
      var path = approachPathKm(a.lat, a.lng, a.track, [r]);
      var on = pointOnRunway(a.lat, a.lng, r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon);
      if (!path || (!path.onFinal && !on.onRunway)) continue;
      var cross = Math.abs(crossTrackKm(a.lat, a.lng, r.thresholdLat, r.thresholdLon, r.farEndLat, r.farEndLon));
      if (cross < bestCross) {
        bestCross = cross;
        best = { runway: r, onFinal: path.onFinal, onRunway: on.onRunway, pathKm: on.onRunway ? 0 : path.pathKm };
      }
    }
    return best;
  }

  // Real posHistory points: [lat, lng, reportMs, altitudeMSL, ground, breakBefore, synthetic].
  // Two consecutive >500 fpm altitude intervals AND >300 ft gained after a low descending final.
  // State consumes each report once, survives lost polls, and never bridges ground or a history gap.
  function updateGoAround(previous, points, nowMs, options) {
    options = options || {};
    var state = Object.assign({ goAroundAtMs: null, lastTs: null }, previous);
    var elevation = options.fieldElevFt || 0;
    function disarm() { state.armedAtMs = null; state.climbSamples = 0; state.lowAltFt = null; state.descentSamples = 0; }
    function clear() { disarm(); state.goAroundAtMs = null; state.backAtMs = null; state.finalSamples = 0; }
    if (options.departing || (state.backAtMs != null && nowMs > state.backAtMs + 5 * 60000)) clear();
    for (var i = 0; points && i < points.length; i++) {
      var p = points[i];
      if (!p || p[6] || !Number.isFinite(p[2]) || p[2] > nowMs || p[2] < nowMs - 180000 ||
          (state.lastTs != null && p[2] <= state.lastTs)) continue;
      var before = state.previous;
      if (before && !p[4] && p[2] - before[2] < 1000) continue;
      state.lastTs = p[2];
      state.previous = p;
      if (p[4]) { clear(); continue; }
      var dt = before ? p[2] - before[2] : 0;
      if (!before || before[4] || p[5] || dt < 1000 || dt > 30000 ||
          !Number.isFinite(p[3]) || !Number.isFinite(before[3])) {
        disarm(); state.finalSamples = 0; continue;
      }
      var rate = (p[3] - before[3]) * 60000 / dt;
      var match = matchArrivalRunway({ lat: p[0], lng: p[1], track: bearingDegrees(before[0], before[1], p[0], p[1]) }, options.runways);
      // No altitude-based "touchdown" guess: alt_baro is uncorrected pressure altitude and swings ~100-300 ft with
      // the day's altimeter setting, so any band either missed real go-arounds or flagged touch-and-goes depending
      // on the weather (v2.48 review round 2). Touchdown comes from the ground bit; light aircraft, whose
      // touch-and-goes often lack it, are excluded from detection on the board.
      var finalApproach = match && match.onFinal && !match.onRunway && rate < -100;
      var final = finalApproach && match.pathKm <= 6 && p[3] - elevation < 1500 && p[3] - elevation >= -100;
      if (state.goAroundAtMs != null) {
        state.finalSamples = finalApproach ? (state.finalSamples || 0) + 1 : 0;
        if (state.finalSamples >= 2) clear();
        else continue;
      }
      if (options.departing) { disarm(); continue; }
      state.descentSamples = final ? (state.descentSamples || 0) + 1 : 0;
      if (final) {
        state.climbSamples = 0;
        if (state.descentSamples >= 2) {
          state.armedAtMs = p[2]; state.runway = match.runway.designator || null;
          state.lowAltFt = p[3];
        }
      } else if (state.armedAtMs != null && p[2] - state.armedAtMs <= 120000) {
        state.lowAltFt = Math.min(state.lowAltFt, p[3]);
        state.climbSamples = rate > 500 ? (state.climbSamples || 0) + 1 : 0;
        if (state.climbSamples >= 2 && p[3] - state.lowAltFt > 300) {
          state.goAroundAtMs = p[2]; state.backAtMs = p[2] + 11 * 60000; state.finalSamples = 0;
        }
      } else disarm();
    }
    return state;
  }

  function sequenceAirportArrivals(rows) {
    var result = (rows || []).map(function(row) { return Object.assign({}, row, { sequence: null }); });
    var groups = {};
    result.forEach(function(row) {
      if (!row.runway || row.runwayAssumed || row.goAround) return;
      var key = normalizeRunwayDesignator(row.runway);
      if (!key) return;
      (groups[key] || (groups[key] = [])).push(row);
    });
    Object.keys(groups).forEach(function(key) {
      groups[key].sort(function(a, b) {
        var distance = Number.isFinite(a.pathKm) && Number.isFinite(b.pathKm) ? a.pathKm - b.pathKm : 0;
        var etaA = Number.isFinite(a.displayEtaMin) ? a.displayEtaMin : Number.isFinite(a.etaMin) ? a.etaMin : Infinity;
        var etaB = Number.isFinite(b.displayEtaMin) ? b.displayEtaMin : Number.isFinite(b.etaMin) ? b.etaMin : Infinity;
        return (etaA === etaB ? 0 : etaA - etaB) || distance || String(a.hex || a.callsign).localeCompare(String(b.hex || b.callsign));
      }).forEach(function(row, i) { row.sequence = i + 1; });
    });
    return result;
  }

  function formatArrivalCountdown(seconds) {
    if (!Number.isFinite(seconds)) return "\u2014";
    var sec = Math.max(0, Math.ceil(seconds));
    return Math.floor(sec / 60) + ":" + (sec % 60 < 10 ? "0" : "") + sec % 60;
  }

  function updateArrivalCountdown(previous, targetMs, nowMs) {
    var desired = Math.max(0, (targetMs - nowMs) / 1000);
    if (!previous) return { atMs: nowMs, targetMs: targetMs, remainingSec: desired };
    var elapsed = Math.max(0, (nowMs - previous.atMs) / 1000);
    var remaining = Math.max(0, previous.remainingSec - elapsed);
    // Large EARLIER revisions snap down once. A large LATER revision never makes the seconds jump backwards:
    // the row shows the coarse "~N min" form for 30 s after the last such revision, then resumes counting
    // from the new target. Small corrections can hold, but never tick upward.
    var coarseUntilMs = previous.coarseUntilMs && previous.coarseUntilMs > nowMs ? previous.coarseUntilMs : 0;
    if (desired - remaining > 20) { remaining = desired; coarseUntilMs = nowMs + 30000; }
    else if (remaining - desired > 20 || coarseUntilMs) remaining = desired;
    else remaining += Math.max(-Math.min(2, elapsed * 2), Math.min(elapsed, desired - remaining));
    var next = { atMs: nowMs, targetMs: targetMs, remainingSec: Math.max(0, remaining) };
    if (coarseUntilMs) { next.coarseUntilMs = coarseUntilMs; next.coarse = true; }
    return next;
  }

  function layoutApproachLadder(rows, options) {
    options = options || {};
    var runways = [], beads = [], pairs = [];
    function addRunway(r) {
      if (r && runways.indexOf(r) === -1 && runways.length < 4) runways.push(r);
    }
    (options.runways || []).forEach(addRunway);
    (rows || []).filter(function(r) { return !r.goAround && r.runway; }).map(function(r) { return r.runway; }).sort().forEach(addRunway);
    (rows || []).forEach(function(r) {
      var lane = runways.indexOf(r.runway);
      if (r.goAround || lane < 0 || !Number.isFinite(r.etaMin)) return;
      beads.push(Object.assign({}, r, { lane: lane, y: 1 - Math.max(0, Math.min(15, r.etaMin)) / 15 }));
    });
    // Keep dots at the true time; spread labels within each strip and connect displaced labels to dots.
    runways.forEach(function(runway, lane) {
      var labels = beads.filter(function(b) { return b.lane === lane; }).sort(function(a, b) { return a.y - b.y; });
      var gap = Math.min(0.14, 1 / Math.max(1, labels.length - 1));
      labels.forEach(function(b, i) {
        b.labelY = Math.max(b.y, i ? labels[i - 1].labelY + gap : 0);
        b.compactLabel = labels.length > 8;
      });
      for (var i = labels.length - 1; i >= 0; i--) labels[i].labelY = Math.max(0, Math.min(labels[i].labelY, i === labels.length - 1 ? 1 : labels[i + 1].labelY - gap));
    });
    var candidates = [];
    for (var i = 0; i < beads.length; i++) for (var j = i + 1; j < beads.length; j++) {
      var a = beads[i], b = beads[j];
      var ar = /^(\d+)[LRC]$/.exec(a.runway), br = /^(\d+)[LRC]$/.exec(b.runway);
      var delta = Math.abs(a.etaMin - b.etaMin) * 60;
      if (ar && br && ar[1] === br[1] && a.lane !== b.lane && delta <= 20 && !a.runwayAssumed && !b.runwayAssumed) {
        candidates.push({ a: a.hex, b: b.hex, left: Math.min(a.lane, b.lane), right: Math.max(a.lane, b.lane),
          y: (a.y + b.y) / 2, deltaSec: delta });
      }
    }
    var paired = {};
    candidates.sort(function(a, b) { return a.deltaSec - b.deltaSec; }).forEach(function(pair) {
      if (paired[pair.a] || paired[pair.b]) return;
      paired[pair.a] = paired[pair.b] = true; pairs.push(pair);
    });
    return { runways: runways, beads: beads, pairs: pairs };
  }

  // Capture once near each *predicted* horizon, avoiding invented samples when the board was closed.
  function arrivalEtaHorizon(etaMin) {
    if (!Number.isFinite(etaMin)) return null;
    var horizons = [10, 5, 2, 1], windows = [1, 0.5, 0.25, 0.2];
    for (var i = 0; i < horizons.length; i++) if (Math.abs(etaMin - horizons[i]) <= windows[i]) return horizons[i];
    return null;
  }

  function pruneArrivalLog(records) {
    return (records || []).filter(function(r) { return r && r.airport && r.hex && Number.isFinite(r.firstAtMs) && r.predictions; })
      .slice().sort(function(a, b) { return a.firstAtMs - b.firstAtMs; }).slice(-2000);
  }

  function recordArrivalPrediction(records, observation) {
    var o = observation || {}, now = o.nowMs;
    if (!o.airport || !o.hex || !Number.isFinite(now)) return records;
    var key = o.airport + ":" + o.hex + ":" + now;
    var index = -1;
    // Match only a recent open approach; one airframe may land several times per day.
    for (var i = records.length - 1; i >= 0; i--) {
      var r = records[i];
      if (r.airport !== o.airport || r.hex !== o.hex) continue;
      // A late feed/cache report must not reopen an already observed flight.
      if (now < r.lastSeenAtMs || (r.actualAtMs != null && now <= r.actualAtMs)) return records;
      if (r.actualAtMs == null && now >= r.lastSeenAtMs && now - r.lastSeenAtMs <= 30 * 60000) { index = i; break; }
    }
    var record = index < 0 ? null : records[index];
    // Aborted-approach forecasts must never be scored against a later touchdown.
    if (o.goAround) return index < 0 ? records : records.filter(function(r, i) { return i !== index; });
    if (o.touchdown) {
      if (!record || !o.atAirport || now < record.lastSeenAtMs || now - record.lastSeenAtMs > 120000) return records;
      record = Object.assign({}, record, { actualAtMs: now });
    } else {
      if (!Number.isFinite(o.etaMin) || o.etaMin <= 0 || (record && now <= record.lastSeenAtMs)) return records;
      var horizon = arrivalEtaHorizon(o.etaMin);
      if (!record && !horizon) return records;
      record = Object.assign({}, record || { key: key, airport: o.airport, hex: o.hex, firstAtMs: now, actualAtMs: null, predictions: {} },
        { lastSeenAtMs: now });
      if (horizon && !record.predictions[horizon]) {
        var predictedAt = Number.isFinite(o.predictionAtMs) ? o.predictionAtMs : now;
        record.predictions = Object.assign({}, record.predictions);
        record.predictions[horizon] = { observedAtMs: predictedAt, touchdownAtMs: predictedAt + o.etaMin * 60000 };
      }
    }
    var result = records.slice();
    if (index < 0) result.push(record); else result[index] = record;
    return pruneArrivalLog(result);
  }

  function arrivalEtaScorecard(records, airport) {
    var landings = (records || []).filter(function(r) { return r.airport === airport && Number.isFinite(r.actualAtMs); })
      .sort(function(a, b) { return b.actualAtMs - a.actualAtMs; }).slice(0, 50);
    return { count: landings.length, horizons: [10, 5, 2, 1].map(function(minutes) {
      var errors = landings.map(function(r) {
        var prediction = r.predictions && r.predictions[minutes];
        return prediction && Number.isFinite(prediction.touchdownAtMs) ? Math.abs(prediction.touchdownAtMs - r.actualAtMs) / 1000 : null;
      }).filter(function(e) { return e != null; }).sort(function(a, b) { return a - b; });
      var n = errors.length;
      return { minutes: minutes, count: n, medianSec: n ? (errors[Math.floor((n - 1) / 2)] + errors[Math.floor(n / 2)]) / 2 : null,
        p90Sec: n ? errors[Math.ceil(n * 0.9) - 1] : null };
    }) };
  }

  // Minutes to fly `distKm` to the airport, slowing down on the way in: the current ground speed out to 60 km,
  // at most 220 kts from 60 to 15 km (approach), at most 150 kts on the last 15 km (final).
  function arrivalPathTimeMin(distKm, spdKts) {
    if (distKm == null || !Number.isFinite(distKm)) return null;
    var gs = spdKts > 0 ? spdKts : 250;
    var legs = [[Math.max(0, distKm - 60), gs], [Math.max(0, Math.min(distKm, 60) - 15), Math.min(gs, 220)], [Math.min(distKm, 15), Math.min(gs, 150)]];
    var min = 0;
    for (var i = 0; i < legs.length; i++) min += legs[i][0] / (legs[i][1] * 1.852 / 60);
    return min;
  }

  // Far out, the feed's (FR24) estimated landing time knows the schedule and routing better than geometry;
  // close in, live geometry wins. Blend linearly from the geometry ETA at 10 min to the feed ETA at 20 min.
  function blendArrivalEta(geoEtaMin, feedEtaMin, options) {
    if (options && options.goAround) return geoEtaMin;
    if (feedEtaMin == null || !Number.isFinite(feedEtaMin) || feedEtaMin < 0) return geoEtaMin;
    if (geoEtaMin == null || !Number.isFinite(geoEtaMin)) return feedEtaMin;
    var w = Math.max(0, Math.min(1, (geoEtaMin - 10) / 10));
    return geoEtaMin * (1 - w) + feedEtaMin * w;
  }

  // altFt is the feed's (sea-level) altitude; with fieldElevFt every altitude rule works on height above the
  // airport. pathKm, when known, is the flying distance to touchdown (approachPathKm) and drives the ETA;
  // distKm (straight line to the airport) still decides eligibility.
  function scoreArrivalCandidate(input) {
    input = input || {};
    var fieldElevFt = Number.isFinite(input.fieldElevFt) ? input.fieldElevFt : 0;
    var altFt = Number.isFinite(input.altFt) ? Math.max(0, input.altFt - fieldElevFt) : null;
    var distKm = Number.isFinite(input.distKm) ? Math.max(0, input.distKm) : null;
    var etaDistKm = Number.isFinite(input.pathKm) ? Math.max(input.pathKm, distKm || 0) : distKm;
    var spdKts = Number.isFinite(input.spdKts) ? Math.max(0, input.spdKts) : 0;
    var confidence = input.confidence || "";
    var phase = input.phase || "";
    var privateAircraft = !!input.private;
    var destinationMatch = !!input.destinationMatch;
    var originMatch = !!input.originMatch;
    var vRateFpm = Number.isFinite(input.vRate) ? input.vRate * 60 : null;
    var descending = vRateFpm != null && vRateFpm <= -200;
    var climbing = vRateFpm != null && vRateFpm >= 150;
    var distanceEtaMin = etaDistKm != null && spdKts > 0 ? arrivalPathTimeMin(etaDistKm, spdKts) : null;
    var descentEtaMin = descending && altFt != null
      ? altFt / Math.max(Math.abs(vRateFpm), 300)
      : null;
    var etaMin = null;
    var eligible = true;

    if ((destinationMatch || Number.isFinite(input.pathKm)) && etaDistKm != null) {
      etaMin = arrivalPathTimeMin(etaDistKm, spdKts);
    } else if (descentEtaMin != null) {
      etaMin = descentEtaMin;
      if (distanceEtaMin != null) etaMin = descentEtaMin * 0.8 + distanceEtaMin * 0.2;
    } else if (distanceEtaMin != null) {
      etaMin = distanceEtaMin;
    } else if (altFt != null) {
      etaMin = Math.max(altFt / 1200, 1);
    } else if (etaDistKm != null) {
      etaMin = Math.max(etaDistKm / 10, 1);
    } else {
      etaMin = 999;
    }
    if (altFt != null) etaMin = Math.max(etaMin, altFt / 1500);
    if (destinationMatch) etaMin = blendArrivalEta(etaMin, input.feedEtaMin, input);

    if (phase === "departing" || phase === "landed") eligible = false;
    if (originMatch) eligible = false;
    if (climbing) eligible = false;
    if (destinationMatch) {
      if (privateAircraft && confidence !== "high") eligible = false;
    } else {
      if (privateAircraft) eligible = false;
      if (altFt == null || altFt > 10000) eligible = false;
      if (distKm == null || distKm > 25) eligible = false;
      if (!descending) eligible = false;
    }

    var score = etaMin * 1.5;
    if (altFt == null) {
      score += 120;
    } else {
      score += altFt / 400;
      if (altFt > 8000) score += (altFt - 8000) / 200;
      if (altFt > 15000) score += 50;
    }
    if (distKm == null) score += 20;
    else score += distKm * 0.1;
    if (climbing) {
      score += 60 + Math.min(40, vRateFpm / 150);
    } else if (!descending) {
      score += 35;
    } else {
      score -= Math.min(25, Math.abs(vRateFpm) / 120);
    }
    if (!spdKts) score += descending ? 8 : 20;
    if (destinationMatch) score -= 10;
    else score += 12;
    if (confidence === "low") score += 12;
    else if (confidence && confidence !== "high") score += 5;
    if (privateAircraft) score += destinationMatch && confidence === "high" ? 2 : 25;
    if (!eligible) score += 1000;

    return {
      eligible: eligible,
      score: roundTo(Math.max(0, score), 2),
      etaMin: roundTo(Math.max(0, etaMin), 2)
    };
  }

  function compareAirportArrivalEntries(a, b) {
    var scoreA = a && a.arrivalScore != null ? a.arrivalScore : Infinity;
    var scoreB = b && b.arrivalScore != null ? b.arrivalScore : Infinity;
    if (scoreA !== scoreB) return scoreA - scoreB;
    if (!!(a && a.proximity) !== !!(b && b.proximity)) return a && a.proximity ? 1 : -1;
    var distA = a && a.distKm != null ? a.distKm : Infinity;
    var distB = b && b.distKm != null ? b.distKm : Infinity;
    if (distA !== distB) return distA - distB;
    return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
  }

  function copyAirportRows(rows) {
    if (!Array.isArray(rows)) return [];
    var copied = [];
    for (var i = 0; i < rows.length; i++) {
      var src = rows[i] || {};
      var dst = {};
      for (var key in src) dst[key] = src[key];
      copied.push(dst);
    }
    return copied;
  }

  function limitAirportRows(rows, limit) {
    if (limit != null && rows.length > limit) rows.length = limit;
    return rows;
  }

  function airportRowDedupeKeys(row) {
    var keys = [];
    var hex = normalizeAircraftHex(row && row.hex);
    if (hex) keys.push("hex:" + hex);
    var callsign = row && row.callsign ? String(row.callsign).trim().toUpperCase() : "";
    if (callsign) keys.push("cs:" + callsign);
    return keys;
  }

  function dedupeAirportRows(rows) {
    var seen = {};
    var deduped = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var keys = airportRowDedupeKeys(row);
      var duplicate = false;
      for (var k = 0; k < keys.length; k++) {
        if (seen[keys[k]]) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      deduped.push(row);
      for (var j = 0; j < keys.length; j++) seen[keys[j]] = true;
    }
    return deduped;
  }

  function compareAirportLandedEntries(a, b) {
    var aRoll = a && a._rolloutDist != null ? a._rolloutDist : null;
    var bRoll = b && b._rolloutDist != null ? b._rolloutDist : null;
    if (aRoll != null || bRoll != null) {
      if (aRoll == null) return 1;
      if (bRoll == null) return -1;
      if (aRoll !== bRoll) return aRoll - bRoll;
    }
    var distA = a && a.distKm != null ? a.distKm : Infinity;
    var distB = b && b.distKm != null ? b.distKm : Infinity;
    if (distA !== distB) return distA - distB;
    return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
  }

  // The board's "Landed" tab: planes on the runway after touchdown (most recent first), then taxiing in,
  // then stopped at the gate.
  function sortAirportLandedRows(landed, taxiingIn, options) {
    options = options || {};
    var totalLimit = options.totalLimit == null ? 15 : options.totalLimit;
    var landedRows = copyAirportRows(landed).sort(compareAirportLandedEntries);
    var taxiingRows = copyAirportRows(taxiingIn).sort(function(a, b) {
      if (!!a.parked !== !!b.parked) return a.parked ? 1 : -1;
      var distA = a && a.distKm != null ? a.distKm : Infinity;
      var distB = b && b.distKm != null ? b.distKm : Infinity;
      if (distA !== distB) return distA - distB;
      return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
    });
    var rows = dedupeAirportRows(landedRows.concat(taxiingRows));
    limitAirportRows(rows, totalLimit);
    for (var i = 0; i < rows.length; i++) delete rows[i]._rolloutDist;
    return rows;
  }

  // The board's "Landings" tab: airborne inbound planes in ETA order, soonest first. Rows for planes
  // already listed in `options.exclude` (the Landed tab) are dropped.
  function sortAirportInboundRows(inbound, options) {
    options = options || {};
    var totalLimit = options.totalLimit == null ? 15 : options.totalLimit;
    var rows = copyAirportRows(inbound).sort(function(a, b) {
      var etaA = a && a.etaMin != null && Number.isFinite(a.etaMin) ? a.etaMin : Infinity;
      var etaB = b && b.etaMin != null && Number.isFinite(b.etaMin) ? b.etaMin : Infinity;
      if (etaA !== etaB) return etaA - etaB;
      return compareAirportArrivalEntries(a, b);
    });
    var excludedKeys = {};
    var excluded = options.exclude || [];
    for (var e = 0; e < excluded.length; e++) {
      var keys = airportRowDedupeKeys(excluded[e]);
      for (var k = 0; k < keys.length; k++) excludedKeys[keys[k]] = true;
    }
    rows = dedupeAirportRows(rows).filter(function(row) {
      var rowKeys = airportRowDedupeKeys(row);
      for (var i = 0; i < rowKeys.length; i++) if (excludedKeys[rowKeys[i]]) return false;
      return true;
    });
    return limitAirportRows(rows, totalLimit);
  }

  // Takeoff board order: rolling, lined up, the ground queue (taxiing + parked), then planes already climbing
  // out, which have taken off and are listed last as "just departed".
  function airportDepartureStatusOrder(status) {
    var statusOrd = { Departing: 0, Holding: 1, Taxiing: 3, Parked: 4, Climbing: 5 };
    return statusOrd[status] != null ? statusOrd[status] : 4;
  }

  // Stopped this close to a departure threshold means waiting at the hold-short line.
  var HOLD_SHORT_KM = 0.35;

  // Rank inside the ground queue: 0 holding short or taxiing toward the runway, 1 taxiing in an unknown
  // direction, 2 parked away from the runway, 3 taxiing away from every departure runway.
  function departureQueueTier(row) {
    if (row.status === "Parked") return row.runwayDistKm != null && row.runwayDistKm <= HOLD_SHORT_KM ? 0 : 2;
    if (row.towardRunway === true) return 0;
    if (row.towardRunway === false) return 3;
    return 1;
  }

  // Track points are [lat, lng, ts, altFt, ground, breakBefore, synthetic]. True when the aircraft was seen
  // airborne within the window with a real altitude change (an approach), not a ground/air flag flicker at
  // field elevation. Used to tell a just-landed plane from one about to depart.
  function landedRecently(points, nowMs, options) {
    if (!points || !points.length) return false;
    options = options || {};
    var windowMs = options.windowMs != null ? options.windowMs : 15 * 60 * 1000;
    var minSpanFt = options.minSpanFt != null ? options.minSpanFt : 400;
    var lo = Infinity, hi = -Infinity;
    for (var i = points.length - 1; i >= 0; i--) {
      var p = points[i];
      if (!p || p[2] < nowMs - windowMs) break;
      if (p[6] || p[4] || p[3] == null || !Number.isFinite(p[3])) continue;
      if (p[3] < lo) lo = p[3];
      if (p[3] > hi) hi = p[3];
    }
    return hi - lo >= minSpanFt;
  }

  // True when the aircraft lost at least minDropFt between its earliest and latest airborne sample in the window:
  // an approach, not a takeoff (which only gains altitude). A flare cuts the descent rate, so the rate alone
  // can't tell a plane about to touch down from one lifting off.
  function descendedRecently(points, nowMs, options) {
    if (!points || !points.length) return false;
    options = options || {};
    var windowMs = options.windowMs != null ? options.windowMs : 3 * 60 * 1000;
    var minDropFt = options.minDropFt != null ? options.minDropFt : 500;
    var earliest = null, latest = null;
    for (var i = points.length - 1; i >= 0; i--) {
      var p = points[i];
      if (!p || p[2] < nowMs - windowMs) break;
      if (p[6] || p[4] || p[3] == null || !Number.isFinite(p[3])) continue;
      if (latest == null) latest = p[3];
      earliest = p[3];
    }
    return earliest != null && latest != null && earliest - latest >= minDropFt;
  }

  // How much closer (km) the track got to a target over about `spanMs`; negative when moving away. Null when
  // the track is too short or the earlier point is too old to say.
  function closingKm(points, targetLat, targetLng, spanMs) {
    if (!points || points.length < 2) return null;
    spanMs = spanMs || 20000;
    var last = points[points.length - 1];
    for (var i = points.length - 2; i >= 0; i--) {
      var p = points[i];
      if (p[6]) continue;
      var age = last[2] - p[2];
      if (age < spanMs) continue;
      if (age > spanMs * 4) return null;
      return haversineKm(p[0], p[1], targetLat, targetLng) - haversineKm(last[0], last[1], targetLat, targetLng);
    }
    return null;
  }

  function classifyGroundDepartureStatus(input) {
    // Decide the ground phase of an on-airport aircraft, taking its direction of
    // travel and which runway it is on into account. Two ways an on-runway aircraft
    // is NOT actually starting a takeoff roll:
    //   1. It is on the active departure runway but tracking opposite (or across)
    //      the takeoff direction — back-taxiing to the start to line up, or rolling
    //      out from a landing on the reciprocal end.
    //   2. It is on a DIFFERENT runway than the one(s) departures are using
    //      (an inactive/closed runway, or just crossing one) — taxiing, not
    //      departing.
    // Such aircraft must not be labelled "Departing" / next departure.
    // Returns "Departing" | "Holding" | "Taxiing" | "Parked".
    input = input || {};
    var speedKts = Number.isFinite(input.speedKts) ? input.speedKts : 0;
    var track = input.track;
    var onActiveDepRunway = !!input.onActiveDepRunway;
    var onAnyRunway = !!input.onAnyRunway;
    var haveActiveDep = !!input.haveActiveDep;
    var minTrackSpeedKts = input.minTrackSpeedKts == null ? 5 : input.minTrackSpeedKts;
    var tol = input.alignToleranceDeg == null ? 60 : input.alignToleranceDeg;
    // ADS-B track is unreliable at very low groundspeed, so only trust direction
    // once the aircraft is actually moving.
    var moving = speedKts >= minTrackSpeedKts && track != null;
    var fast = speedKts >= 50;

    function depAligned() {
      // Tracking roughly in the active takeoff direction.
      return input.depRunwayBearing != null && track != null &&
        angleDiffDeg(track, input.depRunwayBearing) <= tol;
    }
    function axisAligned(bearing) {
      // Tracking roughly along the runway centerline (either direction) — i.e. NOT
      // crossing it. Direction-agnostic since an inactive runway has no "in use" end.
      if (bearing == null || track == null) return false;
      var along = angleDiffDeg(track, bearing);
      var reciprocal = angleDiffDeg(track, (bearing + 180) % 360);
      return Math.min(along, reciprocal) <= tol;
    }

    if (onActiveDepRunway) {
      if (moving && !depAligned()) return "Taxiing"; // opposite / crossing the active runway
      if (fast) return "Departing";
      if (speedKts < 5) return "Holding"; // lined up, waiting for clearance
      return "Departing"; // rolling in the takeoff direction
    }

    if (onAnyRunway) {
      if (haveActiveDep) {
        // Departures are happening on the active runway, and this is not it. Only
        // accept a confirmed fast, centerline-aligned takeoff roll (covers a second
        // active runway we didn't detect this tick). Everything else — crossing,
        // taxiing along a closed/inactive runway, sitting — is taxiing.
        if (fast && (track == null || axisAligned(input.anyRunwayBearing))) return "Departing";
        return "Taxiing";
      }
      // No active-runway signal at all: fall back to geometry, but still reject
      // aircraft crossing the runway perpendicular.
      if (moving && input.anyRunwayBearing != null && !axisAligned(input.anyRunwayBearing)) return "Taxiing";
      if (speedKts < 5) return "Holding";
      return "Departing";
    }

    // Not on any detected runway. A fast ground roll is almost certainly a takeoff
    // whose runway geometry we missed; anything slower is taxiing/parked.
    if (fast) return "Departing";
    if (speedKts >= 5) return "Taxiing";
    return "Parked";
  }

  function describeAirportDepartureStatus(row, options) {
    options = options || {};
    row = row || {};
    var status = row.status || "Parked";
    var speedKts = row.speedKts || 0;
    var runwayDistKm = row.runwayDistKm;
    var activeRunway = !!row.activeRunway;
    var onRunway = activeRunway || !!row.onRunway;
    // "Near runway" must mean genuinely at the threshold/hold area. The old 1.5 km
    // band tagged planes abeam the middle of a long runway (e.g. SFO 28L is 3.3 km)
    // as "near runway" while they still had a km+ taxi to the departure end.
    var nearRunway = runwayDistKm != null && runwayDistKm <= (options.activeRunways ? 0.7 : 1);
    var routeOrigin = !!row.originMatch;
    var confidence = "low";
    var label = status;
    var sortOrder = airportDepartureStatusOrder(status);

    var holdingShort = status === "Parked" && runwayDistKm != null && runwayDistKm <= HOLD_SHORT_KM;
    if (status === "Departing") {
      label = "Rolling";
      confidence = activeRunway || onRunway || speedKts >= 50 || routeOrigin ? "high" : "medium";
    } else if (status === "Climbing") {
      label = "Just departed";
      confidence = routeOrigin || activeRunway || nearRunway ? "high" : "medium";
    } else if (status === "Holding") {
      label = onRunway ? "Holding on runway" : "Holding";
      confidence = activeRunway || onRunway || nearRunway || routeOrigin ? "high" : "medium";
    } else if (status === "Taxiing") {
      if (row.towardRunway === false) label = "Taxiing away";
      else if (nearRunway) label = "Taxiing near runway";
      else label = row.towardRunway ? "Taxiing to runway" : "Taxiing";
      confidence = row.towardRunway !== false && (nearRunway || routeOrigin || row.towardRunway) ? "medium" : "low";
    } else if (holdingShort) {
      label = "Holding short";
      confidence = "medium";
    } else {
      label = routeOrigin ? "Parked, route matched" : "Parked";
      confidence = routeOrigin ? "medium" : "low";
    }

    return {
      label: label,
      confidence: confidence,
      sortOrder: sortOrder,
      activeRunway: activeRunway,
      onRunway: onRunway,
      nearRunway: nearRunway,
      routeOrigin: routeOrigin
    };
  }

  function confidenceOrder(confidence) {
    var ord = { high: 0, medium: 1, low: 2 };
    return ord[confidence] != null ? ord[confidence] : 2;
  }

  function runwayPreferenceOrder(row, signal, options) {
    options = options || {};
    row = row || {};
    signal = signal || describeAirportDepartureStatus(row, options);
    if (signal.activeRunway) return 0;
    if (signal.onRunway) return options.activeRunways ? 2 : 1;
    if (signal.nearRunway) return 2;
    if (row.runwayDistKm != null) return 3;
    return 4;
  }

  function compareAirportDepartureEntries(a, b, options) {
    options = options || {};
    var aSignal = describeAirportDepartureStatus(a, options);
    var bSignal = describeAirportDepartureStatus(b, options);

    // Taxiing and Parked are both the ground queue. Imminence is being at the hold-short line or taxiing
    // toward the runway, then distance to the threshold; a plane parked at a gate near the runway end or
    // taxiing away from it is not next just because it is close. Route/airport distance only break ties.
    var aStaged = aSignal.sortOrder === 3 || aSignal.sortOrder === 4;
    var bStaged = bSignal.sortOrder === 3 || bSignal.sortOrder === 4;
    if (aStaged && bStaged) {
      var aTier = departureQueueTier(a || {});
      var bTier = departureQueueTier(b || {});
      if (aTier !== bTier) return aTier - bTier;
      var aRwyDist = a && a.runwayDistKm != null ? a.runwayDistKm : Infinity;
      var bRwyDist = b && b.runwayDistKm != null ? b.runwayDistKm : Infinity;
      if (aRwyDist !== bRwyDist) return aRwyDist - bRwyDist;
      if (!!(a && a.originMatch) !== !!(b && b.originMatch)) return a && a.originMatch ? -1 : 1;
      var tpDistA = a && a.distKm != null ? a.distKm : Infinity;
      var tpDistB = b && b.distKm != null ? b.distKm : Infinity;
      if (tpDistA !== tpDistB) return tpDistA - tpDistB;
      return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
    }

    if (aSignal.sortOrder !== bSignal.sortOrder) return aSignal.sortOrder - bSignal.sortOrder;

    var aRunwayPref = runwayPreferenceOrder(a, aSignal, options);
    var bRunwayPref = runwayPreferenceOrder(b, bSignal, options);
    if (aRunwayPref !== bRunwayPref) return aRunwayPref - bRunwayPref;

    var aConf = confidenceOrder(aSignal.confidence);
    var bConf = confidenceOrder(bSignal.confidence);
    if (aConf !== bConf) return aConf - bConf;

    if (!!(a && a.originMatch) !== !!(b && b.originMatch)) return a && a.originMatch ? -1 : 1;
    if (a && a.runwayDistKm != null && b && b.runwayDistKm != null) {
      var rwyDiff = a.runwayDistKm - b.runwayDistKm;
      if (rwyDiff !== 0) return rwyDiff;
    }
    if (aSignal.sortOrder <= 3) return (b && b.speedKts || 0) - (a && a.speedKts || 0);
    if (!!(a && a.hasDest) !== !!(b && b.hasDest)) return a && a.hasDest ? -1 : 1;
    var distA = a && a.distKm != null ? a.distKm : Infinity;
    var distB = b && b.distKm != null ? b.distKm : Infinity;
    if (distA !== distB) return distA - distB;
    return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
  }

  function sortAirportDepartureRows(departures, options) {
    options = options || {};
    var totalLimit = options.totalLimit == null ? 15 : options.totalLimit;
    var rows = copyAirportRows(departures).sort(function(a, b) {
      return compareAirportDepartureEntries(a, b, options);
    });
    rows = dedupeAirportRows(rows);
    return limitAirportRows(rows, totalLimit);
  }

  function getAirportNextRow(liveData, dir) {
    var key = dir === "departures" || dir === "landed" ? dir : "arrivals";
    var rows = liveData && liveData[key];
    return rows && rows.length ? rows[0] : null;
  }

  function greatCirclePoints(lat1, lng1, lat2, lng2, segments) {
    // Sample the shortest-path great circle between two points as [lat, lng]
    // pairs for drawing a curved route line. Longitude is kept continuous
    // across the antimeridian (values may exceed +/-180) so the map draws one
    // unbroken line instead of wrapping it across the whole map.
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return [];
    if (!Number.isFinite(lat1) || !Number.isFinite(lng1) || !Number.isFinite(lat2) || !Number.isFinite(lng2)) return [];
    segments = segments && segments > 1 ? Math.floor(segments) : 64;
    var toRad = Math.PI / 180;
    var toDeg = 180 / Math.PI;
    var p1 = lat1 * toRad, l1 = lng1 * toRad;
    var p2 = lat2 * toRad, l2 = lng2 * toRad;
    var sinDp = Math.sin((p2 - p1) / 2);
    var sinDl = Math.sin((l2 - l1) / 2);
    var a = sinDp * sinDp + Math.cos(p1) * Math.cos(p2) * sinDl * sinDl;
    var d = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (d === 0) return [[lat1, lng1], [lat2, lng2]];
    var pts = [];
    var prevLng = null;
    for (var i = 0; i <= segments; i++) {
      var f = i / segments;
      var A = Math.sin((1 - f) * d) / Math.sin(d);
      var B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
      var y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
      var z = A * Math.sin(p1) + B * Math.sin(p2);
      var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg;
      var lng = Math.atan2(y, x) * toDeg;
      if (prevLng != null) {
        while (lng - prevLng > 180) lng -= 360;
        while (lng - prevLng < -180) lng += 360;
      }
      prevLng = lng;
      pts.push([lat, lng]);
    }
    return pts;
  }

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
    // Helicopter codes share prefixes with airliners (MD80s, BAe 146 B46x, An-124/148 A1xx, KC-10), so each
    // family is spelled out: AgustaWestland A1x9, Bell B06/B2xx/B4[0-3]x/B47G/B5x5, MD Helicopters MD5x/MD6x,
    // Kamov KAxx.
    if (/^(EC\d|H1[2-9]\d|H60|R22|R44|R66|S76|S92|A1[0-8]9|AS\d|B06|B2[0-3]\d|B4[0-3]\d|B47G|B5[0-2]5|MD[56]\d|BK|KA\d|MI\d|NH90)/.test(t)) return "heli";
    if (/^(C1[2-9]\d|C2[0-1]\d|P28|PA\d|SR2[02]|DA[24]\d|BE[23]\d|M20|TB[12]\d|DR4|RV\d|COL[34]|TRIN|P46T|PC12|GLST)/.test(t)) return "light";
    if (/^(AT[4-7]\d|DH8[A-D]|DHC[6-8]|SF34|SB20|B190|C208|PC[0-9]|TBM[0-9]|JS[2-4]\d|AN[2-3]\d|L410|DO[0-9]|J328|E120|BE[9A][0-9]|SW[34]|M28)/.test(t)) return "turboprop";
    if (/^(CRJ|E[1-2][0-9]\d|ERJ|GLF[2-7]|GL\dT|GLEX|G[2-7]\d\d|GA[5-7].|LJ\d|CL[0-9]|C[5-7]\d\d|C25|C56|C68|F[29][0-9]\d|FA[57]|H25|HA4|PRM|ASTR|GALX|E35L|E55P|EA50|SF50|PC24|P180)/.test(t)) return "bizjet";
    if (/^(A38\d|B74[0-9]|A34[0-9]|IL96|C5M?|A400|AN12|A124|K35R)/.test(t)) return "quadjet";
    if (/^(B7[6-8].|A3[03].|A35.|MD1[01]|DC10|KC10|L101|IL[89]\d|C17|KC46|A310)/.test(t)) return "widebody";
    if (/^(A3[12]\d|A2[02]\d|A[12]\dN|B73[0-9]|B3[89]M|BCS[1-3]|B75[0-9]|MD[89]\d|B712|E295|MC21|B46[1-3]|A148)/.test(t)) return "narrowbody";
    return sizeFromCategory(category) || "light";
  }

  function isLikelyPrivateClass(type, category) {
    var cls = sizeClass(type, category);
    return cls === "bizjet" || cls === "light" || cls === "turboprop";
  }

  // Greedy label placement: highest rank first; every label is a w x h box at the same offset from its point
  // (screen pixels), so two overlap when their points are closer than w across and h down. A label that would
  // overlap one already placed is dropped. Returns the kept items in placement order.
  function declutterLabels(items, box) {
    var sorted = items.slice().sort(function(a, b) { return (b.rank || 0) - (a.rank || 0); });
    var kept = [];
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var hit = false;
      for (var j = 0; j < kept.length && !hit; j++) {
        hit = Math.abs(kept[j].x - it.x) < box.w && Math.abs(kept[j].y - it.y) < box.h;
      }
      if (!hit) kept.push(it);
    }
    return kept;
  }

  // Offset to add to a feed timestamp (the feed server's clock) to get the client clock. Cached responses
  // arrive late, so the smallest receive delay seen recently is the best estimate; it is allowed to creep
  // up slowly so a client clock change is eventually absorbed.
  function updateClockOffset(prevOffsetMs, receivedAtMs, feedNowMs, creepMs) {
    var observed = receivedAtMs - feedNowMs;
    if (prevOffsetMs == null || !Number.isFinite(prevOffsetMs)) return observed;
    return Math.min(observed, prevOffsetMs + (creepMs == null ? 50 : creepMs));
  }

  // Traffic polling after failures: the normal interval, doubled per consecutive failure, capped.
  function trafficRetryDelayMs(baseMs, failStreak, capMs) {
    if (!failStreak || failStreak < 1) return baseMs;
    return Math.min(capMs == null ? 60000 : capMs, baseMs * Math.pow(2, failStreak - 1));
  }

  // One failed poll is a blip; two in a row, or one with no good data for 30 s, is an outage worth showing.
  function trafficOutage(failStreak, lastOkAt, now, staleMs) {
    if (!failStreak) return false;
    if (failStreak >= 2) return true;
    return !lastOkAt || now - lastOkAt > (staleMs == null ? 30000 : staleMs);
  }

  var routeAirportGrids = new WeakMap();

  function isReportedRouteSource(source) {
    return ["schedule", "fr24-search", "fr24", "live-feed"].indexOf(source) !== -1;
  }

  function routeProvenance(route) {
    var sources = [];
    // The destination is the claim shown in the route label; its source stands on its own.
    if (route && route.destination) sources.push(route.destSource);
    else if (route && route.origin) sources.push(route.originSource);
    var reported = sources.length > 0 && sources.every(isReportedRouteSource);
    var database = sources.indexOf("adsbdb") !== -1 || sources.indexOf("cross-validated") !== -1;
    return { label: reported ? "reported" : "inferred",
      note: reported ? "from FR24 live schedule"
        : database ? "from callsign database — may be outdated" : "estimated from flight path" };
  }

  // Airport rows are airports.json's [iata, lat, lng, name, city, rank, elevationFt].
  // State uses feet and feet/minute, with an optional previous {lat, lng} or heading (track).
  // This rejects evidence for a different leg; it does not detect or describe diversions.
  function rejectContradictoryRoute(route, state, airports) {
    if (!route || !state || !Number.isFinite(state.lat) || !Number.isFinite(state.lng)) return route;
    var keepOrigin = route.origin && (isReportedRouteSource(route.originSource) || route.originSource === "track");
    var keepDest = route.destination && isReportedRouteSource(route.destSource);
    if ((!route.origin || isReportedRouteSource(route.originSource)) && (!route.destination || keepDest)) return route;
    if (!airports) return route;
    var grid = routeAirportGrids.get(airports);
    if (!grid) { grid = buildAirportGrid(airports); routeAirportGrids.set(airports, grid); }
    var origin = route.origin && grid.byIata[route.origin.iata];
    var dest = route.destination && grid.byIata[route.destination.iata];
    var nearest = null, nearestKm = 40;
    var nearby = airportGridCandidates(grid, state.lat, state.lng, nearestKm);
    for (var i = 0; i < nearby.length; i++) {
      var ap = nearby[i];
      var km = haversineKm(state.lat, state.lng, ap[1], ap[2]);
      if (km < nearestKm) { nearestKm = km; nearest = ap; }
    }
    var contradiction = false;
    if (nearest) {
      var agl = Number.isFinite(state.altFt) ? state.altFt - (nearest[6] || 0) : null;
      var low = agl != null && agl < 10000;
      var atOrigin = route.origin && route.origin.iata === nearest[0];
      var atDest = route.destination && route.destination.iata === nearest[0];
      var destFar = dest && haversineKm(nearest[1], nearest[2], dest[1], dest[2]) > 150;
      var closing = null;
      if (state.previous && Number.isFinite(state.previous.lat) && Number.isFinite(state.previous.lng)) {
        var change = haversineKm(state.previous.lat, state.previous.lng, nearest[1], nearest[2]) - nearestKm;
        if (Math.abs(change) > 0.1) closing = change > 0;
      }
      if (closing == null && Number.isFinite(state.track)) {
        closing = Math.cos((state.track - bearingDegrees(state.lat, state.lng, nearest[1], nearest[2])) * Math.PI / 180) > 0.5;
      }
      if (!atOrigin && !atDest) {
        // Only a real descent toward another airport counts: a "low and closing" rule without a descent also
        // caught departures passing a neighbour (DAL->LAS near DFW), so it was removed (v2.47 review round 2).
        contradiction = !!((state.ground && nearestKm < 8) ||
          (closing === true && destFar && low && state.vRate < -300));
      }
    }
    // Distance to the minor great-circle segment, including its endpoints (not the infinite great circle).
    if (!contradiction && origin && dest) {
      var length = haversineKm(origin[1], origin[2], dest[1], dest[2]);
      var fromOrigin = haversineKm(origin[1], origin[2], state.lat, state.lng);
      var delta = (bearingDegrees(origin[1], origin[2], state.lat, state.lng) -
        bearingDegrees(origin[1], origin[2], dest[1], dest[2])) * Math.PI / 180;
      var along = Math.atan2(Math.sin(fromOrigin / 6371) * Math.cos(delta), Math.cos(fromOrigin / 6371)) * 6371;
      var offPath = along < 0 ? fromOrigin : along > length
        ? haversineKm(dest[1], dest[2], state.lat, state.lng)
        : Math.abs(Math.asin(Math.max(-1, Math.min(1, Math.sin(fromOrigin / 6371) * Math.sin(delta))))) * 6371;
      contradiction = offPath > Math.max(500, length * 0.5);
    }
    if (!contradiction) return route;
    if (!keepOrigin && !keepDest) return null;
    return Object.assign({}, route, { origin: keepOrigin ? route.origin : null,
      destination: keepDest ? route.destination : null, originSource: keepOrigin ? route.originSource : null,
      destSource: keepDest ? route.destSource : null, display: "", iata: "", confidence: "low" });
  }

  // Route sources the client's own track/convergence guesses must not overwrite.
  var AUTHORITATIVE_DEST_SOURCES = ["fr24-search", "schedule", "cross-validated"];
  function isAuthoritativeDestSource(source) {
    return AUTHORITATIVE_DEST_SOURCES.indexOf(source) !== -1;
  }

  // Cached routes are re-asked after 10 minutes, or 60 when an authoritative source resolved them.
  function routeCacheEntryStale(entry, now) {
    if (!entry) return true;
    if (!entry.fetchedAt) return true;
    var ttlMs = isAuthoritativeDestSource(entry.destSource) ? 60 * 60 * 1000 : 10 * 60 * 1000;
    return now - entry.fetchedAt > ttlMs;
  }

  // Whether a /routeset answer may replace the cached entry. A destination FR24 or the schedule resolved is
  // never replaced while fresh, whatever the answer's source: the Worker's "cross-validated" only means the
  // trace origin matched ADSBDB, which says nothing about the destination.
  function routeEntryReplaceable(current, now) {
    if (!current || !current.destination) return true;
    if (current.destSource !== "fr24-search" && current.destSource !== "schedule") return true;
    return routeCacheEntryStale(current, now);
  }

  // A feed row worth reading at all: an object with a numeric, finite position.
  function isUsableTrafficRow(row) {
    return !!row && typeof row === "object" &&
      typeof row.lat === "number" && Number.isFinite(row.lat) &&
      typeof row.lon === "number" && Number.isFinite(row.lon);
  }

  // The planes to send in one /routeset request: public callsigns with no fresh cached route, skipping ones
  // the server recently could not resolve (retryAt[callsign] is when they may be asked again).
  function selectRouteFetchPlanes(planes, cache, options) {
    options = options || {};
    var maxPlanes = options.maxPlanes != null ? options.maxPlanes : 20;
    var now = options.now != null ? options.now : Date.now();
    var retryAt = options.retryAt || {};
    var picked = [];
    for (var i = 0; i < planes.length && picked.length < maxPlanes; i++) {
      var a = planes[i];
      if (!a.callsign || a.private) continue;
      if (retryAt[a.callsign] && retryAt[a.callsign] > now) continue;
      if (!routeCacheEntryStale(cache[a.callsign], now)) continue;
      picked.push(a);
    }
    return picked;
  }

  // Axis-aligned view box in degrees. `pad` grows every side by that fraction of the span. Longitudes may run
  // past ±180 when the view crosses the antimeridian, so a point is also tested one world over.
  function viewBounds(north, south, east, west) {
    return {
      north: north, south: south, east: east, west: west,
      northEast: { lat: north, lng: east },
      northWest: { lat: north, lng: west },
      southEast: { lat: south, lng: east },
      southWest: { lat: south, lng: west },
      pad: function(ratio) {
        var dLat = (north - south) * ratio;
        var dLng = (east - west) * ratio;
        return viewBounds(north + dLat, south - dLat, east + dLng, west - dLng);
      },
      contains: function(lat, lng) {
        if (lat < south || lat > north) return false;
        return (lng >= west && lng <= east) || (lng + 360 >= west && lng + 360 <= east) ||
          (lng - 360 >= west && lng - 360 <= east);
      }
    };
  }

  // Finite stand-in for "no edge yet": Infinity would turn the parabola intersections below into NaN.
  var SDF_FAR = 1e20;

  // Squared Euclidean distance transform along one row or column (Felzenszwalb & Huttenlocher), in place.
  function edt1d(grid, offset, stride, length, f, v, z) {
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    f[0] = grid[offset];
    for (var q = 1, k = 0, s = 0; q < length; q++) {
      f[q] = grid[offset + q * stride];
      var q2 = q * q;
      do {
        var r = v[k];
        s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    for (var q3 = 0, k2 = 0; q3 < length; q3++) {
      while (z[k2 + 1] < q3) k2++;
      var r2 = v[k2];
      var qr = q3 - r2;
      grid[offset + q3 * stride] = f[r2] + qr * qr;
    }
  }

  function edt2d(grid, width, height) {
    var n = Math.max(width, height);
    var f = new Float64Array(n), v = new Uint16Array(n), z = new Float64Array(n + 1);
    for (var x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z);
    for (var y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z);
  }

  // Signed distance field from an alpha mask (0-255, row-major), in the encoding MapLibre reads for
  // `sdf: true` images: the shape edge sits at 255 * (1 - cutoff) and each pixel of distance moves the value
  // by 255 / radius, up inside the shape and down outside it.
  function alphaToSdf(alpha, width, height, radius, cutoff) {
    var size = width * height;
    var outer = new Float64Array(size), inner = new Float64Array(size);
    for (var i = 0; i < size; i++) {
      var a = alpha[i] / 255;
      if (a >= 1) { outer[i] = 0; inner[i] = SDF_FAR; }
      else if (a <= 0) { outer[i] = SDF_FAR; inner[i] = 0; }
      else {
        var d = 0.5 - a;
        outer[i] = d > 0 ? d * d : 0;
        inner[i] = d < 0 ? d * d : 0;
      }
    }
    edt2d(outer, width, height);
    edt2d(inner, width, height);
    var out = new Uint8ClampedArray(size);
    for (var j = 0; j < size; j++) {
      var dist = Math.sqrt(outer[j]) - Math.sqrt(inner[j]);
      out[j] = Math.round(255 - 255 * (dist / radius + cutoff));
    }
    return out;
  }

  function dimColor(hslStr) {
    var m = hslStr.match(/[\d.]+/g);
    if (!m || m.length < 3) return hslStr;
    var h = +m[0], s = +m[1], l = +m[2];
    return "hsl(" + h + "," + Math.round(s * 0.4) + "%," + Math.round(l * 0.7 + 20) + "%)";
  }

  // --- Airport board ---
  // Computation shared by the PWA, watch and Worker. All clocks, caches, histories and
  // mutable board state belong to the caller. env.core defaults to this module's API;
  // callback hooks preserve the classic scripts' late-bound overrides.
  // Each public operation uses env.now; it never reads the host realm's clock.
  // Board env: state, aircraft (fallback), airportData, runwayData, posHistory,
  // extraState, routeCache, routeEvidenceMemo, scheduleDataCache, scheduleCacheTtl.
  // Optional policy: departurePerimeterKm (6), airportPopupFetchKm (120), isPrivate,
  // airportDisplayName (IATA by default); proximityMetrics/viewportDistanceKm are
  // required only for snapshots with proximity enabled. Classic adapters may supply
  // validateCachedRoute, routeForAircraft, formatClientRouteLabel,
  // selectClientScheduleMatch and applyScheduleMatch callbacks.
  var DEFAULT_DEPARTURE_PERIMETER_KM = 6;
  var DEFAULT_AIRPORT_POPUP_FETCH_KM = 120;
  var ACTIVE_RUNWAY_MEMORY_MS = 15 * 60 * 1000;

  function createAirportBoardState() {
    return { goArounds: {}, runwayMemory: {}, nearbyRunwayEnds: {}, elevIndex: null };
  }

  function airportElevationIn(env, iata) {
    var airportData = env.airportData;
    if (!env.state.elevIndex && airportData) {
      env.state.elevIndex = {};
      for (var i = 0; i < airportData.length; i++) {
        if (airportData[i][6] != null) env.state.elevIndex[airportData[i][0]] = airportData[i][6];
      }
    }
    return (env.state.elevIndex && env.state.elevIndex[iata]) || 0;
  }

  function feedArrivalEtaIn(env, callsign, airportIata) {
    var scheduleDataCache = env.scheduleDataCache;
    var SCHEDULE_CACHE_TTL = env.scheduleCacheTtl;
    var cached = scheduleDataCache[airportIata];
    if (!callsign || !cached || !cached.data || env.now - cached.ts > 3 * SCHEDULE_CACHE_TTL) return null;
    var variants = callsignVariants(callsign).map(function(v) { return v.toUpperCase(); });
    var arrs = cached.data.arrivals || [];
    for (var i = 0; i < arrs.length; i++) {
      var row = arrs[i];
      if (!row.live || !row.est_arr) continue;
      var cs = (row.callsign || "").toUpperCase();
      var fn = (row.flight || "").replace(/\s/g, "").toUpperCase();
      if (variants.indexOf(cs) !== -1 || variants.indexOf(fn) !== -1) return (row.est_arr * 1000 - env.now) / 60000;
    }
    return null;
  }

  function buildAirportArrival(env, a, routeEntry, airportIata, distKm, options) {
    options = options || {};
    var destinationMatch = !!(routeEntry && routeEntry.destination && routeEntry.destination.iata === airportIata);
    var originMatch = !!(routeEntry && routeEntry.origin && routeEntry.origin.iata === airportIata);
    var scored = scoreArrivalCandidate({
      feedEtaMin: destinationMatch ? feedArrivalEtaIn(env, a.callsign, airportIata) : null,
      pathKm: options.pathKm,
      fieldElevFt: airportElevationIn(env, airportIata),
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
      pathKm: options.approach ? options.approach.pathKm : null,
      runway: options.approach && options.approach.runway ? options.approach.runway.designator : null,
      runwayAssumed: !!(options.approach && options.approach.assumed),
      reportTs: a.reportTs,
      touchdownAtMs: (Number.isFinite(a.reportTs) ? a.reportTs : env.now) + scored.etaMin * 60000,
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
    // An hour or more reads as hours: "~120min" was long enough to wrap rows onto a third line.
    if (etaMin >= 60) {
      var hours = Math.round(etaMin / 30) / 2;
      return "~" + (hours % 1 ? hours.toFixed(1) : String(hours)) + "h";
    }
    return "~" + Math.round(etaMin) + "min";
  }

  function mergeActiveRunways(primary, fallback) {
    if (!primary) return fallback || null;
    fallback = fallback || {};
    var dep = primary.departing_runways && primary.departing_runways.length ? primary.departing_runways : (fallback.departing_runways || []);
    var arr = primary.arriving_runways && primary.arriving_runways.length ? primary.arriving_runways : (fallback.arriving_runways || []);
    if (!dep.length && !arr.length) return null;
    return { departing_runways: dep, arriving_runways: arr };
  }

  function rememberRunwaysIn(env, iata, derived) {
    var core = env.core || api;
    var next = core.updateActiveRunwayMemory(env.state.runwayMemory[iata], derived, env.now, ACTIVE_RUNWAY_MEMORY_MS);
    env.state.runwayMemory[iata] = next.seen;
    return next.active;
  }

  function recentSpeedChangeIn(env, hex, spanMs) {
    var extraState = env.extraState;
    var samples = extraState[hex] && extraState[hex].samples;
    if (!samples || samples.length < 2) return null;
    var last = samples[samples.length - 1];
    for (var i = 0; i < samples.length - 1; i++) {
      if (last.ts - samples[i].ts <= spanMs) return (last.spdMs - samples[i].spdMs) / 0.514444;
    }
    return null;
  }

  function nearbyRunwayEndsIn(env, iata, lat, lng) {
    var airportData = env.airportData;
    var runwayData = env.runwayData;
    if (env.state.nearbyRunwayEnds[iata]) return env.state.nearbyRunwayEnds[iata];
    if (!runwayData || !airportData) return [];
    var ends = [];
    for (var i = 0; i < airportData.length; i++) {
      var row = airportData[i];
      if (row[0] === iata || !runwayData[row[0]]) continue;
      if (haversineKm(lat, lng, row[1], row[2]) > 50) continue;
      ends = ends.concat(runwayApproachEnds(runwayData[row[0]]));
    }
    return (env.state.nearbyRunwayEnds[iata] = ends);
  }

  function observeAirportGoArounds(env, iata, lat, lng, list, ends, nowMs, fieldElev) {
    var core = env.core || api;
    var posHistory = env.posHistory;
    var validateCachedRoute = env.validateCachedRoute || function(a) { return validateRouteIn(env, a); };
    // Merge the map's posHistory with board reports: the board also sees planes outside the viewport.
    // These short private histories never seed or modify the map's animated trails.
    var tracked = env.state.goArounds[iata] || (env.state.goArounds[iata] = {});
    for (var i = 0; i < list.length; i++) {
      var a = list[i], old = tracked[a.icao24];
      var distanceKm = haversineKm(a.lat, a.lng, lat, lng);
      var nearField = distanceKm <= 15;
      // Only low nearby traffic can arm; retain active approaches and recent ground evidence.
      if (!old && (!nearField || (!a.ground && (!Number.isFinite(a.altFt) || a.altFt - fieldElev > 3000)))) continue;
      // Light aircraft are left out: their touch-and-goes often carry no ground bit and look exactly like a go-around.
      // Only when positively known (sizeClass defaults unknown types to "light").
      if (!old && ((a.aircraftType && sizeClass(a.aircraftType, a.category || null) === "light") ||
          /^A[12]$/.test(a.category || ""))) continue;
      old = old || { points: [] };
      var history = posHistory[a.icao24] || [];
      if (a.ground && distanceKm <= 6 && Number.isFinite(a.reportTs) && a.reportTs <= nowMs) old.groundAtMs = a.reportTs;
      for (var h = history.length - 1; h >= 0; h--) {
        var p = history[h];
        if (p[4] && !p[6] && p[2] <= nowMs && nowMs - p[2] <= 10 * 60000 &&
            haversineKm(p[0], p[1], lat, lng) <= 6) { old.groundAtMs = Math.max(old.groundAtMs || 0, p[2]); break; }
      }
      var route = validateCachedRoute(a);
      var departing = !!(route && route.origin && route.origin.iata === iata) ||
        (old.groundAtMs != null && nowMs >= old.groundAtMs && nowMs - old.groundAtMs <= 10 * 60000);
      var points = old.points.concat(history);
      if (Number.isFinite(a.reportTs)) points.push([a.lat, a.lng, a.reportTs, a.altFt, a.ground, false, false]);
      points = points.filter(function(p) { return !p[6] && p[2] >= nowMs - 180000 && p[2] <= nowMs; })
        .sort(function(a, b) { return a[2] - b[2]; }).filter(function(p, j, all) { return !j || p[2] !== all[j - 1][2]; });
      old.points = points;
      old.state = core.updateGoAround(old.state, points, nowMs, { runways: ends, fieldElevFt: fieldElev, departing: departing });
      old.aircraft = a; old.seenAtMs = nowMs;
      tracked[a.icao24] = old;
    }
    Object.keys(env.state.goArounds).forEach(function(airport) {
      var tracks = env.state.goArounds[airport];
      Object.keys(tracks).forEach(function(hex) {
        var track = tracks[hex];
        if (nowMs - track.seenAtMs >= 25 * 60000) delete tracks[hex];
        else if (airport === iata) {
          if (nowMs - track.seenAtMs > 120000) track.state = null;
          else track.state = core.updateGoAround(track.state, [], nowMs);
        }
      });
    });
    return tracked;
  }

  function buildAirportBoard(env, airportIata, airportLat, airportLng, sourceAircraft, activeRunwaysOverride) {
    var core = env.core || api;
    var runwayData = env.runwayData;
    var posHistory = env.posHistory;
    var aircraft = env.aircraft;
    var DEPARTURE_PERIMETER_KM = env.departurePerimeterKm == null ? DEFAULT_DEPARTURE_PERIMETER_KM : env.departurePerimeterKm;
    var AIRPORT_POPUP_FETCH_KM = env.airportPopupFetchKm == null ? DEFAULT_AIRPORT_POPUP_FETCH_KM : env.airportPopupFetchKm;
    var validateCachedRoute = env.validateCachedRoute || function(a) { return validateRouteIn(env, a); };
    var list = Array.isArray(sourceAircraft) ? sourceAircraft : aircraft;
    var arrivals = [];
    var departures = [];
    var justLanded = [];
    var nowMs = env.now;
    var airportRwys = runwayData && runwayData[airportIata];
    var fieldElev = airportElevationIn(env, airportIata);
    var homeEnds = runwayApproachEnds(airportRwys, { designators: true });
    var goAroundTracks = observeAirportGoArounds(env, airportIata, airportLat, airportLng, list, homeEnds, nowMs, fieldElev);
    var goAroundRows = [];
    Object.keys(goAroundTracks).forEach(function(hex) {
      var observation = goAroundTracks[hex], state = observation.state, a = observation.aircraft;
      if (!state || state.goAroundAtMs == null || !a.callsign) return;
      var rc = validateCachedRoute(a);
      goAroundRows.push({ hex: hex, callsign: a.callsign, aircraftType: a.aircraftType, lat: a.lat, lng: a.lng,
        originIata: rc && rc.origin ? rc.origin.iata : null, altFt: a.altFt, runway: state.runway,
        goAround: true, reportTs: a.reportTs, etaMin: Math.max(1, (state.backAtMs - nowMs) / 60000) });
    });
    list = list.filter(function(a) {
      var observation = goAroundTracks[a.icao24];
      return !observation || !observation.state || observation.state.goAroundAtMs == null;
    });
    function heightFt(a) { return a.altFt == null ? null : a.altFt - fieldElev; }
    var derivedRunways = rememberRunwaysIn(env, airportIata,
      deriveActiveRunways(airportRwys, airportIata, list.filter(function(a) {
        // A final that has only just started climbing is still awaiting confirmation, not a takeoff.
        var observation = goAroundTracks[a.icao24];
        return !(observation && observation.state && observation.state.armedAtMs != null && a.vRate > 0);
      }), { maxAltFt: 1500 + fieldElev }));
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
              designator: th.designator,
              distFromThresholdKm: por.distFromThresholdKm,
              // Bearing the aircraft would track during a takeoff roll on this end.
              bearing: bearingDegrees(th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon)
            };
          }
        }
      }
      var any = core.matchArrivalRunway(a, homeEnds);
      return { on: false, designator: any && any.onRunway ? any.runway.designator : null, distFromThresholdKm: null, bearing: null };
    }
    function matchArrRunway(a) {
      if (activeArrThresholds.length > 0) {
        for (var t = 0; t < activeArrThresholds.length; t++) {
          var th = activeArrThresholds[t];
          var por = pointOnRunway(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon);
          if (por.onRunway) return { on: true, designator: th.designator, distFromThresholdKm: por.distFromThresholdKm };
        }
      }
      return { on: false, distFromThresholdKm: null };
    }
    var neighbourEnds = nearbyRunwayEndsIn(env, airportIata, airportLat, airportLng);
    function landingElsewhere(a) {
      if (!neighbourEnds.length || a.track == null) return false;
      var there = approachPathKm(a.lat, a.lng, a.track, neighbourEnds);
      if (!there || !there.onFinal) return false;
      var here = approachPathKm(a.lat, a.lng, a.track, homeEnds);
      return !(here && here.onFinal && here.pathKm <= there.pathKm);
    }
    function arrivalOptions(a, proximity) {
      var best = core.matchArrivalRunway(a, activeArrThresholds.length ? activeArrThresholds : homeEnds);
      if (!best) {
        best = approachPathKm(a.lat, a.lng, a.track, activeArrThresholds);
        if (best) best.assumed = true;
      }
      return { approach: best, pathKm: best ? best.pathKm : null, proximity: !!proximity };
    }
    // Flying the downwind leg for an active landing runway: tracking opposite the landing direction, offset
    // 1.5-12 km to the side and within 20 km of the threshold along the runway line. Such planes head away
    // from the airport but are among the next to land.
    function onDownwind(a) {
      if (a.track == null) return false;
      for (var t = 0; t < activeArrThresholds.length; t++) {
        var th = activeArrThresholds[t];
        var hdg = bearingDegrees(th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon);
        if (angleDiffDeg(a.track, (hdg + 180) % 360) > 30) continue;
        var xt = Math.abs(crossTrackKm(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon));
        if (xt < 1.5 || xt > 12) continue;
        var along = alongTrackKm(a.lat, a.lng, th.thresholdLat, th.thresholdLon, th.farEndLat, th.farEndLon, xt);
        if (Math.abs(along) <= 20) return true;
      }
      return false;
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
      if (!targets.length) return { toward: null, km: null };
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
      var rc = validateCachedRoute(a);
      var destinationHere = !!(rc && rc.destination && rc.destination.iata === airportIata);
      var originHere = !!(rc && rc.origin && rc.origin.iata === airportIata);
      var distKm = haversineKm(a.lat, a.lng, airportLat, airportLng);

      if (!a.ground) {
        if (destinationHere) {
          if (distKm > AIRPORT_POPUP_FETCH_KM) continue;
          var inboundEntry = buildAirportArrival(env, a, rc, airportIata, distKm, arrivalOptions(a));
          if (inboundEntry) arrivals.push(inboundEntry);
          continue;
        }
        // Airborne-departure detection — not bound to RIU availability so non-US airports
        // and RIU-unavailable cases still show planes climbing out after liftoff.
        var vRateFpm = a.vRate != null ? a.vRate * 60 : 0;
        var climbing = vRateFpm > 100;
        var aglFt = heightFt(a);
        var lowAlt = aglFt != null && aglFt < 6000;
        var depRwy = matchDepRunway(a);
        var bearingFromAirport = bearingDegrees(airportLat, airportLng, a.lat, a.lng);
        var outboundTrack = a.track != null && angleDiffDeg(a.track, bearingFromAirport) < 75;
        var shouldShow = false;
        var depRunwayKm = null;
        var depStatus = "Departing";
        // A plane that came down an approach in the last few minutes is landing, even in the flare, where its
        // descent rate drops to near zero (11-18: UA3911 read "Departing" at SFO as it touched down on 28L).
        var approaching = descendedRecently(posHistory[a.icao24], nowMs);
        if (depRwy.on && distKm <= 5 && (aglFt == null || aglFt < 2000) && !approaching) {
          // Over the active departure runway at low altitude — takeoff roll / rotation.
          // Gate on climbing or very low altitude to filter out level transit overflights. A descending plane
          // under 500 ft is landing on a runway shared with departures, not taking off.
          if (climbing || (aglFt != null && aglFt < 500 && vRateFpm > -200)) {
            shouldShow = true;
            depRunwayKm = depRwy.distFromThresholdKm;
            depStatus = aglFt != null && aglFt > 500 ? "Climbing" : "Departing";
          }
        } else if (originHere && distKm <= DEPARTURE_PERIMETER_KM && lowAlt && climbing) {
          shouldShow = true;
          depRunwayKm = nearestDepThresholdKm(a);
          depStatus = "Climbing";
        } else if (distKm <= DEPARTURE_PERIMETER_KM && lowAlt && climbing && outboundTrack) {
          // No route info yet but geometry is strong: close, low, climbing, heading outbound.
          shouldShow = true;
          depRunwayKm = nearestDepThresholdKm(a);
          depStatus = aglFt != null && aglFt > 500 ? "Climbing" : "Departing";
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
            runway: depRwy.designator || null,
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
        var speedChange = anyRwy.on && spdKts >= 30 ? recentSpeedChangeIn(env, a.icao24, 30000) : null;
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
          runway: depRwyGround.designator || null,
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
      var rc = validateCachedRoute(a);
      if (rc && rc.origin && rc.origin.iata === airportIata) continue;
      if (rc && rc.destination && rc.destination.iata !== airportIata && rc.confidence === "high") continue;
      var vRateFpm = a.vRate != null ? a.vRate * 60 : 0;
      if (a.altFt == null || heightFt(a) > 10000 || vRateFpm > -200) continue;
      var toBearing = bearingDegrees(a.lat, a.lng, airportLat, airportLng);
      if (a.track != null && angleDiffDeg(a.track, toBearing) > 60 && !onDownwind(a)) continue;
      if (landingElsewhere(a)) continue;
      var fbDistKm = haversineKm(a.lat, a.lng, airportLat, airportLng);
      if (fbDistKm > 40) continue;
      var fallbackEntry = buildAirportArrival(env, a, rc, airportIata, fbDistKm, arrivalOptions(a, true));
      if (fallbackEntry) arrivals.push(fallbackEntry);
    }
    var landed = [];
    var landedHexes = {};
    if (activeArrThresholds.length > 0) {
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a.callsign) continue;
        var rc = validateCachedRoute(a);
        if (!rc || !rc.destination || rc.destination.iata !== airportIata) continue;
        var landedDist = haversineKm(a.lat, a.lng, airportLat, airportLng);
        if (!a.ground) {
          if (landedDist > 5 || a.altFt == null || heightFt(a) >= 500) continue;
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
          runway: arrMatch.designator || null,
          _rolloutDist: arrMatch.distFromThresholdKm
        });
        landedHexes[a.icao24] = true;
      }
    } else {
      var rwys = runwayData && runwayData[airportIata];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a.callsign || !a.ground) continue;
        var rc = validateCachedRoute(a);
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
      var rc = validateCachedRoute(a);
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
    arrivals = core.sequenceAirportArrivals(sortAirportInboundRows(arrivals.concat(goAroundRows), { totalLimit: 15 + goAroundRows.length }));
    departures = sortAirportDepartureRows(departures, { activeRunways: activeDepThresholds.length > 0 });
    return {
      arrivals: arrivals,
      landed: landedRows,
      departures: departures,
      activeArrivalRunways: activeRunways ? activeRunways.arriving_runways : [],
      activeDepartureRunways: activeDepThresholds.length > 0
    };
  }

  function applyAirportScheduleIn(env, iata, scheduleData, planes) {
    var validateCachedRoute = env.validateCachedRoute || function(a) { return validateRouteIn(env, a); };
    var selectClientScheduleMatch = env.selectClientScheduleMatch || function(variants, sources, a) { return selectAirportScheduleMatch(env, variants, sources, a); };
    var applyScheduleMatch = env.applyScheduleMatch || function(a, match) { return applyScheduleMatchIn(env, a, match); };
    if (!scheduleData || !planes || !planes.length) return 0;
    var sources = [{ iata: iata, data: scheduleData }];
    var updated = 0;
    for (var i = 0; i < planes.length; i++) {
      var a = planes[i];
      if (!a || !a.callsign || a.private) continue;
      var rc = validateCachedRoute(a);
      if (rc && rc.destSource === "schedule") continue;
      var variants = callsignVariants(a.callsign);
      if (!variants.length) continue;
      var match = selectClientScheduleMatch(variants, sources, a);
      if (match && applyScheduleMatch(a, match)) updated++;
    }
    return updated;
  }

  function buildTrafficSnapshot(env, ac, options) {
    var isPrivate = env.isPrivate || isPrivateAircraft;
    var proximityMetrics = env.proximityMetrics;
    var viewportDistanceKm = env.viewportDistanceKm;
    options = options || {};
    var now = options.now != null ? options.now : env.now;
    var positionNow = options.positionNow != null ? options.positionNow : now;
    var includeProximity = options.includeProximity !== false;
    var snapshot = [];
    var activeIds = {};
    for (var i = 0; i < ac.length; i++) {
      var s = ac[i];
      // One malformed row (null, non-numeric position) is skipped rather than failing the whole poll.
      if (!isUsableTrafficRow(s)) continue;
      var hex = normalizeAircraftHex(s.hex);
      var isGround = s.alt_baro === "ground";
      var typeCode = typeof s.t === "string" ? s.t : null;
      if (!hex) continue;
      if (!isGround && s.alt_baro == null) continue;
      if (s.lat == null || s.lon == null) continue;
      if (s.category && /^C/.test(s.category)) continue;
      if (sizeClass(typeCode, s.category || null) === "heli") continue;
      if (s.seen != null && s.seen > 15) continue;
      var heading = s.track != null ? s.track : (s.true_heading != null ? s.true_heading : s.mag_heading);
      if (isGround && heading == null) continue;
      if (activeIds[hex]) continue;

      var callsign = (typeof s.flight === "string" ? s.flight.trim() : "") || null;
      var priv = isPrivate(callsign, typeCode, s.category || null);
      var squawk = s.squawk || null;
      var emerg = typeof s.emergency === "string" && s.emergency && s.emergency !== "none" ? s.emergency : null;
      var baseBearing = s.dir != null ? s.dir : (heading != null ? heading : 0);
      var metrics = includeProximity ? proximityMetrics(s.lat, s.lon, baseBearing) : null;
      var viewDistKm = includeProximity ? viewportDistanceKm(s.lat, s.lon) : null;
      var altFt = isGround ? null : (typeof s.alt_baro === "number" ? Math.round(s.alt_baro) : null);
      var slantDistanceKm = includeProximity && metrics && metrics.distKm != null ? slantKm(metrics.distKm, altFt) : null;
      var reportTs = positionNow - Math.max(0, (s.seen_pos || 0) * 1000);
      activeIds[hex] = true;

      snapshot.push({
        icao24: hex,
        callsign: callsign,
        aircraftType: typeCode,
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

  function checkRouteEvidence(env, a, entry) {
    var core = env.core || api;
    var airportData = env.airportData;
    var posHistory = env.posHistory;
    var routeEvidenceMemo = env.routeEvidenceMemo;
    var formatClientRouteLabel = env.formatClientRouteLabel || function(origin, destination, phase) { return formatAirportRouteLabel(env, origin, destination, phase); };
    if (!a || !entry) return entry;
    var history = typeof posHistory !== "undefined" && posHistory[a.icao24];
    var now = env.now;
    var airports = typeof airportData !== "undefined" ? airportData : null;
    var key = [a.icao24, Math.floor(a.lat * 100), Math.floor(a.lng * 100), a.altFt, a.vRate, a.track, a.ground,
      entry.origin && entry.origin.iata, entry.destination && entry.destination.iata,
      entry.destination && entry.destination.region, entry.originSource, entry.destSource,
      history && history.length, history && history.length && history[history.length - 1][2]].join("|");
    var memo = a.callsign && routeEvidenceMemo.get(a.callsign);
    if (memo && memo.entry === entry && memo.key === key && memo.airports === airports &&
        memo.history === history && now - memo.at < 5000) return memo.checked;
    var previous = null;
    for (var i = history ? history.length - 1 : -1; i >= 0; i--) {
      if (history[i][5] || env.now - history[i][2] > 120000) break;
      if (!history[i][6] && haversineKm(a.lat, a.lng, history[i][0], history[i][1]) > 0.1) {
        previous = { lat: history[i][0], lng: history[i][1] }; break;
      }
    }
    var checked = core.rejectContradictoryRoute(entry, { lat: a.lat, lng: a.lng, altFt: a.altFt,
      ground: a.ground, track: a.track, vRate: a.vRate == null ? null : a.vRate * 60, previous: previous },
      airports);
    if (checked && checked !== entry) {
      checked.display = formatClientRouteLabel(checked.origin, checked.destination, checked.phase || "cruising");
      checked.iata = [checked.origin && checked.origin.iata, checked.destination && checked.destination.iata].filter(Boolean).join(" to ");
    }
    if (a.callsign) {
      if (routeEvidenceMemo.size >= 1000) routeEvidenceMemo.delete(routeEvidenceMemo.keys().next().value);
      routeEvidenceMemo.set(a.callsign, { entry: entry, key: key, airports: airports, history: history, at: now, checked: checked });
    }
    return checked;
  }

  function validateRouteIn(env, a) {
    var routeCache = env.routeCache;
    var routeForAircraft = env.routeForAircraft || function(a, entry) { return checkRouteEvidence(env, a, entry); };
    var entry = a && a.callsign && routeCache[a.callsign];
    var checked = routeForAircraft(a, entry);
    if (checked !== entry) {
      if (checked) routeCache[a.callsign] = checked;
      else delete routeCache[a.callsign];
    }
    return checked;
  }

  function formatAirportRouteLabel(env, origin, destination, phase) {
    var airportDisplayName = env.airportDisplayName || function(iata) { return iata; };
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

  function selectAirportScheduleMatch(env, variants, sources, a) {
    var core = env.core || api;
    var airportData = env.airportData;
    var located = sources.map(function(source) {
      var lat = null, lng = null;
      for (var i = 0; airportData && i < airportData.length; i++) {
        if (airportData[i][0] === source.iata) { lat = airportData[i][1]; lng = airportData[i][2]; break; }
      }
      return { iata: source.iata, data: source.data, lat: lat, lng: lng };
    });
    return core.selectScheduleMatch(variants, located, a, env.now);
  }

  function applyScheduleMatchIn(env, a, match) {
    var routeCache = env.routeCache;
    var validateCachedRoute = env.validateCachedRoute || function(a) { return validateRouteIn(env, a); };
    var formatClientRouteLabel = env.formatClientRouteLabel || function(origin, destination, phase) { return formatAirportRouteLabel(env, origin, destination, phase); };
    if (!a || !match) return false;
    var currentRc = validateCachedRoute(a);
    var origin = null, destination = null, originSource = null, destSource = null;

    // The selector has already checked direction; an arrival row cannot be reversed into an onward leg.
    if (match.dir === "arrival") {
      destination = { iata: match.airport, name: match.airportName };
      destSource = "schedule";
      if (match.from) {
        origin = { iata: match.from, name: match.row.from_name || match.from };
        originSource = "schedule";
      } else if (currentRc && currentRc.origin) {
        origin = currentRc.origin;
        originSource = currentRc.originSource;
      }
    } else {
      origin = { iata: match.airport, name: match.airportName };
      originSource = "schedule";
      if (match.to) {
        destination = { iata: match.to, name: match.row.to_name || match.to };
        destSource = "schedule";
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
      confidence: "high",
      phase: phase,
      airline_iata: match.row.airline_iata || "",
      airline_icao: match.row.airline_icao || "",
      fetchedAt: env.now
    };
    return true;
  }

  var api = {
    createAirportBoardState: createAirportBoardState,
    airportElevationIn: airportElevationIn,
    feedArrivalEtaIn: feedArrivalEtaIn,
    buildAirportArrival: buildAirportArrival,
    formatLandingEta: formatLandingEta,
    mergeActiveRunways: mergeActiveRunways,
    rememberRunwaysIn: rememberRunwaysIn,
    recentSpeedChangeIn: recentSpeedChangeIn,
    nearbyRunwayEndsIn: nearbyRunwayEndsIn,
    observeAirportGoArounds: observeAirportGoArounds,
    buildAirportBoard: buildAirportBoard,
    applyAirportScheduleIn: applyAirportScheduleIn,
    buildTrafficSnapshot: buildTrafficSnapshot,
    checkRouteEvidence: checkRouteEvidence,
    validateRouteIn: validateRouteIn,
    formatAirportRouteLabel: formatAirportRouteLabel,
    selectAirportScheduleMatch: selectAirportScheduleMatch,
    applyScheduleMatchIn: applyScheduleMatchIn,
    AIRLINES: AIRLINES,
    AIRLINE_IATA_ALIASES: AIRLINE_IATA_ALIASES,
    AIRLINE_ICAO_TO_IATA: AIRLINE_ICAO_TO_IATA_ALIASES,
    SQUAWK_ALERTS: SQUAWK_ALERTS,
    airlineName: airlineName,
    angleDiffDeg: angleDiffDeg,
    bearingDegrees: bearingDegrees,
    computePlaybackDelayMs: computePlaybackDelayMs,
    compareAirportArrivalEntries: compareAirportArrivalEntries,
    compareAirportDepartureEntries: compareAirportDepartureEntries,
    classifyGroundDepartureStatus: classifyGroundDepartureStatus,
    landedRecently: landedRecently,
    descendedRecently: descendedRecently,
    arrivalPathTimeMin: arrivalPathTimeMin,
    approachPathKm: approachPathKm,
    matchArrivalRunway: matchArrivalRunway,
    updateGoAround: updateGoAround,
    sequenceAirportArrivals: sequenceAirportArrivals,
    formatArrivalCountdown: formatArrivalCountdown,
    updateArrivalCountdown: updateArrivalCountdown,
    layoutApproachLadder: layoutApproachLadder,
    arrivalEtaHorizon: arrivalEtaHorizon,
    pruneArrivalLog: pruneArrivalLog,
    recordArrivalPrediction: recordArrivalPrediction,
    arrivalEtaScorecard: arrivalEtaScorecard,
    runwayApproachEnds: runwayApproachEnds,
    crossTrackKm: crossTrackKm,
    alongTrackKm: alongTrackKm,
    blendArrivalEta: blendArrivalEta,
    closingKm: closingKm,
    describeAirportDepartureStatus: describeAirportDepartureStatus,
    buildCoverageCircles: buildCoverageCircles,
    buildAirportGrid: buildAirportGrid,
    airportGridCandidates: airportGridCandidates,
    buildViewPolicy: buildViewPolicy,
    buildViewportFetchSpec: buildViewportFetchSpec,
    cardinalDir: cardinalDir,
    countGroundByAirport: countGroundByAirport,
    elevationDeg: elevationDeg,
    escapeHtml: escapeHtml,
    findFlightStartIndex: findFlightStartIndex,
    tracePointOnGround: tracePointOnGround,
    formatDistanceMiles: formatDistanceMiles,
    formatSpeedMph: formatSpeedMph,
    deriveActiveRunways: deriveActiveRunways,
    updateActiveRunwayMemory: updateActiveRunwayMemory,
    greatCirclePoints: greatCirclePoints,
    haversineKm: haversineKm,
    interpolatePlaybackPose: interpolatePlaybackPose,
    interpolateTimedPose: interpolateTimedPose,
    getAirportNextRow: getAirportNextRow,
    isLikelyPrivateCallsign: isLikelyPrivateCallsign,
    isAirlineCallsign: isAirlineCallsign,
    isPrivateAircraft: isPrivateAircraft,
    kmToMiles: kmToMiles,
    knotsToMph: knotsToMph,
    matchRunwayDesignator: matchRunwayDesignator,
    callsignVariants: callsignVariants,
    selectScheduleMatch: selectScheduleMatch,
    normalizeAircraftHex: normalizeAircraftHex,
    normalizeFlightQuery: normalizeFlightQuery,
    normalizeSearchText: normalizeSearchText,
    parseCoordinate: parseCoordinate,
    parseDatisActiveRunways: parseDatisActiveRunways,
    pointOnRunway: pointOnRunway,
    projectLatLng: projectLatLng,
    roundTenths: roundTenths,
    scoreArrivalCandidate: scoreArrivalCandidate,
    sortAirportInboundRows: sortAirportInboundRows,
    sortAirportLandedRows: sortAirportLandedRows,
    sortAirportDepartureRows: sortAirportDepartureRows,
    slantKm: slantKm,
    sizeFromCategory: sizeFromCategory,
    sizeClass: sizeClass,
    isLikelyPrivateClass: isLikelyPrivateClass,
    dimColor: dimColor,
    declutterLabels: declutterLabels,
    updateClockOffset: updateClockOffset,
    viewBounds: viewBounds,
    alphaToSdf: alphaToSdf,
    isIcaoHex: isIcaoHex,
    unwrapLngNear: unwrapLngNear,
    trafficRetryDelayMs: trafficRetryDelayMs,
    trafficOutage: trafficOutage,
    isReportedRouteSource: isReportedRouteSource,
    routeProvenance: routeProvenance,
    rejectContradictoryRoute: rejectContradictoryRoute,
    isAuthoritativeDestSource: isAuthoritativeDestSource,
    routeCacheEntryStale: routeCacheEntryStale,
    selectRouteFetchPlanes: selectRouteFetchPlanes,
    routeEntryReplaceable: routeEntryReplaceable,
    isUsableTrafficRow: isUsableTrafficRow
  };
  return api;
});
