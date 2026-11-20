import fixtures from "./capture.json" with { type: "json" };
import { fr24ResetBackoff } from "../../src/fr24-backoff.js";
import { configureRelay, _providerHealth, _gridState } from "../../src/providers.js";
export { fixtures };

// The capture2 schedules are Worker-shaped. Rehydrate only the upstream fields the
// real schedule loader reads so integration tests still exercise both FR24 pages.
export function rawSchedule(schedule, page = 1) {
  const rows = direction => schedule[direction].filter((_, index) => index % 2 === page - 1).map(row => ({ flight: {
    identification: { number: { default: row.flight }, callsign: row.callsign },
    status: { text: row.status, live: row.live, generic: { status: { color: row.color } } },
    airline: { short: row.airline, code: { iata: row.airline_iata, icao: row.airline_icao } },
    aircraft: { model: { code: row.ac_code, text: row.ac_name }, registration: row.reg },
    airport: { origin: { code: { iata: row.from_iata }, name: row.from_name }, destination: { code: { iata: row.to_iata }, name: row.to_name } },
    time: { scheduled: { departure: row.sched_dep, arrival: row.sched_arr }, estimated: { departure: row.est_dep, arrival: row.est_arr }, real: { departure: row.actual_dep, arrival: row.actual_arr } },
  } }));
  return { result: { response: { airport: { pluginData: { details: { name: schedule.name },
    schedule: { arrivals: { data: rows("arrivals") }, departures: { data: rows("departures") } } } } } } };
}
export function memoryCache() {
  const entries = new Map(), puts = [], matches = [];
  const keyOf = key => typeof key === "string" ? key : key.url;
  return { entries, puts, matches,
    async match(key) {
      const name = keyOf(key); matches.push(name);
      const entry = entries.get(name);
      if (entry && entry.until > Date.now()) return entry.response.clone();
      return null;
    },
    async put(key, response) {
      const name = keyOf(key), ttl = Number(/s-maxage=(\d+)/.exec(response.headers.get("Cache-Control"))?.[1] || 0);
      puts.push({ key: name, ttl });
      entries.set(name, { response: response.clone(), until: Date.now() + ttl * 1000 });
    },
    async delete(key) { return entries.delete(keyOf(key)); },
  };
}
export function recordingContext() {
  const pending = [];
  return { waitUntil(promise) { pending.push(promise); }, async flush() { await Promise.all(pending); } };
}
export function fixtureFetch(calls, realFetch = null, localOrigin = null) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url || String(input));
    if (localOrigin && url.origin === localOrigin) return realFetch(input, init);
    calls.push(url.href);
    let body;
    if (url.pathname.endsWith("/airport.json")) {
      const airport = fixtures.airports[url.searchParams.get("code")];
      body = rawSchedule(airport?.schedule || { name: "Unknown", arrivals: [], departures: [] }, Number(url.searchParams.get("page")));
    } else if (url.pathname.includes("/v1/search/web/find")) {
      body = url.searchParams.get("query") === "UA837" ? fixtures.ua837Search : fixtures.liveInbound.search;
    } else if (url.hostname === "atis.info") {
      body = [fixtures.airports.SFO.datis];
    } else if (/\/(callsign|hex)\//.test(url.pathname)) {
      const value = url.pathname.split("/").at(-1).toUpperCase();
      body = ["BAW305", "400804"].includes(value) ? fixtures.liveInbound.lookup : { ac: [], now: fixtures.epochMs };
    } else if (url.hostname.includes("adsb.")) {
      body = url.pathname.includes("/51.") ? fixtures.liveInbound.adsbGrid : fixtures.airports.SFO.traffic;
    } else if (url.hostname.includes("adsbdb")) {
      body = { response: { flightroute: {} } };
    } else if (url.hostname === "api.planespotters.net") {
      body = { photos: [] };
    } else if (url.hostname.includes("globe.adsb")) {
      return new Response("", { status: 404 });
    } else throw new Error("Unexpected upstream URL: " + url);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
}
export function installFixtures(t, { passLocal = null } = {}) {
  const previousCache = globalThis.caches, previousFetch = globalThis.fetch;
  const cache = memoryCache(), calls = [], ctx = recordingContext();
  globalThis.caches = { default: cache };
  globalThis.fetch = fixtureFetch(calls, previousFetch, passLocal);
  t.mock.method(Date, "now", () => fixtures.epochMs);
  configureRelay({}); _providerHealth.clear(); _gridState.clear(); fr24ResetBackoff();
  t.after(async () => { await ctx.flush(); globalThis.fetch = previousFetch; globalThis.caches = previousCache; fr24ResetBackoff(); _providerHealth.clear(); _gridState.clear(); });
  return { cache, calls, ctx };
}
export function fixtureDeps(iata = "LHR") {
  return {
    loadTraffic: async () => ({ status: "ok", data: fixtures.airports[iata].traffic }),
    loadSchedule: async () => ({ status: "ok", complete: true, data: fixtures.airports[iata].schedule }),
    loadDatis: async () => ({ status: "ok", data: fixtures.airports.SFO.datis }),
    loadLookup: async () => ({ status: "ok", data: fixtures.liveInbound.lookup }),
    loadSearch: async () => ({ status: "ok", data: fixtures.liveInbound.search }),
  };
}
