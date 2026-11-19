import airportData from "../../airports.json" with { type: "json" };
import runwayData from "../../runways.json" with { type: "json" };
import { createBoardRuntime } from "./board-runtime.generated.js";
import { loadTraffic, loadSchedule, loadDatis } from "./loaders.js";
import { json, cachePut } from "./http.js";
import { core, MAP_URL, ApiError, airportFor, clean, round1, finite, iso, delayMinutes,
  integerParam, decodePart, matchesRow, sourceResult } from "./sp-api.js";

const defaults = { loadTraffic, loadSchedule, loadDatis };
const pending = new Map();
// atis.info serves US facilities. An explicit coverage list avoids probing foreign
// airports with a fabricated K prefix (the legacy /datis mapping stays unchanged).
const DATIS_AIRPORTS = new Set(("ABQ ALB ANC ATL AUS BDL BHM BNA BOI BOS BUF BUR BWI CHS CLE CLT CMH CVG DAL " +
  "DAY DCA DEN DFW DSM DTW ELP EWR FLL FNT FAT GEG GRR HNL HOU HPN IAD IAH ICT IND JAX JFK LAS LAX LGA " +
  "LGB LIT MCI MCO MDW MEM MHT MIA MKE MSP MSY OAK OKC OMA ONT ORD ORF PBI PDX PHL PHX PIT PVD RDU RIC " +
  "RNO ROC RSW SAN SAT SAV SDF SEA SFO SJC SJU SLC SMF SNA STL SYR TPA TUL TUS").split(" "));

export function boardOptions(params) {
  const direction = params.get("dir") ?? "both";
  if (!["arrivals", "departures", "both"].includes(direction)) throw new ApiError(400, "Invalid direction");
  const size = params.get("size") ?? "any";
  if (!["any", "big"].includes(size)) throw new ApiError(400, "Invalid size");
  const limit = integerParam(params.get("limit"), 10, 1, 20, "limit");
  let prefixes = null;
  if (params.has("types")) {
    const tokens = params.get("types").split(",").map(token => token.trim().toUpperCase());
    if (tokens.length > 8 || tokens.some(token => !/^[A-Z0-9]{1,8}$/.test(token))) throw new ApiError(400, "Invalid types");
    prefixes = tokens.map(token => /^A3\d0$/.test(token) ? token.slice(0, 3) : /^7\d7$/.test(token) ? "B" + token.slice(0, 2) : token);
  }
  return { direction, size, limit, prefixes };
}

export function filterBoard(board, { direction = "both", size = "any", limit = 10, prefixes = null } = {}) {
  const matches = row => prefixes ? prefixes.some(prefix => (row.type || "").toUpperCase().startsWith(prefix)) :
    size === "any" || ["widebody", "quadjet"].includes(row.size);
  const rows = (list, dir) => direction !== "both" && direction !== dir ? [] : list.filter(matches).slice(0, limit);
  return { ...board, arrivals: rows(board.arrivals, "arrivals"), recent: rows(board.recent, "arrivals"),
    departures: rows(board.departures, "departures"), scheduled: {
      arrivals: rows(board.scheduled.arrivals, "arrivals"), departures: rows(board.scheduled.departures, "departures"),
    } };
}

export function recentState(row, aircraft) {
  if (!aircraft?.ground) return "over-runway";
  return row.taxiingIn ? row.parked ? "parked" : "taxiing-in" : "landed";
}

