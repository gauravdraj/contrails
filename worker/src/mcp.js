import { json, CORS_HEADERS, readBodyCapped } from "./http.js";
import { handleNearby, findRecentPasses } from "./nearby.js";
import { photoFor } from "./photo.js";
import { getBoard, filterBoard, boardOptions } from "./board.js";
import { resolveFlight, makeWatchUrl } from "./flight.js";
import { ApiError, airportFor, clean, flightQuery } from "./sp-api.js";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_HEADERS = { ...CORS_HEADERS, "Access-Control-Allow-Headers": "Content-Type, Mcp-Protocol-Version, Mcp-Session-Id" };
const annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const iata = { type: "string", pattern: "^[A-Za-z]{3}$", description: "Airport IATA code." };
const ident = { type: "string", minLength: 2, maxLength: 20, description: "Flight number, callsign or six-digit aircraft hex." };
const direction = values => ({ type: "string", enum: values });
const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
export const TOOLS = [
  { name: "airport_board", description: "Use for an airport's arrivals and departures, including upcoming scheduled flights. Live snapshot only: no history, go-around detection or runway memory. At most 10 rows per section.",
    inputSchema: schema({ iata, direction: { ...direction(["arrivals", "departures", "both"]), default: "both" }, limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, ["iata"]), annotations },
  { name: "flight_status", description: "Use for one flight's current phase and ETA. Supply an airport when known for schedule-first resolution. Positions can be stale; absence never proves landing.",
    inputSchema: schema({ ident, airport: iata }, ["ident"]), annotations },
  { name: "planes_nearby", description: "Use to identify nearby planes. Pass the phone's coordinates from the situation line. If the fix is older than 15 minutes or the owner is flying, say so instead of guessing. Coordinates are rounded to 0.01 degree; at most five planes.",
    inputSchema: schema({ lat: { type: "number", minimum: -90, maximum: 90 }, lng: { type: "number", minimum: -180, maximum: 180 } }, ["lat", "lng"]), annotations },
  { name: "plane_just_passed", description: "Use when he says a plane just flew past, over or by him, or asks what that plane was. Pass the phone's coordinates from the situation line. Estimates each plane's closest approach over the last few minutes (and the next two) from its current heading and speed, so a plane that turned can be placed wrong. Returns up to three, already-passed first, each with a Planespotters photo when one exists. Download the photo and attach it as a file instead of sending links.",
    inputSchema: schema({ lat: { type: "number", minimum: -90, maximum: 90 }, lng: { type: "number", minimum: -180, maximum: 180 },
      minutes: { type: "integer", minimum: 1, maximum: 10, default: 4, description: "How far back to look." } }, ["lat", "lng"]), annotations },
  { name: "next_big", description: "Use for the next large aircraft at an airport. Big means widebody or quadjet, including cargo; named types (for example A380,747) override size. Live snapshot rows first, then upcoming schedule; at most three results.",
    inputSchema: schema({ iata, direction: { ...direction(["arrivals", "departures"]), default: "arrivals" }, types: { type: "string", maxLength: 71, description: "Up to eight comma-separated aircraft types." } }, ["iata"]), annotations },
  { name: "track_flight", description: "Use when asked to follow a flight. Resolves its current state and returns a URL watcher recipe; does not start a watch. Keep at most three flight watches, ignore lower ranks and transient 503s, and stop at the done marker. A destination is required.",
    inputSchema: schema({ ident, airport: iata, eta_min: { type: "integer", minimum: 5, maximum: 30, default: 10 } }, ["ident"]), annotations },
];

function validateArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ApiError(400, "Arguments must be an object");
  const { properties, required } = tool.inputSchema;
  if (required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new ApiError(400, "Missing or unknown argument");
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key];
    const validType = rule.type === "integer" ? Number.isInteger(value) : typeof value === rule.type;
    if (!validType || (typeof value === "number" && (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)) ||
      (rule.enum && !rule.enum.includes(value)) || (rule.pattern && !new RegExp(rule.pattern).test(value)) ||
      (rule.minLength && value.length < rule.minLength) || (rule.maxLength && value.length > rule.maxLength)) throw new ApiError(400, "Invalid " + key);
  }
  if (args.ident != null) flightQuery(args.ident);
  if (args.iata != null) airportFor(args.iata);
  if (args.airport != null) airportFor(args.airport);
}

