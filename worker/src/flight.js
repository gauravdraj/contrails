import { loadSchedule, loadLookup, loadSearch } from "./loaders.js";
import { getBoard } from "./board.js";
import { json, plainText } from "./http.js";
import { core, MAP_URL, ApiError, airportFor, clean, finite, round1, iso, delayMinutes, compact,
  flightQuery, queryVariants, selectFlightRow, integerParam, decodePart, sourceResult } from "./sp-api.js";

const defaults = { loadSchedule, loadLookup, loadSearch, getBoard };

function positionOf(plane, feedNow, now) {
  if (!plane || !Number.isFinite(plane.lat) || !Number.isFinite(plane.lon)) return null;
  const age = Number.isFinite(plane.seen_pos) ? Math.max(0, plane.seen_pos) +
    (Number.isFinite(feedNow) ? Math.max(0, (now - feedNow) / 1000) : 0) : null;
  return { lat: plane.lat, lng: plane.lon, altFt: plane.alt_baro === "ground" ? 0 : finite(plane.alt_baro),
    speedKts: finite(plane.gs), track: finite(plane.track), ground: plane.alt_baro === "ground", ageSec: age };
}

const registrationKey = value => compact(value).replace(/[^A-Z0-9]/g, "");
function aircraftIdentity(plane) {
  return { hex: compact(plane?.hex), reg: registrationKey(plane?.reg || plane?.r) };
}
function matchesIdentity(plane, identities) {
  const actual = aircraftIdentity(plane);
  let matched = false;
  for (const expected of identities) {
    for (const key of ["hex", "reg"]) {
      if (!expected[key] || !actual[key]) continue;
      if (expected[key] !== actual[key]) return false;
      matched = true;
    }
  }
  return matched;
}
function selectAircraft(candidates, identities) {
  const known = identities.filter(identity => identity.hex || identity.reg);
  // Within this snapshot an airborne aircraft can establish identity even when
  // the schedule cannot. A different ground aircraft must not end its watch.
  const byAge = [...candidates].sort((a, b) => (a.seen_pos ?? Infinity) - (b.seen_pos ?? Infinity));
  const airborne = byAge.find(plane => Number.isFinite(plane.alt_baro) && (plane.hex || plane.r) &&
    (!known.length || matchesIdentity(plane, known)));
  if (airborne) known.push(aircraftIdentity(airborne));
  return known.length ? byAge.find(plane => matchesIdentity(plane, known)) : byAge[0];
}

export function milestoneFor({ row, position, destination, etaMin }, eta) {
  const fresh = position && position.ageSec != null && position.ageSec <= 60;
  // A position with no altitude is not positive evidence of being airborne.
  const airborne = !!(fresh && !position.ground && position.altFt != null);
  const departed = !!(iso(row?.actual_dep) || airborne);
  const landed = !!(iso(row?.actual_arr) || (fresh && position.ground && destination &&
    core.haversineKm(position.lat, position.lng, destination.lat, destination.lng) <= 6));
  const status = String(row?.status || "");
  const terminal = /cancel/i.test(status) ? "cancelled" : /divert/i.test(status) ? "diverted" : landed ? "landed" : null;
  const rank = landed ? 3 : airborne && etaMin != null && etaMin <= eta ? 2 : departed ? 1 : 0;
  const suffix = departed ? "arr" : "dep";
  const delayed30 = !!(row?.["est_" + suffix] > 0 && row?.["sched_" + suffix] > 0 &&
    row["est_" + suffix] - row["sched_" + suffix] >= 1800);
  return { rank, name: terminal || (rank === 2 ? "within-" + eta : rank === 1 ? "departed" : "waiting"), delayed30 };
}

export function makeWatchUrl(origin, ident, destination, eta, flight, now = Date.now()) {
  if (!destination) return null;
  const arrival = Date.parse(flight.estArr || flight.schedArr || "");
  const until = Math.floor(Math.min((Number.isFinite(arrival) ? arrival : now) + 3 * 3600000, now + 24 * 3600000) / 1000);
  const url = new URL("/flight/" + encodeURIComponent(ident) + "/watch", origin);
  url.search = new URLSearchParams({ airport: destination, eta: String(eta), until: String(until) });
  return url.href;
}

