import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAirport,
  buildAirportPlane,
  handleAirport,
  estimateEtaMin,
  shortMiles,
  shortAlt,
  filterArrivals,
  filterDepartures,
  formatArrivalEntry,
  formatDepartureEntry,
  formatAirportText,
} from "./airport.js";

test("resolveAirport returns airport for uppercase IATA", () => {
  const result = resolveAirport("SFO");
  assert.ok(result);
  assert.equal(result.iata, "SFO");
  assert.equal(result.name, "San Francisco");
  assert.equal(typeof result.lat, "number");
  assert.equal(typeof result.lng, "number");
});

test("resolveAirport is case-insensitive", () => {
  const result = resolveAirport("sfo");
  assert.ok(result);
  assert.equal(result.iata, "SFO");
});

test("resolveAirport returns null for unknown code", () => {
  assert.equal(resolveAirport("ZZZZ"), null);
});

test("resolveAirport returns null for null/empty input", () => {
  assert.equal(resolveAirport(null), null);
  assert.equal(resolveAirport(""), null);
});

test("buildAirportPlane builds plane from ADS-B snapshot", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "a12345",
    flight: "UAL123  ",
    t: "B738",
    r: "N12345",
    lat: 37.65,
    lon: -122.40,
    alt_baro: 3500,
    gs: 180.7,
    baro_rate: -800,
    squawk: "1234",
    track: 270,
  });

  assert.ok(plane);
  assert.equal(plane.callsign, "UAL123");
  assert.equal(plane.icao24, "a12345");
  assert.equal(plane.type, "B738");
  assert.equal(plane.registration, "N12345");
  assert.equal(plane.altFt, 3500);
  assert.equal(plane.speedKts, 181);
  assert.equal(plane.vRate, -800);
  assert.equal(plane.ground, false);
  assert.equal(typeof plane.distKm, "number");
  assert.equal(plane.airline, "United");
  assert.equal(plane.priv, false);
});

test("buildAirportPlane includes ground aircraft", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "b12345",
    flight: "DAL456  ",
    t: "A321",
    r: "N67890",
    lat: 37.621,
    lon: -122.379,
    alt_baro: "ground",
    gs: 12,
    baro_rate: 0,
  });

  assert.ok(plane);
  assert.equal(plane.ground, true);
  assert.equal(plane.altFt, 0);
  assert.equal(plane.callsign, "DAL456");
  assert.equal(plane.airline, "Delta");
});

test("buildAirportPlane skips snapshot with null lat", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "c12345",
    flight: "AAL789",
    lat: null,
    lon: -122.40,
    alt_baro: 5000,
  });
  assert.equal(plane, null);
});

test("buildAirportPlane skips snapshot with null lon", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "c12345",
    flight: "AAL789",
    lat: 37.65,
    lon: null,
    alt_baro: 5000,
  });
  assert.equal(plane, null);
});

test("buildAirportPlane detects private aircraft", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "a00001",
    flight: "N12345  ",
    lat: 37.65,
    lon: -122.40,
    alt_baro: 8000,
    gs: 120,
  });
  assert.ok(plane);
  assert.equal(plane.priv, true);
});

test("buildAirportPlane handles missing optional fields", () => {
  const plane = buildAirportPlane(37.62, -122.38, {
    hex: "d12345",
    lat: 37.65,
    lon: -122.40,
    alt_baro: 10000,
  });
  assert.ok(plane);
  assert.equal(plane.callsign, null);
  assert.equal(plane.type, null);
  assert.equal(plane.registration, null);
  assert.equal(plane.speedKts, null);
  assert.equal(plane.vRate, null);
  assert.equal(plane.airline, null);
});

test("handleAirport returns 400 for invalid IATA format", async () => {
  const url = new URL("https://worker.test/airport/12");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 400);
  const body = await resp.text();
  assert.ok(body.includes("Invalid airport code"));
});

test("handleAirport returns 400 for numeric code", async () => {
  const url = new URL("https://worker.test/airport/123");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 400);
});

