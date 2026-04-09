import { MAJOR_AIRPORTS } from "./airports.js";

const ADSB_API = "https://api.adsb.lol/v2";
const ADSB_ROUTE_API = "https://api.adsb.lol/api/0";
const FR24_API = "https://api.flightradar24.com/common/v1";
const FR24_CACHE_TTL = 120;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname.startsWith("/adsb/")) return proxyAdsb(url);
    if (url.pathname.startsWith("/route/")) return proxyRoute(url, request);
    if (url.pathname === "/geo") return handleGeo(request);
    if (url.pathname.startsWith("/schedule/")) return handleSchedule(url, request, ctx);
    if (url.pathname === "/nearby") return handleNearby(url);

    return new Response("Not found", { status: 404 });
  },
};

function handleGeo(request) {
  const cf = request.cf || {};
  const lat = parseFloat(cf.latitude);
  const lng = parseFloat(cf.longitude);
  if (!isFinite(lat) || !isFinite(lng)) {
    return json(503, { error: "Approximate location unavailable" });
  }
  return json(200, {
    lat,
    lng,
    city: cf.city || "",
    region: cf.region || "",
    country: cf.country || "",
    timezone: cf.timezone || "",
    approximate: true,
    source: "ip"
  });
}

async function proxyAdsb(url) {
  const path = url.pathname.slice("/adsb".length);
  return proxy(ADSB_API + path + url.search, "GET");
}

async function proxyRoute(url, request) {
  const path = url.pathname.slice("/route".length);
  const body = request.method === "POST" ? await request.text() : null;
  return proxy(ADSB_ROUTE_API + path + url.search, request.method, body);
}

async function proxy(target, method, body) {
  try {
    const resp = await fetch(target, {
      method,
      headers: { "User-Agent": "contrails/1.0", "Content-Type": "application/json" },
      body,
    });
    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json(502, { error: e.message });
  }
}

async function handleSchedule(url, request, ctx) {
  const iata = url.pathname.split("/").pop().toUpperCase();

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const fr24Url =
      `${FR24_API}/airport.json?code=${encodeURIComponent(iata)}` +
      "&plugin[]=schedule&plugin[]=details&limit=100&page=1";
    const resp = await fetch(fr24Url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)" },
    });
    if (!resp.ok) throw new Error("FR24 HTTP " + resp.status);
    const raw = await resp.json();

    const plugin = raw?.result?.response?.airport?.pluginData || {};
    const sched = plugin.schedule || {};
    const detail = plugin.details || {};

    const result = {
      iata,
      name: detail.name || iata,
      arrivals: extractFlights(sched.arrivals?.data || [], "arrival"),
      departures: extractFlights(sched.departures?.data || [], "departure"),
    };

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    return json(502, { error: e.message });
  }
}

function extractFlights(data, direction) {
  return data.map((item) => {
    const f = item.flight || {};
    const ident = f.identification || {};
    const status = f.status || {};
    const ac = f.aircraft || {};
    const airline = f.airline || {};
    const ap = f.airport || {};
    const t = f.time || {};
    const gen = (status.generic?.status) || {};

    const entry = {
      flight: ident.number?.default || "",
      callsign: ident.callsign || "",
      airline: airline.short || airline.name || "",
      ac_code: ac.model?.code || "",
      ac_name: ac.model?.text || "",
      reg: ac.registration || "",
      status: status.text || "",
      color: gen.color || "",
      sched_dep: t.scheduled?.departure || null,
      sched_arr: t.scheduled?.arrival || null,
      est_dep: t.estimated?.departure || null,
      est_arr: t.estimated?.arrival || null,
      actual_dep: t.real?.departure || null,
      actual_arr: t.real?.arrival || null,
      live: status.live || false,
    };

    if (direction === "arrival") {
      const origin = ap.origin || {};
      entry.from_iata = origin.code?.iata || "";
      entry.from_name = origin.name || "";
    } else {
      const dest = ap.destination || {};
      entry.to_iata = dest.code?.iata || "";
      entry.to_name = dest.name || "";
    }

    return entry;
  });
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function plainText(status, body) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
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
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
  });
}

// --- Nearby: Siri plane spotter ---

const MAP_URL = "https://gauravdraj.github.io/contrails";
const NEARBY_RADIUS_NM = 25;
const MAX_SLANT_KM = 35;
const MAX_NEARBY_RESULTS = 5;
const CONTRAIL_MIN_FT = 25000;
const LANDING_MAX_FT = 10000;
const LANDING_AIRPORT_KM = 50;
const VERT_RATE_THRESHOLD = 300;

const NEARBY_AIRLINES = {
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
  XAX:"AirAsia X",
};