function relative(minutes, scheduled = false) {
  if (!Number.isFinite(minutes)) return "time unknown";
  const value = Math.max(0, Math.round(minutes));
  return scheduled && value >= 60 ? `in ${Math.floor(value / 60)} h ${value % 60} min` : `in ${value} min`;
}
function rowText(row, scheduled = false) {
  const when = scheduled ? (Date.parse(row.estAt || row.schedAt) - Date.now()) / 60000 : row.etaMin;
  return [clean(row.flight || row.callsign) || "Unknown flight", clean(row.type),
    row.origin ? "from " + clean(row.origin) : row.destination ? "to " + clean(row.destination) : null,
    Number.isFinite(when) ? relative(when, scheduled) : clean(row.status), row.runway ? "runway " + clean(row.runway) : null].filter(Boolean).join(" ");
}
function flightText(flight) {
  const type = clean(flight.type);
  const outOfCoverage = flight.phase === "airborne" && !(flight.position?.ageSec != null && flight.position.ageSec <= 60);
  const delay = Number.isFinite(flight.delayMin) && flight.delayMin !== 0 ?
    ` (${Math.abs(flight.delayMin)} min ${flight.delayMin < 0 ? "early" : "late"})` : "";
  return `${clean(flight.flight || flight.callsign || flight.ident)} ${clean(flight.origin) || "?"} to ${clean(flight.destination) || "?"}` +
    `${type ? ` (${type})` : ""}: ${clean(flight.phase)}${outOfCoverage ? ", out of live coverage" : ""}` +
    (flight.etaMin == null ? "." : `${outOfCoverage ? ";" : ","} estimated arrival ${relative(flight.etaMin, true)}${delay}.`);
}
function result(text, structuredContent, isError = false, note = "") {
  const suffix = note ? "\n" + note : "";
  const budget = 600 - suffix.length;
  return { content: [{ type: "text", text: (text.length > budget ? text.slice(0, budget - 3) + "..." : text) + suffix }], structuredContent, isError };
}
// Nearby is an existing API with longer free-form strings. Sanitize its upstream
// fields too, but preserve the map URL that our own nearby code constructed.
function sanitizeObject(value) {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sanitizeObject(v)]));
  return value;
}