test("handleAirport returns 400 for code with special chars", async () => {
  const url = new URL("https://worker.test/airport/SF!");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 400);
});

test("handleAirport returns 404 for unknown airport", async () => {
  const url = new URL("https://worker.test/airport/ZZZ");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 404);
  const body = await resp.text();
  assert.equal(body, "Unknown airport code");
});

test("handleAirport returns 502 on ADS-B fetch failure", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 502);
});

test("handleAirport returns JSON arrivals with format=json", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;

  const mockCache = { match: async () => null, put: async () => {} };
  globalThis.caches = { default: mockCache };

  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      assert.ok(urlStr.includes("/dist/65"), "should use NM radius of 65");
      return new Response(JSON.stringify({
        ac: [
          { hex: "a12345", flight: "UAL123  ", t: "B738", r: "N12345", lat: 37.65, lon: -122.40, alt_baro: 3500, gs: 180, baro_rate: -800 },
          { hex: "b12345", flight: "DAL456  ", t: "A321", r: "N67890", lat: 37.621, lon: -122.379, alt_baro: "ground", gs: 12, baro_rate: 0 },
          { hex: "c12345", flight: "", lat: null, lon: null, alt_baro: 5000 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };

  t.after(() => {
    globalThis.caches = originalCaches;
    globalThis.fetch = originalFetch;
  });

  const url = new URL("https://worker.test/airport/SFO?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);

  const body = await resp.json();
  assert.equal(body.airport.iata, "SFO");
  assert.ok(Array.isArray(body.arrivals));
  assert.equal(body.departures, undefined);
  assert.ok(body.mapUrl.includes("lat="));
  assert.ok(body.mapUrl.includes("zoom=11"));
});

test("handleAirport accepts 4-letter IATA codes", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/ZZZZ");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 404);
});

test("handleAirport fetches with dist/65 (NM)", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => {
    capturedUrl = typeof url === "string" ? url : url.toString();
    return new Response("", { status: 500 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/LAX");
  await handleAirport(url, {}, {});
  assert.ok(capturedUrl);
  assert.ok(capturedUrl.includes("/dist/65"), `Expected dist/65 in URL but got: ${capturedUrl}`);
});

test("handleAirport dir=both&format=json returns arrivals and departures", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?dir=both&format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  assert.ok(Array.isArray(body.arrivals));
  assert.ok(Array.isArray(body.departures));
});

test("handleAirport dir=departures&format=json omits arrivals", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?dir=departures&format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  assert.equal(body.arrivals, undefined);
  assert.ok(Array.isArray(body.departures));
});

test("estimateEtaMin returns descent-rate ETA for descending aircraft", () => {
  const eta = estimateEtaMin({ altFt: 6000, vRate: -1000, speedKts: 200, distKm: 30 });
  assert.equal(eta, 6);
});

test("estimateEtaMin clamps descent divisor to 300 minimum", () => {
  const eta = estimateEtaMin({ altFt: 600, vRate: -600, speedKts: 100, distKm: 10 });
  assert.equal(eta, 1);
});

test("estimateEtaMin returns distance-based ETA for non-descending", () => {
  const eta = estimateEtaMin({ altFt: 30000, vRate: 0, speedKts: 450, distKm: 100 });
  const expected = 100 / (450 * 1.852 / 60);
  assert.ok(Math.abs(eta - expected) < 0.01);
});

test("estimateEtaMin returns null with no speed and not descending", () => {
  assert.equal(estimateEtaMin({ altFt: 5000, vRate: 0, speedKts: 0, distKm: 10 }), null);
  assert.equal(estimateEtaMin({ altFt: 5000, vRate: null, speedKts: null, distKm: 10 }), null);
});

test("estimateEtaMin caps minimum at 0.5", () => {
  const eta = estimateEtaMin({ altFt: 100, vRate: -1500, speedKts: 100, distKm: 1 });
  assert.ok(eta >= 0.5);
});

test("shortMiles converts km to miles", () => {
  assert.equal(shortMiles(10), 6.2);
  assert.equal(shortMiles(0), 0);
});

test("shortAlt formats altitude", () => {
  assert.equal(shortAlt(35000), "35k ft");
  assert.equal(shortAlt(1500), "1.5k ft");
  assert.equal(shortAlt(500), "500 ft");
});

test("filterArrivals includes route-confirmed destination matches", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "UAL123", ground: false, altFt: 10000, distKm: 50, speedKts: 200, vRate: -500 },
  ];
  const routeMap = { UAL123: { destination: { iata: "SFO" }, origin: { iata: "LAX" } } };
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result.length, 1);
  assert.equal(result[0].callsign, "UAL123");
  assert.equal(result[0].origin.iata, "LAX");
});

