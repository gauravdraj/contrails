import { airlineName as nearbyAirlineName, isLikelyPrivateCallsign as isLikelyPrivate } from "./airlines.js";
import { MAJOR_AIRPORTS } from "./airports.js";
import { enrichRoutes, MAX_ENRICH_PLANES } from "./enrich.js";
import { haversineKm } from "./geo.js";
import { json, plainText } from "./http.js";
import { fetchAircraftResilient } from "./providers.js";

const MAP_URL = "https://gauravdraj.github.io/contrails";
const AIRPORT_RADIUS_NM = 65;
const MAX_RESULTS = 15;

const ARRIVAL_PROXIMITY_KM = 20;
const ARRIVAL_MAX_ALT_FT = 6000;
const ARRIVAL_MIN_DESCENT_FPM = 500;

const DEPARTURE_ROUTE_RADIUS_KM = 8;
const DEPARTURE_FALLBACK_RADIUS_KM = 5;
const VERT_RATE_THRESHOLD = 300;

export function estimateEtaMin(plane) {
  if (plane.vRate != null && plane.vRate < -ARRIVAL_MIN_DESCENT_FPM && plane.altFt > 0) {
    return Math.max(plane.altFt / Math.max(Math.abs(plane.vRate), 300), 0.5);
  }
  if (plane.speedKts > 0 && plane.distKm > 0) {
    return Math.max(plane.distKm / (plane.speedKts * 1.852 / 60), 0.5);
  }
  return null;
}

export function shortMiles(km) {
  return Math.round(km * 0.621371 * 10) / 10;
}

export function shortAlt(ft) {
  if (Math.abs(ft) >= 1000) return `${(ft / 1000).toFixed(1).replace(/\.0$/, "")}k ft`;
  return `${ft} ft`;
}

export function filterArrivals(planes, routeMap, airport) {
  const arrivals = [];
  for (const plane of planes) {
    if (plane.ground) continue;
    const cs = plane.callsign?.trim().toUpperCase();
    const route = cs ? routeMap[cs] : null;
    const destIata = route?.destination?.iata;

    const routeConfirmed = destIata && destIata === airport.iata;
    const proximityMatch = plane.distKm <= ARRIVAL_PROXIMITY_KM &&
      plane.altFt != null && plane.altFt <= ARRIVAL_MAX_ALT_FT &&
      plane.vRate != null && plane.vRate <= -ARRIVAL_MIN_DESCENT_FPM &&
      !(destIata && destIata !== airport.iata);

    if (!routeConfirmed && !proximityMatch) continue;
    arrivals.push({
      ...plane,
      etaMin: estimateEtaMin(plane),
      origin: route?.origin || null,
      destination: route?.destination || null,
    });
  }

  arrivals.sort((a, b) => {
    const altDiff = (a.altFt ?? Infinity) - (b.altFt ?? Infinity);
    if (altDiff !== 0) return altDiff;
    return (a.etaMin ?? Infinity) - (b.etaMin ?? Infinity);
  });

  return arrivals.slice(0, MAX_RESULTS);
}

const DEPARTURE_STATUS_PRIORITY = { Departing: 0, Taxiing: 1, Parked: 2 };

export function filterDepartures(planes, routeMap, airport) {
  const departures = [];
  for (const plane of planes) {
    if (!plane.ground || !plane.callsign) continue;
    const cs = plane.callsign.trim().toUpperCase();
    const route = cs ? routeMap[cs] : null;

    if (route?.destination?.iata === airport.iata) continue;

    const originConfirmed = route?.origin?.iata === airport.iata;
    const maxDist = originConfirmed ? DEPARTURE_ROUTE_RADIUS_KM : DEPARTURE_FALLBACK_RADIUS_KM;
    if (plane.distKm > maxDist) continue;

    const spd = plane.speedKts ?? 0;
    const status = spd >= 50 ? "Departing" : spd >= 5 ? "Taxiing" : "Parked";
    departures.push({
      ...plane,
      destination: route?.destination || null,
      status,
    });
  }

  departures.sort((a, b) => {
    const pri = DEPARTURE_STATUS_PRIORITY[a.status] - DEPARTURE_STATUS_PRIORITY[b.status];
    if (pri !== 0) return pri;
    if (a.status === "Departing" || a.status === "Taxiing") {
      return (b.speedKts ?? 0) - (a.speedKts ?? 0);
    }
    const aHas = a.destination ? 0 : 1;
    const bHas = b.destination ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return (a.distKm ?? Infinity) - (b.distKm ?? Infinity);
  });

  return departures.slice(0, MAX_RESULTS);
}

export function resolveAirport(iata) {
  if (!iata) return null;
  const upper = iata.toUpperCase();
  for (const [code, name, lat, lng] of MAJOR_AIRPORTS) {
    if (code === upper) return { iata: code, name, lat, lng };
  }
  return null;
}

