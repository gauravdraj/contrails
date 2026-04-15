import { json } from "./http.js";

const TRACE_CACHE_TTL = 300;
const TRACE_TIMEOUT = 8000;

const PROVIDERS = [
  "https://globe.airplanes.live/data/traces",
  "https://globe.adsb.lol/data/traces",
];

function traceUrl(base, hex) {
  return `${base}/${hex.slice(-2)}/trace_full_${hex}.json`;
}

function normalizeTrace(raw) {
  if (!raw?.trace?.length || !raw.timestamp) return null;
  const baseTime = raw.timestamp;
  const path = [];
  for (const pt of raw.trace) {
    const timeSec = baseTime + pt[0];
    const lat = pt[1];
    const lon = pt[2];
    const altFt = pt[3];
    const heading = pt[5];
    const altM = altFt != null ? altFt * 0.3048 : null;
    const onGround = altFt != null && altFt <= 0;
    path.push([timeSec, lat, lon, altM, heading ?? 0, onGround]);
  }
  return { icao24: raw.icao, path };
}

export async function fetchTrace(hex, cache, ctx) {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  const normalized = hex.toLowerCase();

  const cacheKey = new Request(`https://trace-cache/${normalized}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  for (const base of PROVIDERS) {
    try {
      const resp = await fetch(traceUrl(base, normalized), {
        headers: { "User-Agent": "contrails/1.0", "Accept-Encoding": "gzip" },
        signal: AbortSignal.timeout(TRACE_TIMEOUT),
      });
      if (!resp.ok) continue;
      const raw = await resp.json();
      const track = normalizeTrace(raw);
      if (!track?.path?.length) continue;

      const cacheResp = json(200, track);
      cacheResp.headers.set("Cache-Control", `s-maxage=${TRACE_CACHE_TTL}`);
      ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
      return track;
    } catch (_) {
      continue;
    }
  }
  return null;
}