test("filterArrivals includes proximity heuristic matches", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "DAL456", ground: false, altFt: 4000, distKm: 15, speedKts: 150, vRate: -800 },
  ];
  const routeMap = {};
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result.length, 1);
  assert.equal(result[0].callsign, "DAL456");
});

test("filterArrivals excludes aircraft with conflicting destination", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "AAL789", ground: false, altFt: 4000, distKm: 15, speedKts: 150, vRate: -800 },
  ];
  const routeMap = { AAL789: { destination: { iata: "OAK" } } };
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result.length, 0);
});

test("filterArrivals excludes ground aircraft", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "UAL100", ground: true, altFt: 0, distKm: 1, speedKts: 10, vRate: 0 },
  ];
  const routeMap = { UAL100: { destination: { iata: "SFO" } } };
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result.length, 0);
});

test("filterArrivals sorts by altitude then ETA", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "UAL1", ground: false, altFt: 5000, distKm: 10, speedKts: 200, vRate: -600 },
    { callsign: "UAL2", ground: false, altFt: 2000, distKm: 8, speedKts: 150, vRate: -700 },
    { callsign: "UAL3", ground: false, altFt: 5000, distKm: 5, speedKts: 300, vRate: -800 },
  ];
  const routeMap = {
    UAL1: { destination: { iata: "SFO" } },
    UAL2: { destination: { iata: "SFO" } },
    UAL3: { destination: { iata: "SFO" } },
  };
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result[0].callsign, "UAL2");
  assert.equal(result[1].altFt, 5000);
  assert.equal(result[2].altFt, 5000);
  assert.ok(result[1].etaMin <= result[2].etaMin || result[1].etaMin === null);
});

test("filterArrivals caps at 15 results", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = Array.from({ length: 20 }, (_, i) => ({
    callsign: `UAL${i}`, ground: false, altFt: 3000 + i * 100, distKm: 10, speedKts: 200, vRate: -600,
  }));
  const routeMap = {};
  for (const p of planes) routeMap[p.callsign] = { destination: { iata: "SFO" } };
  const result = filterArrivals(planes, routeMap, airport);
  assert.equal(result.length, 15);
});

test("filterDepartures includes ground aircraft within 8km with route-confirmed origin", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "UAL500", ground: true, altFt: 0, distKm: 6, speedKts: 12 },
  ];
  const routeMap = { UAL500: { origin: { iata: "SFO" }, destination: { iata: "LAX" } } };
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "Taxiing");
  assert.equal(result[0].destination.iata, "LAX");
});

test("filterDepartures includes ground aircraft within 5km without route confirmation", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "DAL600", ground: true, altFt: 0, distKm: 4, speedKts: 0 },
  ];
  const routeMap = {};
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "Parked");
});

test("filterDepartures excludes ground aircraft beyond fallback radius without route", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "DAL700", ground: true, altFt: 0, distKm: 6, speedKts: 0 },
  ];
  const routeMap = {};
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result.length, 0);
});

test("filterDepartures excludes airborne aircraft", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "UAL800", ground: false, altFt: 5000, distKm: 3, speedKts: 200 },
  ];
  const routeMap = {};
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result.length, 0);
});

test("filterDepartures excludes planes without callsign", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: null, ground: true, altFt: 0, distKm: 2, speedKts: 0 },
  ];
  const routeMap = {};
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result.length, 0);
});

