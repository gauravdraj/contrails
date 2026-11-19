// Pure helper copy from contrails-core.js; parity is tested.
import { haversineKm, bearingDeg as bearingDegrees } from "./geo.js";

  function isReportedRouteSource(source) {
    return ["schedule", "fr24-search", "fr24", "live-feed"].indexOf(source) !== -1;
  }

  function routeProvenance(route) {
    var sources = [];
    if (route && route.origin) sources.push(route.originSource);
    if (route && route.destination) sources.push(route.destSource);
    var reported = sources.length > 0 && sources.every(isReportedRouteSource);
    var database = sources.indexOf("adsbdb") !== -1 || sources.indexOf("cross-validated") !== -1;
    return { label: reported ? "reported" : "inferred",
      note: reported ? (sources.indexOf("live-feed") !== -1 ? "from live feed" : "from FR24 live schedule")
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
    var origin = null, dest = null, nearest = null, nearestKm = 40;
    for (var i = 0; airports && i < airports.length; i++) {
      var ap = airports[i];
      if (route.origin && ap[0] === route.origin.iata) origin = ap;
      if (route.destination && ap[0] === route.destination.iata) dest = ap;
      var km = haversineKm(state.lat, state.lng, ap[1], ap[2]);
      if (km < nearestKm) { nearestKm = km; nearest = ap; }
    }
    var contradiction = false;
    if (nearest) {
      var agl = Number.isFinite(state.altFt) ? state.altFt - (nearest[6] || 0) : null;
      var low = agl != null && agl < 10000;
      var atOrigin = route.origin && route.origin.iata === nearest[0];
      var atDest = route.destination && route.destination.iata === nearest[0];
      // A climb can pass a neighboring airport. Keep a plausible nearby origin until outside its area.
      var nearOrigin = origin && haversineKm(state.lat, state.lng, origin[1], origin[2]) < 40;
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
        contradiction = !!((state.ground && nearestKm < 8) ||
          (low && state.vRate > 300 && closing === false && !nearOrigin) ||
          (low && state.vRate < -300 && closing === true && destFar));
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
      contradiction = offPath > Math.max(300, length * 0.25);
    }
    if (!contradiction) return route;
    if (!keepOrigin && !keepDest) return null;
    return Object.assign({}, route, { origin: keepOrigin ? route.origin : null,
      destination: keepDest ? route.destination : null, originSource: keepOrigin ? route.originSource : null,
      destSource: keepDest ? route.destSource : null, display: "", iata: "", confidence: "low" });
  }

export { isReportedRouteSource, routeProvenance, rejectContradictoryRoute };
