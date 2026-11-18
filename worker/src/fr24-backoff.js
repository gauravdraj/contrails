import { fetchFr24ViaRelay } from "./providers.js";

let backoffUntil = 0;
let backoffDelay = 10000;
// Bumped each time a new backoff window starts, so a request that began before
// it can tell its own success is stale news (see fr24ResetBackoff).
let backoffGeneration = 0;

const BACKOFF_CACHE_KEY = new Request('https://fr24-backoff-state/global');
const SEARCH_CACHE_TTL = 300;
const FR24_TIMEOUT_MS = 8000;

export const FR24_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0; +https://gauravdraj.github.io/contrails/)" };

// FR24 intermittently 403s/429s Cloudflare egress; retry those through the relay,
// as well as 5xx, network errors and timeouts. Other 4xx are returned as-is.
export async function fr24Fetch(url) {
  let resp;
  try {
    resp = await fetch(url, { headers: FR24_HEADERS, signal: AbortSignal.timeout(FR24_TIMEOUT_MS) });
  } catch (err) {
    const relayed = await fetchFr24ViaRelay(url);
    if (relayed && relayed.ok) return relayed;
    throw err;
  }
  if (resp.status !== 429 && resp.status !== 403 && resp.status < 500) return resp;
  const relayed = await fetchFr24ViaRelay(url);
  return relayed && relayed.ok ? relayed : resp;
}

export function fr24BackoffGeneration() {
  return backoffGeneration;
}

export async function fr24CheckBackoff() {
  if (Date.now() < backoffUntil) return true;

  try {
    const cache = caches.default;
    const cached = await cache.match(BACKOFF_CACHE_KEY);
    if (cached) {
      const { until } = await cached.json();
      if (until > Date.now()) {
        // Importing another isolate's window counts as a new backoff here, so
        // requests that began before it can't clear it (see fr24ResetBackoff).
        if (until > backoffUntil) backoffGeneration++;
        backoffUntil = until;
        return true;
      }
    }
  } catch (_) {}

  return false;
}

export function fr24TriggerBackoff(ctx) {
  // Concurrent 429s from one burst share the window that is already running;
  // only escalate the delay once that window has expired.
  if (Date.now() < backoffUntil) return;
  backoffGeneration++;
  backoffDelay = Math.min(backoffDelay * 2, 300000);
  backoffUntil = Date.now() + backoffDelay;

  try {
    const cache = caches.default;
    const ttlSeconds = Math.ceil(backoffDelay / 1000);
    const resp = new Response(JSON.stringify({ until: backoffUntil }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${ttlSeconds}` },
    });
    if (ctx?.waitUntil) ctx.waitUntil(cache.put(BACKOFF_CACHE_KEY, resp));
  } catch (_) {}
}

// startGeneration (from fr24BackoffGeneration() taken before the request was
// sent) makes the reset conditional: a success must not clear a backoff that
// started after that request began. Such a success also never deletes the
// shared cache marker: another isolate may have written a newer window this
// isolate hasn't seen, and markers expire on their own (<= 300 s). Without
// startGeneration the reset is unconditional and clears the marker too.
export function fr24ResetBackoff(ctx, startGeneration) {
  if (startGeneration !== undefined && startGeneration !== backoffGeneration) return;
  backoffDelay = 10000;
  backoffUntil = 0;
  if (startGeneration !== undefined) return;

  try {
    const cache = caches.default;
    if (ctx?.waitUntil) ctx.waitUntil(cache.delete(BACKOFF_CACHE_KEY));
  } catch (_) {}
}

export async function fr24CachedSearch(callsign, ctx) {
  const normalized = callsign.trim().toUpperCase();
  const cacheKey = new Request('https://fr24-search-cache/' + normalized);
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  } catch (_) {}

  if (await fr24CheckBackoff()) return null;

  try {
    const searchUrl = `https://www.flightradar24.com/v1/search/web/find?query=${encodeURIComponent(normalized)}&limit=8`;
    const startGeneration = backoffGeneration;
    const resp = await fr24Fetch(searchUrl);

    if (resp.status === 429 || resp.status === 403) {
      fr24TriggerBackoff(ctx);
      return null;
    }

    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    fr24ResetBackoff(ctx, startGeneration);

    const cacheResp = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${SEARCH_CACHE_TTL}` },
    });
    if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, cacheResp));

    return data;
  } catch (_) {
    return null;
  }
}