export async function callTool(name, args, url, env, ctx, deps = {}) {
  if (name === "airport_board" || name === "next_big") {
    const params = new URLSearchParams({ dir: args.direction || (name === "next_big" ? "arrivals" : "both"),
      limit: String(name === "next_big" ? 20 : args.limit ?? 5), size: name === "next_big" ? "big" : "any" });
    if (args.types != null) params.set("types", args.types);
    const options = boardOptions(params);
    const board = filterBoard(await (deps.getBoard || getBoard)(args.iata, env, ctx, deps), options);
    if (board.sources && board.sources.traffic !== "ok") {
      return result("Live traffic unavailable right now.", board, true);
    }
    const partialNotes = [];
    if (board.sources && board.sources.schedule !== "ok") partialNotes.push("Schedule unavailable right now; live traffic shown.");
    if (board.sources?.datis === "error") partialNotes.push("D-ATIS unavailable right now.");
    if (name === "airport_board") {
      const lines = [`${board.airport.iata} live snapshot.`];
      for (const direction of ["arrivals", "departures"]) {
        if (options.direction !== "both" && options.direction !== direction) continue;
        const live = board[direction].map(row => rowText(row));
        const scheduled = board.scheduled[direction].map(row => rowText(row, true));
        lines.push(direction + ": " + (live.concat(scheduled).slice(0, options.limit).join("; ") || "none in this snapshot") + ".");
      }
      return result(lines.join("\n"), board, false, partialNotes.join(" "));
    }
    const live = [...board[options.direction]].sort((a, b) => (a.etaMin ?? Infinity) - (b.etaMin ?? Infinity));
    const rows = [...live.map(row => ({ ...row, source: "live" })),
      ...board.scheduled[options.direction].map(row => ({ ...row, source: "scheduled" }))].slice(0, 3);
    return result(`${board.airport.iata} live snapshot, next large ${options.direction}.\n` +
      (rows.map((row, index) => `${index + 1}. ${rowText(row, row.source === "scheduled")}.`).join("\n") || "None in the schedule window."),
    { schemaVersion: 1, kind: "snapshot", airport: board.airport, generatedAt: board.generatedAt, results: rows, notes: board.notes }, false, partialNotes.join(" "));
  }
  if (name === "planes_nearby") {
    const nearbyUrl = new URL("/nearby", url.origin);
    nearbyUrl.search = new URLSearchParams({ lat: args.lat.toFixed(2), lng: args.lng.toFixed(2), format: "json" });
    const response = await (deps.handleNearby || handleNearby)(nearbyUrl, env, ctx);
    if (!response.ok) throw new ApiError(502, "Nearby traffic unavailable");
    const raw = await response.json();
    const planes = raw.planes.slice(0, 5).map(plane => sanitizeObject({ ...plane,
      routeLine: typeof plane.routeLine === "string" ? plane.routeLine.replace(/->|[→⟶–—]|\s-\s/g, " to ") : plane.routeLine,
    }));
    const lines = ["Live snapshot."];
    for (const [index, plane] of planes.entries()) {
      const distance = plane.distanceMiles != null ? `${plane.distanceMiles} mi ${plane.direction || ""}` : plane.distance;
      const line = `${index + 1}. ` + [plane.name || plane.callsign || "Unknown", plane.type, plane.routeLine,
        `${plane.altitudeFt ?? "unknown"} ft`, distance, plane.vertical, plane.alert].filter(Boolean).join(", ") + ".";
      // Keep complete aircraft descriptions within the text budget.
      if (lines.join("\n").length + line.length + 1 > 600) break;
      lines.push(line);
    }
    if (!planes.length) lines.push("No aircraft detected nearby.");
    const text = lines.join("\n");
    return result(text, { ...raw, planes, text });
  }
  if (name === "plane_just_passed") {
    const lat = Math.round(args.lat * 100) / 100, lng = Math.round(args.lng * 100) / 100;
    const passes = await (deps.findRecentPasses || findRecentPasses)(lat, lng, args.minutes ?? 4, env, ctx);
    const photos = await Promise.all(passes.map(pass => (deps.photoFor || photoFor)(pass.icao24, ctx)));
    const planes = passes.map((pass, index) => ({ ...sanitizeObject({ ...pass,
      routeLine: typeof pass.routeLine === "string" ? pass.routeLine.replace(/->|[→⟶–—]|\s-\s/g, " to ") : pass.routeLine }),
    photo: photos[index] ? { src: photos[index].src, photographer: clean(photos[index].photographer) } : null }));
    const lines = ["Closest approaches, estimated from current heading."];
    for (const [index, plane] of planes.entries()) {
      const { offsetSec, miles, direction, altFt } = plane.closest;
      const when = offsetSec > 0 ? `passing in about ${Math.max(1, Math.round(offsetSec / 60))} min` :
        offsetSec >= -45 ? "closest just now" : `passed about ${Math.round(-offsetSec / 60)} min ago`;
      const line = `${index + 1}. ` + [plane.name || plane.callsign || "Unknown", plane.type, plane.priv ? null : plane.registration,
        plane.routeLine, `${when}, ${miles} mi ${direction} at ${altFt} ft`,
        plane.photo ? `photo ${plane.photo.src}${plane.photo.photographer ? " by " + plane.photo.photographer : ""}` : "no photo"]
        .filter(Boolean).join(", ") + ".";
      if (lines.join("\n").length + line.length + 1 > 600) break;
      lines.push(line);
    }
    if (!planes.length) lines.push("No aircraft passed close by in that window.");
    return result(lines.join("\n"), { schemaVersion: 1, kind: "passes", minutes: args.minutes ?? 4, planes });
  }
  const eta = args.eta_min ?? 10;
  const resolved = await (deps.resolveFlight || resolveFlight)(args.ident, { airport: args.airport, eta, origin: url.origin }, env, ctx, deps);
  if (!resolved.data) throw new ApiError(resolved.status, resolved.status === 404 ? "Flight not found" : "Flight unavailable");
  const flight = resolved.data;
  const note = resolved.rankError ? "Some sources are unavailable right now." : "";
  if (name === "flight_status") return result(flightText(flight) + (flight.notes.length ? " " + flight.notes.join(" ") : ""), flight, false, note);
  let destination = null;
  try { destination = airportFor(flight.destination).iata; } catch (_) {}
  const watchUrl = makeWatchUrl(url.origin, args.ident, destination, eta, flight);
  if (!watchUrl) return result(flightText(flight) + " Cannot create a watch without a resolved destination.", { ...flight, watch: null }, false, note);
  const prompt = "Send one short message per milestone change, never for a lower rank. Latch delayed-30 once. Ignore 503 responses; do not count them toward failure disable. Stop when the body contains SP-WATCH: done. Keep at most 3 flight watches.";
  return result(flightText(flight) + ` To follow it, create a url watcher on ${watchUrl} every 1 minute; send one short message per milestone change, never for a lower rank; stop when the body contains SP-WATCH: done. Keep at most 3 flight watches.`,
    { ...flight, watch: { url: watchUrl, every: "1m", doneMarker: "SP-WATCH: done", prompt } }, false, note);
}