test("filterDepartures sorts taxiing first by speed desc, then parked by distance", () => {
  const airport = { iata: "SFO", lat: 37.62, lng: -122.38 };
  const planes = [
    { callsign: "AAL1", ground: true, altFt: 0, distKm: 1, speedKts: 0 },
    { callsign: "AAL2", ground: true, altFt: 0, distKm: 3, speedKts: 15 },
    { callsign: "AAL3", ground: true, altFt: 0, distKm: 2, speedKts: 8 },
    { callsign: "AAL4", ground: true, altFt: 0, distKm: 0.5, speedKts: 0 },
  ];
  const routeMap = {};
  const result = filterDepartures(planes, routeMap, airport);
  assert.equal(result[0].callsign, "AAL2");
  assert.equal(result[1].callsign, "AAL3");
  assert.equal(result[2].callsign, "AAL4");
  assert.equal(result[3].callsign, "AAL1");
});

test("formatArrivalEntry shows airline name, type, route, altitude, distance, ETA", () => {
  const plane = {
    callsign: "UAL1234", icao24: "a12345", type: "B738", airline: "United",
    altFt: 3500, distKm: 19.3, vRate: -800, etaMin: 4.2, priv: false,
    origin: { iata: "OAK" }, destination: { iata: "SFO" },
  };
  const text = formatArrivalEntry(1, plane);
  assert.ok(text.startsWith("1. United 1234 (B738)"));
  assert.ok(text.includes("OAK"));
  assert.ok(text.includes("SFO"));
  assert.ok(text.includes("\u2193 descending"));
  assert.ok(text.includes("mi"));
  assert.ok(text.includes("~4min"));
});

test("formatArrivalEntry uses raw callsign when no airline", () => {
  const plane = {
    callsign: "N12345", icao24: "a00001", type: "C172", airline: null,
    altFt: 2000, distKm: 5, vRate: -600, etaMin: 3, priv: true,
    origin: null, destination: null,
  };
  const text = formatArrivalEntry(2, plane);
  assert.ok(text.startsWith("2. N12345 (C172)"));
  assert.ok(text.includes("[PRIVATE]"));
});

test("formatArrivalEntry omits type parens when null", () => {
  const plane = {
    callsign: "UAL100", icao24: "a11111", type: null, airline: "United",
    altFt: 5000, distKm: 10, vRate: 0, etaMin: null, priv: false,
    origin: null, destination: { iata: "SFO" },
  };
  const text = formatArrivalEntry(1, plane);
  assert.ok(!text.includes("("));
  assert.ok(!text.includes("\u2193"));
  assert.ok(!text.includes("\u2191"));
  assert.ok(!text.includes("~"));
});

test("formatArrivalEntry shows climbing arrow", () => {
  const plane = {
    callsign: "DAL500", icao24: "b22222", type: "A320", airline: "Delta",
    altFt: 8000, distKm: 30, vRate: 1500, etaMin: 6, priv: false,
    origin: { iata: "SFO" }, destination: { iata: "LAX" },
  };
  const text = formatArrivalEntry(3, plane);
  assert.ok(text.includes("\u2191 climbing"));
});

test("formatDepartureEntry shows taxiing with mph", () => {
  const plane = {
    callsign: "ASA890", icao24: "c33333", type: "B739", airline: "Alaska",
    speedKts: 15, priv: false, status: "Taxiing",
    destination: { iata: "LAX" },
  };
  const text = formatDepartureEntry(1, plane);
  assert.ok(text.startsWith("1. Alaska 890 (B739)"));
  assert.ok(text.includes("\u2192 LAX"));
  assert.ok(text.includes("Taxiing"));
  assert.ok(text.includes(`${Math.round(15 * 1.15078)} mph`));
});

