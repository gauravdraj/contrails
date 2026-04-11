(function(root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ContrailsCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
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

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  var AIRLINES = {
    AAL:"American",AAR:"Asiana",ACA:"Air Canada",AFR:"Air France",AIC:"Air India",
    AIJ:"Interjet",AJX:"Air Japan",AMX:"AeroMexico",ANA:"All Nippon",ANZ:"Air New Zealand",
    APJ:"Peach",ASA:"Alaska",AUA:"Austrian",AVA:"Avianca",AXM:"AirAsia",
    AZA:"Alitalia/ITA",BAW:"British Airways",BEL:"Brussels",BER:"Berlinair",
    BLX:"TUIfly Benelux",BWA:"Caribbean",CAL:"China Airlines",CCA:"Air China",
    CEB:"Cebu Pacific",CES:"China Eastern",CHH:"Hainan",CKS:"Kalitta",CLX:"Cargolux",
    CMP:"Copa",CPA:"Cathay Pacific",CPZ:"Compass",CSN:"China Southern",CTN:"Croatia",
    DAL:"Delta",DLH:"Lufthansa",EIN:"Aer Lingus",EJU:"easyJet Europe",
    ELY:"El Al",ETD:"Etihad",ETH:"Ethiopian",EVA:"EVA Air",EWG:"Eurowings",
    EZY:"easyJet",FDX:"FedEx",FIN:"Finnair",FJI:"Fiji Airways",GAL:"GetJet",
    GEC:"Lufthansa Cargo",GIA:"Garuda",GTI:"Atlas Air",GWI:"Germanwings",
    HAL:"Hawaiian",HVN:"Vietnam Airlines",IAW:"Iraqi",IBE:"Iberia",ICE:"Icelandair",
    IGO:"IndiGo",JAL:"Japan Airlines",JBU:"JetBlue",JIA:"PSA Airlines",JST:"Jetstar",
    KAL:"Korean Air",KLM:"KLM",LAN:"LATAM Chile",LAX:"LATAM",LOT:"LOT Polish",
    MAU:"Air Mauritius",MAS:"Malaysia",MEA:"Middle East",MSR:"EgyptAir",
    NAX:"Norwegian",NKS:"Spirit",NPT:"N. Pacific",NWS:"Nordwind",NZM:"Mount Cook",
    OAL:"Olympic",OMA:"Oman Air",PAC:"Polar Air",PAL:"Philippine",PIA:"Pakistan Intl",
    QFA:"Qantas",QTR:"Qatar",RAM:"Royal Air Maroc",RJA:"Royal Jordanian",
    ROT:"TAROM",RPA:"Republic",RYR:"Ryanair",SAS:"SAS",SAA:"South African",
    SCX:"Sun Country",SEJ:"StarFlyer",SIA:"Singapore",SKW:"SkyWest",SLK:"Silk Way",
    SVA:"Saudia",SWA:"Southwest",SWR:"Swiss",TAM:"LATAM Brazil",TAP:"TAP Portugal",
    THA:"Thai",THY:"Turkish",TOM:"TUI UK",TVF:"Transavia France",
    UAE:"Emirates",UAL:"United",UPS:"UPS",UTA:"UTair",VIR:"Virgin Atlantic",
    VJC:"VietJet",VOI:"Volaris",VTI:"Vistara",WJA:"WestJet",WZZ:"Wizz Air",
    XAX:"AirAsia X"
  };

  var AIRLINE_IATA_ALIASES = {
    AA:"AAL", AC:"ACA", AF:"AFR", AI:"AIC", AS:"ASA", AV:"AVA",
    AY:"FIN", AZ:"AZA", B6:"JBU", BA:"BAW", BR:"EVA", CI:"CAL",
    CM:"CMP", CX:"CPA", DL:"DAL", EI:"EIN", EK:"UAE", ET:"ETH",
    EY:"ETD", FI:"ICE", FR:"RYR", GA:"GIA", HA:"HAL", IB:"IBE",
    JL:"JAL", KE:"KAL", KL:"KLM", LA:"LAN", LH:"DLH", LO:"LOT",
    LX:"SWR", MH:"MAS", MS:"MSR", NH:"ANA", NZ:"ANZ", OS:"AUA",
    OZ:"AAR", PR:"PAL", QF:"QFA", QR:"QTR", SK:"SAS", SQ:"SIA",
    SV:"SVA", TG:"THA", TK:"THY", TP:"TAP", UA:"UAL", VS:"VIR",
    WN:"SWA", WS:"WJA"
  };
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

  function normalizeAircraftHex(value) {
    if (value == null) return null;
    var normalized = String(value).trim().replace(/^~/, "").toLowerCase();
    return /^[0-9a-f]{6}$/.test(normalized) ? normalized : null;
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

  var _PRIV_REG = /^(N\d|C-[FGFI]|G-|D-|F-|I-|EC-|HB-|OE-|PH-|SE-|OH-|OY-|LN-|EI-|CS-|SX-|TC-|VH-|ZK-|PP-|PT-|PR-|JA|B-|HL|VT-|9V-|A[267]-|SU-|5[ABHNXY]-|ZS-|VP-|V[5HPQR]-|RP-|HS-|9M-|PK-|XA-|XB-|LV-|CC-|TI-|HP-|HK-|YV-)/i;
  var _PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
  var _PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

  function isLikelyPrivateCallsign(callsign) {
    if (!callsign) return false;
    if (_PRIV_REG.test(callsign) || _PRIV_ANON_HEX.test(callsign)) return true;
    return !airlineName(callsign) && _PRIV_HEXLIKE.test(callsign);
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

  return {
    AIRLINES: AIRLINES,
    AIRLINE_IATA_ALIASES: AIRLINE_IATA_ALIASES,
    SQUAWK_ALERTS: SQUAWK_ALERTS,
    airlineName: airlineName,
    bearingDegrees: bearingDegrees,
    computePlaybackDelayMs: computePlaybackDelayMs,
    buildViewPolicy: buildViewPolicy,
    buildViewportFetchSpec: buildViewportFetchSpec,
    cardinalDir: cardinalDir,
    elevationDeg: elevationDeg,
    escapeHtml: escapeHtml,
    formatDistanceMiles: formatDistanceMiles,
    formatSpeedMph: formatSpeedMph,
    haversineKm: haversineKm,
    interpolatePlaybackPose: interpolatePlaybackPose,
    interpolateTimedPose: interpolateTimedPose,
    isLikelyPrivateCallsign: isLikelyPrivateCallsign,
    kmToMiles: kmToMiles,
    knotsToMph: knotsToMph,
    callsignVariants: callsignVariants,
    normalizeAircraftHex: normalizeAircraftHex,
    normalizeFlightQuery: normalizeFlightQuery,
    normalizeSearchText: normalizeSearchText,
    parseCoordinate: parseCoordinate,
    projectLatLng: projectLatLng,
    roundTenths: roundTenths,
    slantKm: slantKm
  };
});