function rpcError(id, code, message, status = 200) { return json(status, { jsonrpc: "2.0", id, error: { code, message } }); }
const validId = id => typeof id === "string" || (Number.isFinite(id) && Number.isInteger(id));
async function dispatch(request, env, ctx, deps) {
  if (request.method === "OPTIONS") return new Response(null, { headers: MCP_HEADERS });
  if (request.method !== "POST") {
    const response = json(405, { error: "POST required" });
    response.headers.set("Allow", "POST");
    return response;
  }
  if (Number(request.headers.get("Content-Length")) > 64 * 1024) return rpcError(null, -32600, "Body too large", 413);
  let message;
  try {
    const body = await readBodyCapped(request, 64 * 1024);
    if (!body) return rpcError(null, -32600, "Body too large", 413);
    message = JSON.parse(new TextDecoder().decode(body));
  } catch (_) { return rpcError(null, -32700, "Invalid JSON", 400); }
  const protocolVersion = request.headers.get("Mcp-Protocol-Version");
  if (message?.method !== "initialize" && protocolVersion !== null && !VERSIONS.includes(protocolVersion)) {
    return rpcError(validId(message?.id) ? message.id : null, -32600, "Unsupported protocol version", 400);
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid Request");
  if (!Object.hasOwn(message, "method") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) return new Response(null, { status: 202 });
  if (Object.hasOwn(message, "id") && !validId(message.id)) return rpcError(null, -32600, "Invalid Request");
  if (typeof message.method !== "string") return rpcError(message.id ?? null, -32600, "Invalid Request");
  if (!Object.hasOwn(message, "id")) return new Response(null, { status: 202 });
  const { id, method, params } = message;
  if (params != null && (typeof params !== "object" || Array.isArray(params))) return rpcError(id, -32602, "Invalid params");
  let output;
  if (method === "initialize") output = {
    protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0],
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: "contrails", version: "1.0.0" },
    instructions: "Look up airport boards, individual flights and nearby aircraft, or obtain a flight watcher recipe. Data is a live snapshot with no flight history, go-around detection or runway memory. Watch recipes do not start watches; retain maximum rank and stop at SP-WATCH: done.",
  };
  else if (method === "ping") output = {};
  else if (method === "tools/list") output = { tools: TOOLS };
  else if (method === "tools/call") {
    const tool = TOOLS.find(tool => tool.name === params?.name);
    if (!tool) return rpcError(id, -32602, "Unknown tool");
    try {
      const args = params.arguments ?? {};
      validateArguments(tool, args);
      output = await callTool(tool.name, args, new URL(request.url), env, ctx, deps);
    } catch (error) { output = result(error.status ? clean(error.message) || "Tool unavailable" : "Tool unavailable", { error: true }, true); }
  } else return rpcError(id, -32601, "Method not found");
  return json(200, { jsonrpc: "2.0", id, result: output });
}
export async function handleMcp(request, env, ctx, deps) {
  const response = await dispatch(request, env, ctx, deps);
  for (const [key, value] of Object.entries(MCP_HEADERS)) response.headers.set(key, value);
  response.headers.set("Content-Type", "application/json");
  return response;
}
