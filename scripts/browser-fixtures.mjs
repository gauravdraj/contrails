// Deterministic data for browser-check.mjs. No upstream services or npm packages.
import assert from "node:assert/strict";

export const VIEW = { lat: 51.4776, lng: -0.38, zoom: 11, width: 1280, height: 800 };
export const AIRPORT = { iata: "LHR", name: "London Heathrow", lat: 51.471, lng: -0.46 };
const ORIGIN = { iata: "JFK", name: "John F. Kennedy International", lat: 40.6413, lng: -73.7781 };

export function aircraftFixture(count, tick = 0) {
  const columns = Math.ceil(Math.sqrt(count * 1.6));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, i) => {
    const arrival = i < 4;
    // The first four are on Heathrow's 27R final; the rest fill the viewport with a generous edge margin.
    // Each five-second snapshot moves west ~400 m. Bounded motion keeps even long runs inside the view.
    const motion = Math.min(tick, 12) * 0.006;
    return {
      hex: (0xa00001 + i).toString(16), flight: "BAW" + (100 + i), t: "A320", category: "A3",
      r: "G-T" + String(i).padStart(3, "0"),
      lat: arrival ? 51.4777 : VIEW.lat + ((Math.floor(i / columns) + 0.5) / rows - 0.5) * 0.23,
      lon: arrival ? -0.35 + i * 0.025 - motion : VIEW.lng + ((i % columns + 0.5) / columns - 0.5) * 0.66 - motion,
      alt_baro: arrival ? 2000 + i * 600 - Math.min(tick, 12) * 60 : 9000 + (i % 20) * 1000,
      gs: arrival ? 155 : 220, track: 270, baro_rate: arrival ? -720 : 0,
      seen: 0, seen_pos: 0, squawk: "2000",
    };
  });
}

export function routeFixture(planes) {
  return planes.map(({ callsign }) => ({
    callsign, origin: ORIGIN, destination: AIRPORT, originSource: "track", destSource: "cross-validated",
    confidence: "high", phase: "arriving", display: "JFK to LHR",
  }));
}

export function scheduleFixture(iata, count, now) {
  return {
    iata, name: iata === "LHR" ? AIRPORT.name : iata,
    arrivals: iata === "LHR" ? aircraftFixture(Math.min(count, 4)).map((a, i) => ({
      callsign: a.flight, flight: a.flight.replace("BAW", "BA"), from_iata: "JFK", from_name: ORIGIN.name,
      live: true, est_arr: Math.floor(now / 1000) + (i + 2) * 60,
    })) : [],
    departures: [],
  };
}

export const MAP_STYLE = {
  version: 8,
  glyphs: "https://browser-check.invalid/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#08111e" } }],
};
// A valid protobuf: field 1 (fontstack), length 0. Missing glyphs are legal; plane icons still render.
export const EMPTY_GLYPHS = Buffer.from([0x0a, 0x00]);
export const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

export function externalFixture(urlString, resourceType) {
  const url = new URL(urlString);
  if (url.hostname === "basemaps.cartocdn.com" && url.pathname.endsWith("/style.json")) {
    return { type: "application/json", body: JSON.stringify(MAP_STYLE) };
  }
  if (url.hostname === "browser-check.invalid" && url.pathname.endsWith(".pbf")) {
    return { type: "application/x-protobuf", body: EMPTY_GLYPHS };
  }
  if (url.hostname === "api.rainviewer.com" && url.pathname === "/public/weather-maps.json") {
    return { type: "application/json", body: JSON.stringify({
      host: "https://tilecache.rainviewer.com", radar: { past: [{ time: 1700000000, path: "/v2/radar/1700000000" }] },
    }) };
  }
  if (resourceType === "Image" && /(^|\.)(cartocdn\.com|rainviewer\.com|planespotters\.net)$/.test(url.hostname)) {
    return { type: "image/png", body: EMPTY_PNG };
  }
  // Unknown requests are failed AND reported by the harness, never silently served arbitrary JSON.
  return null;
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function testFixtures() {
  for (const count of [1, 12, 1500]) {
    const first = aircraftFixture(count);
    assert.equal(first.length, count);
    assert.equal(new Set(first.map(a => a.hex)).size, count);
    assert.deepEqual(first, aircraftFixture(count));
    for (const a of aircraftFixture(count, 6)) {
      assert.match(a.hex, /^[a-f0-9]{6}$/);
      // Mercator bounds for the fixed 1280x800 viewport at app zoom 11, including motion.
      assert.ok(a.lat > 51.30 && a.lat < 51.65 && a.lon > -0.81 && a.lon < 0.05);
    }
    assert.ok(aircraftFixture(count, 1)[0].lon < first[0].lon);
    assert.ok(aircraftFixture(count, 1)[0].alt_baro < first[0].alt_baro);
  }
  assert.equal(routeFixture([{ callsign: "BAW100" }])[0].destination.iata, "LHR");
  assert.equal(scheduleFixture("LHR", 12, 1700000000000).arrivals.length, 4);
  assert.equal(scheduleFixture("JFK", 12, 1700000000000).arrivals.length, 0);
  assert.equal(externalFixture("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json").type, "application/json");
  assert.deepEqual(externalFixture("https://browser-check.invalid/fonts/test/0-255.pbf").body, EMPTY_GLYPHS);
  assert.equal(externalFixture("https://unmocked.invalid/test"), null);
  assert.equal(externalFixture("https://evilcartocdn.com/a.png", "Image"), null);
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  console.log("PASS fixture helpers: deterministic counts, bounds, motion, arrivals, network allowlist, percentiles");
}