const SQUAWK_ALERTS = { "7700": "EMERGENCY", "7600": "RADIO FAILURE", "7500": "HIJACK" };

const PRIV_REG = /^(N\d|C-[FGFI]|G-|D-|F-|I-|EC-|HB-|OE-|PH-|SE-|OH-|OY-|LN-|EI-|CS-|SX-|TC-|VH-|ZK-|PP-|PT-|PR-|JA|B-|HL|VT-|9V-|A[267]-|SU-|5[ABHNXY]-|ZS-|VP-|V[5HPQR]-|RP-|HS-|9M-|PK-|XA-|XB-|LV-|CC-|TI-|HP-|HK-|YV-)/i;
const PRIV_ANON_HEX = /^~[0-9a-f]{4,}$/i;
const PRIV_HEXLIKE = /^(?:~)?[0-9a-f]{6}$/i;

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function nearbyAirlineName(callsign) {
  if (!callsign || callsign.length < 3) return null;
  return NEARBY_AIRLINES[callsign.substring(0, 3).toUpperCase()] || null;
}

function isLikelyPrivate(callsign) {
  if (!callsign) return false;
  if (PRIV_REG.test(callsign) || PRIV_ANON_HEX.test(callsign)) return true;
  if (!nearbyAirlineName(callsign) && PRIV_HEXLIKE.test(callsign)) return true;
  return false;
}

function verticalState(rate) {
  if (rate == null || Math.abs(rate) < VERT_RATE_THRESHOLD) return "level";
  return rate > 0 ? "climbing" : "descending";
}

function commaNum(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

async function handleNearby(url) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return plainText(400, "Missing or invalid lat/lng parameters.");
  }

  const fmt = url.searchParams.get("format");

  let acData;
  try {
    const resp = await fetch(
      `${ADSB_API}/lat/${lat.toFixed(4)}/lon/${lng.toFixed(4)}/dist/${NEARBY_RADIUS_NM}`,
      { headers: { "User-Agent": "contrails/1.0" } },
    );
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    acData = await resp.json();
  } catch (e) {
    return plainText(502, "Aircraft data unavailable: " + e.message);
  }

  const planes = [];
  for (const s of (acData.ac || [])) {
    if (s.alt_baro === "ground" || s.alt_baro == null) continue;
    if (s.lat == null || s.lon == null) continue;
    if (typeof s.alt_baro !== "number") continue;

    const callsign = (s.flight || "").trim() || null;
    const groundKm = haversineKm(lat, lng, s.lat, s.lon);
    const altFt = Math.round(s.alt_baro);
    const altKm = altFt * 0.0003048;
    const slant = Math.sqrt(groundKm * groundKm + altKm * altKm);

    if (slant > MAX_SLANT_KM) continue;

    const brg = bearingDeg(lat, lng, s.lat, s.lon);
    planes.push({
      callsign,
      icao24: s.hex,
      type: s.t || null,
      registration: s.r || null,
      lat: s.lat,
      lng: s.lon,
      altFt,
      speedKts: s.gs != null ? Math.round(s.gs) : null,
      vRate: s.baro_rate || null,
      squawk: s.squawk || null,
      track: s.track != null ? Math.round(s.track) : null,
      slantKm: Math.round(slant * 10) / 10,
      elevDeg: Math.round(Math.atan2(altKm, Math.max(groundKm, 0.001)) * 180 / Math.PI),
      cardinal: CARDINALS[Math.round(brg / 45) % 8],
      vertical: verticalState(s.baro_rate),
      priv: isLikelyPrivate(callsign),
      airline: nearbyAirlineName(callsign),
    });
  }

  planes.sort((a, b) => a.slantKm - b.slantKm);

  // Gap-based visibility filter
  const visible = [];
  if (planes.length) {
    const threshold = Math.max(planes[0].slantKm * 3, 5);
    for (const p of planes) {
      if (visible.length >= MAX_NEARBY_RESULTS) break;
      if (p.slantKm > threshold && visible.length > 0) break;
      visible.push(p);
    }
  }

  const mapLink = `${MAP_URL}/?lat=${lat}&lng=${lng}&zoom=${nearbyZoom(visible)}`;

  if (!visible.length) {
    const msg = "No aircraft detected nearby.";
    if (fmt === "text") return plainText(200, msg);
    if (fmt === "json") return json(200, { text: msg, mapUrl: mapLink, anyAircraftDetected: false });
    return nearbyHtml(msg, mapLink);
  }

  // Fetch routes for non-private planes with callsigns
  const routeMap = {};
  const routable = visible.filter(p => p.callsign && !p.priv);
  if (routable.length) {
    try {
      const resp = await fetch(`${ADSB_ROUTE_API}/routeset`, {
        method: "POST",
        headers: { "User-Agent": "contrails/1.0", "Content-Type": "application/json" },
        body: JSON.stringify({
          planes: routable.map(p => ({ callsign: p.callsign, lat: p.lat, lng: p.lng })),
        }),
      });
      if (resp.ok) {
        for (const r of await resp.json()) {
          if (!r.callsign || !r._airports || r._airports.length < 2) continue;
          routeMap[r.callsign] = r._airports;
        }
      }
    } catch (_) { /* routes are optional enrichment */ }
  }

  const lines = [`${visible.length} aircraft nearby:\n`];
  for (let i = 0; i < visible.length; i++) {
    lines.push(formatNearbyEntry(i + 1, visible[i], routeMap[visible[i].callsign]));
  }
  const body = lines.join("\n");

  if (fmt === "text") return plainText(200, body);
  if (fmt === "json") return json(200, { text: body, mapUrl: mapLink, anyAircraftDetected: true });
  return nearbyHtml(body, mapLink);
}

