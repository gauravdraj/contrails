import { fetchCachedRouteEntry } from "./adsbdb.js";
import { detectPhase, formatRouteLabel } from "./opensky.js";
import { json } from "./http.js";

export const ICAO_TO_IATA = {
  AAL: "AA", AAR: "OZ", ACA: "AC", AFR: "AF", AIC: "AI", ANA: "NH",
  ANZ: "NZ", ASA: "AS", AUA: "OS", AVA: "AV", BAW: "BA", CAL: "CI",
  CMP: "CM", CPA: "CX", CSN: "CZ", DAL: "DL", DLH: "LH", EIN: "EI",
  ETD: "EY", ETH: "ET", EVA: "BR", FIN: "AY", GIA: "GA", HAL: "HA",
  IBE: "IB", ICE: "FI", JAL: "JL", JBU: "B6", KAL: "KE", KLM: "KL",
  LAN: "LA", LOT: "LO", MAS: "MH", MSR: "MS", NAX: "DY", NKS: "NK",
  PAL: "PR", QFA: "QF", QTR: "QR", RPA: "YX", RYR: "FR", SAA: "SA",
  SAS: "SK", SCX: "SY", SIA: "SQ", SKW: "OO", SVA: "SV", SWA: "WN",
  SWR: "LX", TAP: "TP", THA: "TG", THY: "TK", UAE: "EK", UAL: "UA",
  VIR: "VS", WJA: "WS",
};

const FR24_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; contrails/1.0)" };
const FR24_CACHE_TTL = 300;
const ADSBDB_CACHE_TTL = 3600;

let enrichBackoffUntil = 0;
let enrichBackoffDelay = 10000;

function fr24EnrichCheckBackoff() {
  return Date.now() < enrichBackoffUntil;
}

function fr24EnrichTriggerBackoff() {
  enrichBackoffDelay = Math.min(enrichBackoffDelay * 2, 300000);
  enrichBackoffUntil = Date.now() + enrichBackoffDelay;
}

function fr24EnrichResetBackoff() {
  enrichBackoffDelay = 10000;
  enrichBackoffUntil = 0;
}

export function resetEnrichBackoff() {
  fr24EnrichResetBackoff();
}

function iataCallsign(cs) {
  const prefix = cs.substring(0, 3);
  const iata = ICAO_TO_IATA[prefix];
  return iata ? iata + cs.substring(3) : cs;
}

export async function enrichRoutes(planes, env, ctx) {
  const routeMap = Object.create(null);
  const routable = planes.filter((p) => p.callsign && p.priv !== true);
  if (!routable.length) return routeMap;

  const cache = caches.default;

  await Promise.allSettled(
    routable.map(async (plane) => {
      const cs = plane.callsign.trim().toUpperCase();
      if (!cs) return;

      const iataVariant = iataCallsign(cs);

      const cacheKey = new Request("https://fr24-enrich-cache/" + cs);
      const cached = await cache.match(cacheKey);

      let origin = null;
      let destination = null;
      let fr24Hit = false;

      if (cached) {
        const data = await cached.json();
        origin = data.origin || null;
        destination = data.destination || null;
        fr24Hit = !!(origin || destination);
      }

      if (!fr24Hit && !fr24EnrichCheckBackoff()) {
        try {
          const searchUrl = `https://www.flightradar24.com/v1/search/web/find?query=${encodeURIComponent(iataVariant)}&limit=8`;
          const resp = await fetch(searchUrl, { headers: FR24_HEADERS });

          if (resp.status === 429 || resp.status === 403) {
            fr24EnrichTriggerBackoff();
          } else if (resp.ok) {
            fr24EnrichResetBackoff();
            const data = await resp.json();
            const results = data?.results || [];
            const match = results.find((r) => {
              if (r.type !== "live") return false;
              const rCs = (r.detail?.callsign || "").replace(/\s/g, "").toUpperCase();
              const rFlight = (r.detail?.flight || "").replace(/\s/g, "").toUpperCase();
              return rCs === cs || rCs === iataVariant || rFlight === cs || rFlight === iataVariant;
            });

            if (match?.detail?.schd_from && match?.detail?.schd_to) {
              origin = { iata: match.detail.schd_from, name: match.detail.schd_from };
              destination = { iata: match.detail.schd_to, name: match.detail.schd_to };
              fr24Hit = true;

              const cacheResp = json(200, { origin, destination });
              cacheResp.headers.set("Cache-Control", `s-maxage=${FR24_CACHE_TTL}`);
              ctx.waitUntil(cache.put(cacheKey, cacheResp.clone()));
            }
          }
        } catch (_) {
          // FR24 fetch failed — fall through to ADSBDB
        }
      }

      if (!fr24Hit) {
        try {
          const entry = await fetchCachedRouteEntry(plane.callsign, cache, ctx, ADSBDB_CACHE_TTL);
          if (entry) {
            origin = entry.origin || null;
            destination = entry.destination || null;
          }
        } catch (_) {
          // ADSBDB fallback failed
        }
      }

      if (!origin && !destination) return;

      const phase = detectPhase(plane.altFt, plane.vRate, plane.ground);
      const display = formatRouteLabel(origin, destination, phase);
      routeMap[cs] = { origin, destination, phase, display };
    }),
  );

  return routeMap;
}
