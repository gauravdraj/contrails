(function(root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ContrailsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  var CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  function roundTenths(value) {
    return Math.round(value * 10) / 10;
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

  function parseCoordinate(value, min, max) {
    var parsed = parseFloat(value);
    if (!isFinite(parsed)) return null;
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
      lng: prev.lng + (next.lng - prev.lng) * progress,
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
    if (extrapolationMs > 0 && isFinite(last.spdMs) && isFinite(last.trackDeg)) {
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
        lng: last.lng + (last.lng - observedPrev.lng) * (extrapolationMs / observedSpan),
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

  return {
    bearingDegrees: bearingDegrees,
    computePlaybackDelayMs: computePlaybackDelayMs,
    buildViewPolicy: buildViewPolicy,
    buildViewportFetchSpec: buildViewportFetchSpec,
    cardinalDir: cardinalDir,
    haversineKm: haversineKm,
    interpolatePlaybackPose: interpolatePlaybackPose,
    interpolateTimedPose: interpolateTimedPose,
    parseCoordinate: parseCoordinate,
    projectLatLng: projectLatLng,
    roundTenths: roundTenths
  };
});
