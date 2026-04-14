let backoffUntil = 0;
let backoffDelay = 10000;

const BACKOFF_CACHE_KEY = new Request('https://fr24-backoff-state/global');
const SEARCH_CACHE_TTL = 300;

export const FR24_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)" };

export async function fr24CheckBackoff() {
  if (Date.now() < backoffUntil) return true;

  try {
    const cache = caches.default;
    const cached = await cache.match(BACKOFF_CACHE_KEY);
    if (cached) {
      const { until } = await cached.json();
      if (until > Date.now()) {
        backoffUntil = until;
        return true;
      }
    }
  } catch (_) {}

  return false;
}

export function fr24TriggerBackoff(ctx) {
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

export function fr24ResetBackoff(ctx) {
  backoffDelay = 10000;
  backoffUntil = 0;

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
    const resp = await fetch(searchUrl, { headers: FR24_HEADERS });

    if (resp.status === 429 || resp.status === 403) {
      fr24TriggerBackoff(ctx);
      return null;
    }

    if (!resp.ok) return null;

    fr24ResetBackoff(ctx);
    const data = await resp.json();

    const cacheResp = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${SEARCH_CACHE_TTL}` },
    });
    if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, cacheResp));

    return data;
  } catch (_) {
    return null;
  }
}
