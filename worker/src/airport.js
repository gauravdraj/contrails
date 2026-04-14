import { MAJOR_AIRPORTS } from "./airports.js";
import { enrichRoutes } from "./enrich.js";
import { haversineKm } from "./geo.js";
import { json, plainText } from "./http.js";

const ADSB_API = "https://api.adsb.lol/v2";
const MAP_URL = "https://gauravdraj.github.io/contrails";
const AIRPORT_RADIUS_NM = 65;
const MAX_RESULTS = 15;

const ARRIVAL_PROXIMITY_KM = 20;
const ARRIVAL_MAX_ALT_FT = 6000;
const ARRIVAL_MIN_DESCENT_FPM = 500;

const DEPARTURE_ROUTE_RADIUS_KM = 8;
const DEPARTURE_FALLBACK_RADIUS_KM = 5;
const VERT_RATE_THRESHOLD = 300;

const NEARBY_AIRLINES = {
  AAL: "American", AAR: "Asiana", ACA: "Air Canada", AFR: "Air France", AIC: "Air India",
  AIJ: "Interjet", AJX: "Air Japan", AMX: "AeroMexico", ANA: "All Nippon", ANZ: "Air New Zealand",
  APJ: "Peach", ASA: "Alaska", AUA: "Austrian", AVA: "Avianca", AXM: "AirAsia",
  AZA: "Alitalia/ITA", BAW: "British Airways", BEL: "Brussels", BER: "Berlinair",
  BLX: "TUIfly Benelux", BWA: "Caribbean", CAL: "China Airlines", CCA: "Air China",
  CEB: "Cebu Pacific", CES: "China Eastern", CHH: "Hainan", CKS: "Kalitta", CLX: "Cargolux",
  CMP: "Copa", CPA: "Cathay Pacific", CPZ: "Compass", CSN: "China Southern", CTN: "Croatia",
  DAL: "Delta", DLH: "Lufthansa", EIN: "Aer Lingus", EJU: "easyJet Europe",
  ELY: "El Al", ETD: "Etihad", ETH: "Ethiopian", EVA: "EVA Air", EWG: "Eurowings",
  EZY: "easyJet", FDX: "FedEx", FIN: "Finnair", FJI: "Fiji Airways", GAL: "GetJet",
  GEC: "Lufthansa Cargo", GIA: "Garuda", GTI: "Atlas Air", GWI: "Germanwings",
  HAL: "Hawaiian", HVN: "Vietnam Airlines", IAW: "Iraqi", IBE: "Iberia", ICE: "Icelandair",
  IGO: "IndiGo", JAL: "Japan Airlines", JBU: "JetBlue", JIA: "PSA Airlines", JST: "Jetstar",
  KAL: "Korean Air", KLM: "KLM", LAN: "LATAM Chile", LAX: "LATAM", LOT: "LOT Polish",
  MAU: "Air Mauritius", MAS: "Malaysia", MEA: "Middle East", MSR: "EgyptAir",
  NAX: "Norwegian", NKS: "Spirit", NPT: "N. Pacific", NWS: "Nordwind", NZM: "Mount Cook",
  OAL: "Olympic", OMA: "Oman Air", PAC: "Polar Air", PAL: "Philippine", PIA: "Pakistan Intl",
  QFA: "Qantas", QTR: "Qatar", RAM: "Royal Air Maroc", RJA: "Royal Jordanian",
  ROT: "TAROM", RPA: "Republic", RYR: "Ryanair", SAS: "SAS", SAA: "South African",
  SCX: "Sun Country", SEJ: "StarFlyer", SIA: "Singapore", SKW: "SkyWest", SLK: "Silk Way",
  SVA: "Saudia", SWA: "Southwest", SWR: "Swiss", TAM: "LATAM Brazil", TAP: "TAP Portugal",
  THA: "Thai", THY: "Turkish", TOM: "TUI UK", TVF: "Transavia France",
  UAE: "Emirates", UAL: "United", UPS: "UPS", UTA: "UTair", VIR: "Virgin Atlantic",
  VJC: "VietJet", VOI: "Volaris", VTI: "Vistara", WJA: "WestJet", WZZ: "Wizz Air",
  XAX: "AirAsia X",
};

const PRIV_REG = /^(N\d|C-[FGFI]|G-|D-|F-|I-|EC-|HB-|OE-|PH-|SE-|OH-|OY-|LN-|EI-|CS-|SX-|TC-|VH-|ZK-|PP-|PT-|PR-|JA|B-|HL|VT-|9V-|A[267]-|SU-|5[ABHNXY]-|ZS-|VP-|V[5HPQR]-|RP-|HS-|9M-|PK-|XA-|XB-|LV-|CC-|TI-|HP-|HK-|YV-)/i;
const PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
const PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

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

function nearbyAirlineName(callsign) {
  if (!callsign || callsign.length < 3) return null;
  return NEARBY_AIRLINES[callsign.substring(0, 3).toUpperCase()] || null;
}

function isLikelyPrivate(callsign) {
  if (!callsign) return false;
  if (PRIV_REG.test(callsign) || PRIV_ANON_HEX.test(callsign)) return true;
  return !nearbyAirlineName(callsign) && PRIV_HEXLIKE.test(callsign);
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
  const resp = await fetch(
    `${ADSB_API}/lat/${lat.toFixed(4)}/lon/${lng.toFixed(4)}/dist/${AIRPORT_RADIUS_NM}`,
    { headers: { "User-Agent": "contrails/1.0" } },
  );
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

export function buildAirportPlane(airportLat, airportLng, snapshot) {
  if (snapshot.lat == null || snapshot.lon == null) return null;

  const callsign = (snapshot.flight || "").trim() || null;
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
    const plane = buildAirportPlane(airport.lat, airport.lng, snapshot);
    if (plane) planes.push(plane);
  }

  let routeMap = Object.create(null);
  try {
    routeMap = await enrichRoutes(planes, env, ctx);
  } catch (_) {
    routeMap = Object.create(null);
  }

  const dir = (url.searchParams.get("dir") || "arrivals").toLowerCase();
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
