import { json } from "./http.js";

const ADSBDB_API = "https://api.adsbdb.com/v0";
const ADSBDB_HEADERS = { "User-Agent": "contrails/1.0" };

export function normalizeCallsign(callsign) {
  if (!callsign) return null;
  const normalized = callsign.trim().toUpperCase();
  return normalized || null;
}

export function buildRouteEntry(callsign, route) {
  if (!route?.origin || !route?.destination) return null;
  return {
    callsign,
    origin: {
      iata: route.origin.iata_code || "",
      name: route.origin.municipality || route.origin.name || "",
    },
    destination: {
      iata: route.destination.iata_code || "",
      name: route.destination.municipality || route.destination.name || "",
    },
    airline: route.airline?.name || null,
  };
}

export function buildRouteAirports(route) {
  if (!route?.origin || !route?.destination) return null;
  return [
    {
      iata: route.origin.iata_code,
      location: route.origin.municipality || route.origin.name || "",
      lat: route.origin.latitude,
      lon: route.origin.longitude,
    },
    {
      iata: route.destination.iata_code,
      location: route.destination.municipality || route.destination.name || "",
      lat: route.destination.latitude,
      lon: route.destination.longitude,
    },
  ];
}

async function fetchFlightroute(callsign) {
  const normalized = normalizeCallsign(callsign);
  if (!normalized) return null;

  const resp = await fetch(`${ADSBDB_API}/callsign/${normalized}`, {
    headers: ADSBDB_HEADERS,
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.response?.flightroute || null;
}

export async function fetchCachedRouteEntry(callsign, cache, ctx, ttlSeconds) {
  const normalized = normalizeCallsign(callsign);
  if (!normalized) return null;

  const cacheKey = new Request(`https://adsbdb-cache/${normalized}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const route = await fetchFlightroute(normalized);
  const entry = buildRouteEntry(normalized, route);
  if (!entry) return null;

  const cacheResp = json(200, entry);
  cacheResp.headers.set("Cache-Control", `s-maxage=${ttlSeconds}`);
  ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
  return entry;
}

export async function fetchRouteAirports(callsign) {
  const route = await fetchFlightroute(callsign);
  return buildRouteAirports(route);
}
