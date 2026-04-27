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

  function angleDiffDeg(a, b) {
    var delta = ((b - a) % 360 + 360) % 360;
    return delta > 180 ? 360 - delta : delta;
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

  function findFlightStartIndex(path) {
    if (!path || !path.length) return 0;
    var scanEnd = path.length - 1;
    while (scanEnd >= 0 && path[scanEnd][5]) scanEnd--;
    if (scanEnd < 0) return 0;

    var groundBound = 0;
    for (var i = scanEnd; i >= 0; i--) {
      if (path[i][5]) { groundBound = i + 1; break; }
    }

    var gapBound = 0;
    for (var j = scanEnd; j >= 1; j--) {
      if (path[j][0] - path[j - 1][0] > 1800) { gapBound = j; break; }
    }

    return Math.max(groundBound, gapBound);
  }

  function matchRunwayDesignator(runwayEntries, iata, designator) {
    if (!runwayEntries || !runwayEntries.length || !iata || !designator) return null;
    var desig = String(designator).toUpperCase().replace(/^0+/, "");
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
      var side1 = parts[0].replace(/^0+/, "") || "0";
      var side2 = parts[1].replace(/^0+/, "") || "0";
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

  function scoreArrivalCandidate(input) {
    input = input || {};
    var altFt = isFinite(input.altFt) ? Math.max(0, input.altFt) : null;
    var distKm = isFinite(input.distKm) ? Math.max(0, input.distKm) : null;
    var spdKts = isFinite(input.spdKts) ? Math.max(0, input.spdKts) : 0;
    var confidence = input.confidence || "";
    var phase = input.phase || "";
    var privateAircraft = !!input.private;
    var destinationMatch = !!input.destinationMatch;
    var originMatch = !!input.originMatch;
    var vRateFpm = isFinite(input.vRate) ? input.vRate * 60 : null;
    var descending = vRateFpm != null && vRateFpm <= -200;
    var climbing = vRateFpm != null && vRateFpm >= 150;
    var speedKmPerMin = spdKts > 0 ? spdKts * 1.852 / 60 : 0;
    var distanceEtaMin = distKm != null && speedKmPerMin > 0 ? distKm / speedKmPerMin : null;
    var descentEtaMin = descending && altFt != null
      ? altFt / Math.max(Math.abs(vRateFpm), 300)
      : null;
    var etaMin = null;
    var eligible = true;

    if (destinationMatch && altFt != null && distKm != null) {
      var nominalDescDistKm = altFt / 172;
      if (distKm > nominalDescDistKm) {
        var cruiseDistKm = distKm - nominalDescDistKm;
        var cruiseTimeMin = speedKmPerMin > 0 ? cruiseDistKm / speedKmPerMin : cruiseDistKm / 10;
        etaMin = cruiseTimeMin + altFt / 1500;
      } else {
        etaMin = altFt / 1500;
      }
    } else if (descentEtaMin != null) {
      etaMin = descentEtaMin;
      if (distanceEtaMin != null) etaMin = descentEtaMin * 0.8 + distanceEtaMin * 0.2;
    } else if (distanceEtaMin != null) {
      etaMin = distanceEtaMin;
    } else if (altFt != null) {
      etaMin = Math.max(altFt / 1200, 1);
    } else if (distKm != null) {
      etaMin = Math.max(distKm / 10, 1);
    } else {
      etaMin = 999;
    }
    if (altFt != null) etaMin = Math.max(etaMin, altFt / 1500);

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

  function sortAirportArrivalRows(landed, taxiingIn, inbound, options) {
    options = options || {};
    var landedLimit = options.landedLimit == null ? 5 : options.landedLimit;
    var taxiingLimit = options.taxiingLimit == null ? 5 : options.taxiingLimit;
    var totalLimit = options.totalLimit == null ? 15 : options.totalLimit;
    var landedRows = dedupeAirportRows(copyAirportRows(landed).sort(compareAirportLandedEntries));
    var taxiingRows = dedupeAirportRows(copyAirportRows(taxiingIn).sort(function(a, b) {
      var distA = a && a.distKm != null ? a.distKm : Infinity;
      var distB = b && b.distKm != null ? b.distKm : Infinity;
      if (distA !== distB) return distA - distB;
      return ((a && a.callsign) || "").localeCompare((b && b.callsign) || "");
    }));
    var inboundRows = dedupeAirportRows(copyAirportRows(inbound).sort(compareAirportArrivalEntries));
    limitAirportRows(landedRows, landedLimit);
    limitAirportRows(taxiingRows, taxiingLimit);
    var rows = dedupeAirportRows(landedRows.concat(taxiingRows, inboundRows));
    limitAirportRows(rows, totalLimit);
    for (var i = 0; i < rows.length; i++) delete rows[i]._rolloutDist;
    return rows;
  }

  function airportDepartureStatusOrder(status) {
    var statusOrd = { Departing: 0, Climbing: 0, Holding: 1, Taxiing: 2, Parked: 3 };
    return statusOrd[status] != null ? statusOrd[status] : 3;
  }

  function describeAirportDepartureStatus(row, options) {
    options = options || {};
    row = row || {};
    var status = row.status || "Parked";
    var speedKts = row.speedKts || 0;
    var runwayDistKm = row.runwayDistKm;
    var activeRunway = !!row.activeRunway;
    var onRunway = activeRunway || !!row.onRunway;
    var nearRunway = runwayDistKm != null && runwayDistKm <= (options.activeRunways ? 1.5 : 1);
    var routeOrigin = !!row.originMatch;
    var confidence = "low";
    var label = status;
    var sortOrder = airportDepartureStatusOrder(status);

    if (status === "Departing") {
      label = "Rolling";
      confidence = activeRunway || onRunway || speedKts >= 50 || routeOrigin ? "high" : "medium";
      sortOrder = 0;
    } else if (status === "Climbing") {
      label = "Climbing out";
      confidence = routeOrigin || activeRunway || nearRunway ? "high" : "medium";
      sortOrder = 1;
    } else if (status === "Holding") {
      label = onRunway ? "Holding on runway" : "Holding";
      confidence = activeRunway || onRunway || nearRunway || routeOrigin ? "high" : "medium";
      sortOrder = 2;
    } else if (status === "Taxiing") {
      label = nearRunway ? "Taxiing near runway" : "Taxiing";
      confidence = nearRunway || routeOrigin ? "medium" : "low";
      sortOrder = 3;
    } else {
      label = routeOrigin ? "Parked, route matched" : "Parked";
      confidence = routeOrigin ? "medium" : "low";
      sortOrder = 4;
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
    var rows = dir === "departures"
      ? liveData && liveData.departures
      : liveData && liveData.arrivals;
    return rows && rows.length ? rows[0] : null;
  }

  return {
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
    describeAirportDepartureStatus: describeAirportDepartureStatus,
    buildViewPolicy: buildViewPolicy,
    buildViewportFetchSpec: buildViewportFetchSpec,
    cardinalDir: cardinalDir,
    elevationDeg: elevationDeg,
    escapeHtml: escapeHtml,
    findFlightStartIndex: findFlightStartIndex,
    formatDistanceMiles: formatDistanceMiles,
    formatSpeedMph: formatSpeedMph,
    haversineKm: haversineKm,
    interpolatePlaybackPose: interpolatePlaybackPose,
    interpolateTimedPose: interpolateTimedPose,
    getAirportNextRow: getAirportNextRow,
    isLikelyPrivateCallsign: isLikelyPrivateCallsign,
    kmToMiles: kmToMiles,
    knotsToMph: knotsToMph,
    matchRunwayDesignator: matchRunwayDesignator,
    callsignVariants: callsignVariants,
    normalizeAircraftHex: normalizeAircraftHex,
    normalizeFlightQuery: normalizeFlightQuery,
    normalizeSearchText: normalizeSearchText,
    parseCoordinate: parseCoordinate,
    pointOnRunway: pointOnRunway,
    projectLatLng: projectLatLng,
    roundTenths: roundTenths,
    scoreArrivalCandidate: scoreArrivalCandidate,
    sortAirportArrivalRows: sortAirportArrivalRows,
    sortAirportDepartureRows: sortAirportDepartureRows,
    slantKm: slantKm
  };
});
