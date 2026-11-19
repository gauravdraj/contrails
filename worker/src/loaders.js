import { fetchTraffic, fetchLookupResilient } from "./providers.js";
import { buildSchedulePayload } from "./fr24.js";
import { CORS_HEADERS, json, cachePut } from "./http.js";
import { fr24CheckBackoff, fr24TriggerBackoff, fr24ResetBackoff, fr24CachedSearch,
  fr24Fetch, fr24BackoffGeneration } from "./fr24-backoff.js";

const FR24_API = "https://api.flightradar24.com/common/v1";
const DATIS_API = "https://atis.info/api";
const FR24_CACHE_TTL = 300;
const DATIS_CACHE_TTL = 60;
const CONTACT_USER_AGENT = "contrails/1.0 (+https://gauravdraj.github.io/contrails/)";
const SCHEDULE_COMPLETE = "X-Contrails-Schedule-Complete";
const SCHEDULE_STATUS = "X-Contrails-Schedule-Status";
const scheduleShape = data => Array.isArray(data?.arrivals) && Array.isArray(data?.departures);
function rawScheduleShape(raw) {
  const schedule = raw?.result?.response?.airport?.pluginData?.schedule;
  return Array.isArray(schedule?.arrivals?.data) && Array.isArray(schedule?.departures?.data);
}

export function snapAdsbGrid(lat, lon, dist) {
  return {
    lat: Math.round(lat / 0.05) * 0.05,
    lon: Math.round(lon / 0.05) * 0.05,
    dist: Math.ceil(dist / 25) * 25,
  };
}

async function trafficResponse(lat, lon, dist, env, ctx) {
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

async function lookupResponse(kind, value, ctx) {
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

export function normalizeDatisAirportCode(code) {
  const raw = String(code || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(raw)) return "K" + raw;
  if (/^[A-Z]{4}$/.test(raw)) return raw;
  return null;
}

async function datisResponse(code, ctx) {
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
    await cachePut(ctx, cache, cacheKey, response.clone());
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

async function scheduleResponse(iata, ctx) {
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
    let status = rawScheduleShape(raw1) ? "ok" : "error";
    fr24ResetBackoff(ctx, startGeneration);

    if (r2 && (r2.status === 429 || r2.status === 403)) {
      status = "backoff";
      fr24TriggerBackoff(ctx);
    } else if (r2 && r2.ok) {
      try {
        const raw2 = await r2.json();
        const page2 = buildSchedulePayload(raw2, iata);
        if (!rawScheduleShape(raw2)) status = "error";
        result.arrivals = result.arrivals.concat(page2.arrivals);
        result.departures = result.departures.concat(page2.departures);
      } catch (_) {
        status = "error";
        // keep page 1
      }
    } else status = "error";

    const response = json(200, result);
    response.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
    // Health and payload must survive eviction and overlapping writes together.
    response.headers.set(SCHEDULE_COMPLETE, status === "ok" ? "1" : "0");
    response.headers.set(SCHEDULE_STATUS, status);
    await cachePut(ctx, cache, cacheKey, response.clone());
    return response;
  } catch (error) {
    return json(502, { error: error.message });
  }
}

// Keep the original wire response for PWA callers, including cache-hit headers.
// New callers consume data/status without calling this Worker's HTTP endpoints.
async function loaded(response, valid = () => true) {
  let data;
  try { data = await response.clone().json(); } catch (_) { return { status: "error", data: null, response }; }
  if (response.ok && !valid(data)) return { status: "error", data: null, response };
  return { status: response.ok ? "ok" : response.status === 503 ? "backoff" : "error",
    data: response.ok ? data : null, response };
}
export async function loadTraffic(lat, lng, dist, env, ctx) {
  return loaded(await trafficResponse(lat, lng, dist, env, ctx));
}
export async function loadLookup(kind, value, ctx) {
  return loaded(await lookupResponse(kind, value, ctx), data => Array.isArray(data?.ac));
}
export async function loadSchedule(iata, ctx) {
  const result = await loaded(await scheduleResponse(iata, ctx), scheduleShape);
  const complete = result.response.headers.get(SCHEDULE_COMPLETE);
  result.complete = complete === "1" ? true : complete === "0" ? false : null;
  if (result.status === "ok" && result.complete === false) {
    result.status = result.response.headers.get(SCHEDULE_STATUS) === "backoff" ? "backoff" : "error";
  }
  // An optional page can be rate limited while page 1 still serves the PWA.
  if (result.status === "ok" && await fr24CheckBackoff()) result.status = "backoff";
  return result;
}
export function publicScheduleResponse(response) {
  const publicResponse = new Response(response.body, response);
  publicResponse.headers.delete(SCHEDULE_COMPLETE);
  publicResponse.headers.delete(SCHEDULE_STATUS);
  return publicResponse;
}
export async function loadDatis(code, ctx) {
  return loaded(await datisResponse(normalizeDatisAirportCode(code), ctx));
}
export async function loadSearch(query, ctx) {
  const data = await fr24CachedSearch(query, ctx);
  // Preserve the raw body for the legacy search handler, but mark invalid data.
  return { data, status: data ? Array.isArray(data.results) ? "ok" : "error" : await fr24CheckBackoff() ? "backoff" : "error" };
}
