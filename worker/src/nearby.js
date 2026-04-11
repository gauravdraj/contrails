import { MAJOR_AIRPORTS } from "./airports.js";
import { fetchRouteAirports } from "./adsbdb.js";
import { bearingDeg, cardinalFromBearing, haversineKm } from "./geo.js";
import { json, plainText } from "./http.js";

const ADSB_API = "https://api.adsb.lol/v2";
const MAP_URL = "https://gauravdraj.github.io/contrails";
const NEARBY_RADIUS_NM = 25;
const MAX_SLANT_KM = 35;
const MAX_NEARBY_RESULTS = 5;
const CONTRAIL_MIN_FT = 25000;
const LANDING_MAX_FT = 10000;
const LANDING_AIRPORT_KM = 50;
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

const SQUAWK_ALERTS = { "7700": "EMERGENCY", "7600": "RADIO FAILURE", "7500": "HIJACK" };

const PRIV_REG = /^(N\d|C-[FGFI]|G-|D-|F-|I-|EC-|HB-|OE-|PH-|SE-|OH-|OY-|LN-|EI-|CS-|SX-|TC-|VH-|ZK-|PP-|PT-|PR-|JA|B-|HL|VT-|9V-|A[267]-|SU-|5[ABHNXY]-|ZS-|VP-|V[5HPQR]-|RP-|HS-|9M-|PK-|XA-|XB-|LV-|CC-|TI-|HP-|HK-|YV-)/i;
const PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
const PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

function nearbyAirlineName(callsign) {
  if (!callsign || callsign.length < 3) return null;
  return NEARBY_AIRLINES[callsign.substring(0, 3).toUpperCase()] || null;
}

function isLikelyPrivate(callsign) {
  if (!callsign) return false;
  if (PRIV_REG.test(callsign) || PRIV_ANON_HEX.test(callsign)) return true;
  return !nearbyAirlineName(callsign) && PRIV_HEXLIKE.test(callsign);
}

function verticalState(rate) {
  if (rate == null || Math.abs(rate) < VERT_RATE_THRESHOLD) return "level";
  return rate > 0 ? "climbing" : "descending";
}

function shortAlt(ft) {
  if (Math.abs(ft) >= 1000) return `${(ft / 1000).toFixed(1).replace(/\.0$/, "")}k ft`;
  return `${ft} ft`;
}

function nearbyZoom(visible) {
  if (!visible.length) return 11;
  const farthestKm = visible[visible.length - 1].slantKm;
  if (farthestKm < 3) return 14;
  if (farthestKm < 8) return 12;
  if (farthestKm < 15) return 11;
  if (farthestKm < 25) return 10;
  return 9;
}