export async function resolveFlight(ident, { airport, eta = 10, origin = "https://contrails-api.therealgraj.workers.dev" } = {}, env, ctx, overrides = {}) {
  const query = flightQuery(ident);
  const variants = queryVariants(query);
  const deps = { ...defaults, ...overrides };
  const now = Date.now();
  const notes = [];
  let rankError = false, schedule = null, match = null, detail = null;
  let scheduleAirport = airport ? airportFor(airport).iata : null;
  async function readSchedule(iata) {
    const result = await sourceResult(() => deps.loadSchedule(iata, ctx));
    if (result.status !== "ok") {
      rankError = true;
      notes.push(result.status === "backoff" ? "Schedule temporarily rate limited." : "Schedule unavailable.");
    }
    if (result.complete !== true) rankError = true;
    return result.data;
  }
  if (scheduleAirport) {
    schedule = await readSchedule(scheduleAirport);
    match = selectFlightRow(schedule, variants, now);
  } else {
    const search = await sourceResult(() => deps.loadSearch(query.display, ctx));
    if (search.status !== "ok") { rankError = true; notes.push("Flight search unavailable."); }
    detail = (search.status === "ok" ? search.data?.results : [])?.find(result => result.type === "live" &&
      (variants.includes(compact(result.detail?.flight)) || variants.includes(compact(result.detail?.callsign))))?.detail || null;
    if (detail?.schd_to) {
      try { scheduleAirport = airportFor(detail.schd_to).iata; } catch (_) { notes.push("Destination airport is not supported."); }
      if (scheduleAirport) {
        schedule = await readSchedule(scheduleAirport);
        match = selectFlightRow(schedule, [...variants, ...core.callsignVariants(detail.callsign)], now);
      }
    }
  }
  let row = match?.row;
  const callsign = compact(row?.callsign || detail?.callsign || query.value);
  const kind = query.type === "hex" ? "hex" : "callsign";
  const lookupValue = kind === "hex" ? query.value : callsign;
  let lookup = { status: "ok", data: null };
  if (kind === "hex" || /^[A-Z0-9]{2,8}$/.test(lookupValue)) {
    lookup = await sourceResult(() => deps.loadLookup(kind, lookupValue, ctx));
    if (lookup.status !== "ok") { rankError = true; notes.push("Live position lookup unavailable."); }
  } else { rankError = true; notes.push("Live callsign unavailable."); }
  const candidates = (lookup.data?.ac || []).filter(plane => kind === "hex" ? String(plane.hex).toLowerCase() === lookupValue :
    compact(plane.flight) === lookupValue || variants.includes(compact(plane.flight)));
  const identities = () => [aircraftIdentity(row), aircraftIdentity(detail),
    aircraftIdentity(kind === "hex" ? { hex: lookupValue } : null)];
  let plane = selectAircraft(candidates, identities());
  // Hex queries can acquire a schedule identity from the actual transponder report.
  if (!match && schedule && plane?.flight) {
    match = selectFlightRow(schedule, core.callsignVariants(plane.flight), now);
    row = match?.row;
    plane = selectAircraft(candidates, identities());
  }
  if (!row && !detail && !plane) return { data: null, status: rankError ? 503 : 404, rankError };
  const destinationCode = (match?.direction === "arrivals" ? scheduleAirport : row?.to_iata) || detail?.schd_to || null;
  const originCode = (match?.direction === "departures" ? scheduleAirport : row?.from_iata) || detail?.schd_from || null;
  let destination = null;
  if (destinationCode) { try { destination = airportFor(destinationCode); } catch (_) {} }
  const position = positionOf(plane, lookup.data?.now, now);
  const fresh = position && position.ageSec != null && position.ageSec <= 60;
  const airborne = fresh && !position.ground && position.altFt != null;
  if (position && !fresh) notes.push("Live position is stale or its age is unknown.");
  let etaMin = row?.live && iso(row?.est_arr) ? round1(Math.max(0, (row.est_arr * 1000 - now) / 60000)) : null;
  let etaSource = etaMin == null ? null : "schedule";
  let runway = null, sequence = null;
  if (airborne && destination && core.haversineKm(position.lat, position.lng, destination.lat, destination.lng) <= 120) {
    try {
      const board = await deps.getBoard(destination.iata, env, ctx, overrides);
      if (board.sources.traffic !== "ok" || board.sources.schedule !== "ok") rankError = true;
      const live = plane.hex ? board.arrivals.find(item => compact(item.hex) === compact(plane.hex)) :
        board.arrivals.find(item => compact(item.callsign) === compact(plane.flight));
      if (live) { etaMin = live.etaMin; etaSource = etaMin == null ? null : "board"; runway = live.runway; sequence = live.sequence; }
    } catch (_) { rankError = true; notes.push("Destination board unavailable."); }
  }
  const milestone = milestoneFor({ row, position, destination, etaMin }, eta);
  const terminal = ["cancelled", "diverted", "landed"].includes(milestone.name);
  const phase = terminal ? milestone.name : airborne ? etaSource === "board" ? "approach" : "airborne" :
    fresh && position.ground ? "taxiing" : !fresh && (iso(row?.actual_dep) || row?.live) ? "airborne" :
    row && !row.actual_dep ? "scheduled" : "unknown";
  const type = clean(plane?.t || row?.ac_code || detail?.ac_type);
  const data = { schemaVersion: 1, ident: query.display, flight: clean(row?.flight || detail?.flight),
    callsign: clean(plane?.flight?.trim() || row?.callsign || detail?.callsign), airline: clean(row?.airline), type,
    size: core.sizeClass(type, plane?.category), registration: clean(plane?.r || row?.reg || detail?.reg),
    origin: clean(originCode), destination: clean(destinationCode), phase, position,
    schedDep: iso(row?.sched_dep), estDep: iso(row?.est_dep), actualDep: iso(row?.actual_dep),
    schedArr: iso(row?.sched_arr), estArr: iso(row?.est_arr), actualArr: iso(row?.actual_arr),
    delayMin: delayMinutes(row?.est_arr, row?.sched_arr), etaMin, etaSource, runway, sequence, milestone,
    watchUrl: null, mapUrl: position ? `${MAP_URL}/?lat=${position.lat}&lng=${position.lng}&zoom=10&hex=${encodeURIComponent(plane.hex)}` :
      destination ? `${MAP_URL}/?lat=${destination.lat}&lng=${destination.lng}&zoom=11` : MAP_URL + "/", notes };
  data.watchUrl = makeWatchUrl(origin, ident, destination?.iata, eta, data, now);
  return { data, status: 200, rankError };
}

