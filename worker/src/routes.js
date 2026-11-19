import { isLikelyPrivateCallsign as classifyPrivateCallsign } from "./airlines.js";
import { MAJOR_AIRPORTS } from "./airports.js";
import { haversineKm } from "./geo.js";
import AIRPORTS from "../../airports.json" with { type: "json" };
import { rejectContradictoryRoute } from "./route-evidence.js";
import { findNearestRegion } from "./regions.js";

const ORIGIN_MAX_ALT_M = 2500;
const ORIGIN_MAX_DIST_KM = 8;
const CONVERGENCE_TAIL_SIZE = 50;
const CONVERGENCE_SEARCH_RADIUS_KM = 80;
const CONVERGENCE_MIN_POINTS = 10;
const DESTINATION_LOW_ALT_M = 3000;
const CLOSE_PASS_KM = 5;
const CLOSE_PASS_BONUS = 8;

export function nearestAirport(lat, lon, maxKm) {
  let best = null;
  let bestDist = maxKm;
  for (const [iata, name, aLat, aLon] of MAJOR_AIRPORTS) {
    const d = haversineKm(lat, lon, aLat, aLon);
    if (d < bestDist) {
      bestDist = d;
      best = { iata, name };
    }
  }
  return best ? { ...best, dist: bestDist } : null;
}

function nearbyAirports(lat, lon, maxKm, limit) {
  const results = [];
  for (const [iata, name, aLat, aLon] of MAJOR_AIRPORTS) {
    const d = haversineKm(lat, lon, aLat, aLon);
    if (d < maxKm) results.push({ iata, name, lat: aLat, lon: aLon, dist: d });
  }
  results.sort((a, b) => a.dist - b.dist);
  return results.slice(0, limit);
}

export function convergenceScore(pathTail, airportLat, airportLon) {
  if (pathTail.length < 2) return 0;
  const dists = pathTail.map((pt) => haversineKm(pt[1], pt[2], airportLat, airportLon));
  const total = dists.length - 1;
  let decreasing = 0;
  for (let i = 1; i <= total; i++) {
    if (dists[i] < dists[i - 1]) decreasing++;
  }
  const pct = decreasing / total;
  const net = dists[dists.length - 1] - dists[0];
  const finalDist = dists[dists.length - 1];
  const minDist = Math.min(...dists);

  let score = 0;
  if (net < 0) {
    score = pct * Math.abs(net) / Math.max(finalDist, 0.1);
  }
  if (minDist < CLOSE_PASS_KM) {
    score += (CLOSE_PASS_KM - minDist) / CLOSE_PASS_KM * CLOSE_PASS_BONUS;
  }
  return score;
}

const LEG_GAP_SEC = 1800;

// Altitude is unknown (null) when the trace had no usable value; only a known
// low altitude or an explicit on-ground flag counts as "low".
function isLowPoint(pt, maxAltM) {
  if (pt[5] === true) return true;
  return typeof pt[3] === "number" && Number.isFinite(pt[3]) && pt[3] <= maxAltM;
}

// Start of the current leg in a whole-day trace: the later of the last gap
// > 30 min anywhere in the trace (including among trailing ground points, e.g.
// taxiing out for the next leg after an hour out of coverage) and the last
// ground->air transition before the final airborne segment. Like the client's
// findFlightStartIndex, the ground point itself (the takeoff roll) is kept so
// the origin scan sees it.
export function findLegStartIndex(path) {
  if (!path || !path.length) return 0;

  let gapBound = 0;
  for (let j = path.length - 1; j >= 1; j--) {
    if (path[j][0] - path[j - 1][0] > LEG_GAP_SEC) { gapBound = j; break; }
  }

  let scanEnd = path.length - 1;
  while (scanEnd >= 0 && path[scanEnd][5] === true) scanEnd--;

  let groundBound = 0;
  for (let i = scanEnd; i >= 0; i--) {
    if (path[i][5] === true) { groundBound = i; break; }
  }

  return Math.max(groundBound, gapBound);
}

