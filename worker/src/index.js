import { fetchCachedRouteEntry } from "./adsbdb.js";
import { buildSchedulePayload } from "./fr24.js";
import { CORS_HEADERS, json, jsonFromCache } from "./http.js";
import { handleNearby } from "./nearby.js";

const ADSB_API = "https://api.adsb.lol/v2";
const ADSB_ROUTE_API = "https://api.adsb.lol/api/0";
const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos";
const FR24_API = "https://api.flightradar24.com/common/v1";
const AERODATABOX_API = "https://aerodatabox.p.rapidapi.com";

const FR24_CACHE_TTL = 120;
const PHOTO_CACHE_TTL = 86400;
const ADSBDB_CACHE_TTL = 3600;
const FLIGHT_CACHE_TTL = 14400;

const JSON_PROXY_HEADERS = {
  "User-Agent": "contrails/1.0",
  "Content-Type": "application/json",
};

const FR24_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/adsb/")) return proxyAdsb(url);
    if (url.pathname.startsWith("/route/")) return proxyRoute(url, request);
    if (url.pathname.startsWith("/photo/")) return handlePhoto(url, ctx);
    if (url.pathname === "/routeset") return handleRouteset(request, ctx);
    if (url.pathname.startsWith("/flight/")) return handleFlight(url, env, ctx);
    if (url.pathname === "/geo") return handleGeo(request);
    if (url.pathname.startsWith("/schedule/")) return handleSchedule(url, ctx);
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
    source: "ip",
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
      headers: JSON_PROXY_HEADERS,
      body,
    });
    const data = await resp.arrayBuffer();
    return new Response(data, {
      status: resp.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handlePhoto(url, ctx) {
  const hex = url.pathname.split("/").pop().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: "Invalid hex" });

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetch(`${PLANESPOTTERS_API}/hex/${hex}`, {
      headers: { "User-Agent": "contrails/1.0" },
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const data = await resp.json();
    const photo = (data.photos || [])[0];
    const result = photo
      ? {
          src: (photo.thumbnail_large || photo.thumbnail || {}).src || null,
          width: (photo.thumbnail_large || photo.thumbnail || {}).size?.width || null,
          height: (photo.thumbnail_large || photo.thumbnail || {}).size?.height || null,
          link: photo.link || null,
          photographer: photo.photographer || null,
        }
      : null;

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${PHOTO_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handleRouteset(request, ctx) {
  if (request.method !== "POST") return json(405, { error: "POST required" });

  let planes;
  try {
    const body = await request.json();
    planes = body.planes;
  } catch (_) {
    return json(400, { error: "Invalid JSON" });
  }
  if (!Array.isArray(planes) || !planes.length) return json(400, { error: "No planes" });

  const cache = caches.default;
  const limited = planes.slice(0, 20);
  const results = await Promise.allSettled(
    limited.map((plane) => fetchCachedRouteEntry(plane.callsign, cache, ctx, ADSBDB_CACHE_TTL)),
  );

  const routes = results
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter(Boolean);
  return json(200, routes);
}

async function handleFlight(url, env, ctx) {
  const callsign = url.pathname.split("/").pop().toUpperCase();
  if (!callsign || callsign.length < 3) return json(400, { error: "Invalid callsign" });

  const apiKey = env.AERODATABOX_KEY;
  if (!apiKey) return json(501, { error: "AeroDataBox not configured" });

  const cache = caches.default;
  const cacheKey = new Request(`https://flight-cache/${callsign}`);
  const cached = await cache.match(cacheKey);
  if (cached) return jsonFromCache(cached);

  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dateFrom = yesterday.toISOString().slice(0, 10);
    const dateTo = now.toISOString().slice(0, 10);
    const resp = await fetch(
      `${AERODATABOX_API}/flights/callsign/${callsign}/${dateFrom}/${dateTo}?withAircraftImage=false&withLocation=false`,
      {
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
        },
      },
    );
    if (resp.status === 204 || resp.status === 404) return json(200, null);
    if (!resp.ok) throw new Error("HTTP " + resp.status);

    const flights = await resp.json();
    const active = Array.isArray(flights)
      ? flights.find((flight) => (
          flight.status === "EnRoute" ||
          flight.status === "Started" ||
          flight.status === "Unknown"
        )) || flights[0]
      : flights;

    if (!active) return json(200, null);

    const dep = active.departure || {};
    const arr = active.arrival || {};
    const result = {
      callsign,
      origin: {
        iata: dep.airport?.iata || "",
        name: dep.airport?.municipalityName || dep.airport?.name || "",
      },
      destination: {
        iata: arr.airport?.iata || "",
        name: arr.airport?.municipalityName || arr.airport?.name || "",
      },
      status: active.status || null,
      airline: active.airline?.name || null,
    };

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FLIGHT_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handleSchedule(url, ctx) {
  const iata = url.pathname.split("/").pop().toUpperCase();
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const fr24Url =
      `${FR24_API}/airport.json?code=${encodeURIComponent(iata)}` +
      "&plugin[]=schedule&plugin[]=details&limit=100&page=1";
    const resp = await fetch(fr24Url, { headers: FR24_HEADERS });
    if (!resp.ok) throw new Error("FR24 HTTP " + resp.status);

    const raw = await resp.json();
    const result = buildSchedulePayload(raw, iata);
    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}