test("formatDepartureEntry shows parked without speed", () => {
  const plane = {
    callsign: "DAL200", icao24: "d44444", type: "A321", airline: "Delta",
    speedKts: 0, priv: false, status: "Parked",
    destination: null,
  };
  const text = formatDepartureEntry(2, plane);
  assert.ok(text.startsWith("2. Delta 200 (A321)"));
  assert.ok(!text.includes("\u2192"));
  assert.ok(text.includes("Parked"));
  assert.ok(!text.includes("mph"));
});

test("formatAirportText builds arrivals section", () => {
  const airport = { iata: "SFO", name: "San Francisco" };
  const arrivals = [{
    callsign: "UAL1", airline: "United", type: "B738", altFt: 3000,
    distKm: 10, vRate: -700, etaMin: 3, priv: false,
    origin: { iata: "LAX" }, destination: { iata: "SFO" },
  }];
  const text = formatAirportText(airport, arrivals, null, "arrivals");
  assert.ok(text.includes("SFO San Francisco"));
  assert.ok(text.includes("1 arriving:"));
  assert.ok(text.includes("United"));
});

test("formatAirportText shows (none detected) for empty arrivals", () => {
  const airport = { iata: "SFO", name: "San Francisco" };
  const text = formatAirportText(airport, [], null, "arrivals");
  assert.ok(text.includes("0 arriving:"));
  assert.ok(text.includes("(none detected)"));
});

test("formatAirportText builds both sections", () => {
  const airport = { iata: "SFO", name: "San Francisco" };
  const text = formatAirportText(airport, [], [], "both");
  assert.ok(text.includes("arriving:"));
  assert.ok(text.includes("departing:"));
});

test("handleAirport default returns HTML with text/html content-type", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  assert.ok(resp.headers.get("Content-Type").includes("text/html"));
  const body = await resp.text();
  assert.ok(body.includes("Open in Contrails"));
  assert.ok(body.includes("background:#0d1117"));
  assert.ok(body.includes("zoom=11"));
});

test("handleAirport format=text returns text/plain", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/sfo?format=text");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  assert.ok(resp.headers.get("Content-Type").includes("text/plain"));
  const body = await resp.text();
  assert.ok(body.includes("SFO"));
  assert.ok(body.includes("arriving:"));
});

test("handleAirport format=json includes mapUrl at zoom 11", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  assert.ok(body.mapUrl.includes("zoom=11"));
  assert.ok(body.mapUrl.includes("contrails"));
  assert.equal(body.airport.iata, "SFO");
  assert.ok(Array.isArray(body.arrivals));
});

