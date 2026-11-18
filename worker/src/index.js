import { fetchCachedRouteEntry, fetchCachedAircraft, normalizeCallsign } from "./adsbdb.js";
import { buildSchedulePayload } from "./fr24.js";
import { CORS_HEADERS, json } from "./http.js";
import { handleAirport } from "./airport.js";
import { handleNearby } from "./nearby.js";
import { mergeRoutes, detectPhase, formatRouteLabel } from "./routes.js";
import { fetchTrace } from "./traces.js";
import { configureRelay, fetchLookupResilient, fetchTraffic } from "./providers.js";
import {
  fr24CheckBackoff,
  fr24TriggerBackoff,
  fr24ResetBackoff,
  fr24CachedSearch,
  fr24Fetch,
  fr24BackoffGeneration,
} from "./fr24-backoff.js";

const PLANESPOTTERS_API = "https://api.planespotters.net/pub/photos";
const FR24_API = "https://api.flightradar24.com/common/v1";
const DATIS_API = "https://atis.info/api";

const FR24_CACHE_TTL = 300;
const PHOTO_CACHE_TTL = 86400;
const ADSBDB_CACHE_TTL = 3600;
const AIRCRAFT_CACHE_TTL = 2592000;
const DATIS_CACHE_TTL = 60;

const CONTACT_USER_AGENT = "contrails/1.0 (+https://gauravdraj.github.io/contrails/)";

// Upstream feeds serve at most 250 NM (adsb.fi rejects anything above it).
const ADSB_MAX_DIST_NM = 250;
// /routeset bodies carry at most 20 small plane records.
const ROUTESET_MAX_BODY_BYTES = 64 * 1024;

// Cache writes must outlive the response, so hand them to ctx.waitUntil; await
// them directly when there is no ctx (unit tests).
async function cachePut(ctx, cache, key, response) {
  const put = Promise.resolve().then(() => cache.put(key, response)).catch(() => {});
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(put);
  else await put;
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    configureRelay(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/adsb/")) return proxyAdsb(url, env, ctx);
    if (url.pathname.startsWith("/photo/")) return handlePhoto(url, ctx);
    if (url.pathname === "/routeset") return handleRouteset(request, env, ctx);
    if (url.pathname.startsWith("/track/")) return handleTrack(url, env, ctx);
    if (url.pathname.startsWith("/aircraft/")) return handleAircraft(url, ctx);
    if (url.pathname === "/geo") return handleGeo(request);
    if (url.pathname.startsWith("/datis/")) return handleDatis(url, ctx);
    if (url.pathname.startsWith("/schedule/")) return handleSchedule(url, ctx);
    if (url.pathname.startsWith("/fr24search/")) return handleFr24Search(url, ctx);
    if (url.pathname === "/nearby") return handleNearby(url, env, ctx);
    if (url.pathname.startsWith("/airport/")) return handleAirport(url, env, ctx);

    return json(404, { error: "Not found" });
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

export function snapAdsbGrid(lat, lon, dist) {
  return {
    lat: Math.round(lat / 0.05) * 0.05,
    lon: Math.round(lon / 0.05) * 0.05,
    dist: Math.ceil(dist / 25) * 25,
  };
}

async function proxyAdsb(url, env, ctx) {
  const parts = url.pathname.slice("/adsb".length).split("/");
  const latIdx = parts.indexOf("lat");
  const lonIdx = parts.indexOf("lon");
  const distIdx = parts.indexOf("dist");

  if (latIdx === -1 || lonIdx === -1 || distIdx === -1) {
    return proxyAdsbLookup(url, ctx);
  }

  const lat = parseFloat(parts[latIdx + 1]);
  let lon = parseFloat(parts[lonIdx + 1]);
  let dist = parseFloat(parts[distIdx + 1]);

  if (!isFinite(lat) || !isFinite(lon) || !isFinite(dist) || lat < -90 || lat > 90 || dist <= 0) {
    return json(400, { error: "Invalid coordinates" });
  }
  // Installed older frontends can send an unwrapped longitude after panning
  // across the antimeridian, and the boot prefetch in index.html asks for up
  // to ~274 NM, so normalize those instead of rejecting them.
  if (lon < -180 || lon > 180) lon = ((lon + 180) % 360 + 360) % 360 - 180;
  dist = Math.min(dist, ADSB_MAX_DIST_NM);

  const snapped = snapAdsbGrid(lat, lon, dist);
  const gridPath = "/lat/" + snapped.lat.toFixed(2) + "/lon/" + snapped.lon.toFixed(2) + "/dist/" + snapped.dist;
  const cacheKey = new Request("https://adsb-grid" + gridPath);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const result = await fetchTraffic(gridPath, snapped, env);
  if (!result) return json(502, { error: "Traffic data unavailable" });

  const body = JSON.stringify(result);
  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "s-maxage=3",
      ...CORS_HEADERS,
    },
  });

  await cachePut(ctx, cache, cacheKey, response.clone());
  return response;
}

// Only the lookups the app uses (search by hex or callsign) are proxied, so the
// Worker can't be used as a general-purpose adsb.lol proxy.
const ADSB_LOOKUP_PATTERNS = {
  hex: /^[0-9a-f]{6}$/,
  callsign: /^[A-Z0-9]{2,8}$/,
};

