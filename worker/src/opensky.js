import { MAJOR_AIRPORTS } from "./airports.js";
import { haversineKm } from "./geo.js";
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

export function extractOriginDest(track) {
  const path = track?.path;
  if (!path || path.length < 2) {
    const lastTrackPoint = path?.length ? path[path.length - 1] : null;
    return { origin: null, destination: null, ambiguous: false, lastTrackPoint };
  }

  const lastTrackPoint = path[path.length - 1];

  let origin = null;
  const originScanLimit = Math.max(20, Math.ceil(path.length * 0.25));
  for (let i = 0; i < Math.min(originScanLimit, path.length); i++) {
    const pt = path[i];
    if (pt[3] <= ORIGIN_MAX_ALT_M) {
      const match = nearestAirport(pt[1], pt[2], ORIGIN_MAX_DIST_KM);
      if (match) {
        origin = { iata: match.iata, name: match.name };
        break;
      }
    }
  }

  let destination = null;
  let ambiguous = false;
  const tail = path.length >= CONVERGENCE_TAIL_SIZE
    ? path.slice(-CONVERGENCE_TAIL_SIZE)
    : path;

  const minAlt = Math.min(...tail.map((pt) => pt[3]));
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

const _PRIV_REG = /^(N\d|C-[FGFI]|G-|D-|F-|I-|EC-|HB-|OE-|PH-|SE-|OH-|OY-|LN-|EI-|CS-|SX-|TC-|VH-|ZK-|PP-|PT-|PR-|JA|B-|HL|VT-|9V-|A[267]-|SU-|5[ABHNXY]-|ZS-|VP-|V[5HPQR]-|RP-|HS-|9M-|PK-|XA-|XB-|LV-|CC-|TI-|HP-|HK-|YV-)/i;
const _ANON_HEX = /^~[0-9a-f]{4,}$/i;

function isLikelyPrivateCallsign(callsign) {
  if (!callsign) return true;
  return _PRIV_REG.test(callsign) || _ANON_HEX.test(callsign);
}

export function mergeRoutes(trackResult, adsbdbEntry, aircraftInfo) {
  const trackOD = trackResult ? extractOriginDest(trackResult) : null;
  const trackOrigin = trackOD?.origin || null;
  const trackDest = trackOD?.destination || null;
  const dbOrigin = adsbdbEntry?.origin || null;
  const dbDest = adsbdbEntry?.destination || null;
  const airline = adsbdbEntry?.airline || null;

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

  return { origin, destination, originSource, destSource, confidence, airline };
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
