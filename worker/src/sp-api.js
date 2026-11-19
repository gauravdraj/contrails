import core from "../../contrails-core.js";
import { MAJOR_AIRPORTS } from "./airports.js";

export { core };
export const MAP_URL = "https://gauravdraj.github.io/contrails";
export const clean = value => value == null || value === "" ? null : String(value).replace(/[^A-Za-z0-9 /().,'+:-]/g, "").replace(/ +/g, " ").trim().slice(0, 40) || null;
export const finite = value => Number.isFinite(value) ? value : null;
export const round1 = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
export const iso = seconds => Number.isFinite(seconds) && seconds > 0 && seconds < 8640000000000 ? new Date(seconds * 1000).toISOString() : null;
export const delayMinutes = (est, sched) => Number.isFinite(est) && Number.isFinite(sched) && est > 0 && sched > 0 ? Math.round((est - sched) / 60) : null;
export const compact = value => String(value || "").replace(/\s/g, "").toUpperCase();

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function airportFor(value) {
  const iata = String(value || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) throw new ApiError(400, "Invalid airport code");
  const row = MAJOR_AIRPORTS.find(row => row[0] === iata);
  if (!row) throw new ApiError(404, "Unknown airport");
  return { iata, name: clean(row[1]), lat: row[2], lng: row[3] };
}
export function integerParam(value, fallback, min, max, name) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new ApiError(400, "Invalid " + name);
  }
  return Number(value);
}
export function decodePart(value) {
  try { return decodeURIComponent(value); } catch (_) { throw new ApiError(400, "Invalid path encoding"); }
}
export function flightQuery(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9 -]{2,20}$/.test(value)) throw new ApiError(400, "Invalid flight ident");
  const query = core.normalizeFlightQuery(value);
  if (!query) throw new ApiError(400, "Invalid flight ident");
  return query;
}
export function queryVariants(query) {
  return [...new Set(query.variants.flatMap(value => core.callsignVariants(value)).map(compact))];
}
export function matchesRow(row, variants) {
  return variants.includes(compact(row.flight)) || variants.includes(compact(row.callsign));
}
export function selectFlightRow(schedule, variants, now = Date.now()) {
  const candidates = ["arrivals", "departures"].flatMap(direction => (schedule?.[direction] || [])
    .filter(row => matchesRow(row, variants)).map(row => ({ row, direction })));
  const distance = row => Math.abs((row.est_arr || row.sched_arr || 0) * 1000 - now);
  candidates.sort((a, b) => Number(!!b.row.live) - Number(!!a.row.live) || distance(a.row) - distance(b.row));
  return candidates[0] || null;
}
// Treat an injected loader throwing the same way as its production error result.
export async function sourceResult(action) {
  try { return await action(); } catch (_) { return { status: "error", data: null }; }
}