export async function fetchAirportAircraft(lat, lng) {
  return fetchAircraftResilient(lat, lng, AIRPORT_RADIUS_NM);
}

// A position older than this is no longer where the plane is.
const MAX_POSITION_AGE_SEC = 60;

export function buildAirportPlane(airportLat, airportLng, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (typeof snapshot.lat !== "number" || typeof snapshot.lon !== "number") return null;
  if (typeof snapshot.seen_pos === "number" && snapshot.seen_pos > MAX_POSITION_AGE_SEC) return null;

  const callsign = typeof snapshot.flight === "string" ? (snapshot.flight.trim() || null) : null;
  const ground = snapshot.alt_baro === "ground";
  const altFt = ground ? 0 : (typeof snapshot.alt_baro === "number" ? Math.round(snapshot.alt_baro) : null);

  return {
    callsign,
    icao24: snapshot.hex,
    type: snapshot.t || null,
    registration: snapshot.r || null,
    lat: snapshot.lat,
    lng: snapshot.lon,
    altFt,
    speedKts: snapshot.gs != null ? Math.round(snapshot.gs) : null,
    vRate: snapshot.baro_rate || null,
    ground,
    distKm: haversineKm(airportLat, airportLng, snapshot.lat, snapshot.lon),
    airline: nearbyAirlineName(callsign),
    priv: isLikelyPrivate(callsign),
  };
}

function verticalState(rate) {
  if (rate == null || Math.abs(rate) < VERT_RATE_THRESHOLD) return "level";
  return rate > 0 ? "climbing" : "descending";
}

export function formatArrivalEntry(num, plane) {
  let name = plane.callsign || plane.icao24;
  if (plane.airline && plane.callsign) {
    name = plane.airline + " " + plane.callsign.substring(3);
  }
  let line1 = `${num}. ${name}`;
  if (plane.type) line1 += ` (${plane.type})`;
  if (plane.priv) line1 += " [PRIVATE]";

  const vertical = verticalState(plane.vRate);
  const originIata = plane.origin?.iata;
  const destIata = plane.destination?.iata;
  let route = "";
  if (originIata && destIata) route = `${originIata} \u2192 ${destIata} \u2014 `;
  else if (destIata) route = `${destIata} \u2014 `;

  let line2 = "   " + route + shortAlt(plane.altFt);
  if (vertical === "descending") line2 += " \u2193 descending";
  else if (vertical === "climbing") line2 += " \u2191 climbing";
  line2 += `, ${shortMiles(plane.distKm)} mi`;
  if (plane.etaMin != null) line2 += `, ~${Math.round(plane.etaMin)}min`;

  return line1 + "\n" + line2;
}

export function formatDepartureEntry(num, plane) {
  let name = plane.callsign || plane.icao24;
  if (plane.airline && plane.callsign) {
    name = plane.airline + " " + plane.callsign.substring(3);
  }
  let line1 = `${num}. ${name}`;
  if (plane.type) line1 += ` (${plane.type})`;
  if (plane.priv) line1 += " [PRIVATE]";
  if (plane.destination?.iata) line1 += ` \u2192 ${plane.destination.iata}`;

  let line2 = "   " + plane.status;
  if ((plane.status === "Taxiing" || plane.status === "Departing") && plane.speedKts != null) {
    line2 += `, ${Math.round(plane.speedKts * 1.15078)} mph`;
  }

  return line1 + "\n" + line2;
}

export function formatAirportText(airport, arrivals, departures, dir) {
  const sections = [];

  if (dir === "arrivals" || dir === "both") {
    const count = arrivals ? arrivals.length : 0;
    let section = `${airport.iata} ${airport.name} \u2014 ${count} arriving:`;
    if (count) {
      section += "\n\n" + arrivals.map((p, i) => formatArrivalEntry(i + 1, p)).join("\n\n");
    } else {
      section += "\n\n(none detected)";
    }
    sections.push(section);
  }

  if (dir === "departures" || dir === "both") {
    const count = departures ? departures.length : 0;
    let section = `${airport.iata} ${airport.name} \u2014 ${count} departing:`;
    if (count) {
      section += "\n\n" + departures.map((p, i) => formatDepartureEntry(i + 1, p)).join("\n\n");
    } else {
      section += "\n\n(none detected)";
    }
    sections.push(section);
  }

  return sections.join("\n\n");
}