function nearbyHtml(textBody, mapLink) {
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

function distanceDependentMinElevationDeg(groundKm) {
  return Math.max(0, (groundKm - 5) * 0.3);
}

async function fetchNearbyAircraft(lat, lng) {
  const resp = await fetch(
    `${ADSB_API}/lat/${lat.toFixed(4)}/lon/${lng.toFixed(4)}/dist/${NEARBY_RADIUS_NM}`,
    { headers: { "User-Agent": "contrails/1.0" } },
  );
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

function buildNearbyPlane(lat, lng, snapshot) {
  if (snapshot.alt_baro === "ground" || snapshot.alt_baro == null) return null;
  if (snapshot.lat == null || snapshot.lon == null) return null;
  if (typeof snapshot.alt_baro !== "number") return null;

  const callsign = (snapshot.flight || "").trim() || null;
  const groundKm = haversineKm(lat, lng, snapshot.lat, snapshot.lon);
  const altFt = Math.round(snapshot.alt_baro);
  const altKm = altFt * 0.0003048;
  const slant = Math.sqrt(groundKm * groundKm + altKm * altKm);
  if (slant > MAX_SLANT_KM) return null;

  const elevDeg = Math.round(Math.atan2(altKm, Math.max(groundKm, 0.001)) * 180 / Math.PI);
  if (elevDeg < distanceDependentMinElevationDeg(groundKm)) return null;

  const bearing = bearingDeg(lat, lng, snapshot.lat, snapshot.lon);
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
    squawk: snapshot.squawk || null,
    track: snapshot.track != null ? Math.round(snapshot.track) : null,
    slantKm: Math.round(slant * 10) / 10,
    elevDeg,
    cardinal: cardinalFromBearing(bearing),
    vertical: verticalState(snapshot.baro_rate),
    priv: isLikelyPrivate(callsign),
    airline: nearbyAirlineName(callsign),
  };
}

function selectVisiblePlanes(planes) {
  const visible = [];
  if (!planes.length) return visible;

  const threshold = Math.max(planes[0].slantKm * 3, 5);
  for (const plane of planes) {
    if (visible.length >= MAX_NEARBY_RESULTS) break;
    if (plane.slantKm > threshold && visible.length > 0) break;
    visible.push(plane);
  }
  return visible;
}

async function fetchRouteMap(visible) {
  const routeMap = Object.create(null);
  const routable = visible.filter((plane) => plane.callsign && !plane.priv);
  if (!routable.length) return routeMap;

  const results = await Promise.allSettled(
    routable.map(async (plane) => {
      const airports = await fetchRouteAirports(plane.callsign);
      return airports ? [plane.callsign.trim().toUpperCase(), airports] : null;
    }),
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const [callsign, airports] = result.value;
    routeMap[callsign] = airports;
  }
  return routeMap;
}

function angleDiff(a, b) {
  const delta = ((b - a) % 360 + 360) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function nearestMajorAirport(plane) {
  if (plane.track == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [iata, name, lat, lon] of MAJOR_AIRPORTS) {
    const distance = haversineKm(plane.lat, plane.lng, lat, lon);
    if (distance > LANDING_AIRPORT_KM || distance >= bestDist) continue;
    const toBearing = bearingDeg(plane.lat, plane.lng, lat, lon);
    if (angleDiff(plane.track, toBearing) > 60) continue;
    best = { iata, name };
    bestDist = distance;
  }
  return best;
}

function nearestAirport(plane, airports) {
  let best = null;
  let bestDist = Infinity;
  let bestIdx = -1;
  for (let index = 0; index < airports.length; index++) {
    const airport = airports[index];
    const airportLat = airport.lat ?? airport.latitude;
    const airportLon = airport.lon ?? airport.longitude;
    if (airportLat == null || airportLon == null) continue;
    const distance = haversineKm(plane.lat, plane.lng, airportLat, airportLon);
    if (distance >= bestDist) continue;
    best = airport;
    bestDist = distance;
    bestIdx = index;
  }
  return { airport: best, dist: bestDist, idx: bestIdx };
}

function airportLabel(airport) {
  return airport.iata || airport.location || "?";
}

function formatRouteContext(plane, airports) {
  if (airports && airports.length >= 2) {
    if (plane.altFt <= LANDING_MAX_FT && (plane.vertical === "descending" || plane.vertical === "climbing")) {
      const { airport, dist, idx } = nearestAirport(plane, airports);
      if (airport && dist <= LANDING_AIRPORT_KM) {
        const name = airportLabel(airport);
        if (plane.vertical === "descending") {
          const fromAirport = idx > 0 ? airports[idx - 1] : airports[0];
          return `Landing at ${name} — from ${airportLabel(fromAirport)}`;
        }
        const toAirport = idx < airports.length - 1 ? airports[idx + 1] : airports[airports.length - 1];
        return `Departing ${name} — to ${airportLabel(toAirport)}`;
      }
    }
  }

  if (plane.altFt <= LANDING_MAX_FT && plane.vertical === "descending") {
    const match = nearestMajorAirport(plane);
    if (match) return `Landing at ${match.name}`;
  }

  if (airports && airports.length >= 2) {
    return airports.map((airport) => airportLabel(airport)).join(" → ");
  }

  return null;
}

function formatNearbyEntry(num, plane, airports) {
  const parts = [];
  const alert = SQUAWK_ALERTS[plane.squawk];
  if (alert) parts.push(`${num}. \u26A0 ${alert} (${plane.squawk})`);

  let name = plane.callsign || plane.icao24;
  if (plane.airline && plane.callsign) {
    name = plane.airline + " " + plane.callsign.substring(3);
  }
  let identifier = (alert ? "   " : `${num}. `) + name;
  if (plane.type) identifier += ` (${plane.type})`;
  if (plane.priv) identifier += " [PRIVATE]";
  parts.push(identifier);

  const routeLine = formatRouteContext(plane, airports);
  const distance = `${Math.round(plane.slantKm)} km \u2191${plane.elevDeg}\u00B0 ${plane.cardinal}`;
  let info = distance + ", " + shortAlt(plane.altFt);
  if (!routeLine) info += ", " + plane.vertical;
  if (plane.altFt >= CONTRAIL_MIN_FT) info += ", contrail likely";
  parts.push("   " + (routeLine ? `${routeLine} — ${info}` : info));

  return parts.join("\n");
}

export async function handleNearby(url) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return plainText(400, "Missing or invalid lat/lng parameters.");
  }

  const format = url.searchParams.get("format");

  let acData;
  try {
    acData = await fetchNearbyAircraft(lat, lng);
  } catch (error) {
    return plainText(502, "Aircraft data unavailable: " + error.message);
  }

  const planes = [];
  for (const snapshot of acData.ac || []) {
    const plane = buildNearbyPlane(lat, lng, snapshot);
    if (plane) planes.push(plane);
  }
  planes.sort((left, right) => left.slantKm - right.slantKm);

  const visible = selectVisiblePlanes(planes);
  const mapLink = `${MAP_URL}/?lat=${lat}&lng=${lng}&zoom=${nearbyZoom(visible)}`;

  if (!visible.length) {
    const message = "No aircraft detected nearby.";
    if (format === "text") return plainText(200, message);
    if (format === "json") return json(200, { text: message, mapUrl: mapLink, anyAircraftDetected: false });
    return nearbyHtml(message, mapLink);
  }

  let routeMap = Object.create(null);
  try {
    routeMap = await fetchRouteMap(visible);
  } catch (_) {
    routeMap = Object.create(null);
  }

  const lines = [`${visible.length} aircraft nearby:\n`];
  for (let index = 0; index < visible.length; index++) {
    const plane = visible[index];
    const routeAirports = routeMap[plane.callsign?.trim().toUpperCase()];
    lines.push(formatNearbyEntry(index + 1, plane, routeAirports));
  }
  const body = lines.join("\n");

  if (format === "text") return plainText(200, body);
  if (format === "json") return json(200, { text: body, mapUrl: mapLink, anyAircraftDetected: true });
  return nearbyHtml(body, mapLink);
}