export function watchBody(ident, milestone) {
  const terminal = ["landed", "cancelled", "diverted", "expired"].includes(milestone.name);
  const token = ["cancelled", "diverted", "expired"].includes(milestone.name) ? milestone.name : `${milestone.rank}/3 ${milestone.name}`;
  return `contrails-watch v1 | ${ident.toUpperCase()} | ${token}${milestone.delayed30 ? " | delayed-30" : ""}` +
    (terminal ? "\nSP-WATCH: done" : "");
}

export async function handleFlight(url, env, ctx, deps) {
  const watch = url.pathname.endsWith("/watch");
  try {
    const ident = decodePart(url.pathname.slice("/flight/".length, watch ? -"/watch".length : undefined));
    flightQuery(ident);
    const airport = url.searchParams.has("airport") ? airportFor(url.searchParams.get("airport")).iata : undefined;
    const eta = integerParam(url.searchParams.get("eta"), 10, 5, 30, "eta");
    if (watch) {
      const rawUntil = url.searchParams.get("until");
      const until = Number(rawUntil);
      if (rawUntil == null || !/^-?\d+$/.test(rawUntil) || !Number.isSafeInteger(until) || until * 1000 > Date.now() + 48 * 3600000) throw new ApiError(400, "until is required and must be within 48 hours");
      if (Date.now() > until * 1000) return plainText(200, watchBody(ident, { name: "expired", delayed30: false }));
    }
    const result = await resolveFlight(ident, { airport, eta, origin: url.origin }, env, ctx, deps);
    if (!watch) return result.data ? json(200, result.data) : json(result.status, { error: result.status === 404 ? "Flight not found" : "Flight unavailable" });
    const milestone = result.data?.milestone || { rank: 0, name: "waiting", delayed30: false };
    if (result.rankError && !["landed", "cancelled", "diverted"].includes(milestone.name)) return plainText(503, "contrails-watch unavailable");
    return plainText(200, watchBody(ident, milestone));
  } catch (error) {
    return watch ? plainText(error.status || 503, error.status ? error.message : "contrails-watch unavailable") :
      json(error.status || 503, { error: error.status ? error.message : "Flight unavailable" });
  }
}

// Reference consumer state only. The server never invokes or stores this fold.
export function foldWatchLines(prevState, body) {
  const previous = prevState || { rank: 0, delayed: false, done: false };
  if (previous.done) return { state: previous, fire: false };
  const match = /^contrails-watch v1 \| [A-Z0-9 -]+ \| (?:(0\/3 waiting|1\/3 departed|2\/3 within-(?:[5-9]|[12]\d|30)|3\/3 landed)|(cancelled|diverted|expired))( \| delayed-30)?(\nSP-WATCH: done)?$/.exec(body);
  if (!match) return { state: previous, fire: false };
  const rank = match[1] ? Number(match[1][0]) : 0;
  const terminal = !!match[2] || rank === 3;
  if (terminal !== !!match[4]) return { state: previous, fire: false };
  const state = { rank: Math.max(previous.rank, rank), delayed: previous.delayed || !!match[3], done: terminal };
  return { state, fire: state.rank > previous.rank || state.delayed !== previous.delayed || state.done !== previous.done };
}