function airportHtml(textBody, mapLink) {
  const escaped = textBody.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<style>body{background:#0d1117;color:#e6edf3;font-family:-apple-system,system-ui,monospace;` +
    `padding:16px;font-size:14px;line-height:1.6}a{color:#58a6ff;font-size:15px}pre{white-space:pre-wrap;margin:0 0 16px}</style>` +
    `</head><body><pre>${escaped}</pre>` +
    `<a href="${mapLink}">Open in Contrails \u2192</a></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
  });
}

function formatArrivalJson(plane) {
  return {
    callsign: plane.callsign,
    airline: plane.airline || null,
    flightNum: plane.airline && plane.callsign ? plane.callsign.substring(3) : null,
    type: plane.type,
    origin: plane.origin?.iata || null,
    altFt: plane.altFt,
    distKm: Math.round(plane.distKm * 10) / 10,
    etaMin: plane.etaMin != null ? Math.round(plane.etaMin * 10) / 10 : null,
    vertical: verticalState(plane.vRate),
  };
}

function formatDepartureJson(plane) {
  return {
    callsign: plane.callsign,
    airline: plane.airline || null,
    flightNum: plane.airline && plane.callsign ? plane.callsign.substring(3) : null,
    type: plane.type,
    destination: plane.destination?.iata || null,
    speedKts: plane.speedKts,
    status: plane.status,
  };
}

// Only planes that could appear on the requested board are worth a route
// lookup: ground planes near the field (departures) and airborne planes
// (arrivals, lowest first, matching the arrivals sort). Climbing planes sort
// last rather than being dropped, so spare capacity still covers a go-around
// whose route is the only thing keeping it on the board. With dir=both each
// list is guaranteed half the budget and any unused share goes to the other,
// so neither list starves.
function isClimbing(plane) {
  return plane.vRate != null && plane.vRate >= VERT_RATE_THRESHOLD ? 1 : 0;
}

export function selectEnrichCandidates(planes, dir) {
  const wantArrivals = dir === "arrivals" || dir === "both";
  const wantDepartures = dir === "departures" || dir === "both";
  const routable = planes.filter((p) => p.callsign && p.priv !== true);

  const departures = wantDepartures
    ? routable
      .filter((p) => p.ground && p.distKm <= DEPARTURE_ROUTE_RADIUS_KM)
      .sort((a, b) => a.distKm - b.distKm)
    : [];
  const arrivals = wantArrivals
    ? routable
      .filter((p) => !p.ground)
      .sort((a, b) => (isClimbing(a) - isClimbing(b)) ||
        ((a.altFt ?? Infinity) - (b.altFt ?? Infinity)) || (a.distKm - b.distKm))
    : [];

  const depBudget = wantArrivals
    ? Math.max(Math.ceil(MAX_ENRICH_PLANES / 2), MAX_ENRICH_PLANES - arrivals.length)
    : MAX_ENRICH_PLANES;
  const picked = departures.slice(0, depBudget);
  return picked.concat(arrivals.slice(0, MAX_ENRICH_PLANES - picked.length));
}

export async function handleAirport(url, env, ctx) {
  const segments = url.pathname.split("/");
  const iataRaw = segments[segments.length - 1] || segments[segments.length - 2];

  if (!iataRaw || !/^[A-Za-z]{3,4}$/.test(iataRaw)) {
    return plainText(400, "Invalid airport code. Provide a 3-4 letter IATA code.");
  }

  const airport = resolveAirport(iataRaw);
  if (!airport) {
    return plainText(404, "Unknown airport code");
  }

  let acData;
  try {
    acData = await fetchAirportAircraft(airport.lat, airport.lng);
  } catch (error) {
    return plainText(502, "Aircraft data unavailable: " + error.message);
  }

  const planes = [];
  for (const snapshot of acData.ac || []) {
    // One malformed row must not reject the whole snapshot.
    try {
      const plane = buildAirportPlane(airport.lat, airport.lng, snapshot);
      if (plane) planes.push(plane);
    } catch (_) {}
  }

  const dir = (url.searchParams.get("dir") || "arrivals").toLowerCase();

  let routeMap = Object.create(null);
  try {
    routeMap = await enrichRoutes(selectEnrichCandidates(planes, dir), env, ctx);
  } catch (_) {
    routeMap = Object.create(null);
  }

  const format = (url.searchParams.get("format") || "").toLowerCase();
  const mapLink = `${MAP_URL}/?lat=${airport.lat}&lng=${airport.lng}&zoom=11`;

  const arrivals = (dir === "arrivals" || dir === "both") ? filterArrivals(planes, routeMap, airport) : null;
  const departures = (dir === "departures" || dir === "both") ? filterDepartures(planes, routeMap, airport) : null;

  if (format === "json") {
    const result = { airport, mapUrl: mapLink };
    if (arrivals) result.arrivals = arrivals.map(formatArrivalJson);
    if (departures) result.departures = departures.map(formatDepartureJson);
    return json(200, result);
  }

  const body = formatAirportText(airport, arrivals, departures, dir);
  if (format === "text") return plainText(200, body);
  return airportHtml(body, mapLink);
}