function shortAlt(ft) {
  if (Math.abs(ft) >= 1000) return `${(ft / 1000).toFixed(1).replace(/\.0$/, "")}k ft`;
  return `${ft} ft`;
}

function formatNearbyEntry(num, p, airports) {
  const parts = [];

  const alert = SQUAWK_ALERTS[p.squawk];
  if (alert) parts.push(`${num}. \u26A0 ${alert} (${p.squawk})`);

  let name = p.callsign || p.icao24;
  if (p.airline && p.callsign) {
    name = p.airline + " " + p.callsign.substring(3);
  }
  let id = (alert ? "   " : `${num}. `) + name;
  if (p.type) id += ` (${p.type})`;
  if (p.priv) id += " [PRIVATE]";
  parts.push(id);

  const routeLine = formatRouteContext(p, airports);
  const dist = `${Math.round(p.slantKm)} km \u2191${p.elevDeg}\u00B0 ${p.cardinal}`;
  let info = dist + ", " + shortAlt(p.altFt);
  if (!routeLine) info += ", " + p.vertical;
  if (p.altFt >= CONTRAIL_MIN_FT) info += ", contrail likely";
  parts.push("   " + (routeLine ? `${routeLine} \u2014 ${info}` : info));

  return parts.join("\n");
}

function angleDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function nearestMajorAirport(p) {
  if (p.track == null) return null;
  let best = null;
  let bestDist = Infinity;
  for (const [iata, name, lat, lon] of MAJOR_AIRPORTS) {
    const d = haversineKm(p.lat, p.lng, lat, lon);
    if (d > LANDING_AIRPORT_KM || d >= bestDist) continue;
    const toBearing = bearingDeg(p.lat, p.lng, lat, lon);
    if (angleDiff(p.track, toBearing) > 60) continue;
    best = { iata, name };
    bestDist = d;
  }
  return best;
}

function nearestAirport(p, airports) {
  let best = null;
  let bestDist = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < airports.length; i++) {
    const a = airports[i];
    const aLat = a.lat ?? a.latitude;
    const aLon = a.lon ?? a.longitude;
    if (aLat == null || aLon == null) continue;
    const d = haversineKm(p.lat, p.lng, aLat, aLon);
    if (d < bestDist) { best = a; bestDist = d; bestIdx = i; }
  }
  return { airport: best, dist: bestDist, idx: bestIdx };
}

function formatRouteContext(p, airports) {
  if (airports && airports.length >= 2) {
    if (p.altFt <= LANDING_MAX_FT && (p.vertical === "descending" || p.vertical === "climbing")) {
      const { airport, dist, idx } = nearestAirport(p, airports);
      if (airport && dist <= LANDING_AIRPORT_KM) {
        const name = airport.location || airport.iata || "?";
        if (p.vertical === "descending") {
          const fromAirport = idx > 0 ? airports[idx - 1] : airports[0];
          const fromName = fromAirport.location || fromAirport.iata || "?";
          return `Landing at ${name} — from ${fromName}`;
        }
        const toAirport = idx < airports.length - 1 ? airports[idx + 1] : airports[airports.length - 1];
        const toName = toAirport.location || toAirport.iata || "?";
        return `Departing ${name} — to ${toName}`;
      }
    }
  }

  if (p.altFt <= LANDING_MAX_FT && p.vertical === "descending") {
    const match = nearestMajorAirport(p);
    if (match) return `Landing at ${match.name}`;
  }

  if (airports && airports.length >= 2) {
    return airports.map(a => a.location || a.iata).join(" → ");
  }

  return null;
}