export function extractOriginDest(track) {
  const path = track?.path;
  if (!path || path.length < 2) {
    const lastTrackPoint = path?.length ? path[path.length - 1] : null;
    return { origin: null, destination: null, ambiguous: false, lastTrackPoint };
  }

  const lastTrackPoint = path[path.length - 1];

  const legStart = findLegStartIndex(path);

  let origin = null;
  const originScanLimit = Math.max(20, Math.ceil((path.length - legStart) * 0.25));
  for (let i = legStart; i < Math.min(legStart + originScanLimit, path.length); i++) {
    const pt = path[i];
    if (isLowPoint(pt, ORIGIN_MAX_ALT_M)) {
      const match = nearestAirport(pt[1], pt[2], ORIGIN_MAX_DIST_KM);
      if (match) {
        origin = { iata: match.iata, name: match.name };
        break;
      }
    }
  }

  let destination = null;
  let ambiguous = false;
  const tail = path.slice(Math.max(legStart, path.length - CONVERGENCE_TAIL_SIZE));

  const knownAlts = tail
    .map((pt) => pt[3])
    .filter((alt) => typeof alt === "number" && Number.isFinite(alt));
  const minAlt = knownAlts.length ? Math.min(...knownAlts) : Infinity;
  if (tail.length >= CONVERGENCE_MIN_POINTS && minAlt < DESTINATION_LOW_ALT_M) {
    const last = tail[tail.length - 1];
    const candidates = nearbyAirports(last[1], last[2], CONVERGENCE_SEARCH_RADIUS_KM, 5);

    let bestScore = 0;
    let secondScore = 0;
    for (const apt of candidates) {
      const score = convergenceScore(tail, apt.lat, apt.lon);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        destination = { iata: apt.iata, name: apt.name };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    if (secondScore > 0 && secondScore / bestScore > 0.8) {
      destination = null;
      ambiguous = true;
    }
  }

  return { origin, destination, ambiguous, lastTrackPoint };
}

export function detectPhase(altFt, vRate, ground) {
  if (ground) return "landed";
  if (altFt == null) return null;
  const descending = vRate != null && vRate < -300;
  const climbing = vRate != null && vRate > 300;
  if (altFt < 10000 && descending) return "arriving";
  if (altFt < 10000 && climbing) return "departing";
  return "cruising";
}

// Missing callsigns cannot support a route; bare hex-like strings historically remain eligible here.
function isLikelyPrivateCallsign(callsign) {
  return classifyPrivateCallsign(callsign, { missingIsPrivate: true, hexlikeIsPrivate: false });
}

export function mergeRoutes(trackResult, adsbdbEntry, aircraftInfo) {
  const airline = adsbdbEntry?.airline || null;
  const path = trackResult?.path || [];
  const last = path[path.length - 1];
  const previous = path[path.length - 2];
  const state = { ...aircraftInfo };
  // Old clients may omit position/heading; a trace still supplies those observations.
  if (!Number.isFinite(state.lat) && last) { state.lat = last[1]; state.lng = last[2]; }
  const traceAge = last ? Date.now() / 1000 - last[0] : Infinity;
  if (last && traceAge >= 0 && traceAge < 60 && haversineKm(state.lat, state.lng, last[1], last[2]) < 2) {
    if (!Number.isFinite(state.track)) {
      state.track = last[4];
      if (previous) state.previous = { lat: previous[1], lng: previous[2] };
    }
  }
  if (adsbdbEntry) adsbdbEntry = rejectContradictoryRoute({ ...adsbdbEntry,
    originSource: "adsbdb", destSource: "adsbdb" }, state, AIRPORTS);
  const trackOD = trackResult ? extractOriginDest(trackResult) : null;
  const trackOrigin = trackOD?.origin || null;
  const trackDest = trackOD?.destination || null;
  const dbOrigin = adsbdbEntry?.origin || null;
  const dbDest = adsbdbEntry?.destination || null;

  const originsMatch = trackOrigin && dbOrigin && trackOrigin.iata === dbOrigin.iata;
  const destsMatch = trackDest && dbDest && trackDest.iata === dbDest.iata;
  const originConflict = trackOrigin && dbOrigin && trackOrigin.iata !== dbOrigin.iata;
  const destConflict = trackDest && dbDest && trackDest.iata !== dbDest.iata;
  const suppressADSBDB = originConflict && destConflict;

  let origin = null;
  let originSource = null;
  if (trackOrigin) {
    origin = trackOrigin;
    originSource = "track";
  } else if (destsMatch && dbOrigin) {
    origin = dbOrigin;
    originSource = "cross-validated";
  } else if (dbOrigin && !suppressADSBDB) {
    origin = dbOrigin;
    originSource = "adsbdb";
  }

  let destination = null;
  let destSource = null;
  if (trackDest) {
    destination = trackDest;
    destSource = "convergence";
  } else if (originsMatch && dbDest) {
    destination = dbDest;
    destSource = "cross-validated";
  } else if (!trackOrigin && dbDest && !suppressADSBDB) {
    destination = dbDest;
    destSource = "adsbdb";
  }

  const ambiguous = trackOD?.ambiguous || false;
  const lastTrackPoint = trackOD?.lastTrackPoint || null;
  if (ambiguous && !destination && aircraftInfo && lastTrackPoint &&
      !isLikelyPrivateCallsign(aircraftInfo.callsign) &&
      aircraftInfo.altFt != null && aircraftInfo.altFt < 15000 &&
      aircraftInfo.vRate != null && aircraftInfo.vRate < -300) {
    const region = findNearestRegion(lastTrackPoint[1], lastTrackPoint[2], 100);
    if (region) {
      destination = { region: region.name, display: "Landing in " + region.name };
      destSource = "region";
    }
  }

  if (!origin && !destination) return null;

  const isRegionalFallback = destSource === "region";
  const hasCrossValidation = originSource === "cross-validated" || destSource === "cross-validated";
  const hasBothTrackSources = !!(trackOrigin && trackDest);
  const confidence = isRegionalFallback ? "low"
    : (hasCrossValidation || hasBothTrackSources) ? "high" : "medium";

  return rejectContradictoryRoute({ origin, destination, originSource, destSource, confidence, airline }, state, AIRPORTS);
}

export function formatRouteLabel(origin, destination, phase) {
  const oIata = origin?.iata;
  const dDisplay = destination?.region
    ? (destination.display || destination.region)
    : destination?.iata;
  const dArriving = destination?.region
    ? (destination.display || destination.region)
    : destination?.iata ? `landing at ${destination.iata}` : "";
  const dLanded = destination?.region
    ? `arrived in ${destination.region}`
    : destination?.iata ? `arrived at ${destination.iata}` : "";

  if (phase === "departing") {
    if (oIata && dDisplay) return `departed ${oIata} for ${dDisplay}`;
    if (oIata) return `departed ${oIata}`;
    if (dDisplay) return dDisplay;
    return "";
  }

  if (phase === "arriving") {
    if (oIata && dArriving) return `${dArriving} from ${oIata}`;
    if (dArriving) return dArriving;
    if (oIata) return `from ${oIata}`;
    return "";
  }

  if (phase === "landed") {
    if (oIata && dLanded) return `${dLanded} from ${oIata}`;
    if (dLanded) return dLanded;
    if (oIata) return `from ${oIata}`;
    return "";
  }

  if (oIata && dDisplay) return `${oIata} → ${dDisplay}`;
  if (oIata) return `from ${oIata}`;
  if (dDisplay) return dDisplay;
  return "";
}
