import { fetchCachedRouteEntry } from "./adsbdb.js";
import { detectPhase, formatRouteLabel } from "./opensky.js";
import { fr24CachedSearch } from "./fr24-backoff.js";

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

const ADSBDB_CACHE_TTL = 3600;

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

      let origin = null;
      let destination = null;
      let fr24Hit = false;

      const data = await fr24CachedSearch(iataVariant, ctx);
      if (data) {
        const results = data.results || [];
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
