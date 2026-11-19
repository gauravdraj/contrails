// Pure helper copies from contrails-core.js; parity is tested.
import { haversineKm, bearingDeg as bearingDegrees } from "./geo.js";

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

export { buildAirportGrid, airportGridCandidates, isReportedRouteSource, routeProvenance, rejectContradictoryRoute };