test("handleAirport format=json arrival entries have expected fields", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({
        ac: [
          { hex: "a12345", flight: "UAL123  ", t: "B738", lat: 37.65, lon: -122.40, alt_baro: 3500, gs: 180, baro_rate: -800 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  assert.ok(body.arrivals.length >= 1);
  const arr = body.arrivals[0];
  assert.equal(arr.callsign, "UAL123");
  assert.equal(arr.airline, "United");
  assert.equal(arr.flightNum, "123");
  assert.equal(arr.type, "B738");
  assert.equal(arr.vertical, "descending");
  assert.equal(typeof arr.altFt, "number");
  assert.equal(typeof arr.distKm, "number");
  assert.equal(typeof arr.etaMin, "number");
});

test("handleAirport case-insensitive via lowercase URL", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/sfo?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.airport.iata, "SFO");
});

test("handleAirport format=json departure entries have expected fields", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({
        ac: [
          { hex: "a11111", flight: "SWA456  ", t: "B738", lat: 37.621, lon: -122.379, alt_baro: "ground", gs: 12, baro_rate: 0 },
          { hex: "a22222", flight: "DAL789  ", t: "A321", lat: 37.622, lon: -122.378, alt_baro: "ground", gs: 0, baro_rate: 0 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?dir=departures&format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.ok(Array.isArray(body.departures));
  if (body.departures.length > 0) {
    const dep = body.departures[0];
    assert.ok("callsign" in dep);
    assert.ok("type" in dep);
    assert.ok("status" in dep);
    assert.ok("speedKts" in dep);
    assert.ok(dep.status === "Taxiing" || dep.status === "Parked");
  }
});

test("handleAirport empty ac returns 200 with (none detected) in text", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?format=text");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  const body = await resp.text();
  assert.ok(body.includes("(none detected)"));
});

test("handleAirport empty ac returns 200 with empty arrays in JSON", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?dir=both&format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.deepEqual(body.arrivals, []);
  assert.deepEqual(body.departures, []);
});

test("handleAirport CORS headers on HTML response", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleAirport CORS headers on JSON response", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleAirport CORS headers on 400 error", async () => {
  const url = new URL("https://worker.test/airport/12");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 400);
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleAirport CORS headers on 404 error", async () => {
  const url = new URL("https://worker.test/airport/ZZZ");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 404);
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleAirport CORS headers on 502 error", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO");
  const resp = await handleAirport(url, {}, {});
  assert.equal(resp.status, 502);
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("handleAirport arrivals sorted lowest altitude first in JSON", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({
        ac: [
          { hex: "a11111", flight: "UAL100  ", t: "B738", lat: 37.63, lon: -122.39, alt_baro: 5000, gs: 200, baro_rate: -600 },
          { hex: "a22222", flight: "UAL200  ", t: "A320", lat: 37.64, lon: -122.40, alt_baro: 2000, gs: 150, baro_rate: -700 },
          { hex: "a33333", flight: "UAL300  ", t: "B777", lat: 37.625, lon: -122.385, alt_baro: 3500, gs: 180, baro_rate: -800 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  assert.ok(body.arrivals.length >= 2, "need at least 2 arrivals to verify sort");
  for (let i = 1; i < body.arrivals.length; i++) {
    assert.ok(body.arrivals[i].altFt >= body.arrivals[i - 1].altFt,
      `arrival ${i} alt ${body.arrivals[i].altFt} should be >= ${body.arrivals[i - 1].altFt}`);
  }
});

test("handleAirport departures sorted taxiing first in JSON", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({
        ac: [
          { hex: "b11111", flight: "DAL100  ", t: "A321", lat: 37.621, lon: -122.379, alt_baro: "ground", gs: 0, baro_rate: 0 },
          { hex: "b22222", flight: "SWA200  ", t: "B738", lat: 37.622, lon: -122.378, alt_baro: "ground", gs: 15, baro_rate: 0 },
          { hex: "b33333", flight: "UAL300  ", t: "B772", lat: 37.620, lon: -122.380, alt_baro: "ground", gs: 0, baro_rate: 0 },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const url = new URL("https://worker.test/airport/SFO?dir=departures&format=json");
  const resp = await handleAirport(url, {}, { waitUntil: () => {} });
  const body = await resp.json();
  if (body.departures.length >= 2) {
    let seenParked = false;
    for (const dep of body.departures) {
      if (dep.status === "Parked") seenParked = true;
      if (dep.status === "Taxiing" && seenParked) {
        assert.fail("Taxiing entry found after Parked entry — should be sorted taxiing-first");
      }
    }
  }
});

test("airport route via index.js returns 400 for invalid code", async (t) => {
  const { default: handler } = await import("./index.js");
  const request = new Request("https://worker.test/airport/12");
  const response = await handler.fetch(request, {}, {});
  assert.equal(response.status, 400);
});

test("airport route via index.js returns 404 for unknown airport", async (t) => {
  const { default: handler } = await import("./index.js");
  const request = new Request("https://worker.test/airport/ZZZ");
  const response = await handler.fetch(request, {}, {});
  assert.equal(response.status, 404);
});

test("airport route via index.js returns 200 for valid airport", async (t) => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => {} } };
  globalThis.fetch = async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("api.adsb.lol")) {
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: {} }), { status: 200 });
  };
  t.after(() => { globalThis.caches = originalCaches; globalThis.fetch = originalFetch; });

  const { default: handler } = await import("./index.js");
  const request = new Request("https://worker.test/airport/LAX?format=json");
  const response = await handler.fetch(request, {}, { waitUntil: () => {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.airport.iata, "LAX");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
});