export function scheduledRows(schedule, direction, live, now) {
  const suffix = direction === "arrivals" ? "arr" : "dep";
  const used = live.flatMap(row => [...core.callsignVariants(row.callsign), ...core.callsignVariants(row.flight)]);
  const seen = new Set();
  return (schedule?.[direction] || []).filter(row => {
    const time = row["est_" + suffix] || row["sched_" + suffix];
    if (!Number.isFinite(time) || time * 1000 < now || time * 1000 > now + 6 * 3600000) return false;
    if (row["actual_" + suffix] || /cancel|divert|landed|arrived/i.test(row.status || "")) return false;
    if (direction === "departures" && /departed|airborne|en.?route|take.?off/i.test(row.status || "")) return false;
    if (matchesRow(row, used)) return false;
    const key = [row.flight, row.callsign, row["sched_" + suffix]].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (a["est_" + suffix] || a["sched_" + suffix]) - (b["est_" + suffix] || b["sched_" + suffix]))
    .map(row => ({ flight: clean(row.flight), callsign: clean(row.callsign), airline: clean(row.airline),
      type: clean(row.ac_code), size: core.sizeClass(row.ac_code),
      [direction === "arrivals" ? "origin" : "destination"]: clean(direction === "arrivals" ? row.from_iata : row.to_iata),
      schedAt: iso(row["sched_" + suffix]), estAt: iso(row["est_" + suffix]),
      delayMin: delayMinutes(row["est_" + suffix], row["sched_" + suffix]), status: clean(row.status) }));
}

async function computeBoard(airport, env, ctx, deps) {
  const { iata, lat, lng } = airport;
  const [traffic, schedule, datis] = await Promise.all([
    sourceResult(() => deps.loadTraffic(lat, lng, 65, env, ctx)),
    sourceResult(() => deps.loadSchedule(iata, ctx)),
    DATIS_AIRPORTS.has(iata) ? sourceResult(() => deps.loadDatis(iata, ctx)) : { status: "none", data: null },
  ]);
  if (traffic.status !== "ok") throw new ApiError(502, "Traffic data unavailable");
  const now = Date.now();
  const runtime = createBoardRuntime({ core, runwayData, airportData });
  const snapshot = runtime.buildAircraftSnapshot(traffic.data.ac, { includeProximity: false,
    positionNow: Number.isFinite(traffic.data.now) ? traffic.data.now : now });
  if (schedule.data) runtime.scheduleDataCache[iata] = { data: schedule.data, ts: now };
  runtime.applyAirportScheduleMatches(iata, schedule.data, snapshot.aircraft);
  const active = core.parseDatisActiveRunways(datis.data && (datis.data.datis || datis.data.text || datis.data.raw));
  const board = runtime.buildLiveScheduleData(iata, lat, lng, snapshot.aircraft, active);
  const elevation = airportData.find(row => row[0] === iata)?.[6] || 0;
  const observed = core.deriveActiveRunways(runwayData[iata], iata, snapshot.aircraft, { maxAltFt: 1500 + elevation });
  const runways = runtime.mergeActiveRunways(active, observed);
  const planes = new Map(snapshot.aircraft.map(plane => [plane.icao24, plane]));
  function label(row) {
    const plane = planes.get(row.hex);
    // Use the same selector as applyAirportScheduleMatches, including its geometry gates.
    const match = plane && !plane.private && schedule.data && core.selectScheduleMatch(core.callsignVariants(plane.callsign),
      [{ iata, data: schedule.data, lat, lng }], plane, now);
    const matched = match?.row;
    return { callsign: clean(row.callsign), flight: clean(matched?.flight), airline: clean(matched?.airline),
      type: clean(row.aircraftType), size: core.sizeClass(row.aircraftType, plane?.category),
      delayMin: delayMinutes(matched?.est_arr, matched?.sched_arr) };
  }
  const arrivals = board.arrivals.map(row => ({ ...label(row), origin: clean(row.originIata),
    etaMin: round1(row.etaMin), etaAt: Number.isFinite(row.etaMin) ? new Date(now + round1(row.etaMin) * 60000).toISOString() : null,
    runway: clean(row.runway), runwayAssumed: !!row.runwayAssumed, sequence: finite(row.sequence),
    altFt: finite(row.altFt), distKm: round1(row.distKm), hex: clean(row.hex) }));
  const recent = board.landed.map(row => {
    const { callsign, flight, type, size } = label(row);
    return { callsign, flight, type, size, origin: clean(row.originIata), runway: clean(row.runway), state: recentState(row, planes.get(row.hex)) };
  });
  const departures = board.departures.map(row => {
    const { callsign, flight, airline, type, size } = label(row);
    return { callsign, flight, airline, type, size, destination: clean(row.destIata), status: clean(row.status), runway: clean(row.runway) };
  });
  const notes = ["Live snapshot; no history, go-around detection or runway memory."];
  if (schedule.status !== "ok") notes.push("Schedule " + (schedule.status === "backoff" ? "temporarily rate limited." : "unavailable."));
  if (datis.status === "error") notes.push("D-ATIS unavailable.");
  return { schemaVersion: 1, kind: "snapshot", airport, generatedAt: new Date(now).toISOString(),
    mapUrl: `${MAP_URL}/?lat=${lat}&lng=${lng}&zoom=11`, capabilities: { history: false, goAroundDetection: false, runwayMemory: false },
    sources: { traffic: "ok", schedule: schedule.status, datis: datis.status === "ok" ? active ? "ok" : "none" : datis.status },
    runways: { arriving: runways?.arriving_runways || [], departing: runways?.departing_runways || [],
      source: active ? "datis" : runways ? "observed" : "none" }, arrivals, recent, departures,
    scheduled: { arrivals: scheduledRows(schedule.data, "arrivals", [...arrivals, ...recent, ...departures], now),
      departures: scheduledRows(schedule.data, "departures", [...arrivals, ...recent, ...departures], now) }, notes };
}

export async function getBoard(iata, env, ctx, overrides = {}) {
  const airport = airportFor(iata);
  const key = new Request("https://board-cache/" + airport.iata);
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) return cached.json();
  // Only in-flight computations live here; no aircraft or milestone history survives.
  if (pending.has(airport.iata)) return pending.get(airport.iata);
  const task = (async () => {
    const board = await computeBoard(airport, env, ctx, { ...defaults, ...overrides });
    const response = json(200, board);
    response.headers.set("Cache-Control", "s-maxage=20");
    // Keep the coalescing lease through the write so a late miss cannot duplicate work.
    await cachePut(null, cache, key, response);
    return board;
  })();
  pending.set(airport.iata, task);
  try { return await task; } finally { pending.delete(airport.iata); }
}

export async function handleBoard(url, env, ctx, deps) {
  try {
    const iata = decodePart(url.pathname.slice("/board/".length));
    const options = boardOptions(url.searchParams);
    const response = json(200, filterBoard(await getBoard(iata, env, ctx, deps), options));
    response.headers.set("Cache-Control", "s-maxage=20");
    return response;
  } catch (error) { return json(error.status || 502, { error: error.status ? error.message : "Board unavailable" }); }
}