async function proxyAdsbLookup(url, ctx) {
  const match = url.pathname.match(/^\/adsb\/(hex|callsign)\/([^/]+)$/);
  if (!match) return json(404, { error: "Not found" });
  const kind = match[1];
  let raw;
  try {
    raw = decodeURIComponent(match[2]).trim();
  } catch (_) {
    return json(400, { error: "Invalid " + kind });
  }
  const value = kind === "hex" ? raw.toLowerCase() : raw.toUpperCase();
  if (!ADSB_LOOKUP_PATTERNS[kind].test(value)) return json(400, { error: "Invalid " + kind });

  const cacheKey = new Request("https://adsb-lookup/" + kind + "/" + value);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchLookupResilient(kind, value);
    const response = new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=5", ...CORS_HEADERS },
    });
    await cachePut(ctx, cache, cacheKey, response.clone());
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handlePhoto(url, ctx) {
  const hex = url.pathname.split("/").pop().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: "Invalid hex" });

  const cache = caches.default;
  // Canonical key: query strings and hex case must not bust the cache.
  const cacheKey = new Request("https://photo-cache/" + hex);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetch(`${PLANESPOTTERS_API}/hex/${hex}`, {
      headers: { "User-Agent": CONTACT_USER_AGENT },
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
  const track = await fetchTrace(hex, cache, ctx);
  if (!track?.path) return json(200, null);
  return json(200, track.path);
}

async function handleAircraft(url, ctx) {
  const hex = url.pathname.split("/").pop().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: "Invalid hex" });

  const cache = caches.default;
  try {
    const entry = await fetchCachedAircraft(hex, cache, ctx, AIRCRAFT_CACHE_TTL);
    const response = json(200, entry || null);
    response.headers.set("Cache-Control", `s-maxage=${AIRCRAFT_CACHE_TTL}`);
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

function normalizeDatisAirportCode(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(raw)) return "K" + raw;
  if (/^[A-Z]{4}$/.test(raw)) return raw;
  return null;
}

async function handleDatis(url, ctx) {
  const code = normalizeDatisAirportCode(url.pathname.split("/").pop());
  if (!code) return json(400, { error: "Invalid airport code" });

  const cache = caches.default;
  const cacheKey = new Request("https://datis-cache/" + code);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const resp = await fetch(`${DATIS_API}/${encodeURIComponent(code)}`, {
      headers: { "User-Agent": CONTACT_USER_AGENT },
    });
    if (!resp.ok) throw new Error("D-ATIS HTTP " + resp.status);
    const data = await resp.json();
    const row = Array.isArray(data) ? data[0] : data;
    const body = {
      airport: code,
      type: row?.type || null,
      code: row?.code || null,
      datis: row?.datis || "",
      time: row?.time || null,
      updatedAt: row?.updatedAt || null,
      source: "datis",
    };
    const response = json(200, body);
    response.headers.set("Cache-Control", `s-maxage=${DATIS_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function handleRouteset(request, env, ctx) {
  if (request.method !== "POST") return json(405, { error: "POST required" });

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > ROUTESET_MAX_BODY_BYTES) return json(413, { error: "Body too large" });

  let planes;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > ROUTESET_MAX_BODY_BYTES) return json(413, { error: "Body too large" });
    const body = JSON.parse(new TextDecoder().decode(buf));
    planes = body.planes;
  } catch (_) {
    return json(400, { error: "Invalid JSON" });
  }
  if (!Array.isArray(planes) || !planes.length) return json(400, { error: "No planes" });

  const cache = caches.default;
  const limited = planes.slice(0, 20);

  const results = await Promise.allSettled(
    limited.map(async (plane) => {
      // Callsigns reach the ADSBDB URL and cache key; drop planes without a valid one.
      const callsign = normalizeCallsign(plane?.callsign);
      if (!callsign) return null;
      const [trackResult, adsbdbResult] = await Promise.allSettled([
        plane.hex ? fetchTrace(plane.hex, cache, ctx) : Promise.resolve(null),
        fetchCachedRouteEntry(callsign, cache, ctx, ADSBDB_CACHE_TTL),
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

  const data = await fr24CachedSearch(query, ctx);
  if (data) return json(200, data);
  if (await fr24CheckBackoff()) return json(503, { error: "FR24 temporarily unavailable" });
  return json(502, { error: "FR24 search failed" });
}

async function handleSchedule(url, ctx) {
  const iata = url.pathname.split("/").pop().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(iata)) return json(400, { error: "Invalid airport code" });

  const cache = caches.default;
  // Canonical key: arbitrary query strings must not bust the cache.
  const cacheKey = new Request("https://schedule-cache/" + iata);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (await fr24CheckBackoff()) return json(503, { error: "FR24 temporarily unavailable" });

  try {
    const lookback = Math.floor(Date.now() / 1000) - 2 * 3600;
    const base = `${FR24_API}/airport.json?code=${encodeURIComponent(iata)}&plugin[]=schedule&plugin[]=details&limit=100&plugin-setting[schedule][timestamp]=${lookback}`;
    const startGeneration = fr24BackoffGeneration();
    // Page 2 is optional: its failure must not discard a good page 1.
    const [r1, r2] = await Promise.all([
      fr24Fetch(base + "&page=1"),
      fr24Fetch(base + "&page=2").catch(() => null),
    ]);
    if (r1.status === 429 || r1.status === 403) {
      fr24TriggerBackoff(ctx);
      return json(503, { error: "FR24 rate limited" });
    }
    if (!r1.ok) throw new Error("FR24 HTTP " + r1.status);

    const raw1 = await r1.json();
    const result = buildSchedulePayload(raw1, iata);
    fr24ResetBackoff(ctx, startGeneration);

    if (r2 && (r2.status === 429 || r2.status === 403)) {
      fr24TriggerBackoff(ctx);
    } else if (r2 && r2.ok) {
      try {
        const raw2 = await r2.json();
        const page2 = buildSchedulePayload(raw2, iata);
        result.arrivals = result.arrivals.concat(page2.arrivals);
        result.departures = result.departures.concat(page2.departures);
      } catch (_) {
        // keep page 1
      }
    }

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}
