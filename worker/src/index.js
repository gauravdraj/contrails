import { fetchCachedRouteEntry } from "./adsbdb.js";
import { buildSchedulePayload } from "./fr24.js";
import { CORS_HEADERS, json } from "./http.js";
import { handleNearby } from "./nearby.js";
import { fetchCachedTrack, mergeRoutes, detectPhase, formatRouteLabel } from "./opensky.js";

const ADSB_API = "https://api.adsb.lol/v2";
const ADSB_ROUTE_API = "https://api.adsb.lol/api/0";
const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos";
const FR24_API = "https://api.flightradar24.com/common/v1";

const FR24_CACHE_TTL = 120;
const PHOTO_CACHE_TTL = 86400;
const ADSBDB_CACHE_TTL = 3600;

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
    if (url.pathname === "/routeset") return handleRouteset(request, env, ctx);
    if (url.pathname.startsWith("/track/")) return handleTrack(url, env, ctx);
    if (url.pathname === "/geo") return handleGeo(request);
    if (url.pathname.startsWith("/schedule/")) return handleSchedule(url, ctx);
    if (url.pathname.startsWith("/fr24search/")) return handleFr24Search(url, ctx);
    if (url.pathname === "/nearby") return handleNearby(url, env, ctx);

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

async function handleTrack(url, env, ctx) {
  const hex = url.pathname.split("/").pop().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: "Invalid hex" });

  const cache = caches.default;
  const track = await fetchCachedTrack(hex, cache, ctx, env);
  if (!track?.path) return json(200, null);
  return json(200, track.path);
}

async function handleRouteset(request, env, ctx) {
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
    limited.map(async (plane) => {
      const [trackResult, adsbdbResult] = await Promise.allSettled([
        plane.hex ? fetchCachedTrack(plane.hex, cache, ctx, env) : Promise.resolve(null),
        fetchCachedRouteEntry(plane.callsign, cache, ctx, ADSBDB_CACHE_TTL),
      ]);
      const track = trackResult.status === "fulfilled" ? trackResult.value : null;
      const adsbdb = adsbdbResult.status === "fulfilled" ? adsbdbResult.value : null;
      const merged = mergeRoutes(track, adsbdb, { callsign: plane.callsign, altFt: plane.altFt, vRate: plane.vRate });
      if (!merged) return null;
      const phase = detectPhase(plane.altFt, plane.vRate, plane.ground);
      return {
        callsign: plane.callsign,
        ...merged,
        phase,
        display: formatRouteLabel(merged.origin, merged.destination, phase),
      };
    }),
  );

  const routes = results
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter(Boolean);
  return json(200, routes);
}

async function handleFr24Search(url, ctx) {
  const query = url.pathname.split("/").pop();
  if (!/^[A-Za-z0-9]{2,10}$/.test(query)) return json(400, { error: "Invalid query" });

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const searchUrl = `https://www.flightradar24.com/v1/search/web/find?query=${encodeURIComponent(query)}&limit=8`;
    const resp = await fetch(searchUrl, { headers: FR24_HEADERS });
    if (!resp.ok) throw new Error("FR24 HTTP " + resp.status);

    const data = await resp.json();
    const response = json(200, data);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handleSchedule(url, ctx) {
  const iata = url.pathname.split("/").pop().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(iata)) return json(400, { error: "Invalid airport code" });

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const lookback = Math.floor(Date.now() / 1000) - 2 * 3600;
    const base = `${FR24_API}/airport.json?code=${encodeURIComponent(iata)}&plugin[]=schedule&plugin[]=details&limit=100&plugin-setting[schedule][timestamp]=${lookback}`;
    const [r1, r2] = await Promise.all([
      fetch(base + "&page=1", { headers: FR24_HEADERS }),
      fetch(base + "&page=2", { headers: FR24_HEADERS }),
    ]);
    if (!r1.ok) throw new Error("FR24 HTTP " + r1.status);

    const raw1 = await r1.json();
    const result = buildSchedulePayload(raw1, iata);

    if (r2.ok) {
      const raw2 = await r2.json();
      const page2 = buildSchedulePayload(raw2, iata);
      result.arrivals = result.arrivals.concat(page2.arrivals);
      result.departures = result.departures.concat(page2.departures);
    }

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}
