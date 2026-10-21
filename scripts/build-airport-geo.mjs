// Regenerates runways.json and the elevation column of airports.json from OurAirports
// (https://ourairports.com/data/, public domain).
//
//   node scripts/build-airport-geo.mjs [airports.csv runways.csv]
//
// With no arguments the two CSVs are downloaded. Only airports already in airports.json are touched;
// runways must be open, at least 4,000 ft, hard-surfaced, and have both end coordinates.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OA_BASE = "https://davidmegginson.github.io/ourairports-data/";
const MIN_RUNWAY_FT = 4000;
const SOFT_SURFACE = /GRASS|GRS|TURF|WATER|GRAVEL|GRVL|DIRT|SAND|SNOW|ICE|SOIL|CLAY|EARTH/i;

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

async function loadCsv(arg, name) {
  if (arg) return parseCsv(readFileSync(arg, "utf8"));
  const resp = await fetch(OA_BASE + name);
  if (!resp.ok) throw new Error(`${name}: HTTP ${resp.status}`);
  return parseCsv(await resp.text());
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;
// "1L" -> "01L", matching the two-digit designators ATIS and the board use.
const padIdent = (id) => (/^\d(?!\d)/.test(id) ? "0" + id : id);
const TYPE_RANK = { large_airport: 0, medium_airport: 1, small_airport: 2 };

const [airportsCsv, runwaysCsv] = process.argv.slice(2);
const oaAirports = await loadCsv(airportsCsv, "airports.csv");
const oaRunways = await loadCsv(runwaysCsv, "runways.csv");

// Several OurAirports rows can share an IATA code (closed fields, heliports); prefer the scheduled, larger one.
const byIata = new Map();
for (const ap of oaAirports) {
  if (!ap.iata_code || ap.type === "closed" || ap.type === "heliport") continue;
  const prev = byIata.get(ap.iata_code);
  const score = (a) => (a.scheduled_service === "yes" ? 0 : 10) + (TYPE_RANK[a.type] ?? 5);
  if (!prev || score(ap) < score(prev)) byIata.set(ap.iata_code, ap);
}

const runwaysByIdent = new Map();
for (const rw of oaRunways) {
  if (rw.closed === "1" || Number(rw.length_ft) < MIN_RUNWAY_FT || SOFT_SURFACE.test(rw.surface)) continue;
  const ends = [rw.le_latitude_deg, rw.le_longitude_deg, rw.he_latitude_deg, rw.he_longitude_deg].map(Number);
  if (ends.some((v) => !rw.le_latitude_deg || !isFinite(v)) || !rw.he_latitude_deg) continue;
  if (!rw.le_ident || !rw.he_ident || /^H/i.test(rw.le_ident)) continue;
  if (!runwaysByIdent.has(rw.airport_ident)) runwaysByIdent.set(rw.airport_ident, []);
  runwaysByIdent.get(rw.airport_ident).push(rw);
}

const airportsPath = path.join(ROOT, "airports.json");
const airports = JSON.parse(readFileSync(airportsPath, "utf8"));
const runways = {};
let withElevation = 0;
for (const row of airports) {
  const ap = byIata.get(row[0]);
  const elev = ap && ap.elevation_ft !== "" ? Math.round(Number(ap.elevation_ft)) : null;
  row.length = 6;
  row[6] = isFinite(elev) ? elev : null;
  if (row[6] != null) withElevation++;
  const list = ap && runwaysByIdent.get(ap.ident);
  if (!list || !list.length) continue;
  runways[row[0]] = list.map((rw) => [
    round4(Number(rw.le_latitude_deg)), round4(Number(rw.le_longitude_deg)), Math.round(Number(rw.le_elevation_ft) || 0),
    round4(Number(rw.he_latitude_deg)), round4(Number(rw.he_longitude_deg)), Math.round(Number(rw.he_elevation_ft) || 0),
    `${row[0]} ${padIdent(rw.le_ident)}/${padIdent(rw.he_ident)}`,
  ]);
}

writeFileSync(airportsPath, JSON.stringify(airports));
writeFileSync(path.join(ROOT, "runways.json"), JSON.stringify(runways));
console.log(`airports.json: ${withElevation}/${airports.length} with elevation; runways.json: ${Object.keys(runways).length} airports`);
